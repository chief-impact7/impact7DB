import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertManagerOrAbove } from './authGuards.js';

// 근태 레코드 보정 — staff_attendance는 write:false(서버전용)이므로 보정도 callable 경유만 가능.
// manager+가 출근/퇴근 시각을 교정하고 메모를 단다. 보정 사실은 edited/editedBy/editedAt로 감사된다.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIso(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

export async function handleEditStaffAttendance(request, deps = {}) {
  const db = deps.firestore || getFirestore();
  await assertManagerOrAbove(request.auth, db);

  const data = request.data ?? {};
  const date = String(data.date ?? '').trim();
  const staffId = String(data.staffId ?? '').trim();
  if (!DATE_RE.test(date)) throw new HttpsError('invalid-argument', 'date(YYYY-MM-DD)가 필요합니다.');
  if (!staffId) throw new HttpsError('invalid-argument', 'staffId가 필요합니다.');

  // 제공된 필드만 갱신. null은 "지움"(merge로 null 기록). ISO 형식은 서버에서 재검증한다.
  const update = {};
  if (data.arriveAt !== undefined) {
    if (data.arriveAt !== null && !isValidIso(data.arriveAt)) {
      throw new HttpsError('invalid-argument', 'arriveAt는 유효한 ISO 문자열이거나 null이어야 합니다.');
    }
    update.arriveAt = data.arriveAt;
  }
  if (data.departAt !== undefined) {
    if (data.departAt !== null && !isValidIso(data.departAt)) {
      throw new HttpsError('invalid-argument', 'departAt는 유효한 ISO 문자열이거나 null이어야 합니다.');
    }
    update.departAt = data.departAt;
  }
  if (data.memo !== undefined) {
    if (typeof data.memo !== 'string') {
      throw new HttpsError('invalid-argument', 'memo는 문자열이어야 합니다.');
    }
    update.memo = data.memo;
  }

  const ref = db.collection('staff_attendance').doc(`${date}_${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '근태 레코드를 찾을 수 없습니다.');

  update.edited = true;
  update.editedBy = request.auth.uid;
  update.editedAt = FieldValue.serverTimestamp();

  await ref.set(update, { merge: true });
  return { ok: true };
}
