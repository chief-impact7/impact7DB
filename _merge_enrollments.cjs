/**
 * students.csv에서 enrollment + branch 정보만 기존 students에 merge
 * 전화번호 등 다른 필드는 덮어쓰지 않음
 */
const admin = require('firebase-admin');
const sa = require('./service-account.json');
const fs = require('fs');
const readline = require('readline');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');

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

function makeDocId(name, phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
  return `${name}_${p}`.replace(/\s+/g, '_');
}

function branchFromClassNumber(num) {
  const first = (num || '').toString().trim().charAt(0);
  if (first === '1') return '2단지';
  if (first === '2') return '10단지';
  return '';
}

(async () => {
  if (DRY_RUN) console.log('🔍 DRY RUN\n');

  // Parse CSV
  const rl = readline.createInterface({ input: fs.createReadStream('students.csv'), crlfDelay: Infinity });
  let headers = null;
  const studentMap = {};

  for await (const line of rl) {
    if (!line.trim()) continue;
    const values = parseCSVLine(line);
    if (!headers) { headers = values.map(h => h.trim()); continue; }
    const raw = {};
    headers.forEach((h, i) => { raw[h] = (values[i] || '').trim(); });

    const name = raw['이름'];
    const phone = raw['학부모연락처1'] || raw['학생연락처'] || '';
    if (!name) continue;

    const classNumber = raw['레벨기호'] || '';  // old CSV: 레벨기호 = class_number
    const levelSymbol = raw['학부기호'] || '';   // old CSV: 학부기호 = level_symbol
    const branch = branchFromClassNumber(classNumber);
    const docId = makeDocId(name, phone);

    const dayRaw = raw['요일'] || '';
    const dayArr = dayRaw.split(/[,\s]+/).map(d => d.replace(/요일$/, '')).filter(d => d);

    const enrollment = {
      class_type: '정규',
      level_symbol: levelSymbol,
      class_number: classNumber,
      day: dayArr,
      start_date: raw['시작일'] || '',
      semester: '2026-Spring',
    };

    if (!studentMap[docId]) {
      studentMap[docId] = { branch, enrollments: [] };
    }

    const hasData = levelSymbol || classNumber || dayArr.length > 0;
    if (hasData) {
      studentMap[docId].enrollments.push(enrollment);
    }
    if (branch) studentMap[docId].branch = branch;
  }

  console.log(`CSV 학생 수: ${Object.keys(studentMap).length}`);

  // Fetch existing
  const snap = await db.collection('students').get();
  const existing = {};
  snap.forEach(d => { existing[d.id] = d.data(); });
  console.log(`Firestore 학생 수: ${Object.keys(existing).length}`);

  // Merge only enrollment + branch
  let updated = 0, skipped = 0, notFound = 0;
  const writes = [];

  for (const [docId, csv] of Object.entries(studentMap)) {
    const ex = existing[docId];
    if (!ex) { notFound++; continue; }

    const update = {};
    if (csv.branch && !ex.branch) update.branch = csv.branch;
    if (csv.enrollments.length > 0 && (!ex.enrollments || ex.enrollments.length === 0)) {
      update.enrollments = csv.enrollments;
    }

    if (Object.keys(update).length === 0) { skipped++; continue; }
    writes.push({ docId, data: update });
    updated++;
  }

  console.log(`\nUPDATE: ${updated}, SKIP: ${skipped}, NOT FOUND: ${notFound}`);

  if (DRY_RUN || writes.length === 0) {
    if (DRY_RUN) console.log('DRY RUN 완료.');
    process.exit(0);
  }

  // Batch write
  let batch = db.batch();
  let count = 0;
  for (const w of writes) {
    batch.set(db.collection('students').doc(w.docId), w.data, { merge: true });
    count++;
    if (count >= 450) {
      await batch.commit();
      console.log(`  ${count}건 커밋...`);
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();

  console.log(`\n✅ 완료. ${updated}명 enrollment/branch 업데이트`);
  process.exit(0);
})();
