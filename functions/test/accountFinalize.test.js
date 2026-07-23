import { describe, expect, it } from 'vitest';
import { accountApplicationOf, buildAccountFinalize } from '../src/accountFinalize.js';

const today = '2026-04-21';
const regular = {
  account_id: 'regular-1',
  account_type: '정규',
  class_type: '정규',
  class_number: '101',
  start_date: '2026-03-01',
};
const naesin = {
  account_id: 'regular-1',
  account_type: '정규',
  class_type: '내신',
  class_number: '중간고사',
  start_date: '2026-04-01',
};
const special = {
  account_id: 'special-1',
  account_type: '특강',
  class_type: '특강',
  class_number: '문법',
  start_date: '2026-04-01',
};

function request(request_type, fields = {}) {
  return {
    id: 'lr-1',
    request_type,
    account_target: { account_id: 'regular-1' },
    ...fields,
  };
}

function student(enrollments = [regular, naesin], fields = {}) {
  return { id: 's1', status: '재원', enrollments, ...fields };
}

describe('buildAccountFinalize', () => {
  it('즉시 휴원은 대상 계정만 멈추고 상태·마커·이력을 계산한다', () => {
    const result = buildAccountFinalize(request('휴원요청', {
      leave_start_date: today,
      leave_end_date: '2026-05-31',
      leave_sub_type: '실휴원',
    }), student(), today);

    expect(result.studentUpdate.status).toBe('실휴원');
    expect(result.studentUpdate.enrollments).toHaveLength(2);
    expect(result.studentUpdate.enrollments.every(e => e.pause_start_date === today)).toBe(true);
    expect(result.markers.start_applied_at).toBe(true);
    expect(result.markers.finalized_at).toBe(true);
    expect(result.historyEntries[0].change_type).toBe('ACCOUNT_PAUSE');
  });

  it('미래 휴원은 학생·마커·이력을 모두 건드리지 않는다', () => {
    const result = buildAccountFinalize(request('휴원요청', {
      leave_start_date: '2026-05-01',
      leave_end_date: '2026-05-31',
    }), student(), today);

    expect(result).toEqual({ studentUpdate: null, historyEntries: [], markers: {} });
  });

  it('휴원연장은 대상 그룹의 종료일만 바꾸고 연장 이력을 남긴다', () => {
    const paused = [regular, naesin].map(e => ({
      ...e,
      pause_start_date: '2026-04-01',
      pause_end_date: '2026-04-30',
      leave_sub_type: '실휴원',
    }));
    const result = buildAccountFinalize(
      request('휴원연장', { leave_end_date: '2026-06-30' }),
      student([...paused, special], { status: '실휴원' }),
      today,
    );

    expect(result.studentUpdate.status).toBeUndefined();
    expect(result.studentUpdate.enrollments.slice(0, 2)
      .every(e => e.pause_end_date === '2026-06-30')).toBe(true);
    expect(result.studentUpdate.enrollments[2]).toEqual(special);
    expect(result.historyEntries[0].reason).toBe('휴원연장');
  });

  it('복귀는 대상 계정의 휴원 필드를 제거하고 상태를 재파생한다', () => {
    const paused = [regular, naesin].map(e => ({
      ...e,
      pause_start_date: '2026-04-01',
      pause_end_date: '2026-04-30',
      leave_sub_type: '가휴원',
    }));
    const result = buildAccountFinalize(
      request('복귀요청'),
      student(paused, { status: '가휴원' }),
      today,
    );

    expect(result.studentUpdate.status).toBe('재원');
    expect(result.studentUpdate.enrollments.every(e => !('pause_start_date' in e))).toBe(true);
    expect(result.historyEntries[0].change_type).toBe('ACCOUNT_RESUME');
  });

  it('미래 복귀 승인은 학생·마커·이력을 건드리지 않고 적용일을 유지한다', () => {
    const futureRequest = request('복귀요청', { return_date: '2026-05-01' });

    expect(accountApplicationOf(futureRequest, today)).toEqual({
      marker: 'start_applied_at',
      dueDate: '2026-05-01',
    });
    expect(buildAccountFinalize(futureRequest, student(), today)).toEqual({
      studentUpdate: null,
      historyEntries: [],
      markers: {},
    });
  });

  it('부분 퇴원은 대상 계정만 제거하고 다른 활성 계정 때문에 재원을 유지한다', () => {
    const result = buildAccountFinalize(
      request('퇴원요청', { withdrawal_date: today }),
      student([regular, naesin, special]),
      today,
    );

    expect(result.studentUpdate.enrollments).toEqual([special]);
    expect(result.studentUpdate.status).toBe('재원');
    expect(result.markers.delete_student_fields).toEqual([]);
    expect(result.historyEntries[0]).toMatchObject({
      change_type: 'ACCOUNT_END',
      account_id: 'regular-1',
      account_type: '정규',
      reason: '퇴원',
      source_request_id: 'lr-1',
      period: { start_date: '2026-03-01', end_date: '2026-04-20' },
    });
    expect(result.historyEntries[0].removed).toHaveLength(2);
    expect(JSON.parse(result.historyEntries[0].after)).toEqual({
      account_id: 'regular-1',
      account_type: '정규',
      account_key: 'regular-1',
      items: result.historyEntries[0].removed,
      end_reason: '퇴원',
      student_status_before: '재원',
      student_status_after: '재원',
      source_request_id: 'lr-1',
    });
  });

  it('마지막 계정 퇴원은 퇴원 상태와 최상위 정리 필드를 계산한다', () => {
    const result = buildAccountFinalize(
      request('퇴원요청', { withdrawal_date: today }),
      student(),
      today,
    );

    expect(result.studentUpdate).toEqual({ enrollments: [], status: '퇴원' });
    expect(result.markers.end_applied_at).toBe(true);
    expect(result.markers.delete_student_fields).toEqual(expect.arrayContaining([
      'pause_start_date',
      'pause_end_date',
      'withdrawal_date',
      'pre_withdrawal_status',
      'scheduled_leave_status',
    ]));
  });

  it('종강요청은 마지막 계정을 종강 사유로 종료한다', () => {
    const result = buildAccountFinalize(
      request('종강요청', { withdrawal_date: today }),
      student(),
      today,
    );

    expect(result.studentUpdate.status).toBe('종강');
    expect(result.historyEntries[0].reason).toBe('종강');
    expect(result.historyEntries[0].removed.every(e => e.end_reason === '종강')).toBe(true);
  });

  it('미래 종료 승인은 학생·마커·이력을 모두 건드리지 않는다', () => {
    const result = buildAccountFinalize(
      request('퇴원요청', { withdrawal_date: '2026-05-01' }),
      student([regular, special]),
      today,
    );

    expect(result).toEqual({ studentUpdate: null, historyEntries: [], markers: {} });
  });

  it('레거시 account key로도 정확한 그룹을 처리한다', () => {
    const legacy = [
      { class_type: '정규', level_symbol: 'HA', class_number: '101', start_date: '2026-03-01' },
      { class_type: '내신', class_number: '중간고사', start_date: '2026-04-01' },
    ];
    const result = buildAccountFinalize({
      id: 'lr-legacy',
      request_type: '종강요청',
      withdrawal_date: today,
      account_target: { account_id: 'legacy:정규:HA101' },
    }, student(legacy), today);

    expect(result.studentUpdate).toEqual({ enrollments: [], status: '종강' });
    expect(JSON.parse(result.historyEntries[0].after).account_key).toBe('legacy:정규:HA101');
  });

  it('부분 종료는 현재 재원계열 status를 보존한다', () => {
    const result = buildAccountFinalize(
      request('퇴원요청', { withdrawal_date: today }),
      student([regular, special], { status: '실휴원' }),
      today,
    );

    expect(result.studentUpdate.status).toBe('실휴원');
  });

  it('account_id가 매칭되지 않으면 학생 계산 전에 실패한다', () => {
    expect(() => buildAccountFinalize(
      { ...request('복귀요청'), account_target: { account_id: 'missing' } },
      student(),
      today,
    )).toThrow('수강계정 missing 매칭 실패: 0개');
  });
});
