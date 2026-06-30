import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertDirector } from './authGuards.js';

// 직원 삭제 cascade — staff_attendance는 write:false(서버전용)라 클라가 못 지운다.
// impact7HR UI가 직원을 삭제할 때 호출해 해당 staffId의 근태 레코드를 함께 정리한다.
// (staff 문서·하위컬렉션은 클라가 rules 권한으로 직접 삭제한다.)

const BATCH_LIMIT = 500;

export async function handleDeleteStaffAttendance(request, deps = {}) {
  const db = deps.firestore || getFirestore();
  await assertDirector(request.auth, db);

  const staffId = String(request.data?.staffId ?? '').trim();
  if (!staffId) throw new HttpsError('invalid-argument', 'staffId가 필요합니다.');

  const snap = await db.collection('staff_attendance').where('staffId', '==', staffId).get();

  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + BATCH_LIMIT)) batch.delete(d.ref);
    await batch.commit();
    deleted += Math.min(BATCH_LIMIT, snap.docs.length - i);
  }

  return { ok: true, deleted };
}
