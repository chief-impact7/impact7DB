// 담임 자격 미러 — HR 직원현황(staff)의 "교수부 재직" 여부를 teachers.homeroom_eligible로 유지한다.
// DSC 담임 선택 UI는 staff(PII — director/manager 전용 읽기)를 못 읽으므로 이 필드가 필터 기준.
// 규약: @impact7/shared teacher-label (isActiveTeacher, 영어이름 첫 토큰 ↔ 이메일 로컬파트 매칭).
import { isActiveTeacher, teacherDisplayName } from '@impact7/shared/teacher-label';

// staff 문서들 → 재직 교수의 영어이름 첫 토큰(소문자) 집합
export function activeTeacherLocals(staffDocs) {
  const locals = new Set();
  for (const s of staffDocs) {
    if (!isActiveTeacher(s)) continue;
    const local = teacherDisplayName(s.englishName).toLowerCase();
    if (local) locals.add(local);
  }
  return locals;
}

export function isEligibleEmail(email, locals) {
  return locals.has(String(email || '').split('@')[0].toLowerCase());
}

// 전량 재계산(멱등) — teachers·교수 staff 모두 수십 건이라 부분 갱신 대신 스윕.
// 값이 같으면 쓰지 않아 teachers 쓰기 트리거와의 루프가 생기지 않는다.
export async function syncTeacherEligibility(db) {
  const [staffSnap, teacherSnap] = await Promise.all([
    db.collection('staff').where('department', '==', '교수').get(),
    db.collection('teachers').get(),
  ]);
  const locals = activeTeacherLocals(staffSnap.docs.map((d) => d.data()));
  let updated = 0;
  for (const doc of teacherSnap.docs) {
    const eligible = isEligibleEmail(doc.id, locals);
    if (doc.data().homeroom_eligible === eligible) continue;
    await doc.ref.update({ homeroom_eligible: eligible });
    updated++;
  }
  return { teachers: teacherSnap.size, activeLocals: locals.size, updated };
}
