import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn(), assertManagerOrAbove: vi.fn() }));

const {
  buildBulkRecipients,
  buildBulkAlimtalkRecipients,
  buildStaffAlimtalkRecipients,
  buildStaffRecipients,
  handleCreateBulkMessage,
  handleGetBulkStaffRecipients,
  applyMessageVars,
  validateAlimtalkVariables,
} = await import('../src/bulkMessageHandler.js');
const { assertManagerOrAbove } = await import('../src/authGuards.js');
const { recipientFingerprint } = await import('../src/campaignResume.js');
const bulkFp = (ids) => recipientFingerprint(ids, { recipientField: null, recipientFields: null });

const auth = { token: { email: 'staff@impact7.kr' }, uid: 'u1' };

describe('buildBulkRecipients (정보성: 전원, 동의 무관)', () => {
  it('queues everyone with a phone as direct SMS/LMS', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222' } },
      { id: 's2', student: { parent_phone_1: '', parent_phone_2: '01033334444' } },
      { id: 's3', student: {} }, // 번호 없음 → 제외
      // 광고 옵트아웃이어도 정보성은 발송
      { id: 's4', student: { parent_phone_1: '01055556666', message_consent: { promo: { optedIn: true, revokedAt: new Date() } } } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, { campaignId: 'c1', content: '안내', recipientField: undefined, scheduledDate: null, imageId: 'mms-1' });
    expect(stats).toMatchObject({ total: 4, queued: 3, skipped_no_phone: 1 });
    expect(docs.every((d) => d.kind === 'direct' && d.content === '안내')).toBe(true);
    expect(docs.every((d) => d.image_id === 'mms-1')).toBe(true);
    expect(docs.every((d) => d.disable_sms == null && d.targeting == null && d.ad_flag == null)).toBe(true);
    expect(docs.map((d) => d.recipient_phone)).toEqual(['01011112222', '01033334444', '01055556666']);
  });
});

function makeDb() {
  const docs = {};
  let n = 0;
  const col = (name) => ({
    async get() {
      const matched = Object.entries(docs)
        .filter(([k]) => k.startsWith(`${name}/`))
        .map(([k, v]) => ({ id: k.slice(name.length + 1), exists: true, data: () => v }));
      return { docs: matched };
    },
    doc: (id) => { const key = id ?? `${name}_auto_${n++}`; return {
      collectionName: name,
      id: id ?? key,
      async get() { return { exists: !!docs[`${name}/${key}`], data: () => docs[`${name}/${key}`] }; },
      async set(v) { docs[`${name}/${key}`] = v; },
      async create(v) {
        if (docs[`${name}/${key}`] !== undefined) {
          const err = new Error('ALREADY_EXISTS'); err.code = 6; throw err;
        }
        docs[`${name}/${key}`] = v;
      },
      async update(v) { docs[`${name}/${key}`] = { ...docs[`${name}/${key}`], ...v }; },
    }; },
    where: (field, _op, val) => ({
      async get() {
        const matched = Object.entries(docs)
          .filter(([k, v]) => k.startsWith(`${name}/`) && v?.[field] === val)
          .map(([, v]) => ({ data: () => v }));
        return { docs: matched };
      },
    }),
  });
  return {
    _docs: docs,
    collection: col,
    async getAll(...refs) { return refs.map((r) => ({ id: r.id, exists: !!docs[`${r.collectionName}/${r.id}`], data: () => docs[`${r.collectionName}/${r.id}`] })); },
    async runTransaction(fn) {
      const ops = [];
      const tx = {
        get: async (ref) => { const s = await ref.get(); return { exists: s.exists, data: s.data }; },
        update: (ref, v) => { ops.push(() => ref.update(v)); },
      };
      const res = await fn(tx);
      for (const op of ops) await op();
      return res;
    },
    batch() { const ops = []; return { set: (ref, v) => ops.push([ref, v]), create: (ref, v) => ops.push([ref, v, true]), async commit() { for (const [ref, v] of ops) await ref.set(v); } }; },
  };
}

