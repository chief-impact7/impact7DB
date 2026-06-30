import { test } from 'vitest';
import assert from 'node:assert';
import {
  STAFF_ACTIONS, STAFF_DAY_STATES, nextStaffDayState, staffAllowedActions,
} from '../src/staffAttendanceState.js';

test('nextStaffDayState — 정상 전이', () => {
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.NONE, STAFF_ACTIONS.CLOCK_IN), STAFF_DAY_STATES.IN);
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.IN, STAFF_ACTIONS.OUT), STAFF_DAY_STATES.OUT);
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.OUT, STAFF_ACTIONS.RETURN), STAFF_DAY_STATES.IN);
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.IN, STAFF_ACTIONS.CLOCK_OUT), STAFF_DAY_STATES.DONE);
});

test('nextStaffDayState — 잘못된 전이는 null', () => {
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.NONE, STAFF_ACTIONS.OUT), null);       // 미출근에서 외출 불가
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.OUT, STAFF_ACTIONS.CLOCK_OUT), null);  // 외출중 퇴근 불가
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.OUT, STAFF_ACTIONS.CLOCK_IN), null);   // 중복 출근 불가
  assert.equal(nextStaffDayState(STAFF_DAY_STATES.DONE, STAFF_ACTIONS.CLOCK_IN), null);  // 퇴근 후 액션 없음
  assert.equal(nextStaffDayState(undefined, STAFF_ACTIONS.OUT), null);                   // 기본=미출근
});

test('staffAllowedActions — 상태별 버튼', () => {
  assert.deepEqual(staffAllowedActions(STAFF_DAY_STATES.NONE), ['출근']);
  assert.deepEqual(staffAllowedActions(STAFF_DAY_STATES.IN), ['외출', '퇴근']);
  assert.deepEqual(staffAllowedActions(STAFF_DAY_STATES.OUT), ['귀원']);
  assert.deepEqual(staffAllowedActions(STAFF_DAY_STATES.DONE), []);
  assert.deepEqual(staffAllowedActions(undefined), ['출근']); // 기본=미출근
});
