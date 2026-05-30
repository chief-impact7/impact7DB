import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(school 미러 + school_level_grade). 변경 없으면 null.
export function computeLabelUpdate(data) {
  // 학부별 필드가 하나도 없으면 미마이그레이션 → skip(기존값 보존).
  const hasAnySchool = !!(data?.school_elementary || data?.school_middle || data?.school_high);
  if (!hasAnySchool) return null;
  const update = {};
  const mirror = currentSchool(data);
  if (data?.school !== mirror) update.school = mirror;
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
