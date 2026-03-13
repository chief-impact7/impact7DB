/**
 * import-grammar-special.cjs
 * Google Form CSV → Firestore: 비내신 문법 특강 enrollment 등록
 *
 * CSV 컬럼 (Google Form 응답):
 *   학생이름, 학부모연락처, 재원생여부, 학교, 학부, 학년, 1주차, 2주차, 3주차
 *
 * 주차 선택 형식: "a / 수 / 19:00" (레벨 / 요일 / 시간)
 *
 * Usage:
 *   node import-grammar-special.cjs                              # live run
 *   node import-grammar-special.cjs --dry-run                    # preview only
 *   node import-grammar-special.cjs --file responses.csv         # custom CSV
 *   node import-grammar-special.cjs --start 2026-04-14 --end 2026-05-02
 */

const admin = require('firebase-admin');
const { createReadStream, readFileSync } = require('fs');
const { createInterface } = require('readline');
const { resolve } = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileIdx = args.indexOf('--file');
const csvFileName = fileIdx !== -1 && args[fileIdx + 1] ? args[fileIdx + 1] : 'grammar-special.csv';
const startIdx = args.indexOf('--start');
const START_DATE = startIdx !== -1 && args[startIdx + 1] ? args[startIdx + 1] : '2026-04-14';
const endIdx = args.indexOf('--end');
const END_DATE = endIdx !== -1 && args[endIdx + 1] ? args[endIdx + 1] : '2026-05-02';
const semIdx = args.indexOf('--semester');
const SEMESTER = semIdx !== -1 && args[semIdx + 1] ? args[semIdx + 1] : '2026-Spring';

if (DRY_RUN) console.log('🔍 DRY RUN 모드 — Firestore에 쓰지 않습니다.\n');
console.log(`기간: ${START_DATE} ~ ${END_DATE}`);
console.log(`학기: ${SEMESTER}\n`);

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
    console.error('1. Place a service-account.json in the project root');
    console.error('2. Set GOOGLE_APPLICATION_CREDENTIALS environment variable');
    process.exit(1);
}

initFirebase();
const db = admin.firestore();

// --- RFC 4180 CSV parser ---
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (ch === '"') { inQuotes = false; }
            else { current += ch; }
        } else {
            if (ch === '"') { inQuotes = true; }
            else if (ch === ',') { result.push(current.trim()); current = ''; }
            else { current += ch; }
        }
    }
    result.push(current.trim());
    return result;
}

// --- Helpers ---
function normalizePhone(raw) {
    let p = (raw || '').replace(/\D/g, '');
    if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
    return p;
}

function makeDocId(name, phone) {
    const p = normalizePhone(phone);
    return `${name}_${p}`.replace(/\s+/g, '_');
}

/**
 * Parse slot string: "a / 수 / 19:00" → { level: 'a', day: '수', time: '19:00' }
 */
function parseSlot(slotStr) {
    if (!slotStr || slotStr.trim() === '' || slotStr === '-') return null;
    const parts = slotStr.split('/').map(s => s.trim());
    if (parts.length < 3) {
        console.warn(`  ⚠ 슬롯 파싱 실패: "${slotStr}"`);
        return null;
    }
    return { level: parts[0], day: parts[1], time: parts[2] };
}

