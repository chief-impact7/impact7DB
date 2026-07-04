import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { promoEligibility, getPromoConsent, consentTargetOf } from './promoConsent.js';
import { resolveAdScheduledAt, isAdNightKST, parseKstToDate } from './promoSchedule.js';
import { resolveRecipientPhone } from './recipientPhone.js';

// 홍보(브랜드 메시지) 캠페인 생성 callable. 원장 권한으로 대상 학생을 동의/번호 게이트에 걸러
// message_queue(kind=promo)에 배치 enqueue한다. 발송 자체는 워커(onMessageQueued)가 수행한다.
//
// 핵심 규칙(설계 friendtalk-promo-design):
//  - 광고이므로 야간(KST 20:50~08:00)이면 자동으로 익일 08:00 예약(scheduledDate)으로 보정.
//  - 친구톡/BMS 도달은 채널 친구 여부로 결정(우리가 막지 않음). SMS 대체발송(disable_sms=false)은
//    광고 수신동의자(canReceivePromoSms)에게만 허용한다(정보통신망법).
//  - 정보성 출결 경로와 데이터·권한·동의를 섞지 않는다.

const MAX_RECIPIENTS = 1000; // 일일 한도 가드(솔라피 사업자 기본 1,000건)
const BATCH_LIMIT = 400; // Firestore 배치 쓰기 상한(500) 여유

// kakao_channel_friends 컬렉션 전체를 Set으로 로드 — 대상별 개별 await 없이 메모리 분기.
async function defaultLoadFriendPhones(db) {
  const snap = await db.collection('kakao_channel_friends').get();
  return new Set(snap.docs.map((d) => d.id));
}

// 학생 1명 → promo 큐 doc(타임스탬프 제외 순수 형태). 호출자가 created_at을 덧붙인다.
export function buildPromoQueueDoc({ studentId, phone, smsAllowed, consent, campaignId, content, buttons, imageId, targeting, scheduledDate }) {
  const tg = targeting === 'I' ? 'I' : 'M';
  return {
    kind: 'promo',
    campaign_id: campaignId,
    student_id: studentId,
    recipient_phone: phone,
    content,
    buttons: buttons ?? null,
    image_id: imageId ?? null,
    ad_flag: tg === 'M', // 마케팅이면 광고 표기
    disable_sms: !smsAllowed, // 미동의 → BMS만(친구 아니면 발송 종료)
    targeting: tg,
    scheduled_date: scheduledDate ?? null,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    // 발송 시점 동의 근거 보존(분쟁 시 입증용) — boolean뿐 아니라 출처·시각도 스냅샷.
    consent_snapshot: { sms: !!smsAllowed, source: consent?.source ?? null, at: consent?.at ?? null },
  };
}

// 비친구 광고동의자에게 보내는 광고 SMS 큐 doc (promo_sms). 발송은 queueWorker가 sendSms로 라우팅.
function buildPromoSmsQueueDoc({ studentId, phone, consent, campaignId, content, scheduledDate }) {
  return {
    kind: 'promo_sms',
    campaign_id: campaignId,
    student_id: studentId,
    recipient_phone: phone,
    content,
    ad_flag: true, // 광고 SMS는 항상 광고
    scheduled_date: scheduledDate ?? null,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    consent_snapshot: { sms: true, source: consent?.source ?? null, at: consent?.at ?? null },
  };
}

// 대상 학생 목록 → 큐 doc 목록 + 집계. 동의/번호/옵트아웃 게이트를 한 곳에서 적용(누락 없음).
// entries: [{ id, student }]
//  - 번호 없음 → 제외(skipped_no_phone)
//  - 옵트아웃(revoked) → 광고 전면 제외(skipped_revoked). 채널 도달 여부와 무관하게 거부 의사 존중.
//
// opts.friendPhones(Set) 제공 시 채널 친구 여부로 분기:
//  - 친구 → kind='promo'(BMS, 기존 그대로)
//  - 비친구 + 동의 → kind='promo_sms'(광고 SMS 직접 발송)
//  - 비친구 + 미동의 → 제외(skipped_no_consent)
// opts.friendPhones 미제공 시 하위호환: 전원 BMS 경로(미동의자는 disable_sms=true로 SMS 차단만).
export function buildPromoRecipients(entries, opts) {
  const hasFriendSet = opts.friendPhones instanceof Set;
  const stats = {
    total: entries.length, queued: 0,
    skipped_no_phone: 0, skipped_revoked: 0, skipped_no_consent: 0,
    sms_allowed: 0, friend_bms: 0, ad_sms: 0,
  };
  const docs = [];

  // 동의는 번호 주인 단위 — 학생 본인에게 보내는 캠페인은 학생 동의, 그 외는 보호자 동의로 판정.
  const consentTarget = consentTargetOf(opts.recipientField);

  for (const { id, student } of entries) {
    const phone = resolveRecipientPhone(student, opts.recipientField);
    if (!phone) { stats.skipped_no_phone += 1; continue; }

    const elig = promoEligibility(student, consentTarget);
    if (elig.reason === 'revoked') { stats.skipped_revoked += 1; continue; }

    if (hasFriendSet) {
      if (opts.friendPhones.has(phone)) {
        if (elig.smsFallbackAllowed) stats.sms_allowed += 1;
        docs.push(buildPromoQueueDoc({ studentId: id, phone, smsAllowed: elig.smsFallbackAllowed, consent: getPromoConsent(student, consentTarget), ...opts }));
        stats.friend_bms += 1;
      } else if (elig.smsFallbackAllowed) {
        docs.push(buildPromoSmsQueueDoc({ studentId: id, phone, consent: getPromoConsent(student, consentTarget), campaignId: opts.campaignId, content: opts.content, scheduledDate: opts.scheduledDate }));
        stats.ad_sms += 1;
      } else {
        stats.skipped_no_consent += 1;
        continue;
      }
    } else {
      // 하위호환: friendPhones 없으면 전원 BMS 경로
      if (elig.smsFallbackAllowed) stats.sms_allowed += 1;
      docs.push(buildPromoQueueDoc({ studentId: id, phone, smsAllowed: elig.smsFallbackAllowed, consent: getPromoConsent(student, consentTarget), ...opts }));
    }
    stats.queued += 1;
  }
  return { docs, stats };
}

