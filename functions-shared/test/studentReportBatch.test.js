import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: {
    serverTimestamp: () => '<serverTimestamp>',
    delete: () => '<delete>',
  },
}));

vi.mock('../src/vertex.js', () => ({
  generateText: vi.fn(),
  generateTextWithUsage: vi.fn(),
}));

vi.mock('../src/notifyLog.js', () => ({ writeLog: vi.fn() }));

// generateReportForStudent를 모킹해 청크 로직(대상선정/스킵/타임박스/재개/락)만 검증.
const reportMock = vi.fn();
vi.mock('../src/studentReportAiHandler.js', () => ({
  generateReportForStudent: (...args) => reportMock(...args),
}));

const { runStudentReportChunk, AUTOMATION_DOC } = await import('../src/studentReportBatch.js');

const USAGE = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 };

// settings(automation 문서) + 학생/요약 데이터로 firestore mock.
// runTransaction(claim), getAll(skip 병렬 조회), merge set(누적 반영) 지원.
// opts.failGetAll=true면 getAll이 throw해 본문 크래시를 시뮬레이션.
function makeFirestore({ settings = {}, students = [], summaries = {}, failGetAll = false } = {}) {
  const automationWrites = [];
  let current = { ...settings };

  function applyMerge(target, data) {
    const next = { ...target };
    for (const [k, v] of Object.entries(data)) {
      if (v === '<delete>') delete next[k];
      else next[k] = v;
    }
    return next;
  }

  function collection(name) {
    return {
      where() { return this; },
      async get() {
        if (name === 'students') return { docs: students.map(s => ({ id: s.id, data: () => s })) };
        return { docs: [] };
      },
      doc(id) {
        if (name === 'student_status_summaries') return { __summaryId: id };
        return { async get() { return { exists: false }; } };
      },
    };
  }
  const settingsRef = {
    async get() { return { exists: Object.keys(current).length > 0, data: () => current }; },
    async set(data, opts) {
      automationWrites.push(data);
      if (opts?.merge) current = applyMerge(current, data);
      else current = { ...data };
    },
  };
  return {
    collection,
    doc(path) {
      if (path === AUTOMATION_DOC) return settingsRef;
      return { async get() { return { exists: false }; }, async set() {} };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, data, opts) { ref.set(data, opts); },
      };
      return fn(tx);
    },
    async getAll(...refs) {
      if (failGetAll) throw new Error('getAll exploded');
      return refs.map((ref) => {
        const gen = summaries[ref.__summaryId];
        return { exists: !!gen, data: () => ({ generated_at: gen }) };
      });
    },
    automationWrites,
    get settings() { return current; },
  };
}

const tsMillis = (ms) => ({ toMillis: () => ms });
// 항상 deadline 이전(무한 예산) 시계.
const fastClock = () => 0;

