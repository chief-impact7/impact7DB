import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn(), assertDirector: vi.fn() }));

const {
  buildPromoSmsQueueDoc, buildPromoRecipients,
  assertAdContentCompliant, resolvePromoScheduledDate,
  handleCreatePromoCampaign,
} = await import('../src/promoCampaignHandler.js');
const { recipientFingerprint } = await import('../src/campaignResume.js');

const kst = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));
const promoFp = (ids) => recipientFingerprint(ids, { recipientField: null, recipientFields: null });

describe('buildPromoSmsQueueDoc', () => {
  it('opted-in → promo_sms, marketing ad_flag, consent snapshot with source/at', () => {
    const d = buildPromoSmsQueueDoc({
      studentId: 's1', phone: '01011112222',
      consent: { source: 'diagnostic_form', at: '<ts>' },
      campaignId: 'c1', content: '(광고)x', scheduledDate: '2026-06-18 08:00:00',
      imageId: 'mms-1',
    });
    expect(d.kind).toBe('promo_sms');
    expect(d.ad_flag).toBe(true);
    expect(d.scheduled_date).toBe('2026-06-18 08:00:00');
    expect(d.image_id).toBe('mms-1');
    expect(d.consent_snapshot).toEqual({ sms: true, source: 'diagnostic_form', at: '<ts>' });
  });
});

describe('buildPromoRecipients (phone + opt-out + consent gating)', () => {
  it('excludes no-phone and revoked; counts SMS-eligible', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '010-1111-2222', message_consent: { promo: { optedIn: true } } } }, // 동의+번호
      { id: 's2', student: { parent_phone_1: '010-3333-4444' } }, // 번호만, 미동의 → 제외
      { id: 's3', student: { name: '무번호' } }, // 번호 없음 → skip
      { id: 's4', student: { parent_phone_1: '010-5555-6666', message_consent: { promo: { optedIn: true, revokedAt: 1 } } } }, // 철회 → 전면 제외
    ];
    const { docs, stats } = buildPromoRecipients(entries, { campaignId: 'c1', content: '(광고)x', targeting: 'M' });
    expect(stats.total).toBe(4);
    expect(stats.queued).toBe(1); // s1
    expect(stats.skipped_no_phone).toBe(1); // s3
    expect(stats.skipped_revoked).toBe(1); // s4
    expect(docs.find((d) => d.student_id === 's1').kind).toBe('promo_sms');
    expect(docs.find((d) => d.student_id === 's2')).toBeUndefined();
    expect(docs.find((d) => d.student_id === 's4')).toBeUndefined(); // 옵트아웃 → 큐에 없음
  });
});