describe('교직원 대량 문자', () => {
  it('%이름 개인화 시 동일 번호도 각 교직원 이름으로 큐잉한다', () => {
    const entries = [
      { id: 'st1', staff: { name: '김재직', phone: '010-1111-2222' } },
      { id: 'st2', staff: { name: '박번호없음', phone: '' } },
      { id: 'st3', staff: { name: '이중복', phone: '01011112222' } },
    ];
    const { docs, stats } = buildStaffRecipients(entries, { campaignId: 'c1', content: '%이름 안내', scheduledDate: null });
    expect(stats).toMatchObject({ total: 3, queued: 2, skipped_no_phone: 1, deduped: 0 });
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ staff_id: 'st1', recipient_role: 'staff', recipient_phone: '01011112222', content: '김재직 안내' });
    expect(docs[1]).toMatchObject({ staff_id: 'st3', recipient_role: 'staff', recipient_phone: '01011112222', content: '이중복 안내' });
    expect(docs[0].student_id).toBeUndefined();
  });

  it('개인화가 없으면 동일 번호를 한 번만 큐잉한다', () => {
    const entries = [
      { id: 'st1', staff: { name: '김재직', phone: '010-1111-2222' } },
      { id: 'st2', staff: { name: '이중복', phone: '01011112222' } },
    ];
    const { docs, stats } = buildStaffRecipients(entries, { campaignId: 'c1', content: '업무 안내', scheduledDate: null });
    expect(stats).toMatchObject({ total: 2, queued: 1, deduped: 1 });
    expect(docs).toHaveLength(1);
  });

  it('발송 시점에 HR 허용 상태가 아닌 교직원은 제외한다', () => {
    const entries = [
      { id: 'st1', staff: { name: '입사대기', phone: '01011112222', status: 'join_pending', plannedJoinDate: '2999-01-01' } },
      { id: 'st2', staff: { name: '재직자', phone: '01022223333', status: 'active' } },
    ];
    const { docs, stats } = buildStaffRecipients(entries, {
      campaignId: 'c1', content: '업무 안내', scheduledDate: null, dateKst: '2026-07-16',
    });
    expect(stats).toMatchObject({ total: 2, queued: 1, skipped_status: 1 });
    expect(docs.map((doc) => doc.staff_id)).toEqual(['st2']);
  });
});

describe('handleGetBulkStaffRecipients', () => {
  it('manager 이상만 조회하고 최소 필드만 반환한다', async () => {
    const db = makeDb();
    db._docs['staff/st1'] = {
      name: '김재직', status: 'active', department: '교수', affiliation: '2단지', phone: '010-1111-2222',
      residentNumber: 'secret', bankInfo: { accountNumber: 'secret' },
    };
    const result = await handleGetBulkStaffRecipients({ auth }, { db, todayKst: '2026-07-16' });
    expect(assertManagerOrAbove).toHaveBeenCalledWith(auth, db);
    expect(result.recipients).toEqual([{
      id: 'st1', name: '김재직', status: 'active', department: '교수', affiliation: '2단지', phoneAvailable: true,
    }]);
    expect(JSON.stringify(result)).not.toContain('010-1111-2222');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('HR 인사일자와 휴직 예정 상태를 재직·휴직·퇴직으로 파생한다', async () => {
    const db = makeDb();
    db._docs['staff/leave'] = { name: '휴직자', status: 'active', leaveDate: '2026-07-01', phone: '01011112222' };
    db._docs['staff/return'] = { name: '복직자', status: 'inactive', returnDate: '2026-07-01', phone: '01022223333' };
    db._docs['staff/retired'] = { name: '퇴직자', status: 'active', resignationDate: '2026-07-01', phone: '01033334444' };
    db._docs['staff/leave-pending'] = { name: '휴직예정자', status: 'leave_pending', phone: '01044445555' };
    const result = await handleGetBulkStaffRecipients({ auth }, { db, todayKst: '2026-07-16' });
    expect(Object.fromEntries(result.recipients.map(({ name, status }) => [name, status]))).toEqual({
      복직자: 'active',
      퇴직자: 'terminated',
      휴직예정자: 'active',
      휴직자: 'inactive',
    });
  });

  it('manager 권한 검사를 통과하지 못하면 조회를 거부한다', async () => {
    const db = makeDb();
    assertManagerOrAbove.mockRejectedValueOnce(new Error('관리자 권한이 필요합니다'));
    await expect(handleGetBulkStaffRecipients({ auth }, { db, todayKst: '2026-07-16' }))
      .rejects.toThrow('관리자 권한');
  });
});

describe('buildBulkRecipients — recipientFields 다중선택 + dedup', () => {
  it('recipientFields 2개 선택 시 학생당 2번호 enqueue', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222', parent_phone_2: '01033334444' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1', content: '안내',
      recipientFields: ['parent_1', 'parent_2'], scheduledDate: null,
    });
    expect(stats).toMatchObject({ total: 1, queued: 2, skipped_no_phone: 0, deduped: 0 });
    expect(docs.map((d) => d.recipient_phone)).toEqual(['01011112222', '01033334444']);
  });

  it('형제·같은 학부모 동일번호는 1건만 enqueue되고 deduped에 카운트', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222' } },
      { id: 's2', student: { parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1', content: '안내',
      recipientFields: ['parent_1'], scheduledDate: null,
    });
    expect(stats).toMatchObject({ total: 2, queued: 1, deduped: 1 });
    expect(docs).toHaveLength(1);
  });

  it('한 학생의 두 필드가 같은 번호면 1건만', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222', parent_phone_2: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1', content: '안내',
      recipientFields: ['parent_1', 'parent_2'], scheduledDate: null,
    });
    expect(stats).toMatchObject({ queued: 1, deduped: 1 });
    expect(docs).toHaveLength(1);
  });

  it('단일 recipientField 하위호환 — stats에 deduped:0 포함, 기존 동작 유지', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1', content: '안내',
      recipientField: 'parent_1', scheduledDate: null,
    });
    expect(stats).toMatchObject({ total: 1, queued: 1, skipped_no_phone: 0, deduped: 0 });
    expect(docs).toHaveLength(1);
  });

  it('번호없음 skip 유지 (recipientFields 사용 시)', () => {
    const entries = [
      { id: 's1', student: {} },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1', content: '안내',
      recipientFields: ['parent_1', 'parent_2'], scheduledDate: null,
    });
    expect(stats).toMatchObject({ total: 1, queued: 0, skipped_no_phone: 1 });
    expect(docs).toHaveLength(0);
  });
});

