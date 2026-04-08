/**
 * cleanup-test-data.js
 * 1) 최윤후: 중복 특강 enrollment 삭제 (수요특강 1개만 남김)
 * 2) 백한결: 특강111 enrollment 삭제 + status 필드 제거
 * 3) 테스트 class_settings 삭제 (소속 없는 학교학부학년 패턴)
 *
 * Usage:
 *   node cleanup-test-data.js          # dry-run
 *   node cleanup-test-data.js --run    # 실제 적용
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const DRY_RUN = !process.argv.includes('--run');
console.log(DRY_RUN ? 'DRY RUN 모드\n' : 'LIVE 모드\n');

function initFirebase() {
    try {
        const sa = JSON.parse(readFileSync(resolve('service-account.json'), 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
        return;
    } catch { /* next */ }
    try {
        const config = JSON.parse(readFileSync(resolve(homedir(), '.config/configstore/firebase-tools.json'), 'utf8'));
        const rt = config.tokens?.refresh_token;
        if (rt) {
            admin.initializeApp({
                credential: admin.credential.refreshToken({
                    type: 'authorized_user',
                    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
                    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
                    refresh_token: rt,
                }),
                projectId: 'impact7db',
            });
            return;
        }
    } catch { /* next */ }
    console.error('Firebase 인증 실패'); process.exit(1);
}

initFirebase();
const db = admin.firestore();

// 소속 prefix 없는 학교학부학년 패턴 (테스트 데이터)
const TEST_CLASS_SETTINGS = [
    '금옥여고1-2', '금옥여고2', '금옥여고2-2',
    '대일고1B',
    '목동고1', '목동고1-2',
    '백암고1-2', '백암고2-2',
    '신목고1-2', '신목고2-2', '신목중2A',
    '신서고1-2', '신서고2', '신서고2-2',
    '양천고1-2', '양천고2-2',
    '예림디자인고1-2',
];

async function run() {
    const batch = db.batch();
    let ops = 0;

    // 1. 최윤후: 중복 특강 enrollment 삭제
    console.log('=== 최윤후: 중복 특강 enrollment 삭제 ===');
    const yoonhuRef = db.collection('students').doc('최윤후_1088624638');
    const yoonhuSnap = await yoonhuRef.get();
    if (yoonhuSnap.exists) {
        const data = yoonhuSnap.data();
        const enrollments = data.enrollments || [];
        // 특강 enrollment 중 start_time 있는 것만 남김
        let keptOne = false;
        const newEnrollments = enrollments.filter(e => {
            if (e.class_type !== '특강') return true;
            if (!keptOne && e.start_time) { keptOne = true; return true; }
            console.log(`  삭제: enrollment`, JSON.stringify(e));
            return false;
        });
        if (newEnrollments.length < enrollments.length) {
            console.log(`  ${enrollments.length}개 → ${newEnrollments.length}개`);
            if (!DRY_RUN) { batch.update(yoonhuRef, { enrollments: newEnrollments }); ops++; }
        }
    }

    // 2. 백한결: 특강111 enrollment 삭제 + status 필드 제거
    console.log('\n=== 백한결: 특강111 삭제 + status 빈칸 ===');
    const hkRef = db.collection('students').doc('백한결_1090322336');
    const hkSnap = await hkRef.get();
    if (hkSnap.exists) {
        const data = hkSnap.data();
        const enrollments = data.enrollments || [];
        const newEnrollments = enrollments.filter(e => {
            const code = (e.level_symbol || '') + (e.class_number || '');
            if (code === '특강111') {
                console.log(`  삭제: enrollment`, JSON.stringify(e));
                return false;
            }
            return true;
        });
        const update = { enrollments: newEnrollments };
        // status 필드 제거
        if (data.status) {
            console.log(`  status: '${data.status}' → 삭제`);
            update.status = admin.firestore.FieldValue.delete();
        } else {
            console.log(`  status: 이미 없음`);
        }
        console.log(`  enrollments: ${enrollments.length}개 → ${newEnrollments.length}개`);
        if (!DRY_RUN) { batch.update(hkRef, update); ops++; }
    }

    // 3. 테스트 class_settings 삭제
    console.log('\n=== 테스트 class_settings 삭제 ===');
    for (const code of TEST_CLASS_SETTINGS) {
        const ref = db.collection('class_settings').doc(code);
        const snap = await ref.get();
        if (snap.exists) {
            console.log(`  삭제: ${code}`);
            if (!DRY_RUN) { batch.delete(ref); ops++; }
        } else {
            console.log(`  없음: ${code}`);
        }
    }

    if (!DRY_RUN && ops > 0) await batch.commit();
    console.log(`\n완료: ${ops}건 처리`);
    if (DRY_RUN) console.log('→ 실제 적용: node cleanup-test-data.js --run');
}

run().catch(err => { console.error(err); process.exit(1); });
