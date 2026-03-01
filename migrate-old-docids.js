/**
 * migrate-old-docids.js
 * _단지 접미사가 붙은 옛 문서를 새 형식(이름_연락처)으로 병합하는 일회성 마이그레이션
 *
 * - 옛 문서(이름_연락처_2단지 또는 이름_연락처_10단지)를 찾아서
 * - 새 형식 문서(이름_연락처)가 있으면 enrollment 병합 후 옛 문서 삭제
 * - 새 형식 문서가 없으면 옛 문서를 새 docId로 이동
 *
 * Usage:
 *   node migrate-old-docids.js              # dry-run (기본)
 *   node migrate-old-docids.js --execute    # 실제 실행
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes('--execute');

if (!EXECUTE) console.log('🔍 DRY RUN 모드 — Firestore에 쓰지 않습니다. --execute 플래그로 실제 실행\n');

// --- Firebase Admin init ---
function initFirebase() {
    const saPath = resolve(__dirname, 'service-account.json');
    try {
        const sa = JSON.parse(readFileSync(saPath, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
        console.log('Firebase Admin: service-account.json 으로 인증됨\n');
        return;
    } catch { /* file not found, try next */ }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ projectId: 'impact7db' });
        console.log('Firebase Admin: GOOGLE_APPLICATION_CREDENTIALS 로 인증됨\n');
        return;
    }

    console.error('Error: No Firebase credentials found.');
    process.exit(1);
}

initFirebase();
const db = admin.firestore();

const BRANCH_SUFFIXES = ['_2단지', '_10단지'];

async function migrate() {
    console.log('📂 전체 students 문서 로딩...');
    const snapshot = await db.collection('students').get();
    const allDocs = {};
    snapshot.forEach(doc => { allDocs[doc.id] = doc.data(); });

    const totalDocs = Object.keys(allDocs).length;
    console.log(`총 ${totalDocs}개 문서 로드 완료\n`);

    // _단지 접미사가 붙은 문서 찾기
    const oldDocs = [];
    for (const [docId, data] of Object.entries(allDocs)) {
        for (const suffix of BRANCH_SUFFIXES) {
            if (docId.endsWith(suffix)) {
                const newDocId = docId.slice(0, -suffix.length);
                oldDocs.push({ oldId: docId, newId: newDocId, data, suffix });
                break;
            }
        }
    }

    if (oldDocs.length === 0) {
        console.log('✅ 마이그레이션 대상 없음 — _단지 접미사 문서가 없습니다.');
        process.exit(0);
    }

    console.log(`🔍 마이그레이션 대상: ${oldDocs.length}개 문서\n`);

    const merged = [];   // 기존 문서에 병합
    const moved = [];    // 새 docId로 이동
    const writes = [];   // Firestore 쓰기 작업
    const logEntries = [];

    for (const { oldId, newId, data } of oldDocs) {
        const existing = allDocs[newId];

        if (existing) {
            // 새 형식 문서가 이미 있음 → enrollment 병합
            const oldEnrollments = data.enrollments || [];
            const existingEnrollments = existing.enrollments || [];

            // 중복 제거하며 병합: 옛 enrollment을 incoming으로 취급
            const allEnrollments = [...existingEnrollments];
            for (const oe of oldEnrollments) {
                const key = `${oe.class_type || '정규'}|${oe.level_symbol || ''}|${oe.class_number || ''}|${oe.semester || ''}`;
                const duplicate = allEnrollments.some(ee => {
                    const ek = `${ee.class_type || '정규'}|${ee.level_symbol || ''}|${ee.class_number || ''}|${ee.semester || ''}`;
                    return ek === key;
                });
                if (!duplicate) {
                    allEnrollments.push(oe);
                }
            }

            const addedCount = allEnrollments.length - existingEnrollments.length;

            console.log(`  🔀 병합: ${oldId} → ${newId}`);
            console.log(`     기존 enrollments: ${existingEnrollments.length}, 옛 문서: ${oldEnrollments.length}, 병합 후: ${allEnrollments.length} (+${addedCount})`);

            writes.push({ docId: newId, data: { enrollments: allEnrollments }, type: 'update' });
            writes.push({ docId: oldId, data: null, type: 'delete' });
            logEntries.push({
                doc_id: newId,
                change_type: 'MIGRATE_MERGE',
                before: `옛 문서 ${oldId} (enrollments: ${oldEnrollments.length})`,
                after: `병합 완료 (enrollments: ${allEnrollments.length})`,
            });
            merged.push({ oldId, newId, added: addedCount });
        } else {
            // 새 형식 문서가 없음 → 이동
            console.log(`  📦 이동: ${oldId} → ${newId}`);

            writes.push({ docId: newId, data, type: 'set' });
            writes.push({ docId: oldId, data: null, type: 'delete' });
            logEntries.push({
                doc_id: newId,
                change_type: 'MIGRATE_MOVE',
                before: `옛 문서 ${oldId}`,
                after: `새 docId ${newId}로 이동`,
            });
            moved.push({ oldId, newId });
        }
    }

    console.log(`\n📊 요약:`);
    console.log(`  병합: ${merged.length}개 (enrollment 추가: ${merged.reduce((s, m) => s + m.added, 0)}개)`);
    console.log(`  이동: ${moved.length}개`);
    console.log(`  총 쓰기: ${writes.length}개\n`);

    if (!EXECUTE) {
        console.log('🔍 DRY RUN 완료. 실제 실행하려면: node migrate-old-docids.js --execute');
        process.exit(0);
    }

    // 실제 실행
    console.log('🚀 Firestore에 쓰는 중...');
    const BATCH_SIZE = 400; // Firestore 배치 제한 500, 여유 확보
    let writeIdx = 0;
    let logIdx = 0;
    let batchNum = 0;

    while (writeIdx < writes.length || logIdx < logEntries.length) {
        const batch = db.batch();
        let ops = 0;

        const chunk = writes.slice(writeIdx, writeIdx + BATCH_SIZE);
        for (const w of chunk) {
            const ref = db.collection('students').doc(w.docId);
            if (w.type === 'delete') {
                batch.delete(ref);
            } else if (w.type === 'set') {
                batch.set(ref, w.data);
            } else {
                batch.set(ref, w.data, { merge: true });
            }
            ops++;
        }
        writeIdx += chunk.length;

        const logChunk = logEntries.slice(logIdx, logIdx + Math.min(BATCH_SIZE - ops, logEntries.length - logIdx));
        for (const log of logChunk) {
            const logRef = db.collection('history_logs').doc();
            batch.set(logRef, {
                ...log,
                google_login_id: 'system@migrate',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        logIdx += logChunk.length;

        await batch.commit();
        batchNum++;
        console.log(`  Batch ${batchNum}: ${chunk.length} writes, ${logChunk.length} logs`);
    }

    console.log(`\n✅ 마이그레이션 완료. 병합: ${merged.length}, 이동: ${moved.length}`);
    process.exit(0);
}

migrate().catch(err => {
    console.error('마이그레이션 실패:', err.message);
    process.exit(1);
});
