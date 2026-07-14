import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { promoEligibility, getPromoConsent, consentTargetOf } from './promoConsent.js';
import { resolveAdScheduledAt, isAdNightKST, parseKstToDate } from './promoSchedule.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import { claimCampaignResume, recipientFingerprint } from './campaignResume.js';
import { buildSmsQueueDoc } from './smsQueueDoc.js';
import { resolveMmsImageId } from './mmsImage.js';

// 홍보 캠페인 생성 callable. 대상 학생을 동의/번호 게이트에 걸러
// message_queue(kind=promo_sms)에 배치 enqueue한다. 발송 자체는 워커(onMessageQueued)가 수행한다.
//
// 핵심 규칙:
//  - 광고이므로 야간(KST 20:50~08:00)이면 자동으로 익일 08:00 예약(scheduledDate)으로 보정.
//  - 광고 문자는 수신동의자(canReceivePromoSms)에게만 허용한다(정보통신망법).
//  - 정보성 출결 경로와 데이터·권한·동의를 섞지 않는다.

const MAX_RECIPIENTS = 1000; // 일일 한도 가드(솔라피 사업자 기본 1,000건)
const BATCH_LIMIT = 400; // Firestore 배치 쓰기 상한(500) 여유

export function buildPromoSmsQueueDoc({ studentId, phone, recipientRole, consent, campaignId, content, scheduledDate, imageId }) {
  return buildSmsQueueDoc({
    kind: 'promo_sms',
    campaignId,
    studentId,
    recipientRole,
    phone,
    content,
    scheduledDate,
    adFlag: true,
    consent,
    imageId,
  });
}

// 대상 학생 목록 → 큐 doc 목록 + 집계. 동의/번호/옵트아웃 게이트를 한 곳에서 적용(누락 없음).
// entries: [{ id, student }]
//  - 번호 없음 → 제외(skipped_no_phone)
//  - 옵트아웃(revoked) → 광고 전면 제외(skipped_revoked). 채널 도달 여부와 무관하게 거부 의사 존중.
//
// 광고 수신동의자만 kind='promo_sms'로 큐잉하고, 미동의자는 제외한다.
export function buildPromoRecipients(entries, opts) {
  const stats = {
    total: entries.length, queued: 0,
    skipped_no_phone: 0, skipped_revoked: 0, skipped_no_consent: 0,
    ad_sms: 0,
  };
  const docs = [];

  const fields = Array.isArray(opts.recipientFields) && opts.recipientFields.length
    ? opts.recipientFields
    : null;

  for (const { id, student } of entries) {
    const targets = fields
      ? resolveRecipientTargets(student, fields)
      : [resolveRecipientTarget(student, opts.recipientField)].filter(Boolean);
    if (!targets.length) { stats.skipped_no_phone += 1; continue; }

    for (const target of targets) {
      // 동의는 번호 주인 단위 — 학생 본인에게 보내는 캠페인은 학생 동의, 그 외는 보호자 동의로 판정.
      const consentTarget = consentTargetOf(target.field);
      const elig = promoEligibility(student, consentTarget);
      if (elig.reason === 'revoked') { stats.skipped_revoked += 1; continue; }

      if (!elig.smsFallbackAllowed) {
        stats.skipped_no_consent += 1;
        continue;
      }
      docs.push(buildPromoSmsQueueDoc({ studentId: id, phone: target.phone, recipientRole: target.field, consent: getPromoConsent(student, consentTarget), campaignId: opts.campaignId, content: opts.content, scheduledDate: opts.scheduledDate, imageId: opts.imageId }));
      stats.ad_sms += 1;
      stats.queued += 1;
    }
  }
  return { docs, stats };
}

