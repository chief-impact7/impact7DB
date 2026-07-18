import { describe, expect, it, vi } from 'vitest';
import {
  activeTeacherLocals,
  assignableStaffLocals,
  isEligibleEmail,
  staffDirectoryEntry,
  syncTeacherEligibility,
} from '../src/teacherDirectory.js';

describe('activeTeacherLocals', () => {
  it('교수부 재직자의 영어이름 첫 토큰(소문자)만 모은다', () => {
    const locals = activeTeacherLocals([
      { department: '교수', englishName: 'Rachel', status: 'active' },
      { department: '교수', englishName: 'Edward Lee', status: 'active' },
      { department: '교수', englishName: 'Mike', status: 'terminated' },
      { department: '행정', englishName: 'Jane', status: 'active' },
      { department: '교수', englishName: '', status: 'active' },
    ]);
    expect([...locals].sort()).toEqual(['edward', 'rachel']);
  });
});

describe('assignableStaffLocals', () => {
  it('교수·행정 재직자만 모으고 단기·퇴직은 제외한다', () => {
    const locals = assignableStaffLocals([
      { department: '교수', englishName: 'Rachel', status: 'active' },
      { department: '행정', englishName: 'Jane Park', status: 'active' },
      { department: '단기', englishName: 'Tom', status: 'active' },
      { department: '행정', englishName: 'Mike', status: 'terminated' },
      { department: '교수', englishName: '', status: 'active' },
    ]);
    expect([...locals].sort()).toEqual(['jane', 'rachel']);
  });
});

describe('isEligibleEmail', () => {
  const locals = new Set(['rachel', 'edward']);
  it('구·신 메일 모두 로컬파트로 매칭한다', () => {
    expect(isEligibleEmail('rachel@impact7.kr', locals)).toBe(true);
    expect(isEligibleEmail('rachel@gw.impact7.kr', locals)).toBe(true);
    expect(isEligibleEmail('Edward@impact7.kr', locals)).toBe(true);
  });
  it('비교수부·퇴직·빈값은 자격 없음', () => {
    expect(isEligibleEmail('chief@impact7.kr', locals)).toBe(false);
    expect(isEligibleEmail('', locals)).toBe(false);
    expect(isEligibleEmail(undefined, locals)).toBe(false);
  });
});

describe('staffDirectoryEntry', () => {
  it('보드에 필요한 안전 필드만 교수·행정 명부로 만든다', () => {
    expect(staffDirectoryEntry({
      name: '김교수',
      englishName: 'Rachel',
      email: 'RACHEL@IMPACT7.KR',
      department: '교수',
      status: 'active',
      residentNumber: '비공개',
    })).toEqual({
      display_name: '김교수',
      email: 'rachel@impact7.kr',
      department: '교수',
      assignable: true,
    });
  });

  it('퇴직자는 명부에 남기되 배정 후보에서 제외하고 단기는 미러하지 않는다', () => {
    expect(staffDirectoryEntry({ name: '퇴직자', department: '행정', status: 'terminated' })?.assignable).toBe(false);
    expect(staffDirectoryEntry({ name: '단기', department: '단기', status: 'active' })).toBeNull();
  });
});

describe('syncTeacherEligibility transaction boundary', () => {
  it('teachers와 staff_directory의 모든 쓰기를 같은 transaction으로 예약한다', async () => {
    const staffRef = { path: 'staff/professor' };
    const teacherRef = { path: 'teachers/rachel@impact7.kr' };
    const staleRef = { path: 'staff_directory/stale' };
    const directoryRef = { path: 'staff_directory/professor' };
    const queries = {
      staff: { key: 'staff' },
      teachers: { key: 'teachers' },
      staffDirectory: { key: 'staff_directory' },
    };
    const snapshots = {
      staff: {
        size: 1,
        docs: [{ ref: staffRef, id: 'professor', data: () => ({
          name: '김교수',
          englishName: 'Rachel',
          email: 'rachel@impact7.kr',
          department: '교수',
          status: 'active',
        }) }],
      },
      teachers: {
        size: 1,
        docs: [{ ref: teacherRef, id: 'rachel@impact7.kr', data: () => ({
          homeroom_eligible: false,
          board_assignable: false,
        }) }],
      },
      staff_directory: {
        size: 1,
        docs: [{ ref: staleRef, id: 'stale', data: () => ({}) }],
      },
    };
    const transaction = {
      get: vi.fn(async (query) => snapshots[query.key]),
      update: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = {
      collection: vi.fn((name) => {
        if (name === 'staff') return { where: () => queries.staff };
        if (name === 'teachers') return queries.teachers;
        return { ...queries.staffDirectory, doc: () => directoryRef };
      }),
      runTransaction: vi.fn(async (callback) => callback(transaction)),
    };

    await syncTeacherEligibility(db);

    expect(db.runTransaction).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledWith(teacherRef, {
      homeroom_eligible: true,
      board_assignable: true,
    });
    expect(transaction.set).toHaveBeenCalledWith(directoryRef, {
      display_name: '김교수',
      email: 'rachel@impact7.kr',
      department: '교수',
      assignable: true,
    });
    expect(transaction.delete).toHaveBeenCalledWith(staleRef);
  });
});
