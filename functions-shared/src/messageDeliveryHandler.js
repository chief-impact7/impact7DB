import { getFirestore } from 'firebase-admin/firestore';
import { assertAuthorizedStaff } from './authGuards.js';
import { maskPhone } from './phoneMask.js';

// 관리자 발송 현황 집계 callable.
// message_queue는 발송용 평문 번호를 보유하는 서버 전용 데이터다(rules read 차단, T11과 짝).
// 클라가 큐 doc을 직접 read하면 네트워크 응답에 평문 번호가 노출되므로, 이 callable이
// 서버에서 카운트 + 마스킹된 실패 목록만 내려준다. 평문은 서버를 벗어나지 않는다.

const QUEUE_STATUSES = ['pending', 'processing', 'awaiting_delivery_result', 'failed_retryable', 'failed_permanent', 'sent'];
const FAILED_STATUSES = ['failed_retryable', 'failed_permanent'];
const CHANNELS = ['kakao', 'sms', 'lms'];
const MAX_FAILURES = 30;
const SCAN_LIMIT = 500;

// 표시용 마스킹. 저장(recipient_masked)·표시 포맷이 공용 maskPhone으로 통일됐으므로
// purge 후 남는 recipient_masked를 그대로 쓰고, 없으면 평문 번호를 즉시 마스킹한다(재마스킹 없음).
function recipientMaskedOf(d) {
  return d.recipient_masked ?? maskPhone(d.recipient_phone);
}

export async function handleGetMessageDeliveryStatus(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const db = deps.firestore || getFirestore();
  const queueCol = db.collection('message_queue');

  // 상태별 카운트는 aggregate count()로 — 큐 전수 스캔(최대 500건) 없이 정확한 카운트를 얻는다.
  const queueCountPromises = QUEUE_STATUSES.map(async (s) => {
    const agg = await queueCol.where('status', '==', s).count().get();
    return [s, agg.data().count];
  });

  // 보관 처리된 실패 항목 수 — 실패 목록에서는 제외되고 개수만 표시한다.
  const archivedCountPromise = queueCol.where('status', '==', 'archived').count().get();

  // 실패 목록은 (status, updated_at) 복합 인덱스로 최신 30건만 — 전수 스캔 불필요.
  const failuresPromise = queueCol
    .where('status', 'in', FAILED_STATUSES)
    .orderBy('updated_at', 'desc')
    .limit(MAX_FAILURES)
    .get();

  const logsPromise = db.collection('message_logs')
    .orderBy('created_at', 'desc').limit(SCAN_LIMIT).get();

  const [queueCountEntries, archivedAgg, failuresSnap, logSnap] = await Promise.all([
    Promise.all(queueCountPromises),
    archivedCountPromise,
    failuresPromise,
    logsPromise,
  ]);

  const queueCounts = Object.fromEntries(QUEUE_STATUSES.map(s => [s, 0]));
  for (const [s, c] of queueCountEntries) queueCounts[s] = c;

  const failures = [];
  failuresSnap.forEach(doc => {
    const d = doc.data();
    failures.push({
      id: doc.id,
      studentId: d.student_id ?? null,
      status: d.status,
      kind: d.kind ?? null,
      lastErrorCode: d.last_error_code ?? null,
      recipientMasked: recipientMaskedOf(d),
      updatedAt: d.updated_at?.toMillis?.() ?? null,
      // 보존기간 경과(평문 번호 purge) — 재발송 불가, 클라가 버튼을 비활성화한다.
      piiPurged: d.pii_purged_at != null,
    });
  });

  const channelCounts = Object.fromEntries(CHANNELS.map(c => [c, 0]));
  let sentCount = 0;
  let failedCount = 0;
  logSnap.forEach(doc => {
    const d = doc.data();
    if (d.status === 'sent') {
      sentCount++;
      if (channelCounts[d.channel] != null) channelCounts[d.channel]++;
    } else if (d.status === 'failed') {
      failedCount++;
    }
  });

  return {
    queueCounts,
    archivedCount: archivedAgg.data().count,
    channelCounts,
    sentCount,
    failedCount,
    failures,
    generatedAt: Date.now(),
  };
}
