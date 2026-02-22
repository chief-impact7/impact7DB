/**
 * import-students.js
 * Upserts all rows from students.csv into the Firestore `students` collection.
 * Uses the client SDK (no service account needed while rules are open).
 * Uses batched writes (500 per batch) for performance.
 *
 * docId strategy: 이름_부모연락처_branch
 *   - 재등록/반변경: 같은 docId → 필드만 업데이트 (중복 없음)
 *   - 형제: 이름이 달라 자동으로 구분
 *   - 다단지 동시 수강: branch가 달라 별도 문서
 *
 * Run: node import-students.js
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, writeBatch, collection, getDocs } from 'firebase/firestore';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Firebase init ---
const firebaseConfig = {
    apiKey: "AIzaSyCb2DKuKVjYevqDlmeL3qa07jSE5azm8Nw",
    authDomain: "impact7db.firebaseapp.com",
    projectId: "impact7db",
    storageBucket: "impact7db.firebasestorage.app",
    messagingSenderId: "485669859162",
    appId: "1:485669859162:web:2cfe866520c0b8f3f74d63"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- docId generator: 이름_부모연락처_branch ---
// 재등록/반변경 시 같은 docId → 필드 업데이트만 (중복 없음)
// 형제: 이름이 달라 자동 구분
// 다단지 동시 수강: branch가 달라 별도 문서
function makeDocId(row) {
    const name   = (row.name   || '').trim();
    const phone  = (row.parent_phone_1 || row.student_phone || '').replace(/\D/g, '');
    const branch = (row.branch || '').trim();
    return `${name}_${phone}_${branch}`.replace(/\s+/g, '_');
}

// --- Column mapping ---
// Headers: ID,이름,학부,학교,학년,학생연락처,학부모연락처1,학부모연락처2,branch,학부기호,레벨기호,시작일,요일,상태
function rowToDoc(headers, values) {
    const raw = {};
    headers.forEach((h, i) => { raw[h.trim()] = (values[i] || '').trim(); });

    return {
        name:           raw['이름'],
        level:          raw['학부'],           // 초등 / 중등 / 고등
        school:         raw['학교'],
        grade:          raw['학년'],
        student_phone:  raw['학생연락처'],
        parent_phone_1: raw['학부모연락처1'],
        parent_phone_2: raw['학부모연락처2'],
        branch:         raw['branch'],
        level_code:     raw['학부기호'],
        level_symbol:   raw['레벨기호'],
        start_date:     raw['시작일'],
        day:            raw['요일'],
        status:         raw['상태'] || 'active',   // 재원 = active
    };
}

// --- Parse CSV ---
async function parseCSV(filePath) {
    const rows = [];
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    let headers = null;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const values = line.split(',');
        if (!headers) {
            headers = values;
        } else {
            rows.push(rowToDoc(headers, values));
        }
    }
    return rows;
}

// --- Delete all existing documents in a collection ---
async function clearCollection(colName) {
    const snap = await getDocs(collection(db, colName));
    if (snap.empty) return 0;
    const BATCH_SIZE = 499;
    let deleted = 0;
    for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += Math.min(BATCH_SIZE, snap.docs.length - i);
    }
    return deleted;
}

// --- Main ---
async function importStudents() {
    const csvPath = resolve(__dirname, 'students.csv');
    const students = await parseCSV(csvPath);
    console.log(`Parsed ${students.length} student(s) from CSV.\n`);

    // Clear existing documents (old docId scheme)
    console.log('기존 문서 삭제 중...');
    const deleted = await clearCollection('students');
    console.log(`  삭제 완료: ${deleted}개\n`);

    let created = 0, skipped = 0;
    const BATCH_SIZE = 499;
    const entries = [];

    for (const student of students) {
        if (!student.name) { skipped++; continue; }
        const docId = makeDocId(student);
        entries.push({ docId, student });
    }

    // Commit in batches of 499
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const chunk = entries.slice(i, i + BATCH_SIZE);
        const batch = writeBatch(db);
        for (const { docId, student } of chunk) {
            batch.set(doc(db, 'students', docId), student);
            created++;
        }
        await batch.commit();
        console.log(`  Batch committed: rows ${i + 1}–${Math.min(i + BATCH_SIZE, entries.length)}`);
    }

    console.log(`\nDone. Imported: ${created} | Skipped: ${skipped}`);
    process.exit(0);
}

importStudents().catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
});
