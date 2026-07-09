// 태블릿 출결 상태머신 — 순수 함수(부수효과 없음). 서버 검증과 허용액션 계산의 단일 소스.
// 대상 학생: 재원/실휴원/가휴원 (등원예정 제외 — isEnrollableStatus보다 좁다).
import { ATTENDANCE_ACTIONS } from '@impact7/shared/attendance-action';

export const TABLET_ELIGIBLE_STATUSES = new Set(['재원', '실휴원', '가휴원']);
export function isTabletEligibleStatus(status) {
  return TABLET_ELIGIBLE_STATUSES.has(status);
}

// 액션 라벨 표준은 shared(attendance-action)가 단일 소스. RETURN='귀원'(구 '복귀'는 정규화로 흡수).
export const ACTIONS = {
  ARRIVE: ATTENDANCE_ACTIONS.arrival,
  REARRIVE: '재등원',
  OUT: ATTENDANCE_ACTIONS.out,
  RETURN: ATTENDANCE_ACTIONS.return,
  DEPART: ATTENDANCE_ACTIONS.departure,
};
export const DAY_STATES = { NONE: '미등원', IN: '원내', OUT: '외출중', GONE: '하원' };

// 유효 전이표. (현재상태 → 액션 → 다음상태)
const TRANSITIONS = {
  [DAY_STATES.NONE]: { [ACTIONS.ARRIVE]: DAY_STATES.IN },
  [DAY_STATES.IN]: { [ACTIONS.OUT]: DAY_STATES.OUT, [ACTIONS.DEPART]: DAY_STATES.GONE },
  [DAY_STATES.OUT]: { [ACTIONS.RETURN]: DAY_STATES.IN },
  [DAY_STATES.GONE]: { [ACTIONS.REARRIVE]: DAY_STATES.IN },
};

export function nextDayState(current, action) {
  const cur = current || DAY_STATES.NONE;
  return TRANSITIONS[cur]?.[action] ?? null;
}

// 하원 게이트: 체크리스트 완료면 항상 가능, 미완료면 allow 정책에서만 가능.
export function canDepart(checklistComplete, departurePolicy) {
  if (checklistComplete) return true;
  // warn·allow는 미완료여도 하원 허용(warn은 클라가 '미완료: OO' 안내만 표시). block만 거부.
  return departurePolicy === 'allow' || departurePolicy === 'warn';
}

// 현재 상태에서 노출할 액션 목록.
// 원내의 하원 버튼은 정책에 따라 노출 여부가 갈린다:
//  - block: 미완료면 하원 숨김(완료여야 노출), 서버도 거부
//  - warn/allow: 하원 노출 + 처리 허용(warn은 클라가 '미완료: OO' 안내만 표시)
export function allowedActions(dayState, { checklistComplete, departurePolicy } = {}) {
  const cur = dayState || DAY_STATES.NONE;
  if (cur === DAY_STATES.NONE) return [ACTIONS.ARRIVE];
  if (cur === DAY_STATES.OUT) return [ACTIONS.RETURN];
  if (cur === DAY_STATES.GONE) return [ACTIONS.REARRIVE];
  // 원내
  const actions = [ACTIONS.OUT];
  const showDepart = checklistComplete || departurePolicy === 'warn' || departurePolicy === 'allow';
  if (showDepart) actions.push(ACTIONS.DEPART);
  return actions;
}

// 알림톡 템플릿 키 매핑 (parentNoticeHandler의 PARENT_NOTICE_TEMPLATES와 동일 키).
export const ACTION_TEMPLATE_KEY = {
  [ACTIONS.ARRIVE]: 'arrival',
  [ACTIONS.REARRIVE]: 'rearrival',
  [ACTIONS.DEPART]: 'departure',
  [ACTIONS.OUT]: 'out',
  [ACTIONS.RETURN]: 'return',
};

// KST 12시간제 한국어 "오전/오후 H:MM". 알림톡 #{시각} 변수용.
// ICU 로케일 비의존 — toLocaleTimeString('ko-KR')은 런타임 ICU 데이터가 없으면
// '오전'을 'AM'으로 폴백한다(일부 CI/슬림 런타임). KST(UTC+9, DST 없음)로 직접 계산.
export function formatKstClock12h(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  const h24 = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const period = h24 < 12 ? '오전' : '오후';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${period} ${h12}:${String(m).padStart(2, '0')}`;
}
