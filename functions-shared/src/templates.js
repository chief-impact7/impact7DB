import { formatDateTimeKST } from '@impact7/shared/datetime';

// 브랜드 prefix는 여기 한 곳에서만 정의한다(checkinHandler 등 호출부 인라인 금지).
const BRAND_PREFIX = '[임팩트세븐학원]';

// 알림톡 템플릿 변수 키. 승인 대기 템플릿 문안 기준(학생명/일시/출결상태).
// 호출자가 keys로 덮어써서 실제 승인 템플릿의 변수명에 맞춘다.
export const DEFAULT_VARIABLE_KEYS = {
  studentName: '#{학생명}',
  dateTime: '#{일시}',
  status: '#{출결상태}',
};

// 알림톡 실패 시 솔라피 내장 대체발송(SMS/LMS)으로 나갈 기본 본문.
// 실제 운영 문구는 호출자가 template 옵션으로 주입한다.
const DEFAULT_FALLBACK_TEMPLATE =
  `${BRAND_PREFIX} #{학생명} 학생이 #{일시} #{출결상태} 처리되었습니다.`;

// "#{...}" 토큰을 variables 값으로 치환. 정의되지 않은 토큰은 빈 문자열.
export function applyTemplate(templateText, variables = {}) {
  if (typeof templateText !== 'string') return '';
  return templateText.replace(/#\{[^}]+\}/g, (token) =>
    Object.prototype.hasOwnProperty.call(variables, token)
      ? String(variables[token] ?? '')
      : '',
  );
}

// 출결 알림 1건의 솔라피 알림톡 변수 맵 생성.
export function buildAttendanceVariables(
  { student, studentName, status, occurredAt },
  { keys = DEFAULT_VARIABLE_KEYS } = {},
) {
  return {
    [keys.studentName]: resolveStudentName({ student, studentName }),
    [keys.dateTime]: formatDateTimeKST(occurredAt),
    [keys.status]: String(status ?? ''),
  };
}

// 알림톡 실패 시 대체발송 본문 생성.
export function buildAttendanceFallbackText(
  { student, studentName, status, occurredAt },
  { template = DEFAULT_FALLBACK_TEMPLATE, keys = DEFAULT_VARIABLE_KEYS } = {},
) {
  const vars = buildAttendanceVariables({ student, studentName, status, occurredAt }, { keys });
  return applyTemplate(template, vars);
}

// 큐 doc에 넣을 발송 페이로드(템플릿코드 + 변수맵 + 대체문구)를 한 번에 생성.
// templateCode는 승인 전이라 호출자가 설정값으로 주입(없으면 null).
export function buildAttendanceMessage(
  { student, studentName, status, occurredAt, templateCode },
  options = {},
) {
  return {
    templateCode: templateCode ?? null,
    templateVariables: buildAttendanceVariables(
      { student, studentName, status, occurredAt },
      options,
    ),
    fallbackText: buildAttendanceFallbackText(
      { student, studentName, status, occurredAt },
      options,
    ),
  };
}

function resolveStudentName({ student, studentName }) {
  if (studentName) return String(studentName);
  if (student?.name) return String(student.name);
  return '';
}
