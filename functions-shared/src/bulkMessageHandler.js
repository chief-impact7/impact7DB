import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff, assertManagerOrAbove } from './authGuards.js';
import { buildSmsQueueDocs } from './smsQueueDoc.js';
import { resolveRecipientPhones, resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import {
  REQUEST_FINGERPRINT_VERSION,
  campaignFingerprintMatches,
  claimCampaignResume,
  recipientFingerprint,
} from './campaignResume.js';
import { parseKstToDate } from './promoSchedule.js';
import { currentSchool } from '@impact7/shared/student-label';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { resolveMmsImageId } from './mmsImage.js';
import { effectiveStaffStatus } from '@impact7/shared/staff-status';
import { digitsOf, isValidPhoneKR } from '@impact7/shared/phone';
import { todayKST } from '@impact7/shared/datetime';
import { applyTemplate } from './templates.js';
import { getApprovedAlimtalkTemplate } from './alimtalkTemplateHandler.js';
import { alimtalkLengthDetails, assertAlimtalkPayloadFits } from './messageLength.js';

const MAX_RECIPIENTS = 10000;
const BATCH_LIMIT = 400;
const SPLIT_UNLOCK_STATUSES = new Set(['awaiting_delivery_result', 'sent', 'failed_permanent']);

const VAR_TOKENS = ['%이름', '%학교', '%학년', '%반'];
const STAFF_STATUSES = new Set(['active', 'inactive', 'terminated']);
const ALIMTALK_RECIPIENT_FIELDS = new Set(['student', 'parent_1', 'parent_2']);

function appendQueueDocs(docs, queueDocs, maxQueueDocs = Infinity) {
  if (docs.length + queueDocs.length > maxQueueDocs) {
    throw new HttpsError('invalid-argument', `분할 발송을 포함해 한 번에 최대 ${maxQueueDocs}건까지 등록할 수 있습니다.`);
  }
  docs.push(...queueDocs);
}

// 본문에 변수 토큰이 포함되어 있는지 여부. 포함 시 dedup 비활성(학생마다 내용이 다름).
export function hasVarTokens(content) {
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

// 정보성 대용량: 번호 있으면 전원 LMS/SMS 큐잉. 동의/옵트아웃 무관(광고 아님).
// recipientFields(배열) 우선, 없으면 recipientField(단일)로 단일 번호, 둘 다 없으면 기존 폴백(parent_1→parent_2).
// 캠페인 내 동일 전화번호는 1건만 enqueue(형제·같은 학부모 번호 중복 방지). 제외 수는 stats.deduped.
// 본문에 변수 토큰(%이름/%학교/%학년/%반)이 있으면 학생별로 치환하고 dedup을 비활성화.
export function buildBulkRecipients(entries, opts) {
  const fields = Array.isArray(opts.recipientFields) && opts.recipientFields.length > 0
    ? opts.recipientFields
    : null;
  const useVars = hasVarTokens(opts.content);

  const stats = { total: entries.length, queued: 0, skipped_no_phone: 0, deduped: 0, split_groups: 0 };
  const docs = [];
  const seenPhones = new Set();

  for (const { id, student } of entries) {
    const targets = fields
      ? resolveRecipientTargets(student, fields)
      : [resolveRecipientTarget(student, opts.recipientField)].filter(Boolean);
    if (fields) stats.deduped += resolveRecipientPhones(student, fields).length - targets.length;

    if (targets.length === 0) {
      stats.skipped_no_phone += 1;
      continue;
    }

    const content = useVars ? applyMessageVars(opts.content, student) : opts.content;
    // 변수 모드에서도 한 학생 내 동일 번호는 1건만(intra-entry dedup).
    // 형제 간(inter-entry) dedup은 변수 모드에서 유지하지 않는다.
    for (const target of targets) {
      if (!useVars && seenPhones.has(target.phone)) {
        stats.deduped += 1;
        continue;
      }
      if (!useVars) seenPhones.add(target.phone);
      const queueDocs = buildSmsQueueDocs({
        studentId: id,
        phone: target.phone,
        campaignId: opts.campaignId,
        content,
        recipientRole: target.field,
        scheduledDate: opts.scheduledDate,
        imageId: opts.imageId,
      }, {
        splitLongMessage: opts.splitLongMessage,
        splitGroupId: `bulk:${opts.campaignId}:${id}:${target.field}`,
      });
      appendQueueDocs(docs, queueDocs, opts.maxQueueDocs);
      stats.queued += queueDocs.length;
      if (queueDocs.length > 1) stats.split_groups += 1;
    }
  }

  return { docs, stats };
}

export function alimtalkFallbackText(template, variables) {
  const lines = [applyTemplate(template.content, variables)];
  const webLinks = [
    ...(template.buttons ?? []).map((button) => ({ name: button.buttonName, type: button.buttonType, url: button.linkMo })),
    ...(template.quickReplies ?? []).map((reply) => ({ name: reply.name, type: reply.linkType, url: reply.linkMo })),
  ];
  for (const link of webLinks) {
    if (link.type === 'WL' && link.url && !/#\{[^}]+\}/.test(link.url)) {
      lines.push(`${link.name}: ${link.url}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

// studentNameAuto=false(직접 번호): 대상 이름을 알 수 없어 #{학생명}도 입력 변수로 요구한다.
export function validateAlimtalkVariables(template, input = {}, { studentNameAuto = true } = {}) {
  const expected = [...new Set((template.variables ?? [])
    .map((variable) => variable.name)
    .filter((name) => name && (!studentNameAuto || name !== '#{학생명}')))];
  const allowed = new Set(expected);
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new HttpsError('invalid-argument', `템플릿에 없는 변수입니다: ${key}`);
  }
  const variables = {};
  for (const key of expected) {
    const value = String(input?.[key] ?? '').trim();
    if (!value) throw new HttpsError('invalid-argument', `템플릿 변수 값을 입력하세요: ${key}`);
    if (value.length > 1000) throw new HttpsError('invalid-argument', `템플릿 변수 값이 너무 깁니다: ${key}`);
    variables[key] = value;
  }
  return variables;
}

// 템플릿에 #{학생명}이 있을 때만 대상 이름을 주입 — 없는 템플릿에 미지의 변수를 보내지 않는다.
function templateHasNameVariable(template) {
  return (template.variables ?? []).some((variable) => variable.name === '#{학생명}');
}

function alimtalkVariablesWithName(templateVariables, hasNameVariable, name) {
  return hasNameVariable
    ? { ...templateVariables, '#{학생명}': String(name ?? '') }
    : { ...templateVariables };
}

export function buildAlimtalkOrSplitSmsDocs({
  phone,
  template,
  variables,
  fallbackText,
  scheduledDate,
  splitLongMessage = false,
  splitGroupId = null,
  createdBy = null,
}) {
  const renderedText = applyTemplate(template.content, variables);
  const details = alimtalkLengthDetails(renderedText, fallbackText);
  if (!details.overLimit) {
    return [{
      kind: 'bulk_alimtalk',
      status: 'pending',
      recipient_phone: phone,
      template_code: template.templateId,
      template_variables: variables,
      fallback_text: fallbackText,
      scheduled_date: scheduledDate ?? null,
      attempt_count: 0,
      next_attempt_at: null,
    }];
  }
  if (!splitLongMessage) assertAlimtalkPayloadFits(renderedText, fallbackText);
  return buildSmsQueueDocs({
    kind: 'direct',
    phone,
    content: fallbackText,
    scheduledDate,
    createdBy,
  }, {
    splitLongMessage: true,
    splitGroupId,
  }).map((doc) => ({ ...doc, fallback_from_alimtalk: true }));
}

export function buildBulkAlimtalkRecipients(entries, opts) {
  const fields = Array.isArray(opts.recipientFields) && opts.recipientFields.length > 0
    ? opts.recipientFields
    : null;
  const hasNameVariable = templateHasNameVariable(opts.template);
  const stats = {
    total: entries.length,
    queued: 0,
    skipped_no_phone: 0,
    deduped: 0,
    split_groups: 0,
    converted_to_sms: 0,
  };
  const docs = [];
  const seenPhones = new Set();

  for (const { id, student } of entries) {
    const targets = fields
      ? resolveRecipientTargets(student, fields)
      : [resolveRecipientTarget(student, opts.recipientField)].filter(Boolean);
    if (fields) stats.deduped += resolveRecipientPhones(student, fields).length - targets.length;
    if (!targets.length) {
      stats.skipped_no_phone += 1;
      continue;
    }
    const variables = alimtalkVariablesWithName(opts.templateVariables, hasNameVariable, student.name);
    const fallbackText = alimtalkFallbackText(opts.template, variables);
    // 이름 변수가 없으면 전원 동일 내용 — SMS(buildBulkRecipients)와 같은 기준으로 번호 중복을 1건만 남긴다.
    for (const target of targets) {
      if (!hasNameVariable && seenPhones.has(target.phone)) {
        stats.deduped += 1;
        continue;
      }
      if (!hasNameVariable) seenPhones.add(target.phone);
      const queueDocs = buildAlimtalkOrSplitSmsDocs({
        phone: target.phone,
        template: opts.template,
        variables,
        fallbackText,
        scheduledDate: opts.scheduledDate,
        splitLongMessage: opts.splitLongMessage,
        splitGroupId: `bulk:${opts.campaignId}:${id}:${target.field}`,
      }).map((doc) => ({
        ...doc,
        student_id: id,
        recipient_role: target.field,
        campaign_id: opts.campaignId,
      }));
      appendQueueDocs(docs, queueDocs, opts.maxQueueDocs);
      stats.queued += queueDocs.length;
      if (queueDocs.length > 1) stats.split_groups += 1;
      if (queueDocs[0]?.fallback_from_alimtalk) stats.converted_to_sms += queueDocs.length;
    }
  }
  return { docs, stats };
}

// 재직 상태·유효 번호 게이트를 통과한 교직원 대상. dedupeByPhone이면 동일 번호를 1건만 남긴다.
function collectStaffTargets(entries, { dateKst, dedupeByPhone }, stats) {
  const targets = [];
  const seenPhones = new Set();
  for (const { id, staff } of entries) {
    if (!STAFF_STATUSES.has(effectiveStaffStatus(staff, dateKst))) {
      stats.skipped_status += 1;
      continue;
    }
    const phone = digitsOf(staff.phone);
    if (!isValidPhoneKR(phone)) {
      stats.skipped_no_phone += 1;
      continue;
    }
    if (dedupeByPhone && seenPhones.has(phone)) {
      stats.deduped += 1;
      continue;
    }
    seenPhones.add(phone);
    targets.push({ id, staff, phone });
  }
  return targets;
}

export function buildStaffAlimtalkRecipients(entries, opts) {
  const hasNameVariable = templateHasNameVariable(opts.template);
  const stats = {
    total: entries.length,
    queued: 0,
    skipped_no_phone: 0,
    skipped_status: 0,
    deduped: 0,
    split_groups: 0,
    converted_to_sms: 0,
  };
  const targets = collectStaffTargets(entries, {
    dateKst: opts.dateKst ?? todayKST(),
    dedupeByPhone: !hasNameVariable,
  }, stats);
  const docs = [];
  for (const { id, staff, phone } of targets) {
    const variables = alimtalkVariablesWithName(opts.templateVariables, hasNameVariable, staff.name);
    const queueDocs = buildAlimtalkOrSplitSmsDocs({
      phone,
      template: opts.template,
      variables,
      fallbackText: alimtalkFallbackText(opts.template, variables),
      scheduledDate: opts.scheduledDate,
      splitLongMessage: opts.splitLongMessage,
      splitGroupId: `bulk:${opts.campaignId}:${id}:staff`,
    }).map((doc) => ({
      ...doc,
      staff_id: id,
      recipient_type: 'staff',
      recipient_role: 'staff',
      campaign_id: opts.campaignId,
    }));
    if (queueDocs.length > 1) stats.split_groups += 1;
    if (queueDocs[0]?.fallback_from_alimtalk) stats.converted_to_sms += queueDocs.length;
    appendQueueDocs(docs, queueDocs, opts.maxQueueDocs);
  }
  stats.queued = docs.length;
  return { docs, stats };
}

export function buildStaffRecipients(entries, opts) {
  const stats = {
    total: entries.length,
    queued: 0,
    skipped_no_phone: 0,
    skipped_status: 0,
    deduped: 0,
    split_groups: 0,
  };
  const targets = collectStaffTargets(entries, {
    dateKst: opts.dateKst ?? todayKST(),
    dedupeByPhone: !opts.content.includes('%이름'),
  }, stats);
  const docs = [];
  for (const { id, staff, phone } of targets) {
    const queueDocs = buildSmsQueueDocs({
      phone,
      campaignId: opts.campaignId,
      content: opts.content.replaceAll('%이름', staff.name ?? ''),
      recipientRole: 'staff',
      scheduledDate: opts.scheduledDate,
      imageId: opts.imageId,
    }, {
      splitLongMessage: opts.splitLongMessage,
      splitGroupId: `bulk:${opts.campaignId}:${id}:staff`,
    }).map((doc) => ({
      ...doc,
      staff_id: id,
      recipient_type: 'staff',
    }));
    if (queueDocs.length > 1) stats.split_groups += 1;
    appendQueueDocs(docs, queueDocs, opts.maxQueueDocs);
  }
  stats.queued = docs.length;
  return { docs, stats };
}

export async function handleGetBulkStaffRecipients(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  await assertManagerOrAbove(request.auth, db);
  const dateKst = deps.todayKst ?? todayKST();
  const snapshot = await db.collection('staff').get();
  const recipients = snapshot.docs
    .map((doc) => {
      const staff = doc.data();
      return {
        id: doc.id,
        name: String(staff.name ?? '').trim(),
        status: effectiveStaffStatus(staff, dateKst),
        department: String(staff.department ?? '').trim(),
        affiliation: String(staff.affiliation ?? '').trim(),
        phoneAvailable: isValidPhoneKR(staff.phone),
      };
    })
    .filter((staff) => staff.name && STAFF_STATUSES.has(staff.status))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { recipients };
}

// 정보성 대용량 발송 — 직원 권한. 동의·야간·광고검증 없음. message_queue(kind='direct')로 enqueue.
export async function handleCreateBulkMessage(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const channel = String(data.channel ?? 'sms');
  if (!['sms', 'alimtalk'].includes(channel)) throw new HttpsError('invalid-argument', '지원하지 않는 발송 채널입니다.');
  let title = String(data.title ?? '').trim();
  let content = String(data.content ?? '').trim();
  const studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds.filter(Boolean))] : [];
  const staffIds = Array.isArray(data.staffIds) ? [...new Set(data.staffIds.filter(Boolean))] : [];
  if (studentIds.length && staffIds.length) throw new HttpsError('invalid-argument', '학생과 교직원은 함께 발송할 수 없습니다.');
  const audience = staffIds.length ? 'staff' : 'student';
  const targetIds = audience === 'staff' ? staffIds : studentIds;
  if (!targetIds.length) throw new HttpsError('invalid-argument', '발송 대상이 없습니다.');
  if (targetIds.length > MAX_RECIPIENTS) throw new HttpsError('invalid-argument', `한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);
  // 권한 게이트는 외부 API(솔라피 템플릿 조회) 호출보다 먼저.
  if (audience === 'staff') await assertManagerOrAbove(request.auth, db);
  let alimtalkTemplate = null;
  let alimtalkVariables = null;
  let alimtalkRecipientFields = null;
  if (channel === 'alimtalk') {
    if (data.mmsImage) throw new HttpsError('invalid-argument', '알림톡에는 MMS 이미지를 첨부할 수 없습니다.');
    const templateId = String(data.templateId ?? '').trim();
    if (!templateId) throw new HttpsError('invalid-argument', '알림톡 템플릿을 선택하세요.');
    alimtalkRecipientFields = Array.isArray(data.recipientFields) && data.recipientFields.length
      ? [...new Set(data.recipientFields)]
      : [data.recipientField || 'parent_1'];
    if (alimtalkRecipientFields.some((field) => !ALIMTALK_RECIPIENT_FIELDS.has(field))) {
      throw new HttpsError('invalid-argument', '알림톡 받는이는 학생·학부모 연락처만 지원합니다.');
    }
    alimtalkTemplate = await (deps.getAlimtalkTemplate ?? getApprovedAlimtalkTemplate)(templateId);
    alimtalkVariables = validateAlimtalkVariables(alimtalkTemplate, data.templateVariables);
    title = String(alimtalkTemplate.name ?? '').trim();
    content = String(alimtalkTemplate.content ?? '').trim();
  }
  if (!title) throw new HttpsError('invalid-argument', '제목이 필요합니다.');
  if (!content) throw new HttpsError('invalid-argument', '본문이 필요합니다.');
  if (audience === 'staff' && channel === 'sms'
    && ['%학교', '%학년', '%반'].some((token) => content.includes(token))) {
    throw new HttpsError('invalid-argument', '교직원 문자 변수는 %이름만 사용할 수 있습니다.');
  }

  // 정보성은 야간 보정 없음. 지정 시 형식만 검증(YYYY-MM-DD HH:mm:ss, KST).
  let scheduledDate = null;
  if (data.scheduledAt) {
    if (!parseKstToDate(data.scheduledAt)) throw new HttpsError('invalid-argument', '예약시각 형식이 올바르지 않습니다(YYYY-MM-DD HH:mm:ss, KST).');
    scheduledDate = String(data.scheduledAt);
  }

  const campaignRef = data.requestId
    ? db.collection('bulk_campaigns').doc(String(data.requestId))
    : db.collection('bulk_campaigns').doc();
  const fingerprint = recipientFingerprint(targetIds, {
    ...(data.splitLongMessage === true ? { splitLongMessage: true } : {}),
    ...(audience === 'staff'
      ? { audience: 'staff' }
      : {
        recipientField: channel === 'alimtalk' ? alimtalkRecipientFields[0] : (data.recipientField ?? null),
        recipientFields: channel === 'alimtalk'
          ? alimtalkRecipientFields
          : (Array.isArray(data.recipientFields) ? data.recipientFields : null),
      }),
    ...(scheduledDate ? { scheduledDate } : {}),
    ...(data.mmsImage ? { mmsImage: data.mmsImage } : {}),
    ...(channel === 'alimtalk' ? {
      channel,
      templateId: alimtalkTemplate.templateId,
      templateContent: alimtalkTemplate.content,
      templateVariables: alimtalkVariables,
      templateButtons: alimtalkTemplate.buttons ?? [],
    } : {}),
  });
  const legacyFingerprint = recipientFingerprint(targetIds, {
    ...(audience === 'staff'
      ? { audience: 'staff' }
      : {
        recipientField: channel === 'alimtalk' ? alimtalkRecipientFields[0] : (data.recipientField ?? null),
        recipientFields: channel === 'alimtalk'
          ? alimtalkRecipientFields
          : (Array.isArray(data.recipientFields) ? data.recipientFields : null),
      }),
    ...(channel === 'alimtalk' ? {
      channel,
      templateId: alimtalkTemplate.templateId,
      templateVariables: alimtalkVariables,
    } : {}),
  });
  const campaignSnapshot = await campaignRef.get();
  if (campaignSnapshot.exists) {
    const existing = campaignSnapshot.data();
    const acceptedLegacy = existing?.request_fingerprint_version === REQUEST_FINGERPRINT_VERSION
      ? []
      : [legacyFingerprint];
    if (existing?.content !== content
      || !campaignFingerprintMatches(existing?.request_fingerprint, fingerprint, acceptedLegacy)) {
      throw new HttpsError('failed-precondition', '재개 요청의 본문/대상이 원 캠페인과 다릅니다. 새 requestId로 발송하세요.');
    }
    if (existing?.status !== 'enqueuing') return { campaignId: campaignRef.id, duplicate: true, stats: existing?.stats ?? null, scheduledDate: existing?.scheduled_date ?? null };
  }
  let imageId = channel === 'sms' && data.mmsImage ? 'preflight' : null;

  const collectionName = audience === 'staff' ? 'staff' : 'students';
  const refs = targetIds.map((id) => db.collection(collectionName).doc(id));
  const snaps = await db.getAll(...refs);
  const entries = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, [audience]: s.data() }));

  const buildRecipients = channel === 'alimtalk'
    ? (audience === 'staff' ? buildStaffAlimtalkRecipients : buildBulkAlimtalkRecipients)
    : (audience === 'staff' ? buildStaffRecipients : buildBulkRecipients);
  const { docs, stats } = buildRecipients(entries, {
    campaignId: campaignRef.id,
    content,
    recipientField: channel === 'alimtalk' ? alimtalkRecipientFields[0] : data.recipientField,
    recipientFields: channel === 'alimtalk'
      ? alimtalkRecipientFields
      : (Array.isArray(data.recipientFields) ? data.recipientFields : undefined),
    scheduledDate,
    imageId,
    dateKst: deps.todayKst ?? todayKST(),
    template: alimtalkTemplate,
    templateVariables: alimtalkVariables,
    splitLongMessage: data.splitLongMessage === true,
    maxQueueDocs: MAX_RECIPIENTS,
  });
  stats.skipped_missing = targetIds.length - entries.length;
  if (data.mmsImage) {
    imageId = docs.length ? await resolveMmsImageId(data.mmsImage, deps.uploadMmsImage) : null;
    for (const doc of docs) doc.image_id = imageId;
  }

  // create로 원자적 선점 — 같은 requestId 동시 요청에서 정확히 하나만 큐에 등록.
  // 'enqueuing' 고착(이전 호출이 배치 도중 사망)이면 duplicate 단락 시 잔여 대상이 영영
  // 미발송되므로, lease 만료 시에만 트랜잭션 CAS(claimCampaignResume)로 잔여 재개 —
  // promoCampaignHandler와 동일 패턴. 지문에 recipientFields 포함 — 대상/수신필드가 바뀌면
  // phone dedup 귀속이 바뀌어 공유번호 중복 발송이 가능하므로 재개 거부.
  const now = deps.now ?? new Date();
  let resuming = false;
  try {
    await campaignRef.create({
      title, content, audience, targeting: 'I', kind: channel === 'alimtalk' ? 'bulk_alimtalk' : 'bulk_info', image_id: imageId,
      ...(channel === 'alimtalk' ? { template_code: alimtalkTemplate.templateId } : {}),
      scheduled_date: scheduledDate ?? null, status: 'enqueuing', stats,
      created_by: request.auth?.uid ?? null, created_at: FieldValue.serverTimestamp(),
      enqueue_started_at: now.getTime(),
      request_fingerprint: fingerprint,
      request_fingerprint_version: REQUEST_FINGERPRINT_VERSION,
    });
  } catch (e) {
    if (!(e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message)))) throw e;
    const claim = await claimCampaignResume(db, campaignRef, {
      now,
      content,
      fingerprint,
      legacyFingerprints: [legacyFingerprint],
      stats,
    });
    if (!claim.resumed) {
      const ex = claim.existing;
      return { campaignId: campaignRef.id, duplicate: true, stats: ex.stats ?? null, scheduledDate: ex.scheduled_date ?? null };
    }
    resuming = true;
  }

  // 재개 시 이미 enqueue된 수신 역할+분할 조각만 제외한다. 구버전 role 없는 큐는 학생 단위로 제외한다.
  let pendingDocs = docs;
  if (resuming) {
    const queuedSnap = await db.collection('message_queue').where('campaign_id', '==', campaignRef.id).get();
    const alreadyStudents = new Set();
    const alreadyTargets = new Set();
    const alreadyStaff = new Set();
    const alreadyUnsplitTargets = new Set();
    const alreadyUnsplitStaff = new Set();
    const splitStatuses = new Map();
    for (const doc of queuedSnap.docs) {
      const queued = doc.data();
      const part = queued.split_part_index ?? 0;
      if (queued.split_group_id && part) {
        splitStatuses.set(`${queued.split_group_id}:${part}`, queued.status);
      }
      if (queued.staff_id) {
        alreadyStaff.add(`${queued.staff_id}:${part}`);
        if (!part) alreadyUnsplitStaff.add(queued.staff_id);
      } else if (queued.recipient_role) {
        alreadyTargets.add(`${queued.student_id}:${queued.recipient_role}:${part}`);
        if (!part) alreadyUnsplitTargets.add(`${queued.student_id}:${queued.recipient_role}`);
      }
      else alreadyStudents.add(queued.student_id);
    }
    pendingDocs = audience === 'staff'
      ? docs.filter((d) => (
        !alreadyUnsplitStaff.has(d.staff_id)
        && !alreadyStaff.has(`${d.staff_id}:${d.split_part_index ?? 0}`)
      ))
      : docs.filter((d) => (
        !alreadyStudents.has(d.student_id)
        && !alreadyUnsplitTargets.has(`${d.student_id}:${d.recipient_role}`)
        && !alreadyTargets.has(`${d.student_id}:${d.recipient_role}:${d.split_part_index ?? 0}`)
      ));
    pendingDocs = pendingDocs.map((doc) => (
      doc.status === 'split_waiting'
      && SPLIT_UNLOCK_STATUSES.has(splitStatuses.get(`${doc.split_group_id}:${doc.split_part_index - 1}`))
        ? { ...doc, status: 'pending' }
        : doc
    ));
  }

  let batch = db.batch();
  let inBatch = 0;
  const groups = [];
  for (const doc of pendingDocs) {
    const previous = groups.at(-1);
    if (doc.split_group_id && previous?.[0].split_group_id === doc.split_group_id) previous.push(doc);
    else groups.push([doc]);
  }
  for (const group of groups) {
    if (inBatch > 0 && inBatch + group.length > BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
    for (const doc of group) {
      const qref = db.collection('message_queue').doc();
      batch.set(qref, { ...doc, created_at: FieldValue.serverTimestamp() });
      inBatch += 1;
    }
  }
  if (inBatch > 0) await batch.commit();

  await campaignRef.update({ status: scheduledDate ? 'scheduled' : 'queued' });
  return { campaignId: campaignRef.id, scheduledDate: scheduledDate ?? null, stats };
}
