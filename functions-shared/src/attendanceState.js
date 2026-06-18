// 태블릿 출결 상태머신 — 순수 함수(부수효과 없음). 서버 검증과 허용액션 계산의 단일 소스.
// 대상 학생: 재원/실휴원/가휴원 (등원예정 제외 — isEnrollableStatus보다 좁다).
export const TABLET_ELIGIBLE_STATUSES = new Set(['재원', '실휴원', '가휴원']);
export function isTabletEligibleStatus(status) {
  return TABLET_ELIGIBLE_STATUSES.has(status);
}

export const ACTIONS = { ARRIVE: '등원', OUT: '외출', RETURN: '복귀', DEPART: '하원' };
export const DAY_STATES = { NONE: '미등원', IN: '원내', OUT: '외출중', GONE: '하원' };

// 유효 전이표. (현재상태 → 액션 → 다음상태)
const TRANSITIONS = {
  [DAY_STATES.NONE]: { [ACTIONS.ARRIVE]: DAY_STATES.IN },
  [DAY_STATES.IN]: { [ACTIONS.OUT]: DAY_STATES.OUT, [ACTIONS.DEPART]: DAY_STATES.GONE },
  [DAY_STATES.OUT]: { [ACTIONS.RETURN]: DAY_STATES.IN },
  [DAY_STATES.GONE]: {},
};

export function nextDayState(current, action) {
  const cur = current || DAY_STATES.NONE;
  return TRANSITIONS[cur]?.[action] ?? null;
}

// 하원 게이트: 체크리스트 완료면 항상 가능, 미완료면 allow 정책에서만 가능.
export function canDepart(checklistComplete, departurePolicy) {
  if (checklistComplete) return true;
  return departurePolicy === 'allow';
}

// 현재 상태에서 노출할 액션 목록.
// 원내의 하원 버튼은 정책에 따라 노출 여부가 갈린다:
//  - block: 미완료면 하원 숨김(완료여야 노출)
//  - warn/allow: 하원 노출(warn은 클라가 경고로 막고, 서버도 미완료는 거부)
export function allowedActions(dayState, { checklistComplete, departurePolicy } = {}) {
  const cur = dayState || DAY_STATES.NONE;
  if (cur === DAY_STATES.NONE) return [ACTIONS.ARRIVE];
  if (cur === DAY_STATES.OUT) return [ACTIONS.RETURN];
  if (cur === DAY_STATES.GONE) return [];
  // 원내
  const actions = [ACTIONS.OUT];
  const showDepart = checklistComplete || departurePolicy === 'warn' || departurePolicy === 'allow';
  if (showDepart) actions.push(ACTIONS.DEPART);
  return actions;
}
