// class_settings.naesin_start/end 변경 시 매핑된 학생들의 명시적 내신 enrollment.end_date를 sync.
//
// 동작 조건:
//   - cs.class_type === '내신'
//   - before.naesin_start !== after.naesin_start  또는  before.naesin_end !== after.naesin_end
//
// 대상 학생:
//   - 활성 상태 (재원/등원예정/실휴원/가휴원)
//   - 정규/자유학기 enrollment에 naesin_class_override === csKey 박혀있음
//
// 업데이트 내용:
//   - class_type='내신' + level_symbol/class_number 빈 enrollment 중
//   - start_date >= after.naesin_start 인 것의 end_date를 after.naesin_end로 sync
//   - 변경된 학생마다 history_logs UPDATE 기록 (cloud-function 작성자)
//
// 배치 한도(500 ops) 처리: 큰 반에서도 안전하도록 chunk 단위로 commit.

import { FieldValue } from 'firebase-admin/firestore';

const ACTIVE_STATUSES = ['재원', '등원예정', '실휴원', '가휴원'];
const BATCH_CHUNK_SIZE = 200; // student.update + history_logs.set = 2 ops × 200 = 400 ops/commit

export async function syncNaesinPeriod(db, csKey, before, after) {
    if (after?.class_type !== '내신') return { skipped: 'not-naesin' };
    const startChanged = before?.naesin_start !== after?.naesin_start;
    const endChanged = before?.naesin_end !== after?.naesin_end;
    if (!startChanged && !endChanged) return { skipped: 'no-change' };

    // status='in' 쿼리는 최대 30개라 4개 잘 들어감
    const snap = await db.collection('students')
        .where('status', 'in', ACTIVE_STATUSES)
        .get();

    const targets = []; // { ref, id, enrollments: newEnrollments, changes: [...] }
    snap.forEach(doc => {
        const s = doc.data();
        const enrollments = s.enrollments || [];
        const hasOverride = enrollments.some(e =>
            ((e.class_type === '정규' || e.class_type === '자유학기') ||
             (!e.class_type && (e.level_symbol || e.class_number))) &&
            e.naesin_class_override === csKey
        );
        if (!hasOverride) return;

        const changes = [];
        const newEnrollments = enrollments.map((e, idx) => {
            if (e.class_type !== '내신') return e;
            if (e.level_symbol || e.class_number) return e;
            // 현재 cs 활성 기간 내 시작인 내신 enrollment만 sync (옛 학기 내신은 보존)
            if (!e.start_date) return e;
            if (after.naesin_start && e.start_date < after.naesin_start) return e;
            if (e.end_date === after.naesin_end) return e;
            changes.push(`#${idx} end_date ${e.end_date || '(없음)'}→${after.naesin_end}`);
            return { ...e, end_date: after.naesin_end };
        });
        if (changes.length > 0) {
            targets.push({ ref: doc.ref, id: doc.id, enrollments: newEnrollments, changes });
        }
    });

    if (targets.length === 0) return { synced: 0, csKey };

    // chunk 단위로 commit
    for (let i = 0; i < targets.length; i += BATCH_CHUNK_SIZE) {
        const chunk = targets.slice(i, i + BATCH_CHUNK_SIZE);
        const batch = db.batch();
        for (const t of chunk) {
            batch.update(t.ref, { enrollments: t.enrollments });
            const histRef = db.collection('history_logs').doc();
            batch.set(histRef, {
                doc_id: t.id,
                change_type: 'UPDATE',
                before: `${csKey} naesin_end=${before?.naesin_end || '(없음)'}`,
                after: `${csKey} naesin_end sync → ${after.naesin_end} (${t.changes.join('; ')}) [cloud-function]`,
                google_login_id: 'cloud-function',
                timestamp: FieldValue.serverTimestamp(),
            });
        }
        await batch.commit();
    }

    return { synced: targets.length, csKey };
}
