/**
 * migrate-enroll-log.js
 *
 * history_logs 중 change_type=ENROLL, after="신규 등록 (첫데이터): ..." 형태의
 * 로그를 "신규 등록: 이름 (반코드)" 형태로 소급 수정.
 *
 * - 반코드는 해당 학생의 현재 enrollments에서 추출.
 * - 퇴원 등으로 enrollment가 없는 경우: '수업없음' 으로 표시.
 *
 * Usage:
 *   node migrate-enroll-log.js          # dry-run (미리보기)
 *   node migrate-enroll-log.js --run    # 실제 적용
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRY_RUN = !process.argv.includes('--run');

console.log(DRY_RUN
    ? 'DRY RUN 모드 — Firestore에 쓰지 않습니다. 실제 적용: node migrate-enroll-log.js --run\n'
    : 'LIVE 모드 — Firestore에 실제로 씁니다.\n'
);

function initFirebase() {
    const saPath = resolve(__dirname, 'service-account.json');
    try {
        const sa = JSON.parse(readFileSync(saPath, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
        console.log('Firebase Admin: service-account.json 으로 인증됨\n');
        return;
    } catch { /* next */ }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ projectId: 'impact7db' });
        console.log('Firebase Admin: GOOGLE_APPLICATION_CREDENTIALS 로 인증됨\n');
        return;
    }
    console.error('오류: service-account.json 없음 & GOOGLE_APPLICATION_CREDENTIALS 미설정');
    process.exit(1);
}

const enrollmentCode = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;

initFirebase();
const db = admin.firestore();

async function run() {
    // 1. 대상 ENROLL 로그 조회
    console.log('history_logs (ENROLL, 구형식) 조회 중...');
    const snap = await db.collection('history_logs')
        .where('change_type', '==', 'ENROLL')
        .get();

    const targets = snap.docs.filter(d => {
        const after = d.data().after || '';
        return after.startsWith('신규 등록 (첫데이터):');
    });

    console.log(`전체 ENROLL 로그: ${snap.size}건 / 구형식(소급 대상): ${targets.length}건\n`);
    if (targets.length === 0) { console.log('소급할 대상 없음.'); return; }

    // 2. 관련 학생 데이터 로드
    const docIds = [...new Set(targets.map(d => d.data().doc_id))];
    console.log(`관련 학생 ${docIds.length}명 조회 중...`);
    const studentMap = {};
    // Firestore 'in' 쿼리는 최대 30개씩
    for (let i = 0; i < docIds.length; i += 30) {
        const chunk = docIds.slice(i, i + 30);
        const sSnap = await db.collection('students').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
        sSnap.forEach(d => { studentMap[d.id] = d.data(); });
    }

    // 3. 변경 내역 계산 + 미리보기
    console.log('\n--- 변경 미리보기 (최대 20건) ---');
    const updates = [];
    for (const logDoc of targets) {
        const data = logDoc.data();
        const student = studentMap[data.doc_id];
        const name = (data.after || '').replace('신규 등록 (첫데이터):', '').trim();
        const codes = student
            ? (student.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean).join(', ') || '수업없음'
            : '수업없음';
        const newAfter = `신규 등록: ${name} (${codes})`;
        updates.push({ id: logDoc.id, before: data.after, after: newAfter });
        if (updates.length <= 20) {
            console.log(`  [${logDoc.id.slice(0, 8)}] ${data.after}`);
            console.log(`    → ${newAfter}`);
        }
    }
    if (updates.length > 20) console.log(`  ... 외 ${updates.length - 20}건`);

    console.log(`\n총 ${updates.length}건 수정 예정.`);
    if (DRY_RUN) { console.log('\nDry-run 완료. --run 플래그 추가 시 실제 적용됩니다.'); return; }

    // 4. 배치 업데이트
    console.log('\nFirestore 업데이트 중...');
    const BATCH = 200;
    for (let i = 0; i < updates.length; i += BATCH) {
        const batch = db.batch();
        updates.slice(i, i + BATCH).forEach(u => {
            batch.update(db.collection('history_logs').doc(u.id), { after: u.after });
        });
        await batch.commit();
        console.log(`  ${Math.min(i + BATCH, updates.length)} / ${updates.length} 완료`);
    }
    console.log('\n✅ 소급 수정 완료');
}

run().catch(err => { console.error(err); process.exit(1); });
