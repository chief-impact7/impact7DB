import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { finalize } from '../src/finalize.js';

let app;
let db;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  app = initializeApp({ projectId: 'impact7db-test' });
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
});

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
  it('재등원 + 반 변경 → status=재원, 정규 교체', async () => {
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
    expect(stu.status).toBe('재원');
    expect(stu.enrollments).toHaveLength(1);
    expect(stu.enrollments[0].class_number).toBe('103');

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
});
