import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { buildBulkRecipients, handleCreateBulkMessage, applyMessageVars } = await import('../src/bulkMessageHandler.js');
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
    doc: (id) => { const key = id ?? `${name}_auto_${n++}`; return {
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
    async getAll(...refs) { return refs.map((r) => ({ id: r.id, exists: !!docs[`students/${r.id}`], data: () => docs[`students/${r.id}`] })); },
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

  it('rejects empty content / empty studentIds', async () => {
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: ' ', studentIds: ['s1'] } }, { db })).rejects.toThrow();
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: 'x', studentIds: [] } }, { db })).rejects.toThrow();
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
