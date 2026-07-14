import { createHmac, randomBytes } from 'node:crypto';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertManagerOrAbove } from './authGuards.js';
import { maskPhone } from './phoneMask.js';

const API_BASE = 'https://api.solapi.com';
const GROUP_NAME = 'DSC 수동 수신거부';

function normalizeMobile(value) {
  const phone = String(value ?? '').replace(/\D/g, '');
  return /^01[016789]\d{7,8}$/.test(phone) ? phone : '';
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
    let group = (groups.blockGroups ?? []).find((item) => item.status === 'ACTIVE' && item.useAll === true);
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
      created_by: request.auth?.token?.email ?? null,
      created_at: FieldValue.serverTimestamp(),
    });
    return { recipientMasked: maskPhone(phone), registered: true };
  } catch (error) {
    console.error('[manualOptOut] 솔라피 등록 실패', { httpStatus: error?.httpStatus ?? null });
    throw new HttpsError('internal', '솔라피 수신거부 등록에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
}
