import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { buildPromoQueueDoc } from './promoCampaignHandler.js';
import { resolveRecipientPhone, resolveRecipientPhones } from './recipientPhone.js';
import { parseKstToDate } from './promoSchedule.js';
import { currentSchool } from '@impact7/shared/student-label';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';

const MAX_RECIPIENTS = 1000;
const BATCH_LIMIT = 400;

const VAR_TOKENS = ['%이름', '%학교', '%학년', '%반'];

// 본문에 변수 토큰이 포함되어 있는지 여부. 포함 시 dedup 비활성(학생마다 내용이 다름).
function hasVarTokens(content) {
  return VAR_TOKENS.some((t) => content.includes(t));
}

// 반코드 목록: enrollment 배열에서 level_symbol+class_number 조합.
function allClassCodes(student) {
  return (student.enrollments || []).map((e) => enrollmentCode(e)).filter(Boolean);
}

// 본문 변수 치환. 각 토큰을 학생 필드 값으로 치환하며, 값이 없으면 빈 문자열.
export function applyMessageVars(content, student) {
  return content
    .replaceAll('%이름', student.name ?? '')
    .replaceAll('%학교', currentSchool(student))
    .replaceAll('%학년', student.grade != null ? String(student.grade) : '')
    .replaceAll('%반', allClassCodes(student)[0] ?? '');
}

// 정보성 대용량: 번호 있으면 전원 큐잉. 동의/옵트아웃 무관(광고 아님), SMS 자동대체 허용(전원 도달).
// buildPromoQueueDoc을 targeting='I', smsAllowed=true, consent=null로 재사용 → ad_flag=false, disable_sms=false.
// recipientFields(배열) 우선, 없으면 recipientField(단일)로 단일 번호, 둘 다 없으면 기존 폴백(parent_1→parent_2).
// 캠페인 내 동일 전화번호는 1건만 enqueue(형제·같은 학부모 번호 중복 방지). 제외 수는 stats.deduped.
// 본문에 변수 토큰(%이름/%학교/%학년/%반)이 있으면 학생별로 치환하고 dedup을 비활성화.
export function buildBulkRecipients(entries, opts) {
  const fields = Array.isArray(opts.recipientFields) && opts.recipientFields.length > 0
    ? opts.recipientFields
    : null;
  const useVars = hasVarTokens(opts.content);

  const stats = { total: entries.length, queued: 0, skipped_no_phone: 0, deduped: 0 };
  const docs = [];
  const seenPhones = new Set();

  for (const { id, student } of entries) {
    const phones = fields
      ? resolveRecipientPhones(student, fields)
      : [resolveRecipientPhone(student, opts.recipientField)].filter(Boolean);

    if (phones.length === 0) {
      stats.skipped_no_phone += 1;
      continue;
    }

    const content = useVars ? applyMessageVars(opts.content, student) : opts.content;
    // 변수 모드에서도 한 학생 내 동일 번호는 1건만(intra-entry dedup).
    // 형제 간(inter-entry) dedup은 변수 모드에서 유지하지 않는다.
    const effectivePhones = useVars ? [...new Set(phones)] : phones;

    for (const phone of effectivePhones) {
      if (!useVars && seenPhones.has(phone)) {
        stats.deduped += 1;
        continue;
      }
      if (!useVars) seenPhones.add(phone);
      docs.push(buildPromoQueueDoc({
        studentId: id,
        phone,
        smsAllowed: true,      // 정보성: 동의 무관 전원 SMS 대체 허용
        consent: null,
        campaignId: opts.campaignId,
        content,
        buttons: opts.buttons ?? null,
        imageId: opts.imageId ?? null,
        targeting: 'I',        // 정보성 → ad_flag=false
        scheduledDate: opts.scheduledDate,
      }));
      stats.queued += 1;
    }
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

  const { docs, stats } = buildBulkRecipients(entries, {
    campaignId: campaignRef.id,
    content,
    recipientField: data.recipientField,
    recipientFields: Array.isArray(data.recipientFields) ? data.recipientFields : undefined,
    scheduledDate,
  });
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
