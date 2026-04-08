/**
 * check-cleanup.js
 * 1) 최윤후 전체 enrollments 조회
 * 2) class_settings 전체 목록 출력 (정리 대상 확인)
 * 3) 특강111 학생 조회
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

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

async function run() {
    // 1. 최윤후 enrollments
    console.log('=== 최윤후 enrollments ===');
    const snap = await db.collection('students').get();
    for (const doc of snap.docs) {
        const d = doc.data();
        if (d.name === '최윤후') {
            console.log(`  docId: ${doc.id}`);
            console.log(`  status: ${d.status || '(없음)'}, status2: ${d.status2 || '(없음)'}`);
            (d.enrollments || []).forEach((e, i) => {
                console.log(`  enrollment[${i}]:`, JSON.stringify(e));
            });
            console.log('');
        }
    }

    // 2. class_settings 전체 목록
    console.log('=== class_settings 전체 목록 ===');
    const csSnap = await db.collection('class_settings').get();
    const codes = [];
    csSnap.forEach(d => {
        const data = d.data();
        codes.push({ code: d.id, class_type: data.class_type || '(없음)', schedule: data.schedule });
    });
    codes.sort((a, b) => a.code.localeCompare(b.code, 'ko'));
    codes.forEach(c => {
        const scheduleStr = typeof c.schedule === 'object' && !Array.isArray(c.schedule)
            ? Object.keys(c.schedule).join(',')
            : JSON.stringify(c.schedule);
        console.log(`  ${c.code} [${c.class_type}] schedule=${scheduleStr}`);
    });

    // 3. 특강111 학생
    console.log('\n=== 특강111 enrollment이 있는 학생 ===');
    for (const doc of snap.docs) {
        const d = doc.data();
        const has111 = (d.enrollments || []).some(e => {
            const code = (e.level_symbol || '') + (e.class_number || '');
            return code === '특강111';
        });
        if (has111) {
            console.log(`  ${d.name} (${doc.id}) status=${d.status || '(없음)'}`);
            (d.enrollments || []).forEach((e, i) => {
                console.log(`    enrollment[${i}]:`, JSON.stringify(e));
            });
        }
    }

    // 4. 학교학부학년 패턴 class_settings 찾기
    console.log('\n=== 학교학부학년 패턴 class_settings (테스트 데이터) ===');
    const schoolPattern = /^[가-힣]+(?:고|중)\d/;
    codes.filter(c => schoolPattern.test(c.code)).forEach(c => {
        console.log(`  ${c.code} [${c.class_type}]`);
    });
}

run().catch(err => { console.error(err); process.exit(1); });
