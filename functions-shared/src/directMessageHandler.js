import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { buildSmsQueueDoc } from './smsQueueDoc.js';
import { assertAdContentCompliant, resolvePromoScheduledDate } from './promoCampaignHandler.js';
import { resolveMmsImageId } from './mmsImage.js';

const MAX_RECIPIENTS = 100;
export { parseMmsImage } from './mmsImage.js';

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

// 임의 번호 정보성/홍보성 SMS 즉석 발송. 학생 DB와 무관. 직원 권한.
// 홍보성은 수동 동의 확인 + 광고 필수표기 + 야간 예약을 서버에서 강제한다.
export async function handleSendDirectMessage(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  const now = deps.now ?? new Date();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const body = String(data.text ?? '').trim();
  if (!body) throw new HttpsError('invalid-argument', '내용이 비어 있습니다.');

  const { valid, invalid } = parseRecipients(data.recipients);
  if (!valid.length) throw new HttpsError('invalid-argument', '유효한 수신번호가 없습니다.');
  if (valid.length > MAX_RECIPIENTS) throw new HttpsError('invalid-argument', `한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);

  const messageKind = data.messageKind ?? 'info';
  if (messageKind !== 'info' && messageKind !== 'promo') {
    throw new HttpsError('invalid-argument', 'messageKind는 info 또는 promo여야 합니다.');
  }
  const isPromo = messageKind === 'promo';
  if (isPromo) {
    if (data.consentConfirmed !== true) throw new HttpsError('failed-precondition', '광고 수신동의 확인이 필요합니다.');
    assertAdContentCompliant(body, 'M');
  }
  const scheduledDate = isPromo
    ? resolvePromoScheduledDate(data.scheduledAt, now)
    : (data.scheduledAt ? String(data.scheduledAt) : null);
  const createdBy = request.auth?.token?.email ?? null;
  const sentinelRef = data.requestId ? db.collection('direct_batches').doc(data.requestId) : null;
  if (sentinelRef && (await sentinelRef.get()).exists) return { queued: 0, invalid, duplicate: true };

  const imageId = await resolveMmsImageId(data.mmsImage, deps.uploadMmsImage);

  // sentinel과 큐 enqueue를 한 batch에 묶어 원자적으로 commit.
  // sentinel(batch.create)이 ALREADY_EXISTS를 던지면 중복 요청으로 처리.
  const batch = db.batch();
  if (sentinelRef) {
    batch.create(sentinelRef, {
      count: valid.length,
      created_by: createdBy,
      created_at: FieldValue.serverTimestamp(),
    });
  }
  for (const phone of valid) {
    batch.set(db.collection('message_queue').doc(), {
      ...buildSmsQueueDoc({
        kind: isPromo ? 'promo_sms' : 'direct',
        phone,
        content: body,
        scheduledDate,
        createdBy,
        adFlag: isPromo,
        consent: isPromo ? { source: 'manual_confirmation', at: now.toISOString() } : null,
        imageId,
      }),
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
