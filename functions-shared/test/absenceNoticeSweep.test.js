import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { runAbsenceNoticeSweep, handleSendAbsenceNotice, syncAbsenceNoticeDeliveryStatus } = await import('../src/absenceNoticeSweep.js');

function makeDb({ students = {}, daily = {}, notices = {}, absences = {} } = {}) {
  const stores = {
    students: { ...students }, daily_records: { ...daily },
    absence_notices: { ...notices }, absence_records: { ...absences }, message_queue: {},
  };
  let mqId = 0;
  const coll = (n) => ({
    where(f, op, v) {
      const filters = [[f, op, v]];
      const q = {
        where(f2, op2, v2) { filters.push([f2, op2, v2]); return q; },
        async get() {
          const docs = Object.entries(stores[n])
            .filter(([, d]) => filters.every(([ff, oo, vv]) => (oo === 'in' ? vv.includes(d[ff]) : d[ff] === vv)))
            .map(([id, d]) => ({ id, data: () => d }));
          return { docs, empty: docs.length === 0 };
        },
      };
      return q;
    },
    doc(id) {
      const _id = id ?? `mq${++mqId}`;
      return {
        id: _id,
        async get() { const d = stores[n][_id]; return { exists: d !== undefined, data: () => d }; },
        async create(data) {
          if (stores[n][_id] !== undefined) { const e = new Error('exists'); e.code = 6; throw e; }
          stores[n][_id] = data;
        },
        async set(data) { stores[n][_id] = data; },
        async delete() { delete stores[n][_id]; },
      };
    },
  });
  return { collection: coll, _stores: stores };
}

const NOW = new Date('2026-07-02T10:00:00Z'); // KST 19:00
const D = '2026-07-02';
const student = (over = {}) => ({ status: '재원', name: '김민수', parent_phone_1: '010-1111-2222', ...over });
const run = (db, over = {}) => runAbsenceNoticeSweep({ db, now: NOW, dateKST: D, enabled: true, loadExpectedArrival: async () => '17:00', ...over });

