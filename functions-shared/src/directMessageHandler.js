import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';

const MAX_RECIPIENTS = 100;

// 줄바꿈/쉼표로 분리 → 숫자만 → 9~11자리 유효 → 중복 제거.
export function parseRecipients(raw) {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
  const tokens = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const token of tokens) {
    const digits = token.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 11) {
      invalid.push(token);
    } else {
      valid.push(digits);
    }
  }
  return { valid: [...new Set(valid)], invalid };
}

// 임의 번호 정보성 SMS 즉석 발송. 학생 DB와 무관. 직원 권한.
// 번호별로 message_queue(kind='direct') doc을 enqueue → 워커가 sendSms로 발송.
export async function handleSendDirectMessage(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const body = String(data.text ?? '').trim();
  if (!body) throw new HttpsError('invalid-argument', '내용이 비어 있습니다.');

  const { valid, invalid } = parseRecipients(data.recipients);
  if (!valid.length) throw new HttpsError('invalid-argument', '유효한 수신번호가 없습니다.');
  if (valid.length > MAX_RECIPIENTS) throw new HttpsError('invalid-argument', `한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);

  const scheduledDate = data.scheduledAt ? String(data.scheduledAt) : null;
  const createdBy = request.auth?.token?.email ?? null;

  // sentinel과 큐 enqueue를 한 batch에 묶어 원자적으로 commit.
  // sentinel(batch.create)이 ALREADY_EXISTS를 던지면 중복 요청으로 처리.
  const batch = db.batch();
  if (data.requestId) {
    batch.create(db.collection('direct_batches').doc(data.requestId),
      { count: valid.length, created_by: createdBy, created_at: FieldValue.serverTimestamp() });
  }
  for (const phone of valid) {
    batch.set(db.collection('message_queue').doc(), {
      kind: 'direct',
      status: 'pending',
      recipient_phone: phone,
      content: body,
      scheduled_date: scheduledDate,
      attempt_count: 0,
      created_by: createdBy,
      created_at: FieldValue.serverTimestamp(),
    });
  }
  try {
    await batch.commit();
  } catch (e) {
    if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) {
      return { queued: 0, invalid, duplicate: true };
    }
    throw e;
  }
  return { queued: valid.length, invalid };
}