describe('buildPromoRecipients — 광고 문자 큐잉', () => {
  const entries = [
    { id: 's1', student: { parent_phone_1: '01011112222', message_consent: { promo: { optedIn: true } } } },
    { id: 's2', student: { parent_phone_1: '01033334444', message_consent: { promo: { optedIn: true } } } },
    { id: 's3', student: { parent_phone_1: '01055556666' } }, // 미동의 → skip
    { id: 's4', student: { parent_phone_1: '01077778888', message_consent: { promo: { optedIn: true, revokedAt: 1 } } } }, // revoked → skip
    { id: 's5', student: {} }, // 번호 없음 → skip
  ];

  it('동의자만 kind=promo_sms, 미동의자는 skip', () => {
    const { docs, stats } = buildPromoRecipients(entries, {
      campaignId: 'c1', content: '(광고)x 무료거부 080-000-0000', targeting: 'M',
      scheduledDate: null, friendPhones: new Set(['01011112222']),
    });
    expect(stats.total).toBe(5);
    expect(stats.queued).toBe(2);
    expect(stats.ad_sms).toBe(2);
    expect(stats.skipped_no_consent).toBe(1); // s3
    expect(stats.skipped_revoked).toBe(1);    // s4
    expect(stats.skipped_no_phone).toBe(1);   // s5
    expect(docs.find((d) => d.student_id === 's1').kind).toBe('promo_sms');
    expect(docs.find((d) => d.student_id === 's2').kind).toBe('promo_sms');
    expect(docs.find((d) => d.student_id === 's3')).toBeUndefined();
  });

  it('promo_sms doc: recipient_phone·content·ad_flag·consent_snapshot 포함', () => {
    const { docs } = buildPromoRecipients(
      [{ id: 's2', student: { parent_phone_1: '01033334444', message_consent: { promo: { optedIn: true, source: 'diagnostic_form', at: '<ts>' } } } }],
      { campaignId: 'c1', content: '(광고)x 무료거부 080', targeting: 'M', scheduledDate: null, friendPhones: new Set() },
    );
    const d = docs[0];
    expect(d.kind).toBe('promo_sms');
    expect(d.recipient_phone).toBe('01033334444');
    expect(d.content).toBe('(광고)x 무료거부 080');
    expect(d.ad_flag).toBe(true);
    expect(d.consent_snapshot).toMatchObject({ sms: true, source: 'diagnostic_form' });
  });

  it('friendPhones 미제공 시에도 미동의자는 제외하고 동의자만 promo_sms', () => {
    const twoEntries = [
      { id: 's1', student: { parent_phone_1: '01011112222', message_consent: { promo: { optedIn: true } } } },
      { id: 's2', student: { parent_phone_1: '01033334444' } },
    ];
    const { docs, stats } = buildPromoRecipients(twoEntries, { campaignId: 'c1', content: 'x', targeting: 'M', scheduledDate: null });
    expect(stats.queued).toBe(1);
    expect(docs.every((d) => d.kind === 'promo_sms')).toBe(true);
    expect(docs.find((d) => d.student_id === 's2')).toBeUndefined();
  });

  it('recipientFields 다중 선택 시 역할별 큐를 만들고 같은 번호는 dedup한다', () => {
    const { docs, stats } = buildPromoRecipients(
      [{
        id: 's1',
        student: {
          student_phone: '01011112222',
          parent_phone_1: '01011112222',
          parent_phone_2: '01033334444',
          message_consent: {
            promo: { optedIn: true },
            promo_student: { optedIn: true },
          },
        },
      }],
      {
        campaignId: 'c1',
        content: '(광고)x 무료거부 080',
        targeting: 'M',
        scheduledDate: null,
        recipientFields: ['student', 'parent_1', 'parent_2'],
        friendPhones: new Set(['01011112222', '01033334444']),
      },
    );
    expect(stats.queued).toBe(2);
    expect(docs.map((d) => [d.recipient_role, d.recipient_phone, d.kind])).toEqual([
      ['student', '01011112222', 'promo_sms'],
      ['parent_2', '01033334444', 'promo_sms'],
    ]);
  });
});

describe('assertAdContentCompliant (정보통신망법 §50)', () => {
  it('passes ad content with (광고) + opt-out notice', () => {
    expect(() => assertAdContentCompliant('(광고)[임팩트세븐학원] 특강\n무료거부 080-123-4567', 'M')).not.toThrow();
  });
  it('rejects ad content missing (광고)', () => {
    expect(() => assertAdContentCompliant('[학원] 특강 무료거부 080', 'M')).toThrow();
  });
  it('rejects ad content missing opt-out', () => {
    expect(() => assertAdContentCompliant('(광고)[학원] 특강 안내', 'M')).toThrow();
  });
  it('skips the check for informational (I) messages', () => {
    expect(() => assertAdContentCompliant('성적 안내드립니다', 'I')).not.toThrow();
  });
  // P1: promo 캠페인은 targeting='I'로 호출해도 항상 광고 표기 강제 — handleCreatePromoCampaign이 'M'으로 위임
  it('targeting=I로 호출해도 (광고)+수신거부 누락 시 거부됨(promo 상시 M 위임)', () => {
    expect(() => assertAdContentCompliant('광고표기없는본문', 'M')).toThrow();
  });
});

describe('resolvePromoScheduledDate (night ad guard)', () => {
  it('returns null for daytime with no scheduledAt (immediate send)', () => {
    expect(resolvePromoScheduledDate(null, kst(2026, 6, 17, 14, 0))).toBeNull();
  });
  it('auto-defers a night "now" to next 08:00', () => {
    expect(resolvePromoScheduledDate(null, kst(2026, 6, 17, 22, 0))).toBe('2026-06-18 08:00:00');
  });
  it('keeps a daytime scheduledAt unchanged', () => {
    expect(resolvePromoScheduledDate('2026-06-18 14:00:00', kst(2026, 6, 17, 14, 0))).toBe('2026-06-18 14:00:00');
  });
  it('corrects a night scheduledAt to next 08:00 (no bypass)', () => {
    expect(resolvePromoScheduledDate('2026-06-18 23:00:00', kst(2026, 6, 17, 14, 0))).toBe('2026-06-19 08:00:00');
  });
  it('rejects a malformed scheduledAt', () => {
    expect(() => resolvePromoScheduledDate('not-a-date', kst(2026, 6, 17, 14, 0))).toThrow();
  });
});