// --- Main ---
async function main() {
    const csvPath = resolve(__dirname, csvFileName);
    console.log(`CSV 파일: ${csvPath}\n`);

    // 1) Parse CSV
    const rows = [];
    const rl = createInterface({ input: createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
    let headers = null;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const cols = parseCSVLine(line);
        if (!headers) {
            headers = cols;
            console.log(`CSV 헤더: ${headers.join(' | ')}\n`);
            continue;
        }
        const row = {};
        headers.forEach((h, i) => { row[h] = cols[i] || ''; });
        rows.push(row);
    }

    console.log(`CSV 행 수: ${rows.length}\n`);
    if (rows.length === 0) { console.log('처리할 데이터가 없습니다.'); return; }

    // 2) Map column names (Google Form 응답 or custom)
    const colName = headers.find(h => /이름|name/i.test(h)) || headers[0];
    const colPhone = headers.find(h => /연락처|phone/i.test(h)) || headers[1];
    const colType = headers.find(h => /재원|비원|원생/i.test(h)) || headers[2];
    const colSchool = headers.find(h => /학교|school/i.test(h));
    const colLevel = headers.find(h => /학부|level/i.test(h));
    const colGrade = headers.find(h => /학년|grade/i.test(h));

    // Find week columns (1주차, 2주차, 3주차 or week1, week2, week3)
    const weekCols = headers.filter(h => /주차|week/i.test(h)).sort();
    console.log(`주차 컬럼: ${weekCols.join(', ') || '(없음 — 기본 3주차)'}\n`);

    // 3) Build student entries
    const entries = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const name = (row[colName] || '').trim();
        const phone = row[colPhone] || '';
        if (!name || !phone) {
            errors.push(`행 ${i + 2}: 이름 또는 연락처 누락`);
            continue;
        }

        const docId = makeDocId(name, phone);
        const isExisting = /재원/i.test(row[colType] || '');

        // Parse weekly schedule
        const weeklySchedule = [];
        for (let w = 0; w < weekCols.length; w++) {
            const slot = parseSlot(row[weekCols[w]]);
            if (slot) {
                weeklySchedule.push({ week: w + 1, ...slot });
            }
        }

        if (weeklySchedule.length === 0) {
            errors.push(`행 ${i + 2}: ${name} — 주차 선택 없음`);
            continue;
        }

        // Collect all unique days from weekly schedule
        const allDays = [...new Set(weeklySchedule.map(ws => ws.day))];

        entries.push({
            docId,
            name,
            phone: normalizePhone(phone),
            isExisting,
            school: colSchool ? (row[colSchool] || '').trim() : '',
            level: colLevel ? (row[colLevel] || '').trim() : '',
            grade: colGrade ? (row[colGrade] || '').trim() : '',
            weeklySchedule,
            allDays,
        });
    }

    if (errors.length > 0) {
        console.log('⚠ 파싱 오류:');
        errors.forEach(e => console.log(`  ${e}`));
        console.log();
    }
    console.log(`처리 대상: ${entries.length}명 (재원 ${entries.filter(e => e.isExisting).length} + 비원 ${entries.filter(e => !e.isExisting).length})\n`);

    // 4) Fetch existing students from Firestore
    console.log('Firestore 기존 데이터 확인 중...');
    const docIds = entries.map(e => e.docId);
    const existingDocs = {};

    // Fetch in batches of 10 (Firestore 'in' query limit)
    for (let i = 0; i < docIds.length; i += 10) {
        const chunk = docIds.slice(i, i + 10);
        const snap = await db.collection('students').where(admin.firestore.FieldPath.documentId(), 'in', chunk).get();
        snap.forEach(d => { existingDocs[d.id] = d.data(); });
    }
    console.log(`기존 학생 매칭: ${Object.keys(existingDocs).length}명\n`);

    // 5) Prepare writes
    const writes = [];
    const logEntries = [];
    let newCount = 0, updateCount = 0;

    for (const entry of entries) {
        const enrollment = {
            class_type: '특강',
            level_symbol: 'GR',
            class_number: '901',
            day: entry.allDays,
            start_date: START_DATE,
            end_date: END_DATE,
            semester: SEMESTER,
            weekly_schedule: entry.weeklySchedule,
        };

        const existing = existingDocs[entry.docId];

        if (existing) {
            // Existing student — append enrollment
            let enrollments = [...(existing.enrollments || [])];

            // Check for existing grammar special with same dates
            const existIdx = enrollments.findIndex(e =>
                e.class_type === '특강' && e.level_symbol === 'GR' &&
                e.start_date === START_DATE && e.end_date === END_DATE
            );
            if (existIdx >= 0) {
                enrollments[existIdx] = enrollment;
                console.log(`  ↻ ${entry.name}: 기존 문법 특강 덮어쓰기`);
            } else {
                enrollments.push(enrollment);
            }

            writes.push({ docId: entry.docId, data: { enrollments }, type: 'merge' });
            logEntries.push({
                doc_id: entry.docId,
                change_type: 'UPDATE',
                before: '—',
                after: `문법 특강 등록: ${entry.weeklySchedule.map(ws => `${ws.week}주=${ws.level}/${ws.day}/${ws.time}`).join(', ')} (${START_DATE}~${END_DATE})`,
            });
            updateCount++;
        } else {
            // New student (비원생) — create full record
            const studentData = {
                name: entry.name,
                parent_phone_1: entry.phone,
                level: entry.level || '',
                school: entry.school || '',
                grade: entry.grade || '',
                branch: '',
                status: '등원예정',
                student_phone: '',
                parent_phone_2: '',
                guardian_name_1: '',
                guardian_name_2: '',
                first_registered: START_DATE,
                enrollments: [enrollment],
            };

            writes.push({ docId: entry.docId, data: studentData, type: 'set' });

            // Also create contacts entry
            writes.push({
                docId: entry.docId,
                collection: 'contacts',
                data: {
                    name: entry.name,
                    parent_phone_1: entry.phone,
                    level: entry.level || '',
                    school: entry.school || '',
                    grade: entry.grade || '',
                },
                type: 'set',
            });

            logEntries.push({
                doc_id: entry.docId,
                change_type: 'ENROLL',
                before: '—',
                after: `비원생 문법 특강 신규등록: ${entry.name} ${entry.weeklySchedule.map(ws => `${ws.week}주=${ws.level}/${ws.day}/${ws.time}`).join(', ')}`,
            });
            newCount++;
        }
    }

    // 6) Print summary
    console.log('=== 처리 요약 ===');
    console.log(`  신규 등록 (비원생): ${newCount}명`);
    console.log(`  enrollment 추가 (재원생): ${updateCount}명`);
    console.log(`  총 Firestore 쓰기: ${writes.length}건`);
    console.log(`  history_logs: ${logEntries.length}건\n`);

    // Print details
    for (const entry of entries) {
        const tag = existingDocs[entry.docId] ? '재원' : '비원';
        const schedule = entry.weeklySchedule.map(ws => `${ws.week}주:${ws.level}/${ws.day}/${ws.time}`).join(' | ');
        console.log(`  [${tag}] ${entry.name} → ${schedule}`);
    }
    console.log();

    if (DRY_RUN) {
        console.log('🔍 DRY RUN 완료 — 실제 쓰기는 수행하지 않았습니다.');
        return;
    }

    // 7) Batch write to Firestore
    const BATCH_SIZE = 150;
    let writeIdx = 0, logIdx = 0, batchNum = 0;

    while (writeIdx < writes.length || logIdx < logEntries.length) {
        const wChunk = writes.slice(writeIdx, writeIdx + BATCH_SIZE);
        const lChunk = logEntries.slice(logIdx, logIdx + BATCH_SIZE);
        const batch = db.batch();

        for (const w of wChunk) {
            const coll = w.collection || 'students';
            const ref = db.collection(coll).doc(w.docId);
            if (w.type === 'set') {
                batch.set(ref, w.data);
            } else {
                batch.set(ref, w.data, { merge: true });
            }
        }

        for (const log of lChunk) {
            const logRef = db.collection('history_logs').doc();
            batch.set(logRef, {
                ...log,
                google_login_id: 'system@grammar-special-import',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        await batch.commit();
        batchNum++;
        console.log(`  Batch ${batchNum} committed (${wChunk.length} writes + ${lChunk.length} logs)`);
        writeIdx += wChunk.length;
        logIdx += lChunk.length;
    }

    console.log(`\n✅ 완료: ${writes.length}건 쓰기, ${logEntries.length}건 로그 기록됨`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
