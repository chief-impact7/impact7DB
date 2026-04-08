/**
 * migrate-teukang-class-number.js
 * 특강 enrollment에 class_number가 비어있는 경우, class_settings에서 class_type='특강'인
 * 반 코드를 찾아 schedule 매칭으로 class_number를 채워줍니다.
 *
 * Usage:
 *   node migrate-teukang-class-number.js        # dry-run
 *   node migrate-teukang-class-number.js --run  # 실제 적용
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--run');

if (DRY_RUN) {
    console.log('DRY RUN 모드 — 실제로 Firestore에 쓰지 않습니다.');
    console.log('실제 적용하려면: node migrate-teukang-class-number.js --run\n');
} else {
    console.log('LIVE 모드 — Firestore에 실제로 씁니다.\n');
}

function initFirebase() {
    try {
        const saPath = resolve('service-account.json');
        const sa = JSON.parse(readFileSync(saPath, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
        console.log('Firebase Admin: service-account.json 으로 인증됨\n');
        return;
    } catch { /* try next */ }

    try {
        const configPath = resolve(homedir(), '.config/configstore/firebase-tools.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const refreshToken = config.tokens?.refresh_token;
        if (refreshToken) {
            admin.initializeApp({
                credential: admin.credential.refreshToken({
                    type: 'authorized_user',
                    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
                    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
                    refresh_token: refreshToken,
                }),
                projectId: 'impact7db',
            });
            console.log('Firebase Admin: Firebase CLI 토큰으로 인증됨\n');
            return;
        }
    } catch { /* try next */ }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ projectId: 'impact7db' });
        console.log('Firebase Admin: GOOGLE_APPLICATION_CREDENTIALS 로 인증됨\n');
        return;
    }

    console.error('오류: Firebase 인증 정보를 찾을 수 없습니다.');
    process.exit(1);
}

initFirebase();
const db = admin.firestore();

async function migrate() {
    // 1. class_settings에서 특강 반 목록 수집 (code → schedule)
    console.log('class_settings 로드 중...');
    const settingsSnap = await db.collection('class_settings').get();
    const teukangClasses = {}; // code → Set<day>
    settingsSnap.forEach(d => {
        const data = d.data();
        if (data.class_type === '특강') {
            // schedule은 { day: time } 객체 형태
            const days = typeof data.schedule === 'object' && !Array.isArray(data.schedule)
                ? Object.keys(data.schedule)
                : (data.schedule || []);
            teukangClasses[d.id] = new Set(days);
        }
    });
    console.log('특강 반 목록:', Object.keys(teukangClasses));
    if (Object.keys(teukangClasses).length === 0) {
        console.log('특강 반이 없습니다. 종료.');
        return;
    }

    // 2. students 중 특강 enrollment가 있고 class_number가 비어있는 경우 처리
    console.log('\nstudents 컬렉션 로드 중...');
    const studentsSnap = await db.collection('students').get();
    console.log(`전체 학생 수: ${studentsSnap.size}명\n`);

    let updated = 0;
    let skipped = 0;
    const BATCH_SIZE = 400;
    let batch = db.batch();
    let batchCount = 0;

    for (const doc of studentsSnap.docs) {
        const data = doc.data();
        const enrollments = data.enrollments || [];
        let changed = false;

        const newEnrollments = enrollments.map(e => {
            if (e.class_type !== '특강') return e;
            const code = (e.level_symbol || '') + (e.class_number || '');
            if (code) return e; // 이미 class_number가 있음

            // schedule 매칭으로 반 코드 결정
            const days = new Set(e.day || []);
            const matched = Object.entries(teukangClasses).find(([, schedule]) =>
                [...days].some(d => schedule.has(d))
            );

            if (!matched) {
                console.log(`  [SKIP] ${data.name} (${doc.id}): 매칭 특강 반 없음 (days=${[...days].join(',')})`);
                return e;
            }

            const [classCode] = matched;
            console.log(`  [FIX]  ${data.name}: class_number='' → '${classCode}'`);
            changed = true;
            return { ...e, class_number: classCode };
        });

        if (!changed) { skipped++; continue; }

        if (!DRY_RUN) {
            batch.update(doc.ref, { enrollments: newEnrollments });
            batchCount++;
            if (batchCount >= BATCH_SIZE) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        updated++;
    }

    if (!DRY_RUN && batchCount > 0) await batch.commit();

    console.log(`\n완료: 수정=${updated}명, 스킵=${skipped}명`);
    if (DRY_RUN) console.log('\n→ 실제 적용: node migrate-teukang-class-number.js --run');
}

migrate().catch(err => { console.error(err); process.exit(1); });
