import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

const chunkMock = vi.fn();
vi.mock('../src/studentReportBatch.js', () => ({
  AUTOMATION_DOC: 'automation_settings/student_report',
  runStudentReportChunk: (...args) => chunkMock(...args),
}));

const {
  kstParts, scheduleMatches,
  handleRunStudentReportAutomation, handleRunStudentReportBatchManual,
} = await import('../src/studentReportAutomationHandler.js');

// 특정 KST 시각의 Date를 만든다 (KST = UTC+9, DST 없음).
function kstDate(y, m, d, hour) {
  return new Date(Date.UTC(y, m - 1, d, hour - 9, 0, 0));
}

describe('kstParts', () => {
  it('extracts KST hour/weekday/day regardless of server TZ', () => {
    // 2026-06-15는 월요일
    const p = kstParts(kstDate(2026, 6, 15, 14));
    expect(p).toMatchObject({ year: 2026, month: 6, day: 15, hour: 14, weekday: 1 });
    expect(p.dateStr).toBe('2026-06-15');
  });

  it('handles KST midnight crossing from UTC', () => {
    // KST 2026-06-15 00:00 == UTC 2026-06-14 15:00
    const p = kstParts(kstDate(2026, 6, 15, 0));
    expect(p).toMatchObject({ day: 15, hour: 0 });
  });
});

describe('scheduleMatches', () => {
  const parts = { hour: 9, weekday: 1, day: 15, dateStr: '2026-06-15' }; // 월요일 09시 15일

  it('returns false when disabled', () => {
    expect(scheduleMatches({ enabled: false, interval: 'daily', run_hour: 9 }, parts)).toBe(false);
  });
  it('daily matches at run_hour and catches up on later hours (hour >= run_hour)', () => {
    expect(scheduleMatches({ enabled: true, interval: 'daily', run_hour: 9 }, parts)).toBe(true);   // 정시
    expect(scheduleMatches({ enabled: true, interval: 'daily', run_hour: 8 }, parts)).toBe(true);   // catch-up(놓친 8시 → 9시 따라잡음)
    expect(scheduleMatches({ enabled: true, interval: 'daily', run_hour: 10 }, parts)).toBe(false); // 아직 이름(9 < 10)
  });
  it('weekly matches on run_day weekday + hour>=run_hour', () => {
    expect(scheduleMatches({ enabled: true, interval: 'weekly', run_day: 1, run_hour: 9 }, parts)).toBe(true);
    expect(scheduleMatches({ enabled: true, interval: 'weekly', run_day: 1, run_hour: 8 }, parts)).toBe(true);  // catch-up(같은 요일 안)
    expect(scheduleMatches({ enabled: true, interval: 'weekly', run_day: 2, run_hour: 9 }, parts)).toBe(false); // 다른 요일
  });
  it('monthly matches on run_day date + hour>=run_hour', () => {
    expect(scheduleMatches({ enabled: true, interval: 'monthly', run_day: 15, run_hour: 9 }, parts)).toBe(true);
    expect(scheduleMatches({ enabled: true, interval: 'monthly', run_day: 15, run_hour: 8 }, parts)).toBe(true);  // catch-up(같은 날짜 안)
    expect(scheduleMatches({ enabled: true, interval: 'monthly', run_day: 1, run_hour: 9 }, parts)).toBe(false);  // 다른 날짜
  });
  it('does not match before run_hour', () => {
    expect(scheduleMatches({ enabled: true, interval: 'daily', run_hour: 10 }, parts)).toBe(false);
  });
  it('unknown interval never matches', () => {
    expect(scheduleMatches({ enabled: true, interval: 'hourly', run_hour: 9 }, parts)).toBe(false);
  });
});

