import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff, assertDirector } from './authGuards.js';
import { maskPhone } from './phoneMask.js';

// 관리자 발송 현황 집계 callable.
// message_queue는 발송용 평문 번호를 보유하는 서버 전용 데이터다(rules read 차단, T11과 짝).
// 클라가 큐 doc을 직접 읽지 않고, 권한 확인을 거친 이 callable이 상태별 상세와
// 마스킹된 실패 관리 목록을 구분해 내려준다.

const QUEUE_STATUSES = ['pending', 'processing', 'awaiting_delivery_result', 'failed_retryable', 'failed_permanent', 'sent'];
const FAILED_STATUSES = ['failed_retryable', 'failed_permanent'];
const CHANNELS = ['kakao', 'sms', 'mms'];
const MAX_FAILURES = 30;
const SCAN_LIMIT = 500;
const MAX_DETAILS_PER_STATUS = SCAN_LIMIT;
const RANGED_SCAN_LIMIT = 2000; // 기간 지정 통계는 상한을 넉넉히(학원 규모에서 사실상 전수)

// 표시용 마스킹. 저장(recipient_masked)·표시 포맷이 공용 maskPhone으로 통일됐으므로
// purge 후 남는 recipient_masked를 그대로 쓰고, 없으면 평문 번호를 즉시 마스킹한다(재마스킹 없음).
function recipientMaskedOf(d) {
  return d.recipient_masked ?? maskPhone(d.recipient_phone);
}

function queueDetail(doc, includeRecipientPhone = false) {
  const d = doc.data();
  return {
    id: doc.id,
    studentId: d.student_id ?? null,
    status: d.status,
    kind: d.kind ?? null,
    lastErrorCode: d.last_error_code ?? null,
    recipientRole: d.recipient_role ?? null,
    recipientMasked: recipientMaskedOf(d),
    ...(includeRecipientPhone && d.recipient_phone ? { recipientPhone: d.recipient_phone } : {}),
    createdAt: d.created_at?.toMillis?.() ?? (d.created_at instanceof Date ? d.created_at.getTime() : null),
    updatedAt: d.updated_at?.toMillis?.() ?? (d.updated_at instanceof Date ? d.updated_at.getTime() : null),
  };
}

// 솔라피 SDK는 잔액 조회 시에만 동적 로드(콜드스타트에 solapi 패키지 미포함 유지).
async function defaultFetchBalance() {
  const provider = await import('./solapiProvider.js');
  return provider.fetchSolapiBalance();
}

function failureDetail(doc) {
  const d = doc.data();
  return {
    ...queueDetail(doc),
    content: d.content || d.fallback_text || null,
    piiPurged: d.pii_purged_at != null,
  };
}

