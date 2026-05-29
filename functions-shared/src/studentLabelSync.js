import { studentFullLabel } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(또는 변경 없으면 null).
export function computeLabelUpdate(data) {
  const label = studentFullLabel(data);
  if (data.school_level_grade === label) return null;
  return { school_level_grade: label };
}
