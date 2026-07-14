import { createHmac, randomBytes } from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertManagerOrAbove } from './authGuards.js';
import { maskPhone } from './phoneMask.js';
import { formatDateKST } from '@impact7/shared/datetime';

const API_BASE = 'https://api.solapi.com';
const GROUP_NAME = 'DSC 수동 수신거부';

function normalizeMobile(value) {
  const phone = String(value ?? '').replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(phone) ? phone : '';
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return '';
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? match[0]
    : '';
}

function authorizationHeader(apiKey, apiSecret, now, salt) {
  const date = now.toISOString();
  const signature = createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function solapiRequest(path, { method = 'GET', body, apiKey, apiSecret, fetchFn, now, salt }) {
  const response = await fetchFn(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authorizationHeader(apiKey, apiSecret, now, salt),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const error = new Error('SOLAPI request failed');
    error.httpStatus = response.status;
    throw error;
  }
  return data;
}

export async function handleRegisterManualOptOut(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  await assertManagerOrAbove(request.auth, db);

  const phone = normalizeMobile(request.data?.phone);
  if (!phone) throw new HttpsError('invalid-argument', '올바른 휴대폰 번호가 필요합니다.');
  const memo = String(request.data?.memo ?? '').trim().slice(0, 250);
  const apiKey = deps.apiKey ?? process.env.SOLAPI_API_KEY;
  const apiSecret = deps.apiSecret ?? process.env.SOLAPI_API_SECRET;
  if (!apiKey || !apiSecret) throw new HttpsError('failed-precondition', '솔라피 인증 정보가 설정되지 않았습니다.');

  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const requestedDateInput = String(request.data?.requestedDate ?? '');
  const parsedRequestedDate = validDate(requestedDateInput);
  if (requestedDateInput && !parsedRequestedDate) {
    throw new HttpsError('invalid-argument', '수신거부 요청일이 올바르지 않습니다.');
  }
  const requestedDate = parsedRequestedDate || formatDateKST(now);
  const call = (path, options = {}) => solapiRequest(path, {
    ...options,
    apiKey,
    apiSecret,
    fetchFn,
    now,
    salt: randomBytes(16).toString('hex'),
  });

  try {
    const groups = await call('/iam/v1/block/groups/?status=ACTIVE&useAll=true&limit=100');
    let group = (groups.blockGroups ?? []).find((item) => item.status === 'ACTIVE' && item.useAll === true && item.name === GROUP_NAME)
      ?? (groups.blockGroups ?? []).find((item) => item.status === 'ACTIVE' && item.useAll === true);
    if (!group) {
      group = await call('/iam/v1/block/groups/', {
        method: 'POST',
        body: { name: GROUP_NAME, status: 'ACTIVE', useAll: true },
      });
    }

    const existing = await call(`/iam/v1/block/numbers/?phoneNumber=${phone}&limit=20`);
    const current = (existing.blockNumbers ?? []).find((item) => item.phoneNumber === phone);
    const blockGroupIds = [...new Set([...(current?.blockGroupIds ?? []), group.blockGroupId])];
    const saved = await call('/iam/v1/block/numbers/', {
      method: 'POST',
      body: {
        ...(current?.blockNumberId ? { blockNumberId: current.blockNumberId } : {}),
        phoneNumber: phone,
        memo: memo || 'DSC 수동 수신거부 등록',
        blockGroupIds,
      },
    });

    await db.collection('message_opt_out_audit').add({
      recipient_masked: maskPhone(phone),
      provider: 'solapi',
      provider_block_number_id: saved.blockNumberId ?? current?.blockNumberId ?? null,
      provider_block_group_id: group.blockGroupId,
      requested_date: requestedDate,
      memo: memo || 'DSC 수동 수신거부 등록',
      created_by: request.auth?.token?.email ?? null,
      created_at: FieldValue.serverTimestamp(),
    });
    return { recipientMasked: maskPhone(phone), requestedDate, registered: true };
  } catch (error) {
    console.error('[manualOptOut] 솔라피 등록 실패', { httpStatus: error?.httpStatus ?? null });
    throw new HttpsError('internal', '솔라피 수신거부 등록에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
}

async function fetchAllBlockNumbers(call, groupIds) {
  const rows = [];
  for (const groupId of groupIds) {
    let startKey = null;
    do {
      const query = new URLSearchParams({ blockGroupId: groupId, limit: '100' });
      if (startKey) query.set('startKey', startKey);
      const page = await call(`/iam/v1/block/numbers/?${query}`);
      rows.push(...(page.blockNumbers ?? []));
      startKey = page.nextKey || null;
    } while (startKey);
  }
  return [...new Map(rows.map((row) => [row.blockNumberId, row])).values()];
}

function millisOf(value) {
  return value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : null);
}

export async function handleGetManualOptOuts(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  await assertManagerOrAbove(request.auth, db);
  const apiKey = deps.apiKey ?? process.env.SOLAPI_API_KEY;
  const apiSecret = deps.apiSecret ?? process.env.SOLAPI_API_SECRET;
  if (!apiKey || !apiSecret) throw new HttpsError('failed-precondition', '솔라피 인증 정보가 설정되지 않았습니다.');
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? new Date();
  const call = (path, options = {}) => solapiRequest(path, {
    ...options,
    apiKey,
    apiSecret,
    fetchFn,
    now,
    salt: randomBytes(16).toString('hex'),
  });

  try {
    const [groups, localSnap] = await Promise.all([
      call('/iam/v1/block/groups/?status=ACTIVE&useAll=true&limit=100'),
      db.collection('message_opt_out_audit').orderBy('created_at', 'desc').limit(500).get(),
    ]);
    const relevantGroups = (groups.blockGroups ?? []).filter((group) => group.status === 'ACTIVE' && group.useAll === true);
    const providerRows = await fetchAllBlockNumbers(call, relevantGroups.map((group) => group.blockGroupId));
    const localRows = localSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const localByProviderId = new Map();
    for (const row of localRows) {
      if (row.provider_block_number_id && !localByProviderId.has(row.provider_block_number_id)) {
        localByProviderId.set(row.provider_block_number_id, row);
      }
    }
    const providerIds = new Set(providerRows.map((row) => row.blockNumberId));
    const items = providerRows.map((row) => {
      const local = localByProviderId.get(row.blockNumberId);
      return {
        id: row.blockNumberId,
        recipientMasked: maskPhone(row.phoneNumber),
        requestedDate: local?.requested_date ?? null,
        providerCreatedAt: row.dateCreated ?? null,
        localCreatedAt: millisOf(local?.created_at),
        memo: local?.memo || row.memo || '',
        syncStatus: local ? 'matched' : 'solapi_only',
      };
    });
    for (const local of localRows) {
      if (local.provider_block_number_id && providerIds.has(local.provider_block_number_id)) continue;
      items.push({
        id: local.provider_block_number_id || `local:${local.id}`,
        recipientMasked: local.recipient_masked || '',
        requestedDate: local.requested_date ?? null,
        providerCreatedAt: null,
        localCreatedAt: millisOf(local.created_at),
        memo: local.memo || '',
        syncStatus: 'local_only',
      });
    }
    items.sort((a, b) => String(b.providerCreatedAt ?? b.requestedDate ?? '').localeCompare(String(a.providerCreatedAt ?? a.requestedDate ?? '')));
    return {
      items,
      groupCount: relevantGroups.length,
      matchedCount: items.filter((item) => item.syncStatus === 'matched').length,
      solapiOnlyCount: items.filter((item) => item.syncStatus === 'solapi_only').length,
      localOnlyCount: items.filter((item) => item.syncStatus === 'local_only').length,
      localLimitReached: (localSnap.size ?? localSnap.docs.length) >= 500,
      generatedAt: Date.now(),
    };
  } catch (error) {
    console.error('[manualOptOut] 솔라피 목록 조회 실패', { httpStatus: error?.httpStatus ?? null });
    throw new HttpsError('internal', '솔라피 수신거부 목록 조회에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
}
