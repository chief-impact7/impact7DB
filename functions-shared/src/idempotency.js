import { getFirestore } from 'firebase-admin/firestore';

// 멱등키를 payment_records에 기록. 이미 처리됐으면 false(중복), 신규면 true.
// 실제 결제 검증 로직은 나중에 paymentHook에서 이 함수를 호출한다.
export async function claimIdempotencyKey(key) {
  const db = getFirestore();
  const ref = db.collection('payment_records').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { claimed_at: new Date(), status: 'pending' });
    return true;
  });
}
