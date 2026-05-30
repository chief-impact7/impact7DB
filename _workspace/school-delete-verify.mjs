import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, '../service-account.json'), 'utf8'))),
  projectId: 'impact7db',
});
const db = admin.firestore();

const snap = await db.collection('students').get();

let total = 0;
let stillHasSchool = 0;
const remaining = [];
let withE = 0, withM = 0, withH = 0, withGrade = 0; // 학부필드/라벨 보존 sanity
snap.forEach((d) => {
  total++;
  const x = d.data();
  if (Object.prototype.hasOwnProperty.call(x, 'school')) {
    stillHasSchool++;
    if (remaining.length < 50) remaining.push(d.id);
  }
  if (x.school_elementary) withE++;
  if (x.school_middle) withM++;
  if (x.school_high) withH++;
  if (x.school_level_grade) withGrade++;
});

console.log('=== 삭제 검증 (read-only) ===');
console.log(`전체 students: ${total}`);
console.log(`'school' 키 잔여: ${stillHasSchool}`);
if (stillHasSchool) console.log(`잔여 docId(최대50): ${JSON.stringify(remaining)}`);
console.log('--- 학부필드/라벨 보존 sanity ---');
console.log(`school_elementary 보유: ${withE}`);
console.log(`school_middle 보유: ${withM}`);
console.log(`school_high 보유: ${withH}`);
console.log(`school_level_grade 보유: ${withGrade}`);
console.log(JSON.stringify({ total, stillHasSchool, withE, withM, withH, withGrade }));
process.exit(0);
