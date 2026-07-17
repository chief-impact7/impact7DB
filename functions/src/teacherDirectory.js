// 담임·보드 담당자 자격 미러 — HR 직원현황(staff)의 재직 여부를 teachers 필드로 유지한다.
// DSC 담임 선택 UI·보드 담당자 목록은 staff(PII — director/manager 전용 읽기)를 못 읽으므로
// 이 필드들이 필터 기준: homeroom_eligible(교수부 재직), board_assignable(교수·행정부 재직).
// 규약: @impact7/shared teacher-label (isActiveTeacher, 영어이름 첫 토큰 ↔ 이메일 로컬파트 매칭).
import { isActiveTeacher, teacherDisplayName } from '@impact7/shared/teacher-label';
import { effectiveStaffStatus } from '@impact7/shared/staff-status';
import { todayKST } from '@impact7/shared/datetime';

// 미러 대상 부서 — 보드 담당자는 교수+행정(단기 제외).
export const MIRRORED_DEPARTMENTS = ['교수', '행정'];

function localOf(staff) {
  return teacherDisplayName(staff.englishName).toLowerCase();
}

// staff 문서들 → 재직 교수의 영어이름 첫 토큰(소문자) 집합. 재직은 파생 판정(staff-status).
export function activeTeacherLocals(staffDocs) {
  const locals = new Set();
  const today = todayKST();
  for (const s of staffDocs) {
    if (!isActiveTeacher(s, today)) continue;
    const local = localOf(s);
    if (local) locals.add(local);
  }
  return locals;
}

// staff 문서들 → 재직 교수·행정의 영어이름 첫 토큰(소문자) 집합 (보드 담당자 자격).
export function assignableStaffLocals(staffDocs) {
  const locals = new Set();
  const today = todayKST();
  for (const s of staffDocs) {
    if (!MIRRORED_DEPARTMENTS.includes(s?.department)) continue;
    if (effectiveStaffStatus(s, today) !== 'active') continue;
    const local = localOf(s);
    if (local) locals.add(local);
  }
  return locals;
}

export function isEligibleEmail(email, locals) {
  return locals.has(String(email || '').split('@')[0].toLowerCase());
}

// 전량 재계산(멱등) — teachers·대상 staff 모두 수십 건이라 부분 갱신 대신 스윕.
// 값이 같으면 쓰지 않아 teachers 쓰기 트리거와의 루프가 생기지 않는다.
export async function syncTeacherEligibility(db) {
  const [staffSnap, teacherSnap] = await Promise.all([
    db.collection('staff').where('department', 'in', MIRRORED_DEPARTMENTS).get(),
    db.collection('teachers').get(),
  ]);
  const staffDocs = staffSnap.docs.map((d) => d.data());
  const homeroomLocals = activeTeacherLocals(staffDocs);
  const assignableLocals = assignableStaffLocals(staffDocs);
  let updated = 0;
  for (const doc of teacherSnap.docs) {
    const patch = {
      homeroom_eligible: isEligibleEmail(doc.id, homeroomLocals),
      board_assignable: isEligibleEmail(doc.id, assignableLocals),
    };
    const data = doc.data();
    if (data.homeroom_eligible === patch.homeroom_eligible && data.board_assignable === patch.board_assignable) continue;
    await doc.ref.update(patch);
    updated++;
  }
  return { teachers: teacherSnap.size, activeLocals: homeroomLocals.size, assignableLocals: assignableLocals.size, updated };
}
