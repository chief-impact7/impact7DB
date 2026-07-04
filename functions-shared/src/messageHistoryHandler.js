import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { maskPhone } from './phoneMask.js';

// 수신자별 발송 이력 타임라인. 카카오 관리자센터는 API 발송(알림톡/BMS) 원문을 보여주지 않으므로
// 학부모 답장의 맥락(무엇을 보냈는지)은 message_queue의 본문으로 복원한다.
// message_logs가 아닌 message_queue를 읽는 이유: 본문(content/fallback_text)은 큐 doc에만 있다.
// 종결 7일 후 purgeExpiredPii가 recipient_phone·fallback_text·template_variables를 지우므로
// 전화번호 검색은 purge 전 doc만 매칭되고, 알림톡 본문은 보존기간 경과 시 표시 불가(piiPurged).

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

function toMillis(ts) {
  return ts?.toMillis?.() ?? null;
}

// 큐 doc → 화면용 형태. 평문 번호는 내려주지 않는다(마스킹만).
export function mapQueueDoc(id, d) {
  const piiPurged = d.pii_purged_at != null;
  return {
    id,
    kind: d.kind ?? null,
    status: d.status ?? null,
    templateCode: d.template_code ?? null,
    content: d.content || d.fallback_text || null,
    recipientMasked: d.recipient_masked ?? maskPhone(d.recipient_phone),
    lastErrorCode: d.last_error_code ?? null,
    scheduledDate: d.scheduled_date ?? null,
    createdBy: d.created_by ?? null,
    createdAt: toMillis(d.created_at),
    updatedAt: toMillis(d.updated_at),
    piiPurged,
  };
}

export async function handleGetRecipientMessageHistory(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const studentId = String(request.data?.studentId ?? '').trim();
  const phone = onlyDigits(request.data?.phone);
  if (!studentId && !phone) throw new HttpsError('invalid-argument', 'studentId 또는 phone이 필요합니다.');
  if (!studentId && (phone.length < 9 || phone.length > 11)) {
    throw new HttpsError('invalid-argument', '유효한 전화번호가 아닙니다.');
  }
  const limit = Math.min(Number(request.data?.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  const field = studentId ? 'student_id' : 'recipient_phone';
  const value = studentId || phone;
  const snap = await db.collection('message_queue')
    .where(field, '==', value)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();

  return { items: snap.docs.map((doc) => mapQueueDoc(doc.id, doc.data())) };
}
