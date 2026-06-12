import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

const { handleAttendanceCheckin } = await import('../src/checkinHandler.js');

const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr' } };

// 트랜잭션·쿼리를 흉내내는 최소 Firestore mock.
function makeFirestore({ students = [], checkins = {}, daily = null } = {}) {
  const writes = { checkins: [], daily: [], queue: [] };
  let queueSeq = 0;

  function collection(name) {
    const chain = {
      _where: null,
      doc(id) {
        const docId = id ?? `auto-queue-${++queueSeq}`;
        return { id: docId, _collection: name, _id: docId };
      },
      where(field, op, value) {
        chain._where = { field, value };
        return chain;
      },
      async get() {
        const value = chain._where?.value;
        const docs = students
          .filter(s => s.studentNumber === value)
          .map(s => ({ id: s.studentId, data: () => s }));
        return { docs };
      },
    };
    return chain;
  }

  function runTransaction(fn) {
    const tx = {
      async get(ref) {
        if (ref._collection === 'attendance_checkins') {
          const found = checkins[ref._id];
          return found ? { exists: true, data: () => found } : { exists: false };
        }
        if (ref._collection === 'students') {
          const found = students.find(s => s.studentId === ref._id);
          return found ? { exists: true, data: () => found } : { exists: false };
        }
        if (ref._collection === 'daily_records') {
          return daily ? { exists: true, data: () => daily } : { exists: false };
        }
        return { exists: false };
      },
      set(ref, data, opts) {
        if (ref._collection === 'attendance_checkins') writes.checkins.push({ ref, data });
        else if (ref._collection === 'daily_records') writes.daily.push({ ref, data, opts });
        else if (ref._collection === 'message_queue') writes.queue.push({ ref, data });
      },
    };
    return fn(tx);
  }

  return { collection, runTransaction, writes };
}

const baseStudent = {
  studentId: 's1',
  name: '김학생',
  studentNumber: '123456',
  status: '재원',
  branch: '2단지',
  parent_phone_1: '010-1111-2222',
};

