// 수신 대상 번호 선택 — 메시지 발송 경로(출결/정보성/홍보) 공통.
// 대상: 학생 본인 / 학부모1 / 학부모2 / 기타. 명시 없으면 학부모1 → 학부모2 폴백(기존 정책).

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

export const RECIPIENT_FIELDS = {
  student: 'student_phone',
  parent_1: 'parent_phone_1',
  parent_2: 'parent_phone_2',
  other: 'other_phone',
};

// field 지정 시 해당 번호(있으면). 미지정이거나 그 필드가 비어 있으면 parent_1 → parent_2 폴백.
export function resolveRecipientPhone(student, field) {
  if (field && RECIPIENT_FIELDS[field]) {
    const d = onlyDigits(student?.[RECIPIENT_FIELDS[field]]);
    if (d) return d;
  }
  for (const f of ['parent_phone_1', 'parent_phone_2']) {
    const d = onlyDigits(student?.[f]);
    if (d) return d;
  }
  return '';
}
