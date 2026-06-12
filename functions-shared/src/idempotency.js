import { getFirestore } from 'firebase-admin/firestore';

// 멱등키를 지정 컬렉션에 기록. 이미 처리됐으면 false(중복), 신규면 true.
// 결제(paymentHook)는 기본 payment_records, 메시지 경로는 호출 시 컬렉션을 넘긴다.
export async function claimIdempotencyKey(key, collection = 'payment_records') {
  const db = getFirestore();
  const ref = db.collection(collection).doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { claimed_at: new Date(), status: 'pending' });
    return true;
  });
}
