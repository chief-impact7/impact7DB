import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { promoEligibility, getPromoConsent } from './promoConsent.js';
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

// 대상 학생 목록 → 큐 doc 목록 + 집계. 동의/번호/옵트아웃 게이트를 한 곳에서 적용(누락 없음).
// entries: [{ id, student }]
//  - 번호 없음 → 제외(skipped_no_phone)
//  - 옵트아웃(revoked) → 광고 전면 제외(skipped_revoked). 채널 도달 여부와 무관하게 거부 의사 존중.
//  - 미동의(no_consent) → BMS는 발송(채널 친구 근거), SMS 대체만 차단(disable_sms=true).
export function buildPromoRecipients(entries, opts) {
  const stats = { total: entries.length, queued: 0, skipped_no_phone: 0, skipped_revoked: 0, sms_allowed: 0 };
  const docs = [];
  for (const { id, student } of entries) {
    const phone = resolveRecipientPhone(student, opts.recipientField);
    if (!phone) {
      stats.skipped_no_phone += 1;
      continue;
    }
    const elig = promoEligibility(student);
    if (elig.reason === 'revoked') {
      stats.skipped_revoked += 1; // 옵트아웃 → 광고 자체에서 영구 제외
      continue;
    }
    if (elig.smsFallbackAllowed) stats.sms_allowed += 1;
    docs.push(buildPromoQueueDoc({
      studentId: id,
      phone,
      smsAllowed: elig.smsFallbackAllowed,
      consent: getPromoConsent(student),
      ...opts,
    }));
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
  assertAdContentCompliant(content, targeting);

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

  // 멱등: requestId 지정 시 같은 id로 캠페인 doc 선점 — 더블클릭/재시도 중복 발송 방지.
  const campaignRef = data.requestId
    ? db.collection('promo_campaigns').doc(String(data.requestId))
    : db.collection('promo_campaigns').doc();
  if (data.requestId) {
    const existing = await campaignRef.get();
    if (existing.exists) {
      const ex = existing.data() ?? {};
      return { campaignId: campaignRef.id, duplicate: true, stats: ex.stats ?? null, scheduledDate: ex.scheduled_date ?? null };
    }
  }

  const refs = studentIds.map((id) => db.collection('students').doc(id));
  const snaps = await db.getAll(...refs);
  const entries = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, student: s.data() }));

  const { docs, stats } = buildPromoRecipients(entries, { campaignId: campaignRef.id, content, buttons, imageId, targeting, scheduledDate, recipientField: data.recipientField });
  stats.skipped_missing = studentIds.length - entries.length; // 존재하지 않는 학생 id

  // 캠페인 doc을 먼저 'enqueuing'으로 기록 → 배치 도중 실패해도 이력·부분상태가 남아 추적 가능.
  await campaignRef.set({
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
  });

  // 큐 배치 enqueue (400건씩).
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

  return { campaignId: campaignRef.id, scheduledDate: scheduledDate ?? null, nightDeferred, stats };
}