describe('handleRunStudentReportAutomation', () => {
  beforeEach(() => {
    chunkMock.mockReset();
    chunkMock.mockResolvedValue({ ok: true, status: 'complete', done: 1, total: 1 });
  });

  function firestoreWith(settings) {
    return {
      doc: () => ({ async get() { return { exists: true, data: () => settings }; } }),
    };
  }

  it('starts a new chunk when the schedule matches and no prior run this slot', async () => {
    const now = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h - 9));
    const firestore = firestoreWith({ enabled: true, interval: 'daily', run_hour: 9 });
    const r = await handleRunStudentReportAutomation({ firestore, now: now(2026, 6, 15, 9) });
    expect(chunkMock).toHaveBeenCalledTimes(1);
    expect(chunkMock.mock.calls[0][0]).toMatchObject({ trigger: 'scheduled' });
    expect(r.ran).toBe(true);
  });

  it('resumes an active batch regardless of schedule (no trigger override)', async () => {
    const now = new Date(Date.UTC(2026, 5, 15, 5)); // KST 14시 — 스케줄과 무관해도 이어받음
    const firestore = firestoreWith({ batch_active: true, enabled: true, interval: 'daily', run_hour: 9 });
    chunkMock.mockResolvedValue({ ok: true, status: 'in_progress', done: 100, total: 500 });
    const r = await handleRunStudentReportAutomation({ firestore, now });
    expect(chunkMock).toHaveBeenCalledTimes(1);
    // 재개 경로는 trigger를 주지 않음(worker가 상태에서 복원)
    expect(chunkMock.mock.calls[0][0].trigger).toBeUndefined();
    expect(r).toMatchObject({ ok: true, ran: true, status: 'in_progress', done: 100, total: 500 });
  });

  it('skips (ran:false) when the chunk is locked by another worker', async () => {
    chunkMock.mockResolvedValue({ ok: false, reason: 'locked' });
    const now = new Date(Date.UTC(2026, 5, 15, 0)); // KST 09:00 매칭
    const firestore = firestoreWith({ enabled: true, interval: 'daily', run_hour: 9 });
    const r = await handleRunStudentReportAutomation({ firestore, now });
    expect(r.ok).toBe(true);
    expect(r.ran).toBe(false);
    expect(r.batch_ok).toBe(false);
  });

  it('does not run before run_hour', async () => {
    const now = new Date(Date.UTC(2026, 5, 14, 23)); // KST 2026-06-15 08:00 (run_hour 9 이전)
    const firestore = firestoreWith({ enabled: true, interval: 'daily', run_hour: 9 });
    const r = await handleRunStudentReportAutomation({ firestore, now });
    expect(chunkMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ran: false, reason: 'no_match' });
  });

  it('catches up on a later hour when the slot has not run yet (no last_run_at)', async () => {
    const now = new Date(Date.UTC(2026, 5, 15, 2)); // KST 2026-06-15 11:00 (run_hour 9 이후, 미완료)
    const firestore = firestoreWith({ enabled: true, interval: 'daily', run_hour: 9 });
    const r = await handleRunStudentReportAutomation({ firestore, now });
    expect(chunkMock).toHaveBeenCalledTimes(1);
    expect(r.ran).toBe(true);
  });

  it('does not start twice in the same slot (last_run_at same KST day)', async () => {
    const now = new Date(Date.UTC(2026, 5, 15, 0)); // KST 2026-06-15 09:00
    const lastRunMs = Date.UTC(2026, 5, 14, 23); // KST 2026-06-15 08:00 same day
    const firestore = firestoreWith({
      enabled: true, interval: 'daily', run_hour: 9,
      last_run_at: { toMillis: () => lastRunMs },
    });
    const r = await handleRunStudentReportAutomation({ firestore, now });
    expect(chunkMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ran: false, reason: 'already_ran_slot' });
  });
});

describe('handleRunStudentReportBatchManual', () => {
  beforeEach(() => {
    chunkMock.mockReset();
    chunkMock.mockResolvedValue({ ok: true, status: 'in_progress', done: 50, total: 500 });
  });

  function firestoreWithRole(role) {
    return {
      collection: () => ({
        doc: () => ({ async get() { return { exists: !!role, data: () => ({ role }) }; } }),
      }),
    };
  }

  it('requires auth', async () => {
    await expect(handleRunStudentReportBatchManual({}, { firestore: firestoreWithRole('owner') }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleRunStudentReportBatchManual(
      { auth: { uid: 'u', token: { email: 'x@gmail.com' } } },
      { firestore: firestoreWithRole('owner') },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects insufficient role', async () => {
    await expect(handleRunStudentReportBatchManual(
      { auth: { uid: 'u', token: { email: 't@impact7.kr' } } },
      { firestore: firestoreWithRole('teacher') },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('starts the first chunk for an authorized director', async () => {
    const r = await handleRunStudentReportBatchManual(
      { auth: { uid: 'u', token: { email: 'd@impact7.kr' } } },
      { firestore: firestoreWithRole('director') },
    );
    expect(chunkMock).toHaveBeenCalledTimes(1);
    expect(chunkMock.mock.calls[0][0]).toMatchObject({ trigger: 'manual', actor: { uid: 'u', email: 'd@impact7.kr' } });
    expect(r).toMatchObject({ ok: true, status: 'in_progress', done: 50, total: 500 });
  });

  it('returns locked when a chunk is already in progress', async () => {
    chunkMock.mockResolvedValue({ ok: false, reason: 'locked' });
    const r = await handleRunStudentReportBatchManual(
      { auth: { uid: 'u', token: { email: 'd@impact7.kr' } } },
      { firestore: firestoreWithRole('owner') },
    );
    expect(r).toEqual({ ok: false, reason: 'locked' });
  });
});