// 광고 본문 규제 검증(정보통신망법 §50) — (광고) 표기 + 무료 수신거부 안내가 필수.
export function assertAdContentCompliant(content, targeting) {
  if (targeting === 'M' && (!/\(광고\)/.test(content) || !/(무료거부|수신거부|080)/.test(content))) {
    throw new HttpsError(
      'invalid-argument',
      '광고 메시지 본문에는 (광고) 표기와 무료 수신거부 안내(예: 무료거부 080-xxx-xxxx)가 포함되어야 합니다.',
    );
  }
}

// 예약시각 결정. 지정 시 형식 검증 후 야간(20:50~08:00)이면 익일 08:00로 강제 보정(야간 금지 우회 차단),
// 미지정 시 현재 시각이 야간일 때만 익일 08:00 자동 예약. null이면 즉시 발송.
export function resolvePromoScheduledDate(scheduledAt, now) {
  if (scheduledAt != null) {
    const at = parseKstToDate(scheduledAt);
    if (!at) throw new HttpsError('invalid-argument', '예약시각 형식이 올바르지 않습니다(YYYY-MM-DD HH:mm:ss, KST).');
    return isAdNightKST(at) ? resolveAdScheduledAt(at) : String(scheduledAt);
  }
  return resolveAdScheduledAt(now);
}

