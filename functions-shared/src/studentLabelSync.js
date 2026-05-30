import { studentFullLabel } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 라벨 필드(school_level_grade). 변경 없으면 null.
// school 미러 write는 중단 — school_* 필드가 SSoT.
export function computeLabelUpdate(data) {
  // 학부별 필드가 하나도 없으면 미마이그레이션 → skip(기존값 보존).
  const hasAnySchool = !!(data?.school_elementary || data?.school_middle || data?.school_high);
  if (!hasAnySchool) return null;
  const update = {};
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
