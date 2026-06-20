import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveStudentId, syncExternalScore, syncResultScore } from '../src/syncStudentScores.js';

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
    for (const col of ['students', 'student_scores', 'exams', 'external_score_events']) {
        const snap = await db.collection(col).get();
        await Promise.all(snap.docs.map(d => d.ref.delete()));
    }
});

describe('resolveStudentId', () => {
    it('registrationNo로 studentNumber 역조회', async () => {
        await db.doc('students/홍길동_123').set({ name: '홍길동', studentNumber: 922764 });
        expect(await resolveStudentId(db, { registrationNo: 922764 })).toBe('홍길동_123');
    });

    it('registrationNo 없으면 studentName 단일 매칭', async () => {
        await db.doc('students/김철수_1').set({ name: '김철수', studentNumber: 111 });
        expect(await resolveStudentId(db, { studentName: '김철수' })).toBe('김철수_1');
    });

    it('동명이인이면 모호 → null (잘못된 학생에 쓰지 않음)', async () => {
        await db.doc('students/이영희_1').set({ name: '이영희', studentNumber: 1 });
        await db.doc('students/이영희_2').set({ name: '이영희', studentNumber: 2 });
        expect(await resolveStudentId(db, { studentName: '이영희' })).toBe(null);
    });

    it('registrationNo 문자열도 studentNumber(number)에 매칭 (타입 정규화)', async () => {
        await db.doc('students/A_1').set({ name: 'A', studentNumber: 263639 });
        expect(await resolveStudentId(db, { registrationNo: '263639' })).toBe('A_1');
    });

    it('registrationNo가 전화번호면 parent_phone_1(하이픈 형식)로 매칭', async () => {
        await db.doc('students/B_1').set({ name: 'B', studentNumber: 111, parent_phone_1: '010-2211-0500' });
        expect(await resolveStudentId(db, { registrationNo: '01022110500' })).toBe('B_1');
    });

    it('parent_phone_1 하이픈 없는 형식도 매칭', async () => {
        await db.doc('students/C_1').set({ name: 'C', studentNumber: 222, parent_phone_1: '01099887766' });
        expect(await resolveStudentId(db, { registrationNo: '010-9988-7766' })).toBe('C_1');
    });

    it('매핑 실패 → null', async () => {
        expect(await resolveStudentId(db, { registrationNo: 555123 })).toBe(null);
    });
});

describe('syncExternalScore', () => {
    it('external 점수를 student_scores.external[eventId]에 비정규화 (event meta 포함)', async () => {
        await db.doc('external_score_events/ev1').set({ type: 'school', examName: '중간' });
        await syncExternalScore(db, 'ev1', 'stu1', { finalScore: 90 });
        const doc = (await db.doc('student_scores/stu1').get()).data();
        expect(doc.external.ev1.type).toBe('school');
        expect(doc.external.ev1.event.examName).toBe('중간');
        expect(doc.external.ev1.score.finalScore).toBe(90);
    });

    it('삭제(after=null) → external[eventId] 제거', async () => {
        await db.doc('external_score_events/ev1').set({ type: 'school' });
        await syncExternalScore(db, 'ev1', 'stu1', { finalScore: 90 });
        await syncExternalScore(db, 'ev1', 'stu1', null);
        const doc = (await db.doc('student_scores/stu1').get()).data();
        expect(doc.external?.ev1).toBeUndefined();
    });
});

describe('syncResultScore', () => {
    it('registrationNo 역조회 후 academy[examId] 비정규화 (exam meta 포함)', async () => {
        await db.doc('students/홍길동_123').set({ name: '홍길동', studentNumber: 922764 });
        await db.doc('exams/ex1').set({ title: '진단평가1', deptId: 'd1', schedule: { startDate: '2026-06-01' } });
        const r = await syncResultScore(db, 'ex1', { registrationNo: 922764, studentName: '홍길동', score: 80 }, null);
        expect(r.action).toBe('set');
        expect(r.studentId).toBe('홍길동_123');
        const doc = (await db.doc('student_scores/홍길동_123').get()).data();
        expect(doc.academy.ex1.title).toBe('진단평가1');
        expect(doc.academy.ex1.date).toBe('2026-06-01');
        expect(doc.academy.ex1.result.score).toBe(80);
    });

    it('매핑 실패(미등록 학생) → skipped unresolved, 아무 문서도 안 만듦', async () => {
        const r = await syncResultScore(db, 'ex1', { registrationNo: 999 }, null);
        expect(r.skipped).toBe('unresolved');
    });

    it('삭제(after=null)이고 학생 매핑되면 academy[examId] 제거', async () => {
        await db.doc('students/홍길동_123').set({ name: '홍길동', studentNumber: 922764 });
        await db.doc('exams/ex1').set({ title: '진단평가1' });
        await syncResultScore(db, 'ex1', { registrationNo: 922764, score: 80 }, null);
        const r = await syncResultScore(db, 'ex1', null, { registrationNo: 922764 });
        expect(r.action).toBe('delete');
        const doc = (await db.doc('student_scores/홍길동_123').get()).data();
        expect(doc.academy?.ex1).toBeUndefined();
    });
});
