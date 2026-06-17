import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { buildPromoQueueDoc } from './promoCampaignHandler.js';
import { resolveRecipientPhone } from './recipientPhone.js';
import { parseKstToDate } from './promoSchedule.js';

const MAX_RECIPIENTS = 1000;
const BATCH_LIMIT = 400;

// 정보성 대용량: 번호 있으면 전원 큐잉. 동의/옵트아웃 무관(광고 아님), SMS 자동대체 허용(전원 도달).
// buildPromoQueueDoc을 targeting='I', smsAllowed=true, consent=null로 재사용 → ad_flag=false, disable_sms=false.
export function buildBulkRecipients(entries, opts) {
  const stats = { total: entries.length, queued: 0, skipped_no_phone: 0 };
  const docs = [];
  for (const { id, student } of entries) {
    const phone = resolveRecipientPhone(student, opts.recipientField);
    if (!phone) {
      stats.skipped_no_phone += 1;
      continue;
    }
    docs.push(buildPromoQueueDoc({
      studentId: id,
      phone,
      smsAllowed: true,      // 정보성: 동의 무관 전원 SMS 대체 허용
      consent: null,
      campaignId: opts.campaignId,
      content: opts.content,
      buttons: opts.buttons ?? null,
      imageId: opts.imageId ?? null,
      targeting: 'I',        // 정보성 → ad_flag=false
      scheduledDate: opts.scheduledDate,
    }));
    stats.queued += 1;
  }
  return { docs, stats };
}

// 정보성 대용량 발송 — 직원 권한. 동의·야간·광고검증 없음. message_queue(kind='promo', targeting='I')로 enqueue.
export async function handleCreateBulkMessage(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const title = String(data.title ?? '').trim();
  const content = String(data.content ?? '').trim();
  const studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds.filter(Boolean))] : [];
  if (!title) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  if (!content) throw new HttpsError('invalid-argument', '본문이 필요합니다.');
  if (!studentIds.length) throw new HttpsError('invalid-argument', '발송 대상이 없습니다.');
  if (studentIds.length > MAX_RECIPIENTS) throw new HttpsError('invalid-argument', `한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);

  // 정보성은 야간 보정 없음. 지정 시 형식만 검증(YYYY-MM-DD HH:mm:ss, KST).
  let scheduledDate = null;
  if (data.scheduledAt) {
    if (!parseKstToDate(data.scheduledAt)) throw new HttpsError('invalid-argument', '예약시각 형식이 올바르지 않습니다(YYYY-MM-DD HH:mm:ss, KST).');
    scheduledDate = String(data.scheduledAt);
  }

  const campaignRef = data.requestId
    ? db.collection('bulk_campaigns').doc(String(data.requestId))
    : db.collection('bulk_campaigns').doc();

  const refs = studentIds.map((id) => db.collection('students').doc(id));
  const snaps = await db.getAll(...refs);
  const entries = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, student: s.data() }));

  const { docs, stats } = buildBulkRecipients(entries, { campaignId: campaignRef.id, content, recipientField: data.recipientField, scheduledDate });
  stats.skipped_missing = studentIds.length - entries.length;

  // create로 원자적 선점 — 같은 requestId 동시 요청에서 정확히 하나만 큐에 등록.
  try {
    await campaignRef.create({
      title, content, targeting: 'I', kind: 'bulk_info',
      scheduled_date: scheduledDate ?? null, status: 'enqueuing', stats,
      created_by: request.auth?.uid ?? null, created_at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) {
      const ex = (await campaignRef.get()).data() ?? {};
      return { campaignId: campaignRef.id, duplicate: true, stats: ex.stats ?? null, scheduledDate: ex.scheduled_date ?? null };
    }
    throw e;
  }

  let batch = db.batch();
  let inBatch = 0;
  for (const doc of docs) {
    const qref = db.collection('message_queue').doc();
    batch.set(qref, { ...doc, created_at: FieldValue.serverTimestamp() });
    if ((inBatch += 1) >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  await campaignRef.update({ status: scheduledDate ? 'scheduled' : 'queued' });
  return { campaignId: campaignRef.id, scheduledDate: scheduledDate ?? null, stats };
}