describe('handleAttendanceCheckin', () => {
  let firestore;

  beforeEach(() => {
    firestore = makeFirestore({ students: [baseStudent] });
  });

  it('requires auth', async () => {
    await expect(handleAttendanceCheckin({ data: { studentNumber: '123456' } }, { firestore }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a non-impact7 Google account (blocks studentNumber enumeration)', async () => {
    await expect(handleAttendanceCheckin(
      { auth: { uid: 'x', token: { email: 'stranger@gmail.com' } }, data: { studentNumber: '123456' } },
      { firestore },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('requires studentNumber', async () => {
    await expect(handleAttendanceCheckin({ auth, data: {} }, { firestore }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('lookup returns enrollable candidates and disambiguates by name', async () => {
    firestore = makeFirestore({
      students: [
        baseStudent,
        { studentId: 's2', name: '이학생', studentNumber: '123456', status: '재원' },
        { studentId: 's3', name: '퇴원생', studentNumber: '123456', status: '퇴원' },
      ],
    });
    const res = await handleAttendanceCheckin({ auth, data: { studentNumber: '123456' } }, { firestore });
    expect(res.result).toBe('candidates');
    expect(res.candidates.map(c => c.studentId)).toEqual(['s1', 's2']); // 퇴원 제외
    // 이름은 부분 마스킹(성+끝자) — 본인 식별 가능, 타 학생 평문 노출 차단.
    expect(res.candidates[0]).toMatchObject({ studentId: 's1', name: '김*생' });
    expect(res.candidates[1].name).toBe('이*생');
  });

  it('confirm creates checkin, merges daily_records, and enqueues a message', async () => {
    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore });

    expect(res).toMatchObject({ result: 'created', queued: true, attendanceSaved: true });
    expect(res.checkinId).toMatch(/^s1_.*_출석$/);

    expect(firestore.writes.checkins).toHaveLength(1);
    const checkin = firestore.writes.checkins[0].data;
    expect(checkin).toMatchObject({
      student_id: 's1', student_name: '김학생', student_number: '123456',
      status: '출석', source: 'tablet', created_by: 'teacher@impact7.kr',
    });
    expect(checkin.queue_id).toBeTruthy();

    expect(firestore.writes.daily).toHaveLength(1);
    const daily = firestore.writes.daily[0];
    expect(daily.opts).toEqual({ merge: true });
    expect(daily.data.attendance).toEqual({ status: '출석' });
    expect(daily.data.arrival_time).toMatch(/^\d{2}:\d{2}$/); // 출석 → 도착시간 기록

    expect(firestore.writes.queue).toHaveLength(1);
    const queue = firestore.writes.queue[0].data;
    expect(queue).toMatchObject({
      kind: 'attendance', student_id: 's1', recipient_phone: '01011112222', status: 'pending',
    });
    expect(queue.template_variables['#{출결상태}']).toBe('출석');
  });

  it('clears arrival_time for 결석 (등원 의미 없음 → 빈 문자열)', async () => {
    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '결석' },
    }, { firestore });
    expect(res.result).toBe('created');
    expect(firestore.writes.daily[0].data.arrival_time).toBe('');
  });

  it('clears arrival_time for 조퇴', async () => {
    firestore = makeFirestore({
      students: [baseStudent],
      daily: { arrival_time: '08:30', attendance: { status: '출석' } },
    });
    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '조퇴' },
    }, { firestore });
    expect(res.result).toBe('created');
    expect(firestore.writes.daily[0].data.arrival_time).toBe('');
  });

  it('preserves an existing arrival_time when 출석/지각 is re-applied', async () => {
    firestore = makeFirestore({
      students: [baseStudent],
      daily: { arrival_time: '08:30', attendance: { status: '지각' } },
    });
    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore });
    expect(res.result).toBe('created');
    // 기존 등원 시각 보존 — 덮어쓰지 않는다(DSC attendance.js와 일치).
    expect(firestore.writes.daily[0].data.arrival_time).toBeUndefined();
  });

  it('skips enqueue when no parent phone but still saves attendance', async () => {
    firestore = makeFirestore({
      students: [{ studentId: 's1', name: '김학생', studentNumber: '123456', status: '재원' }],
    });
    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore });

    expect(res).toMatchObject({ result: 'created', queued: false, attendanceSaved: true });
    expect(firestore.writes.queue).toHaveLength(0);
    expect(firestore.writes.checkins[0].data.queue_id).toBeNull();
    expect(firestore.writes.daily).toHaveLength(1);
  });

  it('rejects a duplicate claim without new writes', async () => {
    firestore = makeFirestore({
      students: [baseStudent],
      checkins: { 's1_': null }, // placeholder replaced below
    });
    // 멱등 docId는 날짜에 의존하므로, 모든 attendance_checkins get이 존재한다고 응답하게 만든다.
    firestore.runTransaction = (fn) => fn({
      async get(ref) {
        if (ref._collection === 'attendance_checkins') {
          return { exists: true, data: () => ({ queue_id: 'q-existing' }) };
        }
        if (ref._collection === 'students') return { exists: true, data: () => baseStudent };
        return { exists: false };
      },
      set: (ref, data, opts) => {
        if (ref._collection === 'attendance_checkins') firestore.writes.checkins.push({ ref, data });
        else if (ref._collection === 'daily_records') firestore.writes.daily.push({ ref, data, opts });
        else if (ref._collection === 'message_queue') firestore.writes.queue.push({ ref, data });
      },
    });

    const res = await handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore });

    expect(res).toMatchObject({ result: 'duplicate', queued: true, attendanceSaved: true });
    expect(firestore.writes.checkins).toHaveLength(0);
    expect(firestore.writes.daily).toHaveLength(0);
    expect(firestore.writes.queue).toHaveLength(0);
  });

  it('rejects when studentNumber does not match the student record', async () => {
    await expect(handleAttendanceCheckin({
      auth,
      data: { studentNumber: '999999', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects an invalid status', async () => {
    await expect(handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '지각조퇴' },
    }, { firestore })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects checkin for a non-enrollable student', async () => {
    firestore = makeFirestore({
      students: [{ studentId: 's1', name: '김학생', studentNumber: '123456', status: '퇴원', parent_phone_1: '010-1111-2222' }],
    });
    await expect(handleAttendanceCheckin({
      auth,
      data: { studentNumber: '123456', studentId: 's1', studentName: '김학생', status: '출석' },
    }, { firestore })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
