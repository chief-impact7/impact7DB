import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { syncNaesinPeriod } from '../src/syncNaesinPeriod.js';

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
    for (const col of ['students', 'class_settings', 'history_logs']) {
        const snap = await db.collection(col).get();
        await Promise.all(snap.docs.map(d => d.ref.delete()));
    }
});

const CS_KEY = '2단지진명여고1B';
const NEW_END = '2026-07-03';
const OLD_END = '2026-07-02';

describe('syncNaesinPeriod', () => {
    it('cs.class_type이 내신이 아니면 skip', async () => {
        const result = await syncNaesinPeriod(db, CS_KEY,
            { class_type: '정규' }, { class_type: '정규' });
        expect(result.skipped).toBe('not-naesin');
    });

    it('naesin_start/end가 안 바뀌면 skip', async () => {
        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { ...before };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);
        expect(result.skipped).toBe('no-change');
    });

    it('override 매핑 학생의 명시적 내신 enrollment.end_date를 새 값으로 sync', async () => {
        await db.doc('students/s1').set({
            name: '학생1', status: '재원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: CS_KEY, day: ['목','화'] },
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_time: '18:30',
                  start_date: '2026-05-14', end_date: OLD_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);

        expect(result.synced).toBe(1);
        const stu = (await db.doc('students/s1').get()).data();
        expect(stu.enrollments[1].end_date).toBe(NEW_END);
    });

    it('override 매핑 안 된 학생은 건드리지 않음', async () => {
        await db.doc('students/s2').set({
            name: '학생2', status: '재원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: '다른csKey', day: ['목','화'] },
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-05-14', end_date: OLD_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);

        expect(result.synced).toBe(0);
        const stu = (await db.doc('students/s2').get()).data();
        expect(stu.enrollments[1].end_date).toBe(OLD_END);  // 변경 안 됨
    });

    it('cs.naesin_start 이전 시작인 옛 내신 enrollment는 보존', async () => {
        await db.doc('students/s3').set({
            name: '학생3', status: '재원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: CS_KEY, day: ['목','화'] },
                // 옛 내신 (작년/지난 학기) — 보존되어야
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-01-10', end_date: '2026-03-15' },
                // 새 내신 — sync 대상
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-05-14', end_date: OLD_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);

        expect(result.synced).toBe(1);
        const stu = (await db.doc('students/s3').get()).data();
        expect(stu.enrollments[1].end_date).toBe('2026-03-15');  // 옛 내신 보존
        expect(stu.enrollments[2].end_date).toBe(NEW_END);       // 새 내신만 sync
    });

    it('퇴원 학생은 건드리지 않음', async () => {
        await db.doc('students/s4').set({
            name: '학생4', status: '퇴원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: CS_KEY, day: ['목','화'] },
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-05-14', end_date: OLD_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);

        expect(result.synced).toBe(0);
    });

    it('이미 end_date가 새 값이면 변경 없음 (idempotent)', async () => {
        await db.doc('students/s5').set({
            name: '학생5', status: '재원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: CS_KEY, day: ['목','화'] },
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-05-14', end_date: NEW_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        const result = await syncNaesinPeriod(db, CS_KEY, before, after);

        expect(result.synced).toBe(0);
    });

    it('history_logs에 sync 기록 남김 (audit trail)', async () => {
        await db.doc('students/s6').set({
            name: '학생6', status: '재원',
            enrollments: [
                { class_type: '정규', level_symbol: 'HA', class_number: '102',
                  naesin_class_override: CS_KEY, day: ['목','화'] },
                { class_type: '내신', level_symbol: '', class_number: '',
                  day: ['화','목'], start_date: '2026-05-14', end_date: OLD_END },
            ],
        });

        const before = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: OLD_END };
        const after = { class_type: '내신', naesin_start: '2026-05-14', naesin_end: NEW_END };
        await syncNaesinPeriod(db, CS_KEY, before, after);

        const hist = await db.collection('history_logs').where('doc_id', '==', 's6').get();
        expect(hist.size).toBe(1);
        const h = hist.docs[0].data();
        expect(h.change_type).toBe('UPDATE');
        expect(h.google_login_id).toBe('cloud-function');
        expect(h.after).toContain(NEW_END);
        expect(h.after).toContain(CS_KEY);
    });
});
