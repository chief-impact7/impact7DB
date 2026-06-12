import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertDirector } from './authGuards.js';

// 관리자 수동 재시도. 클라는 message_queue를 직접 쓸 수 없으므로(rules: write if false)
// 이 callable이 서버 검증 후 doc을 failed_retryable로 되돌려 sweeper(T3)가 재처리하게 한다.
// attempt_count를 0으로 리셋해 sweeper의 attempt_count<MAX 게이트를 통과시킨다.

const MAX_MANUAL_RETRIES = 3;   // 수동 재시도 상한(자동 sweeper와 별도 카운트)
const COOLDOWN_MS = 60_000;     // 직전 수동 재시도 후 쿨다운(연타·남용 방지)

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
    // failed_permanent(잘못된 번호·템플릿 거부 등)는 재시도해도 같은 실패 — failed_retryable만 허용.
    if (d.status !== 'failed_retryable') {
      throw new HttpsError('failed-precondition', '재시도할 수 없는 상태입니다.');
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
      manual_retry_count: manualCount + 1,
      retried_by: email,                          // 감사: 누가
      retried_at: FieldValue.serverTimestamp(),   // 감사: 언제
      updated_at: FieldValue.serverTimestamp(),
    });
    return { ok: true, queueId };
  });
}
