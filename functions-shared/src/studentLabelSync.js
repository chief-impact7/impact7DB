import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(school 미러 + school_level_grade). 변경 없으면 null.
export function computeLabelUpdate(data) {
  const mirror = currentSchool(data);
  // 가드: 현재 학부 학교가 비어있으면(미마이그레이션/미입력) 동기화 skip.
  // 마이그레이션 전 학부별 필드가 없는 기존 학생의 school_level_grade를 "중1"로 파괴하는 것 방지.
  if (!mirror) return null;
  const update = {};
  if (data?.school !== mirror) update.school = mirror;
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
