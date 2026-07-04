import { HttpsError } from 'firebase-functions/v2/https';

export const RESUME_LEASE_MS = 10 * 60 * 1000;

// 대상 구성 지문 — 재개 요청이 원 호출과 다른 대상/수신필드로 오면 phone dedup 귀속이 바뀌어
// 공유번호(형제) 수신자에게 중복 발송될 수 있으므로, content와 함께 대상 구성 동일성도 강제한다.
export function recipientFingerprint(studentIds, recipientKeys) {
  const src = [...studentIds].sort().join(',') + '|' + JSON.stringify(recipientKeys ?? null);
  let h = 5381;
  for (let i = 0; i < src.length; i += 1) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return `${studentIds.length}-${h.toString(16)}`;
}

// enqueuing 고착 캠페인 재개 클레임 — 트랜잭션 CAS라 동시 재개 요청 중 정확히 하나만 통과한다
// (plain get→update면 둘 다 lease 만료를 읽고 둘 다 잔여를 enqueue → 중복 발송).
// 반환: { resumed: true } | { resumed: false, existing }(완료/진행중 → 호출자가 duplicate 응답).
// content/지문 불일치는 failed-precondition — 한 캠페인에 다른 문구·대상이 섞이는 것 차단.
export async function claimCampaignResume(db, campaignRef, { now, content, fingerprint, stats }) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(campaignRef);
    const ex = (snap.exists ? snap.data() : null) ?? {};
    const leaseExpired = now.getTime() - (ex.enqueue_started_at ?? 0) >= RESUME_LEASE_MS;
    if (ex.status !== 'enqueuing' || !leaseExpired) return { resumed: false, existing: ex };
    if (ex.content !== content || (ex.request_fingerprint ?? null) !== (fingerprint ?? null)) {
      throw new HttpsError('failed-precondition', '재개 요청의 본문/대상이 원 캠페인과 다릅니다. 새 requestId로 발송하세요.');
    }
    tx.update(campaignRef, { stats, status: 'enqueuing', enqueue_started_at: now.getTime() });
    return { resumed: true };
  });
}
