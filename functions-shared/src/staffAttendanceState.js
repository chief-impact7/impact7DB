// 직원 출퇴근 상태머신 — 순수 함수(부수효과 없음). 서버 검증·허용액션 계산의 단일 소스.
// 학생 attendanceState.js 패턴을 복제하되 체크리스트·하원게이트가 없어 더 단순하다.

export const STAFF_ACTIONS = {
  CLOCK_IN: '출근',
  OUT: '외출',
  RETURN: '복귀',
  CLOCK_OUT: '퇴근',
};

export const STAFF_DAY_STATES = {
  NONE: '미출근',
  IN: '근무중',
  OUT: '외출중',
  DONE: '퇴근',
};

// 유효 전이표. (현재상태 → 액션 → 다음상태)
const TRANSITIONS = {
  [STAFF_DAY_STATES.NONE]: { [STAFF_ACTIONS.CLOCK_IN]: STAFF_DAY_STATES.IN },
  [STAFF_DAY_STATES.IN]: { [STAFF_ACTIONS.OUT]: STAFF_DAY_STATES.OUT, [STAFF_ACTIONS.CLOCK_OUT]: STAFF_DAY_STATES.DONE },
  [STAFF_DAY_STATES.OUT]: { [STAFF_ACTIONS.RETURN]: STAFF_DAY_STATES.IN },
  [STAFF_DAY_STATES.DONE]: {},
};

export function nextStaffDayState(current, action) {
  const cur = current || STAFF_DAY_STATES.NONE;
  return TRANSITIONS[cur]?.[action] ?? null;
}

export function staffAllowedActions(dayState) {
  const cur = dayState || STAFF_DAY_STATES.NONE;
  if (cur === STAFF_DAY_STATES.IN) return [STAFF_ACTIONS.OUT, STAFF_ACTIONS.CLOCK_OUT];
  if (cur === STAFF_DAY_STATES.OUT) return [STAFF_ACTIONS.RETURN];
  if (cur === STAFF_DAY_STATES.DONE) return [];
  return [STAFF_ACTIONS.CLOCK_IN]; // NONE(미출근) 기본
}
