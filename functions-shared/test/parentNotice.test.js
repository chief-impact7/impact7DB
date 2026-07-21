import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const { buildParentNoticeVariables, handleSendParentNotice } = await import('../src/parentNoticeHandler.js');

describe('buildParentNoticeVariables', () => {
  it('maps student name + input vars (counsel)', () => {
    const v = buildParentNoticeVariables({ name: '김학생' }, 'counsel', { 상담일시: '6/20 15시', 장소: '2층' });
    expect(v).toEqual({ '#{학생명}': '김학생', '#{상담일시}': '6/20 15시', '#{장소}': '2층' });
  });
  it('fills missing vars with empty string', () => {
    expect(buildParentNoticeVariables({ name: '김' }, 'exam', {})).toEqual({
      '#{학생명}': '김', '#{시험명}': '', '#{안내내용}': '',
    });
  });
  it('maps approved report template vars', () => {
    expect(buildParentNoticeVariables({ name: '김' }, 'report', { 날짜: '7/7(화)', 내용: '수업 결과' })).toEqual({
      '#{학생명}': '김', '#{날짜}': '7/7(화)', '#{내용}': '수업 결과',
    });
  });
  it('maps arrival_plan template vars', () => {
    expect(buildParentNoticeVariables({ name: '김' }, 'arrival_plan', { 일시: '7/22 14시', 사유: '보충' })).toEqual({
      '#{학생명}': '김', '#{일시}': '7/22 14시', '#{사유}': '보충',
    });
  });
  it('returns null for an unknown template', () => {
    expect(buildParentNoticeVariables({}, 'bogus', {})).toBeNull();
  });
});

describe('handleSendParentNotice', () => {
  const auth = { uid: 'u1', token: { email: 't@impact7.kr', email_verified: true } };
  function makeDb(students = {}) {
    const queue = [];
    return {
      queue,
      collection: () => ({
        doc: (id) => ({
          id: id ?? 'q1',
          get: async () => ({ exists: id in students, data: () => students[id] }),
          set: async (d) => { queue.push(d); },
        }),
      }),
    };
  }
  const ORIG_COUNSEL = process.env.COUNSEL_TEMPLATE_CODE;
  const ORIG_REPORT = process.env.REPORT_TEMPLATE_CODE;
  afterEach(() => {
    if (ORIG_COUNSEL === undefined) delete process.env.COUNSEL_TEMPLATE_CODE;
    else process.env.COUNSEL_TEMPLATE_CODE = ORIG_COUNSEL;
    if (ORIG_REPORT === undefined) delete process.env.REPORT_TEMPLATE_CODE;
    else process.env.REPORT_TEMPLATE_CODE = ORIG_REPORT;
  });

  it('enqueues a parent_notice with template code + variables + fallback', async () => {
    process.env.COUNSEL_TEMPLATE_CODE = 'KA01TP_COUNSEL';
    const db = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    const res = await handleSendParentNotice(
      { auth, data: { studentId: 's1', templateKey: 'counsel', variables: { 상담일시: '6/20 15시', 장소: '2층' } } },
      { db },
    );
    expect(res.queued).toBe(true);
    const doc = db.queue[0];
    expect(doc.kind).toBe('parent_notice');
    expect(doc.template_code).toBe('KA01TP_COUNSEL');
    expect(doc.recipient_phone).toBe('01011112222');
    expect(doc.recipient_role).toBe('parent_1');
    expect(doc.template_variables['#{상담일시}']).toBe('6/20 15시');
    expect(doc.fallback_text).toContain('상담 안내');
    expect(doc.fallback_text).toContain('6/20 15시');
  });

  it('recipientFields 다중 선택 시 수신자별 parent_notice를 enqueue하고 같은 번호는 dedup한다', async () => {
    process.env.COUNSEL_TEMPLATE_CODE = 'KA01TP_COUNSEL';
    const db = makeDb({
      s1: {
        name: '김학생',
        student_phone: '010-1111-2222',
        parent_phone_1: '010-1111-2222',
        parent_phone_2: '010-3333-4444',
      },
    });
    const res = await handleSendParentNotice(
      { auth, data: { studentId: 's1', templateKey: 'counsel', variables: { 상담일시: '6/20', 장소: '2층' }, recipientFields: ['student', 'parent_1', 'parent_2'], requestId: 'req1' } },
      { db },
    );
    expect(res).toMatchObject({ queued: true, queuedCount: 2, duplicateCount: 0 });
    expect(db.queue).toHaveLength(2);
    expect(db.queue.map((d) => d.recipient_role)).toEqual(['student', 'parent_2']);
    expect(db.queue.map((d) => d.recipient_phone)).toEqual(['01011112222', '01033334444']);
  });

  it('enqueues approved report alimtalk with report template variables', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const db = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    const res = await handleSendParentNotice(
      { auth, data: { studentId: 's1', templateKey: 'report', reportDate: '2026-07-07', variables: { 날짜: '7/7(화)', 내용: '수업 결과입니다.' } } },
      { db },
    );
    expect(res).toMatchObject({ queued: true, template: '수업 리포트' });
    const doc = db.queue[0];
    expect(doc.kind).toBe('parent_notice');
    expect(doc).toMatchObject({ template_key: 'report', report_date_kst: '2026-07-07' });
    expect(doc.template_code).toBe('KA01TP_REPORT');
    expect(doc.template_variables).toMatchObject({
      '#{학생명}': '김학생',
      '#{날짜}': '7/7(화)',
      '#{내용}': '수업 결과입니다.',
    });
    expect(doc.fallback_text).toContain('수업 리포트');
    expect(doc.fallback_text).toContain('7/7(화)');
    expect(doc.fallback_text).toContain('수업 결과입니다.');
    expect(doc.fallback_text).not.toContain('함께 보내드린 자료도 확인해 주세요.');
    expect(doc.fallback_text).not.toContain('감사합니다. 임팩트7');
  });

  it('rejects when template code is not configured (not approved yet)', async () => {
    delete process.env.COUNSEL_TEMPLATE_CODE;
    const db = makeDb({ s1: { name: '김', parent_phone_1: '010-1' } });
    await expect(handleSendParentNotice({ auth, data: { studentId: 's1', templateKey: 'counsel' } }, { db })).rejects.toThrow();
  });

  it('rejects when parent phone is missing', async () => {
    process.env.COUNSEL_TEMPLATE_CODE = 'X';
    const db = makeDb({ s1: { name: '김' } });
    await expect(handleSendParentNotice({ auth, data: { studentId: 's1', templateKey: 'counsel' } }, { db })).rejects.toThrow();
  });

  it('rejects an unknown template', async () => {
    const db = makeDb({ s1: { name: '김', parent_phone_1: '010-1' } });
    await expect(handleSendParentNotice({ auth, data: { studentId: 's1', templateKey: 'bogus' } }, { db })).rejects.toThrow();
  });

  it('rejects an unauthorized caller', async () => {
    const db = makeDb({});
    const outsider = { uid: 'x', token: { email: 'x@gmail.com', email_verified: true } };
    await expect(handleSendParentNotice({ auth: outsider, data: { studentId: 's1', templateKey: 'counsel' } }, { db })).rejects.toThrow();
  });
});
