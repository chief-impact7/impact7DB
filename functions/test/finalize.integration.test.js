import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { finalize } from '../src/finalize.js';
import { runScheduledWithdrawals } from '../src/scheduledWithdrawals.js';

let app;
let db;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  app = initializeApp({ projectId: 'demo-impact7' });
  db = getFirestore();
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  // 모든 컬렉션 클리어
  for (const col of ['students', 'leave_requests', 'history_logs', 'class_settings']) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
}, 30_000);

async function seed(stu, lr, cs = {}) {
  await db.doc(`students/${stu.id}`).set(stu);
  for (const [code, data] of Object.entries(cs)) {
    await db.doc(`class_settings/${code}`).set(data);
  }
  const lrRef = db.collection('leave_requests').doc();
  await lrRef.set(lr);
  return lrRef;
}

describe('finalize — integration', () => {
  it('재등원 + 반 변경 → status=등원예정, 정규 교체(start_date=복귀일)', async () => {
    const lrRef = await seed(
      { id: 's1', name: '유시우', status: '퇴원', enrollments: [] },
      {
        student_id: 's1', request_type: '재등원요청',
        target_class_code: 'A103', return_date: '2026-04-21',
        status: 'approved',
      },
      { A103: { default_days: ['월', '수'] } },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);

    const stu = (await db.doc('students/s1').get()).data();
    expect(stu.status).toBe('등원예정');
    expect(stu.enrollments).toHaveLength(1);
    expect(stu.enrollments[0].class_number).toBe('103');
    expect(stu.enrollments[0].start_date).toBe('2026-04-21');

    const lrAfter = (await lrRef.get()).data();
    expect(lrAfter.finalized_at).toBeDefined();
    expect(lrAfter.finalize_attempts).toBe(1);

    const hl = await db.collection('history_logs').get();
    expect(hl.size).toBe(1);
    expect(hl.docs[0].data().change_type).toBe('RETURN');
  });

  it('휴원요청 + 미래 시작일 → scheduled_leave_status', async () => {
    const lrRef = await seed(
      { id: 's2', name: '김철수', status: '재원', enrollments: [] },
      {
        student_id: 's2', request_type: '휴원요청', leave_sub_type: '실휴원',
        leave_start_date: '2099-01-01', leave_end_date: '2099-02-01',
        status: 'approved',
      },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);
    const stu = (await db.doc('students/s2').get()).data();
    expect(stu.status).toBe('재원');
    expect(stu.scheduled_leave_status).toBe('실휴원');
    expect(stu.pause_start_date).toBe('2099-01-01');
  });

  it('휴원→퇴원: pause_* 삭제, status=퇴원', async () => {
    const lrRef = await seed(
      {
        id: 's3', name: '이민호', status: '실휴원',
        pause_start_date: '2026-01-01', pause_end_date: '2026-12-31',
        enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }],
      },
      {
        student_id: 's3', request_type: '휴원→퇴원', withdrawal_date: '2026-04-21',
        status: 'approved',
      },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);
    const stu = (await db.doc('students/s3').get()).data();
    expect(stu.status).toBe('퇴원');
    expect(stu.pause_start_date).toBeUndefined();
    expect(stu.pause_end_date).toBeUndefined();
  });

  it('트리거 인자 대신 트랜잭션에서 읽은 최신 account_target을 적용한다', async () => {
    const lrRef = await seed(
      {
        id: 's4',
        name: '최신원장',
        status: '재원',
        enrollments: [{
          account_id: 'regular-1',
          account_type: '정규',
          class_type: '정규',
          class_number: '101',
          start_date: '2026-03-01',
        }],
      },
      {
        student_id: 's4',
        request_type: '휴원요청',
        leave_start_date: '2026-04-21',
        leave_end_date: '2026-05-31',
        account_target: { account_id: 'regular-1' },
        status: 'approved',
      },
    );

    await finalize(lrRef, { student_id: 'stale-student' }, { db, today: '2026-04-21' });

    const stu = (await db.doc('students/s4').get()).data();
    expect(stu.status).toBe('실휴원');
    const lr = (await lrRef.get()).data();
    expect(lr.account_target.start_applied_at).toBeDefined();
    expect(lr.finalized_at).toBeDefined();
  });

  it('미래 계정 휴원은 학생·finalized_at·finalize_error를 건드리지 않는다', async () => {
    const before = {
      id: 's-future-pause',
      name: '미래휴원',
      status: '재원',
      enrollments: [{
        account_id: 'regular-1',
        account_type: '정규',
        class_type: '정규',
        class_number: '101',
      }],
    };
    const lrRef = await seed(before, {
      student_id: 's-future-pause',
      request_type: '휴원요청',
      leave_start_date: '2026-05-01',
      leave_end_date: '2026-05-31',
      account_target: { account_id: 'regular-1' },
      status: 'approved',
    });

    await finalize(lrRef, {}, { db, today: '2026-04-21' });

    expect((await db.doc('students/s-future-pause').get()).data()).toEqual(before);
    const lr = (await lrRef.get()).data();
    expect(lr.finalized_at).toBeUndefined();
    expect(lr.finalize_error).toBeUndefined();
  });

  it('account_id 불일치는 학생을 바꾸지 않고 finalize_error를 기록한다', async () => {
    const before = {
      id: 's5',
      name: '불일치',
      status: '재원',
      enrollments: [{
        account_id: 'regular-1',
        account_type: '정규',
        class_type: '정규',
        class_number: '101',
      }],
    };
    const lrRef = await seed(before, {
      student_id: 's5',
      request_type: '복귀요청',
      account_target: { account_id: 'missing' },
      status: 'approved',
    });

    await expect(finalize(lrRef, {}, { db, today: '2026-04-21' }))
      .rejects.toThrow('수강계정 missing 매칭 실패');

    expect((await db.doc('students/s5').get()).data()).toEqual(before);
    const lr = (await lrRef.get()).data();
    expect(lr.finalize_error).toContain('수강계정 missing 매칭 실패');
    expect(lr.finalized_at).toBeUndefined();
  });

  it('미래 계정 종료를 예약하고 스케줄러가 도래일에 한 번만 적용한다', async () => {
    const lrRef = await seed(
      {
        id: 's6',
        name: '예약종료',
        status: '재원',
        enrollments: [{
          account_id: 'regular-1',
          account_type: '정규',
          class_type: '정규',
          class_number: '101',
          start_date: '2026-03-01',
        }],
      },
      {
        student_id: 's6',
        request_type: '퇴원요청',
        withdrawal_date: '2026-05-01',
        account_target: { account_id: 'regular-1' },
        status: 'approved',
      },
    );

    await finalize(lrRef, {}, { db, today: '2026-04-21' });
    const scheduled = (await db.doc('students/s6').get()).data();
    expect(scheduled.enrollments[0].end_date).toBeUndefined();
    expect(scheduled.status).toBe('재원');
    expect((await lrRef.get()).data().finalized_at).toBeUndefined();

    const first = await runScheduledWithdrawals(db, '2026-05-01');
    const second = await runScheduledWithdrawals(db, '2026-05-01');

    expect(first.accountProcessed).toBe(1);
    expect(second.accountProcessed).toBe(0);
    const applied = (await db.doc('students/s6').get()).data();
    expect(applied.status).toBe('퇴원');
    expect(applied.enrollments).toEqual([]);
    expect((await lrRef.get()).data().account_target.end_applied_at).toBeDefined();
  });
});