describe('runAbsenceNoticeSweep', () => {
  it('게이트 off → 조회·발송 없이 disabled', async () => {
    const db = makeDb({ students: { s1: student() } });
    const res = await runAbsenceNoticeSweep({ db, enabled: false });
    expect(res).toMatchObject({ disabled: true, sent: 0 });
    expect(Object.keys(db._stores.message_queue)).toHaveLength(0);
  });

  it('재원 미등원 + 예정+유예 경과 + 결석 없음 → parent_notice 발송 + 멱등 기록', async () => {
    const db = makeDb({ students: { s1: student() } });
    const res = await run(db);
    expect(res.sent).toBe(1);
    const q = Object.values(db._stores.message_queue)[0];
    expect(q).toMatchObject({ kind: 'parent_notice', source: 'absence_sweep' });
    expect(q.template_variables['#{학생명}']).toBe('김민수');
    expect(q.fallback_text).toContain('등원하지 않았습니다');
    expect(db._stores.absence_notices[`s1_${D}`]).toBeTruthy();
  });

  it('휴원(실휴원) → 대상 아님(재원만)', async () => {
    const db = makeDb({ students: { s1: student({ status: '실휴원' }) } });
    expect((await run(db)).sent).toBe(0);
  });

  it('이미 체크인(day_state != 미등원) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, daily: { [`s1_${D}`]: { day_state: '원내' } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('수동 출결·결석 처리(attendance.status) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, daily: { [`s1_${D}`]: { attendance: { status: '결석' } } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('사전 결석 통보(absence_records 오늘) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, absences: { a1: { student_id: 's1', absence_date: D } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('수업 없는 날(예정시각 없음) → 제외', async () => {
    const db = makeDb({ students: { s1: student() } });
    expect((await run(db, { loadExpectedArrival: async () => '' })).sent).toBe(0);
  });

  it('유예 내(예정+40분 전) → 제외', async () => {
    const db = makeDb({ students: { s1: student() } });
    expect((await run(db, { loadExpectedArrival: async () => '18:40' })).sent).toBe(0); // 19:00 < 19:20
  });

  it('멱등: absence_notices 이미 존재 → 재발송 안 함', async () => {
    const db = makeDb({ students: { s1: student() }, notices: { [`s1_${D}`]: { student_id: 's1' } } });
    const res = await run(db);
    expect(res.sent).toBe(0);
    expect(Object.keys(db._stores.message_queue)).toHaveLength(0);
  });

  it('학부모 번호 없음 → 제외', async () => {
    const db = makeDb({ students: { s1: student({ parent_phone_1: '', parent_phone_2: '' }) } });
    expect((await run(db)).sent).toBe(0);
  });
});

describe('handleSendAbsenceNotice (수동 발송)', () => {
  const auth = { token: { email: 'staff@impact7.kr' } };
  const call = (db, data) => handleSendAbsenceNotice({ auth, data }, { db, dateKST: D });

  it('학생+연락처 → parent_notice 발송 + absence_notices 멱등 기록(source=manual)', async () => {
    const db = makeDb({ students: { s1: student() } });
    const res = await call(db, { studentId: 's1', expectedTime: '17:00' });
    expect(res).toMatchObject({ sent: true, alreadySent: false });
    const q = Object.values(db._stores.message_queue)[0];
    expect(q).toMatchObject({ kind: 'parent_notice', source: 'absence_manual' });
    expect(q.template_variables['#{학생명}']).toBe('김민수');
    expect(q.template_variables['#{일시}']).toBe('오늘 17:00');
    expect(db._stores.absence_notices[`s1_${D}`]).toMatchObject({ source: 'manual' });
  });

  it('예정시각 없으면 일시=오늘', async () => {
    const db = makeDb({ students: { s1: student() } });
    await call(db, { studentId: 's1' });
    expect(Object.values(db._stores.message_queue)[0].template_variables['#{일시}']).toBe('오늘');
  });

  it('이미 발송(absence_notices 존재) → alreadySent, 큐 미생성(스윕과 멱등 공유)', async () => {
    const db = makeDb({ students: { s1: student() }, notices: { [`s1_${D}`]: { student_id: 's1' } } });
    const res = await call(db, { studentId: 's1' });
    expect(res).toMatchObject({ sent: false, alreadySent: true });
    expect(Object.keys(db._stores.message_queue)).toHaveLength(0);
  });

  it('학생 없음 → not-found', async () => {
    const db = makeDb({ students: {} });
    await expect(call(db, { studentId: 'x' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('연락처 없음 → failed-precondition(멱등 기록도 남기지 않음)', async () => {
    const db = makeDb({ students: { s1: student({ parent_phone_1: '', parent_phone_2: '' }) } });
    await expect(call(db, { studentId: 's1' })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(db._stores.absence_notices[`s1_${D}`]).toBeUndefined();
  });

  it('studentId 없음 → invalid-argument', async () => {
    const db = makeDb({ students: { s1: student() } });
    await expect(call(db, {})).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('syncAbsenceNoticeDeliveryStatus (발송 결과 반영)', () => {
  const ts = (ms) => ({ toMillis: () => ms });

  // seed: absence_notices 사전 상태(path → data). tx.get/tx.set으로 라우팅해 트랜잭션 가드를 검증한다.
  function makeSyncDb(seed = {}) {
    const store = { ...seed };
    const sets = [];
    const db = {
      collection: (name) => ({ doc: (id) => ({ id, path: `${name}/${id}` }) }),
      runTransaction: async (fn) => fn({
        get: async (ref) => ({ data: () => store[ref.path] }),
        set: (ref, data, opts) => {
          sets.push({ path: ref.path, data, opts });
          store[ref.path] = opts?.merge ? { ...(store[ref.path] ?? {}), ...data } : data;
        },
      }),
    };
    return { db, sets, store };
  }
  // beforeMs/afterMs: 모의 Firestore updateTime(ms). undefined면 updateTime 없음(before 미존재 등).
  const snap = (data, ms) => (data ? { data: () => data, updateTime: ms != null ? ts(ms) : null } : undefined);
  const event = (before, after, { beforeMs, afterMs } = {}) => ({
    data: { before: snap(before, beforeMs), after: snap(after, afterMs) },
  });

  it('absence_notice_id 없는 큐 doc(다른 발송 종류) → 반영 없음', async () => {
    const { db, sets } = makeSyncDb();
    await syncAbsenceNoticeDeliveryStatus(event({ status: 'pending' }, { status: 'sent' }), { db });
    expect(sets).toHaveLength(0);
  });

  it('생성 이벤트(before 없음, 최초 pending) → 반영됨', async () => {
    const { db, sets } = makeSyncDb();
    await syncAbsenceNoticeDeliveryStatus(
      event(undefined, { status: 'pending', absence_notice_id: `s1_${D}`, student_id: 's1' }, { afterMs: 1000 }),
      { db },
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].data).toMatchObject({ delivery_status: 'pending', student_id: 's1' });
  });

  it('상태 변화 없음(같은 status 재기록) → 반영 없음(중복 write 방지)', async () => {
    const { db, sets } = makeSyncDb();
    await syncAbsenceNoticeDeliveryStatus(
      event({ status: 'failed_retryable', absence_notice_id: `s1_${D}` }, { status: 'failed_retryable', absence_notice_id: `s1_${D}` }),
      { db },
    );
    expect(sets).toHaveLength(0);
  });

  it('발송 성공(sent) → absence_notices에 student_id·delivery_status 반영(collection 경로 확인)', async () => {
    const { db, sets } = makeSyncDb();
    await syncAbsenceNoticeDeliveryStatus(
      event(
        { status: 'processing', absence_notice_id: `s1_${D}` },
        { status: 'sent', absence_notice_id: `s1_${D}`, student_id: 's1' },
        { beforeMs: 1000, afterMs: 2000 },
      ),
      { db },
    );
    expect(sets).toHaveLength(1);
    expect(sets[0].path).toBe(`absence_notices/s1_${D}`);
    expect(sets[0].data).toMatchObject({ delivery_status: 'sent', delivery_error_code: null, student_id: 's1' });
    expect(sets[0].opts).toMatchObject({ merge: true });
  });

  it('영구 실패(failed_permanent) → last_error_code 포함 반영(100자 상한)', async () => {
    const { db, sets } = makeSyncDb();
    const longCode = 'x'.repeat(150);
    await syncAbsenceNoticeDeliveryStatus(
      event(
        { status: 'processing', absence_notice_id: `s1_${D}` },
        { status: 'failed_permanent', absence_notice_id: `s1_${D}`, last_error_code: longCode },
        { beforeMs: 1000, afterMs: 2000 },
      ),
      { db },
    );
    expect(sets[0].data.delivery_status).toBe('failed_permanent');
    expect(sets[0].data.delivery_error_code).toHaveLength(100);
  });

  it('삭제(after 없음) → 반영 없음', async () => {
    const { db, sets } = makeSyncDb();
    await syncAbsenceNoticeDeliveryStatus(event({ status: 'sent', absence_notice_id: `s1_${D}` }, undefined), { db });
    expect(sets).toHaveLength(0);
  });

  it('레이스: 더 최신 이벤트(sent)가 이미 반영된 뒤 지연 도착한 과거 이벤트(processing) → 무시', async () => {
    const noticeId = `s1_${D}`;
    // sent(afterMs=5000)가 먼저 커밋·반영된 상태를 시드 — 뒤늦게 온 processing(afterMs=2000)이 덮으면 안 됨.
    const { db, sets } = makeSyncDb({ [`absence_notices/${noticeId}`]: { delivery_status: 'sent', delivery_source_updated_at: ts(5000) } });
    await syncAbsenceNoticeDeliveryStatus(
      event(
        { status: 'pending', absence_notice_id: noticeId },
        { status: 'processing', absence_notice_id: noticeId },
        { beforeMs: 1000, afterMs: 2000 },
      ),
      { db },
    );
    expect(sets).toHaveLength(0);
  });

  it('정상 순서: 더 오래된 상태가 저장돼 있을 때 최신 이벤트는 반영됨', async () => {
    const noticeId = `s1_${D}`;
    const { db, sets, store } = makeSyncDb({ [`absence_notices/${noticeId}`]: { delivery_status: 'processing', delivery_source_updated_at: ts(2000) } });
    await syncAbsenceNoticeDeliveryStatus(
      event(
        { status: 'processing', absence_notice_id: noticeId },
        { status: 'sent', absence_notice_id: noticeId },
        { beforeMs: 2000, afterMs: 5000 },
      ),
      { db },
    );
    expect(sets).toHaveLength(1);
    expect(store[`absence_notices/${noticeId}`].delivery_status).toBe('sent');
  });
});
