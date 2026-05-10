// 종료된 + 0명인 class_settings를 grace period 후 자동 삭제.
// - 특강: special_end + 7일 < today, 학생 0명
// - 내신: naesin_end + 30일 < today, 학생 0명 (자동 유도 + 명시 + override 모두 포함)
//
// 삭제 시 history_logs에 before snapshot 기록 → 복구 가능.

import { FieldValue } from 'firebase-admin/firestore';
import { todayKST } from './kst.js';
import { enrollmentCode, resolveNaesinCsKey } from './naesinHelpers.js';

const SPECIAL_GRACE_DAYS = 7;
const NAESIN_GRACE_DAYS = 30;

function daysAgo(yyyymmdd, n) {
    const d = new Date(yyyymmdd + 'T00:00:00+09:00');
    d.setDate(d.getDate() - n);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function _countTeukangStudents(students, code) {
    return students.filter(s => (s.enrollments || []).some(
        e => e.class_type === '특강' && enrollmentCode(e) === code
    )).length;
}

function _countNaesinStudents(students, csKey) {
    return students.filter(s => {
        const enrolls = s.enrollments || [];
        // 명시적 '내신' enrollment 직접 매칭 (정규 enrollment 없이도 카운트)
        if (enrolls.some(e => e.class_type === '내신' && enrollmentCode(e) === csKey)) return true;
        // 정규/자유학기 enrollment 기반 자동 유도 + override 매칭
        const reg = enrolls.find(e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number);
        return !!reg && resolveNaesinCsKey(s, reg) === csKey;
    }).length;
}

export async function runClassCleanup(db, opts = {}) {
    const today = opts.today || todayKST();
    const specialCutoff = daysAgo(today, SPECIAL_GRACE_DAYS);
    const naesinCutoff = daysAgo(today, NAESIN_GRACE_DAYS);

    const [csSnap, sSnap] = await Promise.all([
        db.collection('class_settings').get(),
        db.collection('students').where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원', '상담']).get(),
    ]);

    const students = sSnap.docs.map(d => ({ docId: d.id, ...d.data() }));

    const candidates = [];
    for (const doc of csSnap.docs) {
        const code = doc.id;
        const cs = doc.data();
        if (!cs) continue;

        if (cs.class_type === '특강' && cs.special_end && cs.special_end < specialCutoff) {
            const count = _countTeukangStudents(students, code);
            if (count === 0) candidates.push({ code, mode: 'teukang', cs });
            continue;
        }

        const isNaesin = !!(cs.naesin_start && cs.naesin_end) && cs.class_type !== '특강';
        if (isNaesin && cs.naesin_end < naesinCutoff) {
            const count = _countNaesinStudents(students, code);
            if (count === 0) candidates.push({ code, mode: 'naesin', cs });
        }
    }

    if (candidates.length === 0) {
        return { deleted: 0, candidates: [] };
    }

    // delete + history_logs = 2 ops/건 → Firestore 배치 한도 500이므로 250건 단위로 청킹
    const CHUNK_SIZE = 250;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
        const chunk = candidates.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();
        const ts = FieldValue.serverTimestamp();
        for (const { code, mode, cs } of chunk) {
            batch.delete(db.doc(`class_settings/${code}`));
            batch.set(db.collection('history_logs').doc(), {
                doc_id: code,
                change_type: 'DELETE',
                before: JSON.stringify({
                    type: 'CLASS_AUTO_DELETE',
                    mode,
                    class_settings: cs,
                }),
                after: JSON.stringify({ deleted: true, mode, reason: 'scheduled-cleanup' }),
                google_login_id: 'scheduled-cleanup',
                timestamp: ts,
            });
        }
        await batch.commit();
    }

    return { deleted: candidates.length, candidates: candidates.map(c => ({ code: c.code, mode: c.mode })) };
}

// 테스트용 export
export const _internals = { daysAgo, _countTeukangStudents, _countNaesinStudents, SPECIAL_GRACE_DAYS, NAESIN_GRACE_DAYS };