describe('runStudentReportChunk', () => {
  let generateWithUsage;
  beforeEach(() => {
    reportMock.mockReset();
    reportMock.mockResolvedValue({
      status: 'good', consultation_count: 0, consultation_gap_days: null,
      consultation_gap_warning: false, chat_mention_count: 0, usage: { ...USAGE },
    });
    generateWithUsage = vi.fn();
  });

  it('claims chunk_lock atomically then completes in one chunk when within budget', async () => {
    const firestore = makeFirestore({
      settings: { enabled: true },
      students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 'complete', done: 3, total: 3, generated: 3 });
    expect(r.total_tokens).toBe(450);
    expect(reportMock).toHaveBeenCalledTimes(3);

    // claim write: chunk_lock=true + run_started_at (last_run_at은 시작 시점에 쓰지 않음)
    const claim = firestore.automationWrites[0];
    expect(claim).toMatchObject({ chunk_lock: true, run_started_at: '<serverTimestamp>' });
    expect(claim).not.toHaveProperty('last_run_at');

    // 완료 write: last_run_* + batch_active=false + chunk_lock 해제 + run_* 클리어
    const final = firestore.automationWrites.at(-1);
    expect(final).toMatchObject({
      batch_active: false, chunk_lock: false,
      last_run_at: '<serverTimestamp>', last_run_status: 'success',
      last_run_generated: 3, last_run_skipped: 0, last_run_total_tokens: 450,
      progress_done: 3, progress_total: 3,
      run_pending_ids: '<delete>', run_actor: '<delete>', run_trigger: '<delete>',
    });
    expect(final.last_run_cost_usd).toBeGreaterThan(0);
    expect(firestore.settings.batch_active).toBe(false);
    expect(firestore.settings.run_pending_ids).toBeUndefined();
  });

  it('skips students generated within skip_within_days (fixed at first chunk)', async () => {
    const now = 100 * 86400000; // day 100
    const firestore = makeFirestore({
      settings: { skip_within_days: 7 },
      students: [{ id: 's1' }, { id: 's2' }],
      summaries: { s1: tsMillis(now - 2 * 86400000) }, // 2일 전 → 스킵
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: now });
    expect(r).toMatchObject({ status: 'complete', generated: 1, skipped: 1, total: 1 });
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0][0].studentId).toBe('s2');
  });

  it('timeboxes: stops grabbing new students past the deadline, leaving pending + batch_active', async () => {
    const firestore = makeFirestore({
      settings: { enabled: true },
      students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }],
    });
    // 시계가 매 호출 100씩 증가, maxRunMs=50 → deadline=base+50. 첫 pick 직후 곧 초과.
    let t = 0;
    const clock = () => { const v = t; t += 100; return v; };
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock, maxRunMs: 50, nowMs: 0 });
    expect(r.status).toBe('in_progress');
    expect(r.done).toBeLessThan(4);
    expect(r.total).toBe(4);

    const final = firestore.automationWrites.at(-1);
    expect(final).toMatchObject({ batch_active: true, chunk_lock: false, run_started_at: '<delete>' });
    expect(Array.isArray(final.run_pending_ids)).toBe(true);
    expect(final.run_pending_ids.length).toBeGreaterThan(0);
    expect(firestore.automationWrites.some(w => 'last_run_at' in w)).toBe(false);
  });

  it('resumes a batch_active run, accumulating counts across chunks', async () => {
    const firestore = makeFirestore({
      settings: {
        batch_active: true,
        run_pending_ids: ['s2', 's3'],
        progress_total: 3,
        run_generated: 1,
        run_skipped: 0,
        run_prompt_tokens: 100,
        run_candidate_tokens: 50,
        run_total_tokens: 150,
        run_trigger: 'scheduled',
        run_actor: { uid: 'system', email: 'automation@impact7.kr' },
      },
      students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: 1 });
    expect(r).toMatchObject({ status: 'complete', total: 3, generated: 3 }); // 1(이전) + 2(이번)
    expect(reportMock).toHaveBeenCalledTimes(2); // 재개 청크는 s2,s3만
    const final = firestore.automationWrites.at(-1);
    expect(final).toMatchObject({
      batch_active: false, last_run_generated: 3,
      last_run_total_tokens: 450, // 150(이전) + 300(이번 2건)
    });
    // 재개 시 students 쿼리/skip 재평가 없음 — 대상은 pending에 고정.
    expect(reportMock.mock.calls.map(c => c[0].studentId).sort()).toEqual(['s2', 's3']);
  });

  it('records partial status when some students fail (within one chunk)', async () => {
    reportMock
      .mockResolvedValueOnce({ status: 'good', usage: { ...USAGE } })
      .mockRejectedValueOnce(new Error('gemini blew up'))
      .mockResolvedValueOnce({ status: 'good', usage: { ...USAGE } });
    const firestore = makeFirestore({
      settings: { enabled: true },
      students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: 1 });
    expect(r).toMatchObject({ status: 'complete', generated: 2 });
    expect(firestore.automationWrites.at(-1).last_run_status).toBe('partial');
  });

  it('refuses to start when chunk_lock held and not stale (atomic guard, no writes)', async () => {
    const now = 10_000_000;
    const firestore = makeFirestore({
      settings: { chunk_lock: true, run_started_at: tsMillis(now - 60_000) }, // 1분 전 claim
      students: [{ id: 's1' }],
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: now });
    expect(r).toEqual({ ok: false, reason: 'locked' });
    expect(reportMock).not.toHaveBeenCalled();
    expect(firestore.automationWrites).toHaveLength(0);
  });

  it('steals a stale chunk_lock (run_started_at older than 30min)', async () => {
    const now = 10_000_000;
    const firestore = makeFirestore({
      settings: {
        chunk_lock: true, run_started_at: tsMillis(now - 31 * 60_000), // 31분 전(stale)
        enabled: true,
      },
      students: [{ id: 's1' }],
    });
    const r = await runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: now });
    expect(r).toMatchObject({ ok: true, status: 'complete', generated: 1 });
  });

  it('releases chunk_lock without last_run_at when the body crashes (batch_active untouched)', async () => {
    // 새 시작 경로에서 getAll(대상 확정)이 throw → claim 직후 본문 크래시.
    const firestore = makeFirestore({
      settings: { skip_within_days: 7 }, // skipDays>0 이라야 getAll 호출됨
      students: [{ id: 's1' }, { id: 's2' }],
      failGetAll: true,
    });
    await expect(runStudentReportChunk({ firestore, generateWithUsage, clock: fastClock, nowMs: 1 }))
      .rejects.toThrow('getAll exploded');
    // claim(1) 후 마지막 write는 chunk_lock 해제 + run_started_at 삭제만(last_run·batch_active 손대지 않음).
    const final = firestore.automationWrites.at(-1);
    expect(final).toEqual({ chunk_lock: false, run_started_at: '<delete>' });
    expect(firestore.automationWrites.some(w => 'last_run_at' in w)).toBe(false);
  });
});
