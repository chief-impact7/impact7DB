// 담임 자격과 보드용 안전 명부 미러 — HR staff의 PII를 노출하지 않고 필요한 필드만 공개한다.
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

export function staffDirectoryEntry(staff) {
  if (!MIRRORED_DEPARTMENTS.includes(staff?.department)) return null;
  return {
    display_name: String(staff.name || staff.englishName || staff.email || '').trim(),
    email: String(staff.email || '').trim().toLowerCase(),
    department: staff.department,
    assignable: effectiveStaffStatus(staff, todayKST()) === 'active',
  };
}

// 전량 재계산(멱등) — teachers·대상 staff 모두 수십 건이라 부분 갱신 대신 스윕.
// 한 transaction에서 현재 staff 정본을 읽고 미러 전체를 원자적으로 맞춘다.
export async function syncTeacherEligibility(db) {
  return db.runTransaction(async (transaction) => {
    const [staffSnap, teacherSnap, directorySnap] = await Promise.all([
      transaction.get(db.collection('staff').where('department', 'in', MIRRORED_DEPARTMENTS)),
      transaction.get(db.collection('teachers')),
      transaction.get(db.collection('staff_directory')),
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
      transaction.update(doc.ref, patch);
      updated++;
    }

    const existingDirectory = new Map(directorySnap.docs.map((d) => [d.id, d]));
    let directoryUpdated = 0;
    for (const doc of staffSnap.docs) {
      const entry = staffDirectoryEntry(doc.data());
      if (!entry) continue;
      existingDirectory.delete(doc.id);
      // 안전 4필드로 매번 덮어써 과거 버그가 추가한 필드도 조직 전체에 남지 않게 한다.
      transaction.set(db.collection('staff_directory').doc(doc.id), entry);
      directoryUpdated++;
    }
    for (const doc of existingDirectory.values()) {
      transaction.delete(doc.ref);
      directoryUpdated++;
    }

    return {
      teachers: teacherSnap.size,
      activeLocals: homeroomLocals.size,
      assignableLocals: assignableLocals.size,
      updated,
      directory: staffSnap.size,
      directoryUpdated,
    };
  });
}
