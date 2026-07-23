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
  const getAlimtalkTemplate = vi.fn(async (templateId) => ({
    templateId,
    content: '#{학생명} 학생 #{상담일시} #{장소} #{날짜}\n#{내용}',
    variables: [],
    buttons: [],
  }));
  function makeDb(students = {}) {
    const queue = [];
    const collections = new Map([['message_queue', new Map()]]);
    let autoId = 0;
    const db = {
      queue,
      collection: (name) => {
        const collection = name === 'students'
          ? new Map(Object.entries(students))
          : (collections.get(name) ?? new Map());
        collections.set(name, collection);
        return {
          doc: (id) => {
          const refId = id ?? `q${autoId++}`;
          return {
            id: refId,
            get: async () => ({ exists: collection.has(refId), data: () => collection.get(refId) }),
            set: async (d) => {
              collection.set(refId, d);
              if (name === 'message_queue') queue.push(d);
            },
            create: async (d) => {
              if (collection.has(refId)) {
                const error = new Error('ALREADY_EXISTS');
                error.code = 6;
                throw error;
              }
              collection.set(refId, d);
              if (name === 'message_queue') queue.push(d);
            },
          };
        },
        };
      },
      batch() {
        const ops = [];
        return {
          create(ref, value) { ops.push(() => ref.create(value)); },
          set(ref, value) { ops.push(() => ref.set(value)); },
          async commit() {
            for (const op of ops) await op();
          },
        };
      },
    };
    return db;
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
      { db, getAlimtalkTemplate },
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
      { db, getAlimtalkTemplate },
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
      { db, getAlimtalkTemplate },
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

  it('길이 초과 리포트는 큐 생성 전에 거부하고, 명시적 선택 시 번호를 붙인 문자로 나눈다', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const getReportTemplate = vi.fn(async (templateId) => ({
      templateId,
      content: '#{내용}',
      variables: [{ name: '#{내용}' }],
      buttons: [],
    }));
    const data = {
      studentId: 's1',
      templateKey: 'report',
      reportDate: '2026-07-21',
      variables: { 날짜: '7/21(화)', 내용: '가'.repeat(1001) },
      requestId: 'same-id',
    };
    const rejectedDb = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    await expect(handleSendParentNotice(
      { auth, data },
      { db: rejectedDb, getAlimtalkTemplate: getReportTemplate },
    )).rejects.toMatchObject({
      code: 'invalid-argument',
      details: expect.objectContaining({ canSplit: true, splitParts: 2 }),
    });
    expect(rejectedDb.queue).toHaveLength(0);

    const splitDb = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    const result = await handleSendParentNotice(
      { auth, data: { ...data, splitLongMessage: true } },
      { db: splitDb, getAlimtalkTemplate: getReportTemplate },
    );
    expect(result).toMatchObject({ channel: 'sms', splitParts: 2, queuedCount: 2 });
    expect(result.queueIds.every((id) => id.startsWith('parent_same-id_'))).toBe(true);
    expect(splitDb.queue.map((doc) => doc.kind)).toEqual(['direct', 'direct']);
    expect(splitDb.queue.every((doc) => doc.split_group_id === 'parent:same-id:s1:parent_1')).toBe(true);
    expect(splitDb.queue
      .sort((a, b) => a.split_part_index - b.split_part_index)
      .map((doc) => doc.content.slice(0, 5))).toEqual(['[1/2]', '[2/2]']);
  });

  it('동일 requestId 재시도는 큐를 중복 생성하지 않는다', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const db = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    const data = {
      studentId: 's1',
      templateKey: 'report',
      variables: { 날짜: '7/21(화)', 내용: '안내' },
      requestId: 'report-1',
    };
    await handleSendParentNotice({ auth, data }, { db, getAlimtalkTemplate });
    const retry = await handleSendParentNotice({ auth, data }, { db, getAlimtalkTemplate });

    expect(retry).toMatchObject({ duplicate: true, queuedCount: 0, duplicateCount: 1 });
    expect(db.queue).toHaveLength(1);
    const sentinel = await db.collection('message_request_batches').doc('parent_report-1').get();
    expect(sentinel.data().request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sentinel.data().request_fingerprint).not.toContain('김학생');

    await expect(handleSendParentNotice({
      auth,
      data: { ...data, variables: { 날짜: '7/21(화)', 내용: '수정 안내' } },
    }, { db, getAlimtalkTemplate })).rejects.toThrow('이전 요청과 다릅니다');
  });

  it('구버전 requestId 큐가 있으면 배포 후 재시도도 중복으로 처리한다', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const db = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    await db.collection('message_queue').doc('legacy-parent').set({ kind: 'parent_notice' });

    const result = await handleSendParentNotice({
      auth,
      data: {
        studentId: 's1',
        templateKey: 'report',
        variables: { 날짜: '7/21(화)', 내용: '안내' },
        requestId: 'legacy-parent',
      },
    }, { db, getAlimtalkTemplate });

    expect(result).toMatchObject({ duplicate: true, queuedCount: 0, queueId: 'legacy-parent' });
    expect(db.queue).toHaveLength(1);
  });

  it('구버전 다중 수신 큐가 일부만 있으면 누락 수신자만 생성한다', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const db = makeDb({
      s1: {
        name: '김학생',
        parent_phone_1: '010-1111-2222',
        parent_phone_2: '010-3333-4444',
      },
    });
    await db.collection('message_queue').doc('legacy-partial_parent_1').set({
      kind: 'parent_notice',
      recipient_role: 'parent_1',
    });

    const result = await handleSendParentNotice({
      auth,
      data: {
        studentId: 's1',
        templateKey: 'report',
        variables: { 날짜: '7/21(화)', 내용: '안내' },
        recipientFields: ['parent_1', 'parent_2'],
        requestId: 'legacy-partial',
      },
    }, { db, getAlimtalkTemplate });

    expect(result).toMatchObject({ queued: true, queuedCount: 1, duplicateCount: 1 });
    expect(db.queue.map((doc) => doc.recipient_role).sort()).toEqual(['parent_1', 'parent_2']);
    const sentinel = await db.collection('message_request_batches').doc('parent_legacy-partial').get();
    expect(sentinel.exists).toBe(true);
  });

  it('동일 requestId로 분할 선택이나 수신 대상이 바뀌면 큐를 추가하지 않는다', async () => {
    process.env.REPORT_TEMPLATE_CODE = 'KA01TP_REPORT';
    const db = makeDb({
      s1: {
        name: '김학생',
        parent_phone_1: '010-1111-2222',
        parent_phone_2: '010-3333-4444',
      },
    });
    const data = {
      studentId: 's1',
      templateKey: 'report',
      variables: { 날짜: '7/21(화)', 내용: '안내' },
      requestId: 'report-shape',
    };
    await handleSendParentNotice({ auth, data }, { db, getAlimtalkTemplate });

    await expect(handleSendParentNotice({
      auth,
      data: { ...data, splitLongMessage: true },
    }, { db, getAlimtalkTemplate })).rejects.toThrow('이전 요청과 다릅니다');
    await expect(handleSendParentNotice({
      auth,
      data: { ...data, recipientFields: ['parent_1', 'parent_2'] },
    }, { db, getAlimtalkTemplate })).rejects.toThrow('이전 요청과 다릅니다');
    expect(db.queue).toHaveLength(1);
  });

  it('rejects when template code is not configured (not approved yet)', async () => {
    delete process.env.COUNSEL_TEMPLATE_CODE;
    const db = makeDb({ s1: { name: '김', parent_phone_1: '010-1' } });
    await expect(handleSendParentNotice({ auth, data: { studentId: 's1', templateKey: 'counsel' } }, { db })).rejects.toThrow();
  });

  it.each([
    ['설정 대기 코드', 'KA01TP_COUNSEL_PENDING', null],
    ['비승인 템플릿', 'KA01TP_COUNSEL', Object.assign(new Error('숨김 템플릿'), { code: 'failed-precondition' })],
  ])('%s이면 기존 SMS fallback 경로를 보존한다', async (_label, templateCode, templateError) => {
    process.env.COUNSEL_TEMPLATE_CODE = templateCode;
    const db = makeDb({ s1: { name: '김학생', parent_phone_1: '010-1111-2222' } });
    const getTemplate = templateError
      ? vi.fn().mockRejectedValue(templateError)
      : vi.fn();

    const result = await handleSendParentNotice({
      auth,
      data: {
        studentId: 's1',
        templateKey: 'counsel',
        variables: { 상담일시: '7/24 15시', 장소: '2층' },
      },
    }, { db, getAlimtalkTemplate: getTemplate });

    expect(result).toMatchObject({ queued: true, channel: 'alimtalk' });
    expect(db.queue[0]).toMatchObject({
      kind: 'parent_notice',
      template_code: templateCode,
      fallback_text: expect.stringContaining('7/24 15시'),
    });
    expect(getTemplate).toHaveBeenCalledTimes(templateError ? 1 : 0);
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
