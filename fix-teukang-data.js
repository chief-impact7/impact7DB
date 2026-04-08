/**
 * fix-teukang-data.js
 * 1) class_settings에서 '수 특강 1회차', '수토특강A' 삭제
 * 2) 수요특강 4명(고태원, 김여원, 김지안, 최윤후) enrollment class_number → '수요특강'
 *
 * Usage:
 *   node fix-teukang-data.js          # dry-run
 *   node fix-teukang-data.js --run    # 실제 적용
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

const DELETE_CLASSES = ['수 특강 1회차', '수토특강A'];
const TARGET_CLASS = '수요특강';
const TARGET_STUDENTS = new Set(['고태원', '김여원', '김지안', '최윤후']);

async function run() {
    // 1. class_settings 삭제
    console.log('=== class_settings 삭제 ===');
    for (const code of DELETE_CLASSES) {
        const ref = db.collection('class_settings').doc(code);
        const snap = await ref.get();
        if (snap.exists) {
            console.log(`  삭제: class_settings/${code}`, snap.data());
            if (!DRY_RUN) await ref.delete();
        } else {
            console.log(`  없음: class_settings/${code}`);
        }
    }

    // 2. 수요특강 학생 enrollment 수정
    console.log('\n=== 수요특강 학생 enrollment 수정 ===');
    const snap = await db.collection('students').get();
    let fixed = 0;

    const batch = db.batch();
    for (const doc of snap.docs) {
        const data = doc.data();
        if (!TARGET_STUDENTS.has(data.name)) continue;

        const enrollments = data.enrollments || [];
        let changed = false;
        const newEnrollments = enrollments.map(e => {
            if (e.class_type !== '특강') return e;
            const code = (e.level_symbol || '') + (e.class_number || '');
            if (code === TARGET_CLASS) return e; // 이미 올바름
            if (code && code !== TARGET_CLASS) return e; // 다른 특강 반 — 건드리지 않음
            // class_number 비어있음 → 수요특강으로 수정
            console.log(`  [FIX] ${data.name} (${doc.id}): class_number='' → '${TARGET_CLASS}'`);
            changed = true;
            return { ...e, class_number: TARGET_CLASS };
        });

        if (changed) {
            if (!DRY_RUN) batch.update(doc.ref, { enrollments: newEnrollments });
            fixed++;
        }
    }

    if (!DRY_RUN && fixed > 0) await batch.commit();
    console.log(`\n완료: ${fixed}명 수정`);
    if (DRY_RUN) console.log('→ 실제 적용: node fix-teukang-data.js --run');
}

run().catch(err => { console.error(err); process.exit(1); });