export async function handleCreatePromoCampaign(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  const now = deps.now ?? new Date();
  // 전 직원 발송 허용(2026-07-04 사용자 결정) — DSC 교사 개별 홍보 플로우 유지.
  // 원장 전용 격상 시 DSC UI role 게이팅 + 원장 HR_users 등록 확인이 선행돼야 한다.
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const title = String(data.title ?? '').trim();
  const content = String(data.content ?? '').trim();
  const studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds.filter(Boolean))] : [];
  if (!title) throw new HttpsError('invalid-argument', '캠페인 제목이 필요합니다.');
  if (!content) throw new HttpsError('invalid-argument', '본문이 필요합니다.');
  if (!studentIds.length) throw new HttpsError('invalid-argument', '발송 대상이 없습니다.');
  if (studentIds.length > MAX_RECIPIENTS) {
    throw new HttpsError('invalid-argument', `한 번에 최대 ${MAX_RECIPIENTS}명까지 발송할 수 있습니다.`);
  }

  const targeting = data.targeting === 'I' ? 'I' : 'M';
  // promo 캠페인은 targeting 값과 무관하게 광고 표기 강제(정보통신망법 §50).
  // targeting='I'로 호출해도 promo_sms(ad_flag:true) doc이 생성될 수 있으므로 항상 검증.
  assertAdContentCompliant(content, 'M');

  // 버튼 구조 최소 검증 — 형식 오류가 전 건 영구실패로 번지는 것 방지.
  const buttons = Array.isArray(data.buttons) && data.buttons.length ? data.buttons : null;
  if (buttons) {
    for (const b of buttons) {
      if (!b || typeof b.buttonType !== 'string' || typeof b.buttonName !== 'string') {
        throw new HttpsError('invalid-argument', '버튼 형식이 올바르지 않습니다(buttonType/buttonName 필요).');
      }
    }
  }
  const scheduledDate = resolvePromoScheduledDate(data.scheduledAt, now);
  const nightDeferred = data.scheduledAt == null && !!resolveAdScheduledAt(now);

  const campaignRef = data.requestId
    ? db.collection('promo_campaigns').doc(String(data.requestId))
    : db.collection('promo_campaigns').doc();
  const campaignSnapshot = await campaignRef.get();
  if (campaignSnapshot.exists) {
    const existing = campaignSnapshot.data();
    if (existing?.status !== 'enqueuing') return { campaignId: campaignRef.id, duplicate: true, stats: existing?.stats ?? null, scheduledDate: existing?.scheduled_date ?? null };
  }
  const imageId = data.mmsImage
    ? await resolveMmsImageId(data.mmsImage, deps.uploadMmsImage)
    : data.imageId ?? null;

  const refs = studentIds.map((id) => db.collection('students').doc(id));
  const snaps = await db.getAll(...refs);
  const entries = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, student: s.data() }));

  const { docs, stats } = buildPromoRecipients(entries, {
    campaignId: campaignRef.id,
    content,
    buttons,
    imageId,
    targeting,
    scheduledDate,
    recipientField: data.recipientField,
    recipientFields: Array.isArray(data.recipientFields) ? data.recipientFields : undefined,
    imageId,
  });
  stats.skipped_missing = studentIds.length - entries.length; // 존재하지 않는 학생 id

  // 멱등: create()로 원자 선점(bulkMessageHandler와 동일 관용구) — 같은 requestId 동시
  // 요청(더블클릭)에서 정확히 하나만 enqueue한다. 캠페인 doc을 먼저 'enqueuing'으로 기록해
  // 배치 도중 실패해도 이력·부분상태가 남는다.
  // 이미 존재하는 캠페인: 완료(queued/scheduled)면 duplicate 단락. 'enqueuing' 고착이면 이전
  // 호출이 배치 도중 죽었을 수 있으나 아직 진행 중일 수도 있으므로, lease 만료 시에만
  // 트랜잭션 CAS(claimCampaignResume)로 잔여 재개 — duplicate 단락으로 잔여 대상이 영영
  // 미발송되는 것과, 진행 중/동시 재개 호출과의 경쟁으로 중복 발송되는 것을 동시에 차단한다.
  const fingerprint = recipientFingerprint(studentIds, {
    recipientField: data.recipientField ?? null,
    recipientFields: Array.isArray(data.recipientFields) ? data.recipientFields : null,
  });
  let resuming = false;
  try {
    await campaignRef.create({
      title,
      content,
      targeting,
      message_type: imageId ? 'CTI' : 'CTA',
      image_id: imageId,
      buttons,
      scheduled_date: scheduledDate ?? null,
      status: 'enqueuing',
      stats,
      created_by: request.auth?.uid ?? null,
      created_at: FieldValue.serverTimestamp(),
      enqueue_started_at: now.getTime(),
      request_fingerprint: fingerprint,
    });
  } catch (e) {
    if (!(e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message)))) throw e;
    const claim = await claimCampaignResume(db, campaignRef, { now, content, fingerprint, stats });
    if (!claim.resumed) {
      const ex = claim.existing;
      return { campaignId: campaignRef.id, duplicate: true, stats: ex.stats ?? null, scheduledDate: ex.scheduled_date ?? null };
    }
    resuming = true;
  }

  // 재개 시 이미 enqueue된 수신자는 제외 — 구버전 role 없는 큐는 학생 단위로 보수적으로 제외.
  let pendingDocs = docs;
  if (resuming) {
    const queuedSnap = await db.collection('message_queue').where('campaign_id', '==', campaignRef.id).get();
    const alreadyStudents = new Set();
    const alreadyTargets = new Set();
    for (const doc of queuedSnap.docs) {
      const queued = doc.data();
      if (queued.recipient_role) alreadyTargets.add(`${queued.student_id}:${queued.recipient_role}`);
      else alreadyStudents.add(queued.student_id);
    }
    pendingDocs = docs.filter((d) => (
      !alreadyStudents.has(d.student_id)
      && !alreadyTargets.has(`${d.student_id}:${d.recipient_role}`)
    ));
  }

  // 큐 배치 enqueue (400건씩).
  let batch = db.batch();
  let inBatch = 0;
  for (const doc of pendingDocs) {
    const qref = db.collection('message_queue').doc();
    batch.set(qref, { ...doc, created_at: FieldValue.serverTimestamp() });
    if ((inBatch += 1) >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  // 재개 시 예약시각이 재계산됐을 수 있어(야간 보정) scheduled_date를 status와 함께 갱신 —
  // scheduled_date=null인데 status='scheduled'가 되는 필드 간 모순 차단.
  await campaignRef.update({ status: scheduledDate ? 'scheduled' : 'queued', scheduled_date: scheduledDate ?? null });

  return { campaignId: campaignRef.id, scheduledDate: scheduledDate ?? null, nightDeferred, stats };
}
