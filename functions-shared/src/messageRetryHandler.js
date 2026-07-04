import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff, assertDirector } from './authGuards.js';

// 관리자 수동 재시도. 클라는 message_queue를 직접 쓸 수 없으므로(rules: write if false)
// 이 callable이 서버 검증 후 doc을 failed_retryable로 되돌려 sweeper(T3)가 재처리하게 한다.
// attempt_count를 0으로 리셋해 sweeper의 attempt_count<MAX 게이트를 통과시킨다.

const MAX_MANUAL_RETRIES = 3;   // 수동 재시도 상한(자동 sweeper와 별도 카운트)
const COOLDOWN_MS = 60_000;     // 직전 수동 재시도 후 쿨다운(연타·남용 방지)
// 광고성은 원 발송 이후 수신거부됐을 수 있는데 수동 재발송은 동의 게이트를 다시 타지 않는다 — 금지.
const NON_RETRYABLE_KINDS = new Set(['promo', 'promo_sms']);

export async function handleRetryMessageDelivery(request, deps = {}) {
  const db = deps.firestore || getFirestore();
  // 재발송은 비용·외부발송이 걸린 변경 작업 — 원장급(owner/principal)만 허용(rules isDirector와 동일 소스).
  await assertDirector(request.auth, db);

  const queueId = String(request.data?.queueId ?? '').trim();
  if (!queueId) throw new HttpsError('invalid-argument', 'queueId가 필요합니다.');

  const email = request.auth.token?.email || '';
  const now = deps.now ?? new Date();
  const ref = db.collection('message_queue').doc(queueId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', '발송 항목을 찾을 수 없습니다.');
    const d = snap.data();
    // failed_permanent도 허용 — 실패 원인이 나중에 해소되는 사례가 실재한다
    // (미승인 템플릿의 추후 승인, 3058 전송경로 등). 상한·쿨다운이 남용을 막는다.
    if (d.status !== 'failed_retryable' && d.status !== 'failed_permanent') {
      throw new HttpsError('failed-precondition', '재시도할 수 없는 상태입니다.');
    }
    // 종결 7일 후 purge로 평문 번호가 삭제된 doc은 재발송 자체가 불가능.
    if (d.pii_purged_at != null || !d.recipient_phone) {
      throw new HttpsError('failed-precondition', '보존기간이 지나 재발송할 수 없습니다.');
    }
    if (NON_RETRYABLE_KINDS.has(d.kind)) {
      throw new HttpsError('failed-precondition', '홍보성 메시지는 수동 재발송할 수 없습니다 (동의 재확인 필요).');
    }
    const manualCount = d.manual_retry_count ?? 0;
    if (manualCount >= MAX_MANUAL_RETRIES) {
      throw new HttpsError('resource-exhausted', '수동 재시도 한도를 초과했습니다.');
    }
    const lastRetryMs = d.retried_at?.toMillis?.() ?? null;
    if (lastRetryMs != null && now.getTime() - lastRetryMs < COOLDOWN_MS) {
      throw new HttpsError('failed-precondition', '너무 잦은 재시도입니다. 잠시 후 시도하세요.');
    }
    tx.update(ref, {
      status: 'failed_retryable',
      attempt_count: 0,
      next_attempt_at: now,
      last_error_code: null,
      purge_after: FieldValue.delete(), // 종결 시점에 다시 설정됨 — 재처리 중 purge 방지
      manual_retry_count: manualCount + 1,
      retried_by: email,                          // 감사: 누가
      retried_at: FieldValue.serverTimestamp(),   // 감사: 언제
      updated_at: FieldValue.serverTimestamp(),
    });
    return { ok: true, queueId };
  });
}

// 실패 항목 정리 — 목록에 무한 누적되는 실패 doc을 보관(숨김) 또는 삭제한다.
// archive: status를 'archived'로 바꿔 실패 목록 쿼리(status in failed_*)에서 제외. 직원 가능.
// delete: doc 자체를 삭제. message_logs가 남으므로 발송 이력은 소실되지 않는다. 원장만.
const MANAGE_ACTIONS = new Set(['archive', 'delete']);
// failed_permanent만 허용: failed_retryable은 message_logs 미기록(삭제=이력 소실)·purge_after
// 미설정(보관=평문 번호 영구 잔존)이며, 아직 sweeper가 재처리 중인 상태라 정리 대상이 아니다.
const ARCHIVABLE_STATUSES = new Set(['failed_permanent']);
const DELETABLE_STATUSES = new Set(['failed_permanent', 'archived']);

export async function handleManageMessageFailure(request, deps = {}) {
  const db = deps.firestore || getFirestore();
  const action = String(request.data?.action ?? '');
  if (!MANAGE_ACTIONS.has(action)) throw new HttpsError('invalid-argument', 'action은 archive 또는 delete여야 합니다.');
  if (action === 'delete') await assertDirector(request.auth, db);
  else assertAuthorizedStaff(request.auth);

  const queueId = String(request.data?.queueId ?? '').trim();
  if (!queueId) throw new HttpsError('invalid-argument', 'queueId가 필요합니다.');

  const email = request.auth.token?.email || '';
  const ref = db.collection('message_queue').doc(queueId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', '발송 항목을 찾을 수 없습니다.');
    const d = snap.data();
    const allowed = action === 'delete' ? DELETABLE_STATUSES : ARCHIVABLE_STATUSES;
    if (!allowed.has(d.status)) {
      throw new HttpsError('failed-precondition', '보관/삭제할 수 없는 상태입니다.');
    }
    if (action === 'delete') {
      tx.delete(ref);
      return { ok: true, queueId, action };
    }
    tx.update(ref, {
      status: 'archived',
      archived_from: d.status,
      archived_by: email,
      archived_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    return { ok: true, queueId, action };
  });
}