// P1: targeting='I'로 handleCreatePromoCampaign 호출 시에도 광고 표기 없으면 거부됨.
describe('handleCreatePromoCampaign — promo 광고 표기 상시 강제(targeting=I 우회 차단)', () => {
  function makeDb(students = {}) {
    const docs = { ...students };
    let n = 0;
    const col = (name) => ({
      doc: (id) => {
        const key = id ?? `${name}_auto_${n++}`;
        return {
          id: key,
          async get() { return { exists: !!docs[`${name}/${key}`], data: () => docs[`${name}/${key}`] }; },
          async set(v) { docs[`${name}/${key}`] = v; },
          async update(v) { docs[`${name}/${key}`] = { ...docs[`${name}/${key}`], ...v }; },
          async create(v) {
            if (docs[`${name}/${key}`]) { const err = new Error('already exists'); err.code = 6; throw err; }
            docs[`${name}/${key}`] = v;
          },
        };
      },
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
      async getAll(...refs) {
        return refs.map((r) => ({ id: r.id, exists: !!docs[`students/${r.id}`], data: () => docs[`students/${r.id}`] }));
      },
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
      batch() {
        const ops = [];
        return { set: (ref, v) => ops.push([ref, v]), async commit() { for (const [ref, v] of ops) await ref.set(v); } };
      },
    };
  }

  const auth = { uid: 'u1', token: { email: 'staff@impact7.kr' } };

  it('targeting=I + 광고 표기 없는 본문 → 거부(정보통신망법 §50 우회 차단)', async () => {
    const db = makeDb({ 'students/s1': { parent_phone_1: '01011112222' } });
    await expect(
      handleCreatePromoCampaign(
        { auth, data: { title: '홍보', content: '광고표기없는본문입니다', studentIds: ['s1'], targeting: 'I' } },
        { db, now: kst(2026, 6, 17, 14, 0), loadFriendPhones: async () => new Set() },
      ),
    ).rejects.toThrow('광고 메시지 본문');
  });

  it('targeting=I + (광고)+수신거부 표기 포함 본문 → 통과', async () => {
    const db = makeDb({ 'students/s1': { parent_phone_1: '01011112222' } });
    await expect(
      handleCreatePromoCampaign(
        { auth, data: { title: '홍보', content: '(광고)이벤트 안내\n무료거부 080-000-0000', studentIds: ['s1'], targeting: 'I' } },
        { db, now: kst(2026, 6, 17, 14, 0), loadFriendPhones: async () => new Set() },
      ),
    ).resolves.toMatchObject({ campaignId: expect.any(String) });
  });

  const AD_CONTENT = '(광고)이벤트 안내\n무료거부 080-000-0000';
  const CONSENTED = { parent_phone_1: '01011112222', message_consent: { promo: { optedIn: true } } };
  const CONSENTED_2 = { parent_phone_1: '01033334444', message_consent: { promo: { optedIn: true } } };

  it('requestId 재호출: queued 완료 캠페인 → duplicate 반환(재발송 없음)', async () => {
    const db = makeDb({
      'students/s1': CONSENTED,
      'promo_campaigns/req1': { status: 'queued', stats: { queued: 1 }, scheduled_date: null },
    });
    const res = await handleCreatePromoCampaign(
      { auth, data: { title: '홍보', content: AD_CONTENT, studentIds: ['s1'], requestId: 'req1' } },
      { db, now: kst(2026, 6, 17, 14, 0), loadFriendPhones: async () => new Set() },
    );
    expect(res.duplicate).toBe(true);
    expect(Object.keys(db._docs).some((k) => k.startsWith('message_queue/'))).toBe(false);
  });

  it('requestId 재호출: enqueuing 고착(lease 만료) 캠페인 → 이미 enqueue된 학생 제외하고 잔여만 재개', async () => {
    const now = kst(2026, 6, 17, 14, 0);
    const db = makeDb({
      'students/s1': CONSENTED,
      'students/s2': CONSENTED_2,
      // 20분 전 시작된 enqueuing 고착 — lease(10분) 만료로 재개 대상
      'promo_campaigns/req1': {
        status: 'enqueuing', stats: { queued: 2 }, content: AD_CONTENT,
        enqueue_started_at: now.getTime() - 20 * 60 * 1000,
        request_fingerprint: promoFp(['s1', 's2']),
      },
      'message_queue/q1': { kind: 'promo_sms', campaign_id: 'req1', student_id: 's1' }, // 이전 호출이 s1까지 enqueue 후 실패
    });
    const res = await handleCreatePromoCampaign(
      { auth, data: { title: '홍보', content: AD_CONTENT, studentIds: ['s1', 's2'], requestId: 'req1' } },
      { db, now, loadFriendPhones: async () => new Set() },
    );
    expect(res.duplicate).toBeUndefined();
    const queued = Object.entries(db._docs).filter(([k]) => k.startsWith('message_queue/')).map(([, v]) => v);
    expect(queued.filter((q) => q.student_id === 's1')).toHaveLength(1); // 중복 없음
    expect(queued.filter((q) => q.student_id === 's2')).toHaveLength(1); // 잔여 재개
    expect(db._docs['promo_campaigns/req1'].status).toBe('queued');
  });

  it('requestId 재호출: 다중 수신 캠페인은 이미 enqueue된 역할만 제외하고 남은 역할을 재개', async () => {
    const now = kst(2026, 6, 17, 14, 0);
    const db = makeDb({
      'students/s1': {
        student_phone: '01011112222',
        parent_phone_2: '01033334444',
        message_consent: {
          promo: { optedIn: true },
          promo_student: { optedIn: true },
        },
      },
      'promo_campaigns/req1': {
        status: 'enqueuing', stats: { queued: 2 }, content: AD_CONTENT,
        enqueue_started_at: now.getTime() - 20 * 60 * 1000,
        request_fingerprint: recipientFingerprint(['s1'], {
          recipientField: null,
          recipientFields: ['student', 'parent_2'],
        }),
      },
      'message_queue/q1': { kind: 'promo', campaign_id: 'req1', student_id: 's1', recipient_role: 'student' },
    });
    await handleCreatePromoCampaign(
      { auth, data: { title: '홍보', content: AD_CONTENT, studentIds: ['s1'], recipientFields: ['student', 'parent_2'], requestId: 'req1' } },
      { db, now, loadFriendPhones: async () => new Set(['01011112222', '01033334444']) },
    );
    const queued = Object.entries(db._docs).filter(([k]) => k.startsWith('message_queue/')).map(([, v]) => v);
    expect(queued.map((q) => q.recipient_role).sort()).toEqual(['parent_2', 'student']);
    expect(queued.filter((q) => q.recipient_role === 'student')).toHaveLength(1);
  });

  it('requestId 재호출: enqueuing 진행 중(lease 유효) → duplicate 단락, 재발송 없음 (더블클릭 race 차단)', async () => {
    const now = kst(2026, 6, 17, 14, 0);
    const db = makeDb({
      'students/s1': CONSENTED,
      'students/s2': CONSENTED_2,
      // 5초 전 시작된 enqueuing — 다른 호출이 배치 커밋 중일 수 있으므로 손대면 안 됨
      'promo_campaigns/req1': { status: 'enqueuing', stats: { queued: 2 }, content: AD_CONTENT, enqueue_started_at: now.getTime() - 5000 },
    });
    const res = await handleCreatePromoCampaign(
      { auth, data: { title: '홍보', content: AD_CONTENT, studentIds: ['s1', 's2'], requestId: 'req1' } },
      { db, now, loadFriendPhones: async () => new Set() },
    );
    expect(res.duplicate).toBe(true);
    expect(Object.keys(db._docs).some((k) => k.startsWith('message_queue/'))).toBe(false);
  });

  it('재개 요청의 본문이 원 캠페인과 다르면 거부 — 한 캠페인 내 문구 혼합 차단', async () => {
    const now = kst(2026, 6, 17, 14, 0);
    const db = makeDb({
      'students/s1': CONSENTED,
      'promo_campaigns/req1': {
        status: 'enqueuing', stats: {}, content: AD_CONTENT,
        enqueue_started_at: now.getTime() - 20 * 60 * 1000,
        request_fingerprint: promoFp(['s1']),
      },
    });
    await expect(
      handleCreatePromoCampaign(
        { auth, data: { title: '홍보', content: '(광고)다른 문구\n무료거부 080-000-0000', studentIds: ['s1'], requestId: 'req1' } },
        { db, now, loadFriendPhones: async () => new Set() },
      ),
    ).rejects.toThrow('원 캠페인과 다릅니다');
  });

  it('재개 요청의 대상 구성이 다르면 거부 — phone dedup 귀속 변경으로 인한 중복 발송 차단', async () => {
    const now = kst(2026, 6, 17, 14, 0);
    const db = makeDb({
      'students/s1': CONSENTED,
      'students/s2': CONSENTED_2,
      'promo_campaigns/req1': {
        status: 'enqueuing', stats: {}, content: AD_CONTENT,
        enqueue_started_at: now.getTime() - 20 * 60 * 1000,
        request_fingerprint: promoFp(['s1', 's2']), // 원 호출은 s1+s2
      },
    });
    await expect(
      handleCreatePromoCampaign(
        { auth, data: { title: '홍보', content: AD_CONTENT, studentIds: ['s2'], requestId: 'req1' } }, // 재개는 s2만
        { db, now, loadFriendPhones: async () => new Set() },
      ),
    ).rejects.toThrow('원 캠페인과 다릅니다');
  });
});