// 광고 본문 규제 검증(정보통신망법 §50) — 광고는 (광고) 표기 + 무료 수신거부 안내가 필수.
// BMS는 adFlag로 카카오가 자동 표기하지만 SMS 대체 본문(=content)엔 강제 주입이 없어 서버에서 검증.
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
  const imageId = data.imageId ?? null;

  const scheduledDate = resolvePromoScheduledDate(data.scheduledAt, now);
  const nightDeferred = data.scheduledAt == null && !!resolveAdScheduledAt(now);

  const campaignRef = data.requestId
    ? db.collection('promo_campaigns').doc(String(data.requestId))
    : db.collection('promo_campaigns').doc();

  const refs = studentIds.map((id) => db.collection('students').doc(id));
  const loadFriendPhones = deps.loadFriendPhones ?? defaultLoadFriendPhones;
  const [snaps, friendPhones] = await Promise.all([db.getAll(...refs), loadFriendPhones(db)]);
  const entries = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, student: s.data() }));

  const { docs, stats } = buildPromoRecipients(entries, { campaignId: campaignRef.id, content, buttons, imageId, targeting, scheduledDate, recipientField: data.recipientField, friendPhones });
  stats.skipped_missing = studentIds.length - entries.length; // 존재하지 않는 학생 id

  // 멱등: create()로 원자 선점(bulkMessageHandler와 동일 관용구) — 같은 requestId 동시
  // 요청(더블클릭)에서 정확히 하나만 enqueue한다. 캠페인 doc을 먼저 'enqueuing'으로 기록해
  // 배치 도중 실패해도 이력·부분상태가 남는다.
  // 이미 존재하는 캠페인: 완료(queued/scheduled)면 duplicate 단락. 'enqueuing' 고착이면 이전
  // 호출이 배치 도중 죽었을 수 있으나 아직 진행 중일 수도 있으므로, enqueue_started_at이
  // RESUME_LEASE_MS 이상 지난 경우에만 잔여 재개 — duplicate 단락으로 잔여 대상이 영영
  // 미발송되는 것과, 진행 중 호출과의 경쟁으로 중복 발송되는 것을 동시에 차단한다.
  const RESUME_LEASE_MS = 10 * 60 * 1000;
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
    });
  } catch (e) {
    if (!(e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message)))) throw e;
    const ex = (await campaignRef.get()).data() ?? {};
    const leaseExpired = now.getTime() - (ex.enqueue_started_at ?? 0) >= RESUME_LEASE_MS;
    if (ex.status !== 'enqueuing' || !leaseExpired) {
      return { campaignId: campaignRef.id, duplicate: true, stats: ex.stats ?? null, scheduledDate: ex.scheduled_date ?? null };
    }
    // 재개는 동일 본문 요청만 허용 — 한 캠페인 안에서 수신자별로 다른 문구가 섞이는 것 차단.
    if (ex.content !== content) {
      throw new HttpsError('failed-precondition', '재개 요청의 본문이 원 캠페인과 다릅니다. 새 requestId로 발송하세요.');
    }
    resuming = true;
    await campaignRef.update({ stats, status: 'enqueuing', enqueue_started_at: now.getTime() });
  }

  // 재개 시 이미 enqueue된 학생은 제외 — 같은 학생에게 2건 쌓이는 중복 발송 차단.
  let pendingDocs = docs;
  if (resuming) {
    const queuedSnap = await db.collection('message_queue').where('campaign_id', '==', campaignRef.id).get();
    const already = new Set(queuedSnap.docs.map((d) => d.data().student_id));
    pendingDocs = docs.filter((d) => !already.has(d.student_id));
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
