import { describe, it, expect } from 'vitest';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import {
  applyTemplate,
  buildAttendanceVariables,
  buildAttendanceFallbackText,
  buildAttendanceMessage,
  DEFAULT_VARIABLE_KEYS,
} from '../src/templates.js';

// 2026-06-12 09:05 KST
const occurredAt = new Date('2026-06-12T00:05:00.000Z');
const student = { name: '김학생', level: '중등', grade: '2', school_middle: '신가중' };

describe('applyTemplate', () => {
  it('replaces #{...} tokens and blanks out undefined ones', () => {
    expect(applyTemplate('#{a}-#{b}', { '#{a}': '1' })).toBe('1-');
    expect(applyTemplate('plain', {})).toBe('plain');
    expect(applyTemplate(null, {})).toBe('');
  });
});

describe('buildAttendanceVariables', () => {
  it('maps the default variable keys (학생명/일시/출결상태)', () => {
    const vars = buildAttendanceVariables({ studentName: '김학생', status: '출석', occurredAt });
    expect(vars[DEFAULT_VARIABLE_KEYS.studentName]).toBe('김학생');
    expect(vars[DEFAULT_VARIABLE_KEYS.status]).toBe('출석');
    expect(vars[DEFAULT_VARIABLE_KEYS.dateTime]).toBe(formatDateTimeKST(occurredAt));
    // 승인 대기 템플릿 변수는 학생명/일시/출결상태 3개뿐 — 학생라벨 키는 없다.
    expect(Object.keys(vars).sort()).toEqual(['#{일시}', '#{출결상태}', '#{학생명}'].sort());
  });

  it('resolves the student name from a student object', () => {
    const vars = buildAttendanceVariables({ student, status: '지각', occurredAt });
    expect(vars[DEFAULT_VARIABLE_KEYS.studentName]).toBe('김학생');
  });

  it('honors custom variable keys for the approved template', () => {
    const keys = { studentName: '#{name}', dateTime: '#{time}', status: '#{state}' };
    const vars = buildAttendanceVariables({ studentName: '박학생', status: '조퇴', occurredAt }, { keys });
    expect(vars['#{name}']).toBe('박학생');
    expect(vars['#{state}']).toBe('조퇴');
  });
});

describe('buildAttendanceFallbackText', () => {
  it('renders the default fallback body with the brand prefix', () => {
    const text = buildAttendanceFallbackText({ studentName: '김학생', status: '출석', occurredAt });
    expect(text.startsWith('[임팩트세븐학원]')).toBe(true); // 브랜드 prefix는 templates.js 한 곳에서만 정의
    expect(text).toContain('김학생');
    expect(text).toContain('출석');
    expect(text).toContain(formatDateTimeKST(occurredAt));
  });

  it('uses a caller-supplied template', () => {
    const text = buildAttendanceFallbackText(
      { studentName: '김학생', status: '결석', occurredAt },
      { template: '#{학생명}/#{출결상태}' },
    );
    expect(text).toBe('김학생/결석');
  });
});

describe('buildAttendanceMessage', () => {
  it('bundles templateCode, variables and fallbackText', () => {
    const msg = buildAttendanceMessage({
      studentName: '김학생',
      status: '출석',
      occurredAt,
      templateCode: 'TMPL_ATTEND',
    });
    expect(msg.templateCode).toBe('TMPL_ATTEND');
    expect(msg.templateVariables[DEFAULT_VARIABLE_KEYS.studentName]).toBe('김학생');
    expect(msg.fallbackText).toContain('김학생');
  });

  it('defaults templateCode to null while approval is pending', () => {
    const msg = buildAttendanceMessage({ studentName: '김학생', status: '출석', occurredAt });
    expect(msg.templateCode).toBeNull();
  });
});