describe('알림톡 수신자·변수 구성', () => {
  const template = {
    templateId: 'TPL_COUNSEL',
    name: '상담 안내',
    content: '#{학생명} 학생 상담은 #{상담일시}입니다.',
    variables: [{ name: '#{학생명}' }, { name: '#{상담일시}' }],
    buttons: [],
  };

  it('학생명은 학생별로 치환하고 형제 동일 번호도 각각 큐잉한다', () => {
    const entries = [
      { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222' } },
      { id: 's2', student: { name: '이영희', parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkAlimtalkRecipients(entries, {
      campaignId: 'c1', template, templateVariables: { '#{상담일시}': '7월 20일 15시' },
      recipientFields: ['parent_1'], scheduledDate: '2026-07-20 14:00:00',
    });
    expect(stats).toMatchObject({ queued: 2, deduped: 0 });
    expect(docs[0]).toMatchObject({
      kind: 'bulk_alimtalk', template_code: 'TPL_COUNSEL',
      template_variables: { '#{학생명}': '김철수', '#{상담일시}': '7월 20일 15시' },
      fallback_text: '김철수 학생 상담은 7월 20일 15시입니다.',
      scheduled_date: '2026-07-20 14:00:00',
    });
    expect(docs[1].template_variables['#{학생명}']).toBe('이영희');
  });

  it('템플릿에 없는 변수와 누락된 변수 값을 거부한다', () => {
    expect(() => validateAlimtalkVariables(template, { '#{다른값}': 'x' })).toThrow('템플릿에 없는 변수');
    expect(() => validateAlimtalkVariables(template, {})).toThrow('템플릿 변수 값을 입력하세요');
  });

  it('studentNameAuto=false면 #{학생명}도 입력 변수로 요구한다', () => {
    expect(() => validateAlimtalkVariables(template, { '#{상담일시}': '7월 20일' }, { studentNameAuto: false }))
      .toThrow('템플릿 변수 값을 입력하세요: #{학생명}');
    expect(validateAlimtalkVariables(template, { '#{학생명}': '학부모님', '#{상담일시}': '7월 20일' }, { studentNameAuto: false }))
      .toEqual({ '#{학생명}': '학부모님', '#{상담일시}': '7월 20일' });
  });

  it('학생명 변수가 없는 템플릿은 이름 미주입 + 형제 동일 번호를 1건으로 합친다', () => {
    const noName = { templateId: 'TPL_NOTICE', content: '휴원 안내', variables: [], buttons: [] };
    const { docs, stats } = buildBulkAlimtalkRecipients(
      [
        { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222' } },
        { id: 's2', student: { name: '이영희', parent_phone_1: '01011112222' } },
      ],
      { campaignId: 'c1', template: noName, templateVariables: {}, recipientFields: ['parent_1'], scheduledDate: null },
    );
    expect(stats).toMatchObject({ queued: 1, deduped: 1 });
    expect(docs).toHaveLength(1);
    expect(docs[0].template_variables).toEqual({});
  });

  it('교직원 알림톡은 재직·유효번호만 큐잉하고 #{학생명}에 직원 이름을 넣는다', () => {
    const entries = [
      { id: 'st1', staff: { name: '김직원', phone: '010-5555-6666', status: 'active' } },
      { id: 'st2', staff: { name: '이중복', phone: '01055556666', status: 'active' } },
      { id: 'st3', staff: { name: '박대기', phone: '01077778888', status: 'join_pending', plannedJoinDate: '2999-01-01' } },
      { id: 'st4', staff: { name: '최무번', phone: '', status: 'active' } },
    ];
    // 이름 변수 템플릿 = 개인화 발송 — SMS(%이름)와 동일하게 동일 번호도 각각 발송.
    const { docs, stats } = buildStaffAlimtalkRecipients(entries, {
      campaignId: 'c1', template, templateVariables: { '#{상담일시}': '7월 20일 15시' }, scheduledDate: null, dateKst: '2026-07-16',
    });
    expect(stats).toMatchObject({ total: 4, queued: 2, deduped: 0, skipped_status: 1, skipped_no_phone: 1 });
    expect(docs[0]).toMatchObject({
      kind: 'bulk_alimtalk', staff_id: 'st1', recipient_role: 'staff', recipient_phone: '01055556666',
      template_code: 'TPL_COUNSEL',
      template_variables: { '#{학생명}': '김직원', '#{상담일시}': '7월 20일 15시' },
    });
    expect(docs[1].template_variables['#{학생명}']).toBe('이중복');

    const noName = { templateId: 'TPL_NOTICE', content: '휴원 안내', variables: [], buttons: [] };
    const uniform = buildStaffAlimtalkRecipients(entries, {
      campaignId: 'c1', template: noName, templateVariables: {}, scheduledDate: null, dateKst: '2026-07-16',
    });
    expect(uniform.stats).toMatchObject({ queued: 1, deduped: 1 });
  });
});

describe('applyMessageVars', () => {
  it('각 토큰을 학생 필드 값으로 치환', () => {
    const student = {
      name: '김철수',
      level: '중등',
      school_middle: '봉영여중',
      grade: 2,
      enrollments: [{ level_symbol: 'HA', class_number: '101' }],
    };
    expect(applyMessageVars('%이름 %학교 %학년 %반', student)).toBe('김철수 봉영여중 2 HA101');
  });

  it('값이 없으면 빈 문자열로 치환', () => {
    const student = {};
    expect(applyMessageVars('%이름/%학교/%학년/%반', student)).toBe('///');
  });

  it('변수 없는 문자열은 그대로 반환', () => {
    expect(applyMessageVars('안내 문자입니다.', { name: '김철수' })).toBe('안내 문자입니다.');
  });

  it('여러 번 등장하는 같은 토큰도 모두 치환', () => {
    const student = { name: '이영희' };
    expect(applyMessageVars('%이름 학생, %이름 학생', student)).toBe('이영희 학생, 이영희 학생');
  });
});

describe('buildBulkRecipients — 변수 치환 + dedup 상충', () => {
  it('변수 포함 본문 → 학생별 content 다름', () => {
    const entries = [
      { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222' } },
      { id: 's2', student: { name: '이영희', parent_phone_1: '01033334444' } },
    ];
    const { docs } = buildBulkRecipients(entries, {
      campaignId: 'c1',
      content: '%이름 학부모님께',
      recipientFields: ['parent_1'],
      scheduledDate: null,
    });
    expect(docs[0].content).toBe('김철수 학부모님께');
    expect(docs[1].content).toBe('이영희 학부모님께');
  });

  it('변수 포함 본문 → 동일 번호도 각각 enqueue(dedup 비활성)', () => {
    const entries = [
      { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222' } },
      { id: 's2', student: { name: '이영희', parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1',
      content: '%이름 학부모님',
      recipientFields: ['parent_1'],
      scheduledDate: null,
    });
    expect(docs).toHaveLength(2);
    expect(stats.deduped).toBe(0);
    expect(docs[0].content).toBe('김철수 학부모님');
    expect(docs[1].content).toBe('이영희 학부모님');
  });

  it('변수 없는 본문 → 기존 dedup 유지(동일 번호 1건만)', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222' } },
      { id: 's2', student: { parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1',
      content: '안내 문자입니다.',
      recipientFields: ['parent_1'],
      scheduledDate: null,
    });
    expect(docs).toHaveLength(1);
    expect(stats.deduped).toBe(1);
  });

  // P2: 변수 본문에서도 한 학생 내(intra-entry) 동일 번호는 1건만 발송.
  it('변수 본문 + 한 학생이 두 필드에 같은 번호 → 1건만 enqueue', () => {
    const entries = [
      { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222', parent_phone_2: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1',
      content: '%이름 학부모님께',
      recipientFields: ['parent_1', 'parent_2'],
      scheduledDate: null,
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('김철수 학부모님께');
    expect(stats.queued).toBe(1);
  });

  it('변수 본문 + 형제 동일 번호 → 각각 enqueue(inter-entry dedup 비활성 유지)', () => {
    const entries = [
      { id: 's1', student: { name: '김철수', parent_phone_1: '01011112222' } },
      { id: 's2', student: { name: '이영희', parent_phone_1: '01011112222' } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, {
      campaignId: 'c1',
      content: '%이름 학부모님',
      recipientFields: ['parent_1'],
      scheduledDate: null,
    });
    expect(docs).toHaveLength(2);
    expect(stats.deduped).toBe(0);
  });
});

describe('handleCreateBulkMessage', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
    db._docs['students/s1'] = { parent_phone_1: '01011112222' };
    db._docs['students/s2'] = { parent_phone_1: '01033334444' };
  });

  it('enqueues direct SMS/LMS docs for all valid students', async () => {
    const res = await handleCreateBulkMessage({ auth, data: { title: '개강', content: '여름학기 개강 안내', studentIds: ['s1', 's2'] } }, { db });
    expect(res.stats).toMatchObject({ total: 2, queued: 2 });
    const queue = Object.entries(db._docs).filter(([k]) => k.startsWith('message_queue/')).map(([, v]) => v);
    expect(queue).toHaveLength(2);
    expect(queue.every((d) => d.kind === 'direct' && d.content === '여름학기 개강 안내')).toBe(true);
  });

  it('승인 템플릿을 재검증해 학생별 알림톡 큐를 등록한다', async () => {
    db._docs['students/s1'].name = '김학생';
    const template = {
      templateId: 'TPL_COUNSEL', name: '상담 안내', status: 'APPROVED',
      content: '#{학생명} 학생 상담은 #{상담일시}입니다.',
      variables: [{ name: '#{학생명}' }, { name: '#{상담일시}' }], buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    const res = await handleCreateBulkMessage({
      auth,
      data: {
        channel: 'alimtalk', templateId: 'TPL_COUNSEL', studentIds: ['s1'],
        recipientFields: ['parent_1'], templateVariables: { '#{상담일시}': '7월 20일 15시' },
        requestId: 'alimtalk-1',
      },
    }, { db, getAlimtalkTemplate });
    expect(getAlimtalkTemplate).toHaveBeenCalledWith('TPL_COUNSEL');
    expect(res.stats).toMatchObject({ total: 1, queued: 1 });
    const queue = Object.entries(db._docs)
      .find(([key, value]) => key.startsWith('message_queue/') && value.kind === 'bulk_alimtalk')?.[1];
    expect(queue).toMatchObject({
      student_id: 's1', recipient_role: 'parent_1', template_code: 'TPL_COUNSEL',
      template_variables: { '#{학생명}': '김학생', '#{상담일시}': '7월 20일 15시' },
    });
    expect(db._docs['bulk_campaigns/alimtalk-1']).toMatchObject({ kind: 'bulk_alimtalk', template_code: 'TPL_COUNSEL' });
  });

  it('교직원 알림톡을 매니저 게이트로 큐잉하고 #{학생명}에 직원 이름을 넣는다', async () => {
    db._docs['staff/st1'] = { name: '김직원', phone: '01055556666', status: 'active' };
    const template = {
      templateId: 'TPL_COUNSEL', name: '상담 안내', status: 'APPROVED',
      content: '#{학생명} 상담은 #{상담일시}입니다.',
      variables: [{ name: '#{학생명}' }, { name: '#{상담일시}' }], buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    const res = await handleCreateBulkMessage({
      auth,
      data: {
        channel: 'alimtalk', templateId: 'TPL_COUNSEL', staffIds: ['st1'],
        templateVariables: { '#{상담일시}': '7월 20일 15시' }, requestId: 'alimtalk-staff-1',
      },
    }, { db, getAlimtalkTemplate });
    expect(assertManagerOrAbove).toHaveBeenCalled();
    expect(res.stats).toMatchObject({ total: 1, queued: 1 });
    const queue = Object.entries(db._docs)
      .find(([key, value]) => key.startsWith('message_queue/') && value.kind === 'bulk_alimtalk')?.[1];
    expect(queue).toMatchObject({
      staff_id: 'st1', recipient_role: 'staff', template_code: 'TPL_COUNSEL',
      template_variables: { '#{학생명}': '김직원', '#{상담일시}': '7월 20일 15시' },
    });
  });

  it('학생 알림톡은 받는이에 학생 본인 번호도 허용한다', async () => {
    db._docs['students/s1'] = { name: '김학생', student_phone: '01099998888', parent_phone_1: '01011112222' };
    const template = {
      templateId: 'TPL_NOTICE', name: '공지', status: 'APPROVED',
      content: '#{학생명} 안내', variables: [{ name: '#{학생명}' }], buttons: [],
    };
    const getAlimtalkTemplate = vi.fn().mockResolvedValue(template);
    const res = await handleCreateBulkMessage({
      auth,
      data: {
        channel: 'alimtalk', templateId: 'TPL_NOTICE', studentIds: ['s1'],
        recipientFields: ['student', 'parent_1'], requestId: 'alimtalk-student-field',
      },
    }, { db, getAlimtalkTemplate });
    expect(res.stats).toMatchObject({ queued: 2 });
    const roles = Object.entries(db._docs)
      .filter(([key, value]) => key.startsWith('message_queue/') && value.kind === 'bulk_alimtalk')
      .map(([, value]) => value.recipient_role)
      .sort();
    expect(roles).toEqual(['parent_1', 'student']);
  });

  it('알림톡에서 MMS 첨부와 지원 외 받는이 필드를 거부한다', async () => {
    await expect(handleCreateBulkMessage({
      auth, data: { channel: 'alimtalk', templateId: 'TPL', studentIds: ['s1'], mmsImage: { dataBase64: 'x' } },
    }, { db })).rejects.toThrow('MMS 이미지를 첨부할 수 없습니다');
    await expect(handleCreateBulkMessage({
      auth, data: { channel: 'alimtalk', templateId: 'TPL', studentIds: ['s1'], recipientFields: ['other'] },
    }, { db })).rejects.toThrow('학생·학부모 연락처만');
  });

  it('rejects empty content / empty studentIds', async () => {
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: ' ', studentIds: ['s1'] } }, { db })).rejects.toThrow();
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: 'x', studentIds: [] } }, { db })).rejects.toThrow();
  });

  it('studentIds와 staffIds 혼합 요청을 거부한다', async () => {
    db._docs['staff/st1'] = { name: '직원', phone: '01055556666', status: 'active' };
    await expect(handleCreateBulkMessage({
      auth,
      data: { title: 't', content: 'x', studentIds: ['s1'], staffIds: ['st1'] },
    }, { db })).rejects.toThrow('함께 발송할 수 없습니다');
  });

  it('manager가 선택한 교직원 번호를 서버에서 조회해 큐잉한다', async () => {
    db._docs['staff/st1'] = { name: '김재직', phone: '010-5555-6666', status: 'active' };
    const res = await handleCreateBulkMessage({
      auth,
      data: { title: 't', content: '%이름 업무 안내', staffIds: ['st1'], requestId: 'staff-1' },
    }, { db });
    expect(assertManagerOrAbove).toHaveBeenCalledWith(auth, db);
    expect(res.stats).toMatchObject({ total: 1, queued: 1 });
    const queue = Object.values(db._docs).find((v) => v.staff_id === 'st1');
    expect(queue).toMatchObject({ recipient_role: 'staff', recipient_phone: '01055556666', content: '김재직 업무 안내' });
    expect(queue.student_id).toBeUndefined();
  });

  it('교직원 발송은 학생 전용 변수를 거부한다', async () => {
    await expect(handleCreateBulkMessage({
      auth,
      data: { title: 't', content: '%학교 안내', staffIds: ['st1'] },
    }, { db })).rejects.toThrow('교직원 문자 변수는 %이름만 사용할 수 있습니다');
  });

  it('교직원 대상도 한 번에 10,000명을 넘길 수 없다', async () => {
    const staffIds = Array.from({ length: 10001 }, (_, i) => `staff-${i}`);
    await expect(handleCreateBulkMessage({
      auth,
      data: { title: 't', content: '안내', staffIds },
    }, { db })).rejects.toThrow('한 번에 최대 10000명');
  });

  it('accepts up to 10,000 recipients and rejects more', async () => {
    const studentIds = Array.from({ length: 10000 }, (_, i) => `bulk-${i}`);
    for (let i = 0; i < studentIds.length; i += 1) {
      db._docs[`students/${studentIds[i]}`] = { parent_phone_1: `010${String(i).padStart(8, '0')}` };
    }
    const accepted = await handleCreateBulkMessage(
      { auth, data: { title: 't', content: 'x', studentIds } },
      { db },
    );
    expect(accepted.stats).toMatchObject({ total: 10000, queued: 10000, skipped_missing: 0 });
    expect(Object.keys(db._docs).filter((key) => key.startsWith('message_queue/'))).toHaveLength(10000);

    await expect(handleCreateBulkMessage(
      { auth, data: { title: 't', content: 'x', studentIds: [...studentIds, 'bulk-over'] } },
      { db },
    )).rejects.toThrow('한 번에 최대 10000명');
  });

  it('실제 큐 문서가 10,000건을 넘으면 거부', async () => {
    const studentIds = Array.from({ length: 5001 }, (_, i) => `multi-${i}`);
    for (let i = 0; i < studentIds.length; i += 1) {
      db._docs[`students/${studentIds[i]}`] = {
        parent_phone_1: `010${String(i).padStart(8, '0')}`,
        parent_phone_2: `011${String(i).padStart(8, '0')}`,
      };
    }
    await expect(handleCreateBulkMessage({
      auth,
      data: { title: 't', content: 'x', studentIds, recipientFields: ['parent_1', 'parent_2'] },
    }, { db })).rejects.toThrow('한 번에 최대 10000건');
    expect(Object.keys(db._docs).filter((key) => key.startsWith('message_queue/'))).toHaveLength(0);
  });

  it('is idempotent on requestId', async () => {
    const data = { title: 't', content: 'x', studentIds: ['s1'], requestId: 'b-1' };
    await handleCreateBulkMessage({ auth, data }, { db });
    const second = await handleCreateBulkMessage({ auth, data }, { db });
    expect(second.duplicate).toBe(true);
    const queue = Object.keys(db._docs).filter((k) => k.startsWith('message_queue/'));
    expect(queue).toHaveLength(1);
  });

  it('is idempotent on concurrent requestId (no double enqueue)', async () => {
    const data = { title: 't', content: 'x', studentIds: ['s1'], requestId: 'b-concurrent' };
    const [r1, r2] = await Promise.all([
      handleCreateBulkMessage({ auth, data }, { db }),
      handleCreateBulkMessage({ auth, data }, { db }),
    ]);
    expect([r1, r2].filter((r) => !r.duplicate)).toHaveLength(1);
    expect([r1, r2].filter((r) => r.duplicate)).toHaveLength(1);
    expect(Object.keys(db._docs).filter((k) => k.startsWith('message_queue/'))).toHaveLength(1);
  });

  it('enqueuing 고착(lease 만료) 재호출 → 이미 enqueue된 학생 제외하고 잔여만 재개', async () => {
    const now = new Date('2026-07-04T05:00:00Z');
    db._docs['bulk_campaigns/b-stuck'] = {
      status: 'enqueuing', stats: {}, content: 'x',
      enqueue_started_at: now.getTime() - 20 * 60 * 1000,
      request_fingerprint: bulkFp(['s1', 's2']),
    };
    db._docs['message_queue/q1'] = { kind: 'direct', campaign_id: 'b-stuck', student_id: 's1' };
    const res = await handleCreateBulkMessage(
      { auth, data: { title: 't', content: 'x', studentIds: ['s1', 's2'], requestId: 'b-stuck' } },
      { db, now },
    );
    expect(res.duplicate).toBeUndefined();
    const queue = Object.entries(db._docs).filter(([k]) => k.startsWith('message_queue/')).map(([, v]) => v);
    expect(queue.filter((q) => q.student_id === 's1')).toHaveLength(1);
    expect(queue.filter((q) => q.student_id === 's2')).toHaveLength(1);
    expect(db._docs['bulk_campaigns/b-stuck'].status).toBe('queued');
  });

  it('다중 수신 캠페인 재개 시 이미 저장된 역할만 제외하고 남은 역할을 큐잉', async () => {
    const now = new Date('2026-07-04T05:00:00Z');
    db._docs['students/s1'].student_phone = '01055556666';
    db._docs['students/s1'].parent_phone_2 = '01077778888';
    db._docs['bulk_campaigns/b-multi-stuck'] = {
      status: 'enqueuing', stats: {}, content: 'x',
      enqueue_started_at: now.getTime() - 20 * 60 * 1000,
      request_fingerprint: recipientFingerprint(['s1'], {
        recipientField: null,
        recipientFields: ['student', 'parent_2'],
      }),
    };
    db._docs['message_queue/q1'] = {
      kind: 'direct', campaign_id: 'b-multi-stuck', student_id: 's1', recipient_role: 'student',
    };
    await handleCreateBulkMessage({
      auth,
      data: {
        title: 't', content: 'x', studentIds: ['s1'],
        recipientFields: ['student', 'parent_2'], requestId: 'b-multi-stuck',
      },
    }, { db, now });
    const queue = Object.values(db._docs).filter((value) => value.campaign_id === 'b-multi-stuck');
    expect(queue.map((value) => value.recipient_role).sort()).toEqual(['parent_2', 'student']);
  });

  it('enqueuing 진행 중(lease 유효) 재호출 → duplicate 단락 (더블클릭 race 차단)', async () => {
    const now = new Date('2026-07-04T05:00:00Z');
    db._docs['bulk_campaigns/b-live'] = {
      status: 'enqueuing', stats: {}, content: 'x',
      enqueue_started_at: now.getTime() - 5000,
    };
    const res = await handleCreateBulkMessage(
      { auth, data: { title: 't', content: 'x', studentIds: ['s1'], requestId: 'b-live' } },
      { db, now },
    );
    expect(res.duplicate).toBe(true);
    expect(Object.keys(db._docs).some((k) => k.startsWith('message_queue/'))).toBe(false);
  });

  it('재개 요청의 본문이 다르면 거부', async () => {
    const now = new Date('2026-07-04T05:00:00Z');
    db._docs['bulk_campaigns/b-diff'] = {
      status: 'enqueuing', stats: {}, content: '원래 본문',
      enqueue_started_at: now.getTime() - 20 * 60 * 1000,
      request_fingerprint: bulkFp(['s1']),
    };
    await expect(
      handleCreateBulkMessage(
        { auth, data: { title: 't', content: '다른 본문', studentIds: ['s1'], requestId: 'b-diff' } },
        { db, now },
      ),
    ).rejects.toThrow('원 캠페인과 다릅니다');
  });

  it('재개 요청의 대상/수신필드 구성이 다르면 거부 — 공유번호 dedup 귀속 변경 차단', async () => {
    const now = new Date('2026-07-04T05:00:00Z');
    db._docs['bulk_campaigns/b-fp'] = {
      status: 'enqueuing', stats: {}, content: 'x',
      enqueue_started_at: now.getTime() - 20 * 60 * 1000,
      request_fingerprint: bulkFp(['s1', 's2']),
    };
    await expect(
      handleCreateBulkMessage(
        { auth, data: { title: 't', content: 'x', studentIds: ['s2'], requestId: 'b-fp' } },
        { db, now },
      ),
    ).rejects.toThrow('원 캠페인과 다릅니다');
  });
});
