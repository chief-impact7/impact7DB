import { getFirestore } from 'firebase-admin/firestore';

// 광고 수신동의 2년 주기 재확인(정보통신망법 §50의8) — 골격.
// 동의일(message_consent.promo.at) 2년 경과 + 미통지(또는 마지막 통지 2년 경과) 동의자를 식별한다.
// 실제 재확인 통지 발송(알림톡/SMS)은 동의자가 쌓이고 수단이 확정되면 연결한다.
// 발송 구현 전까지는 대상 수만 집계해 모니터링한다(발송하지 않으므로 lastNotifiedAt도 기록하지 않음).

const RECONFIRM_INTERVAL_MS = 2 * 365 * 24 * 60 * 60 * 1000; // 2년

function toMs(ts) {
  if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return null;
}

// 2년 재확인 통지 대상인가: 동의·미철회 + 동의일 2년 경과 + (미통지거나 마지막 통지 2년 경과).
export function isReconfirmDue(promo, now) {
  if (!promo || promo.optedIn !== true || promo.revokedAt) return false;
  const atMs = toMs(promo.at);
  if (atMs == null || now.getTime() - atMs < RECONFIRM_INTERVAL_MS) return false;
  const lastMs = toMs(promo.lastNotifiedAt);
  if (lastMs != null && now.getTime() - lastMs < RECONFIRM_INTERVAL_MS) return false;
  return true;
}

export async function runPromoConsentReconfirm(deps = {}) {
  const db = deps.db ?? getFirestore();
  const now = deps.now ?? new Date();

  // 보호자(promo)·학생(promo_student) 동의를 각각 조회 — optedIn 동의자만 좁혀(단일 필드 인덱스),
  // 동의일/통지일 판정은 코드에서. 같은 학생이 양쪽 동의면 각각 별도 재확인 대상이다.
  let due = 0;
  const dueIds = [];
  for (const field of ['promo', 'promo_student']) {
    const snap = await db.collection('students').where(`message_consent.${field}.optedIn`, '==', true).get();
    for (const doc of snap.docs) {
      const consent = doc.data()?.message_consent?.[field];
      if (!isReconfirmDue(consent, now)) continue;
      // TODO(발송): 재확인 통지(알림톡/SMS) 발송 후 해당 필드에 lastNotifiedAt 기록.
      due += 1;
      if (dueIds.length < 50) dueIds.push(`${doc.id}:${field}`);
    }
  }
  if (due > 0) console.log(`[promoConsentReconfirm] 2년 재확인 통지 대상 ${due}건 (발송 미연결):`, dueIds);
  return { due, dueIds };
}
