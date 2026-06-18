import { test } from 'node:test';
import assert from 'node:assert';
import {
  isTabletEligibleStatus, ACTIONS, DAY_STATES,
  nextDayState, allowedActions, canDepart,
  formatKstClock12h, ACTION_TEMPLATE_KEY,
} from '../src/attendanceState.js';

test('isTabletEligibleStatus — 등원예정 제외', () => {
  for (const s of ['재원', '실휴원', '가휴원']) assert.equal(isTabletEligibleStatus(s), true);
  for (const s of ['등원예정', '상담', '퇴원', '종강', '', undefined]) {
    assert.equal(isTabletEligibleStatus(s), false);
  }
});

test('nextDayState — 정상 전이', () => {
  assert.equal(nextDayState(DAY_STATES.NONE, ACTIONS.ARRIVE), DAY_STATES.IN);
  assert.equal(nextDayState(DAY_STATES.IN, ACTIONS.OUT), DAY_STATES.OUT);
  assert.equal(nextDayState(DAY_STATES.OUT, ACTIONS.RETURN), DAY_STATES.IN);
  assert.equal(nextDayState(DAY_STATES.IN, ACTIONS.DEPART), DAY_STATES.GONE);
});

test('nextDayState — 잘못된 전이는 null', () => {
  assert.equal(nextDayState(DAY_STATES.NONE, ACTIONS.OUT), null);      // 미등원에서 외출 불가
  assert.equal(nextDayState(DAY_STATES.OUT, ACTIONS.DEPART), null);    // 외출중 하원 불가
  assert.equal(nextDayState(DAY_STATES.OUT, ACTIONS.ARRIVE), null);    // 중복 등원 불가
  assert.equal(nextDayState(DAY_STATES.GONE, ACTIONS.ARRIVE), null);   // 하원 후 액션 없음
});

test('canDepart — 정책별', () => {
  assert.equal(canDepart(true, 'block'), true);
  assert.equal(canDepart(false, 'block'), false);
  assert.equal(canDepart(false, 'warn'), false);   // warn도 미완료는 서버 거부
  assert.equal(canDepart(false, 'allow'), true);
  assert.equal(canDepart(true, 'allow'), true);
});

test('allowedActions — 상태·정책별 버튼', () => {
  assert.deepEqual(allowedActions(DAY_STATES.NONE, { checklistComplete: false, departurePolicy: 'block' }), ['등원']);
  assert.deepEqual(allowedActions(DAY_STATES.OUT, { checklistComplete: true, departurePolicy: 'block' }), ['복귀']);
  assert.deepEqual(allowedActions(DAY_STATES.GONE, { checklistComplete: true, departurePolicy: 'block' }), []);
  // 원내 + 미완료 + block → 하원 버튼 숨김
  assert.deepEqual(allowedActions(DAY_STATES.IN, { checklistComplete: false, departurePolicy: 'block' }), ['외출']);
  // 원내 + 미완료 + warn → 하원 노출(클라 경고)
  assert.deepEqual(allowedActions(DAY_STATES.IN, { checklistComplete: false, departurePolicy: 'warn' }), ['외출', '하원']);
  // 원내 + 완료 → 하원 노출
  assert.deepEqual(allowedActions(DAY_STATES.IN, { checklistComplete: true, departurePolicy: 'block' }), ['외출', '하원']);
});

test('formatKstClock12h — KST 12시간제 한국어', () => {
  // 2026-06-18 01:30 UTC = 10:30 KST (오전)
  assert.equal(formatKstClock12h(new Date('2026-06-18T01:30:00Z')), '오전 10:30');
  // 2026-06-18 09:05 UTC = 18:05 KST (오후 6:05)
  assert.equal(formatKstClock12h(new Date('2026-06-18T09:05:00Z')), '오후 6:05');
});

test('ACTION_TEMPLATE_KEY — 액션→알림톡 템플릿', () => {
  assert.equal(ACTION_TEMPLATE_KEY['등원'], 'arrival');
  assert.equal(ACTION_TEMPLATE_KEY['하원'], 'departure');
  assert.equal(ACTION_TEMPLATE_KEY['외출'], 'out');
  assert.equal(ACTION_TEMPLATE_KEY['복귀'], 'return');
});