export async function handleGetMessageDeliveryStatus(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const db = deps.firestore || getFirestore();
  const queueCol = db.collection('message_queue');
  let includeRecipientPhone = false;
  try {
    await assertDirector(request.auth, db);
    includeRecipientPhone = true;
  } catch (error) {
    if (error?.code !== 'permission-denied') throw error;
  }

  // 기간 필터(선택) — fromMs/toMs epoch ms. 큐 요약과 발송 로그에 함께 적용한다.
  const fromMs = Number(request.data?.fromMs);
  const toMs = Number(request.data?.toMs);
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs > toMs) {
    throw new HttpsError('invalid-argument', '기간이 올바르지 않습니다 (from > to).');
  }
  const hasRange = Number.isFinite(fromMs) || Number.isFinite(toMs);
  const queueCountPromises = hasRange ? [] : QUEUE_STATUSES.map(async (s) => {
    const agg = await queueCol.where('status', '==', s).count().get();
    return [s, agg.data().count];
  });
  const archivedCountPromise = queueCol.where('status', '==', 'archived').count().get();
  const failuresPromise = hasRange ? null : queueCol
    .where('status', 'in', FAILED_STATUSES)
    .orderBy('updated_at', 'desc')
    .limit(MAX_FAILURES)
    .get();
  let queueQuery = queueCol.orderBy('created_at', 'desc');
  if (Number.isFinite(fromMs)) queueQuery = queueQuery.where('created_at', '>=', new Date(fromMs));
  if (Number.isFinite(toMs)) queueQuery = queueQuery.where('created_at', '<=', new Date(toMs));
  const queueScanLimit = hasRange ? RANGED_SCAN_LIMIT : SCAN_LIMIT;
  const queuePreviewPromise = queueQuery.limit(queueScanLimit).get();
  let logsQuery = db.collection('message_logs').orderBy('created_at', 'desc');
  if (Number.isFinite(fromMs)) logsQuery = logsQuery.where('created_at', '>=', new Date(fromMs));
  if (Number.isFinite(toMs)) logsQuery = logsQuery.where('created_at', '<=', new Date(toMs));
  const logScanLimit = hasRange ? RANGED_SCAN_LIMIT : SCAN_LIMIT;
  const logsPromise = logsQuery.limit(logScanLimit).get();
  // 잔액 고갈은 전 채널 발송 실패로 이어짐 — 조회 실패는 통계에 영향 주지 않게 null 처리.
  const balancePromise = (deps.fetchBalance ?? defaultFetchBalance)().catch(() => null);

  const [queueCountEntries, archivedAgg, failuresSnap, queuePreviewSnap, logSnap] = await Promise.all([
    Promise.all(queueCountPromises),
    archivedCountPromise,
    failuresPromise,
    queuePreviewPromise,
    logsPromise,
  ]);

  const queueCounts = Object.fromEntries(QUEUE_STATUSES.map(s => [s, 0]));
  if (hasRange) {
    queuePreviewSnap.forEach((doc) => {
      const status = doc.data().status;
      if (queueCounts[status] != null) queueCounts[status] += 1;
    });
  } else {
    for (const [s, c] of queueCountEntries) queueCounts[s] = c;
  }

  const queueDetails = Object.fromEntries(QUEUE_STATUSES.map((status) => [status, []]));
  queuePreviewSnap.forEach((doc) => {
    const status = doc.data().status;
    if (queueDetails[status]?.length < MAX_DETAILS_PER_STATUS) {
      queueDetails[status].push(queueDetail(doc, includeRecipientPhone));
    }
  });
  const failureDocs = hasRange
    ? queuePreviewSnap.docs.filter((doc) => FAILED_STATUSES.includes(doc.data().status)).slice(0, MAX_FAILURES)
    : failuresSnap.docs;
  const failures = failureDocs.map(failureDetail);

  const channelCounts = Object.fromEntries(CHANNELS.map(c => [c, 0]));
  let sentCount = 0;
  let failedCount = 0;
  const failedCodeCounts = {};
  logSnap.forEach(doc => {
    const d = doc.data();
    if (d.status === 'sent') {
      sentCount++;
      const channel = d.channel === 'lms' ? 'sms' : d.channel;
      if (channelCounts[channel] != null) channelCounts[channel]++;
    } else if (d.status === 'failed') {
      failedCount++;
      const code = String(d.status_code ?? 'unknown');
      failedCodeCounts[code] = (failedCodeCounts[code] || 0) + 1;
    }
  });

  return {
    solapiBalance: await balancePromise,
    failedCodeCounts,
    queueCounts,
    archivedCount: archivedAgg.data().count,
    channelCounts,
    sentCount,
    failedCount,
    // 스캔 상한 도달 = 기간 내 로그가 더 있음(통계가 하한값) — UI가 안내한다.
    logLimitReached: (logSnap.size ?? logSnap.docs?.length ?? 0) >= logScanLimit,
    queueLimitReached: (queuePreviewSnap.size ?? queuePreviewSnap.docs?.length ?? 0) >= queueScanLimit,
    queueDetails,
    failures,
    generatedAt: Date.now(),
  };
}
