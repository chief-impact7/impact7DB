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
const RUN = process.argv.includes('--run');

const snap = await db.collection('students').get();

// 'school' 키가 존재하는 문서만 (empty/사본/위험 전부 포함). 다른 필드는 절대 건드리지 않음.
const targets = [];
snap.forEach((d) => {
  const x = d.data();
  if (Object.prototype.hasOwnProperty.call(x, 'school')) targets.push(d.ref);
});

console.log('=== school 미러 키 삭제 ===');
console.log(`전체 students: ${snap.size}`);
console.log(`삭제 대상('school' 키 보유): ${targets.length}`);

if (!RUN) {
  console.log('\n[dry-run] --run 으로 실제 삭제');
  process.exit(0);
}

const BATCH = 200;
const totalBatches = Math.ceil(targets.length / BATCH);
let deleted = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const n = Math.floor(i / BATCH) + 1;
  const batch = db.batch();
  const slice = targets.slice(i, i + BATCH);
  slice.forEach((ref) => batch.update(ref, { school: admin.firestore.FieldValue.delete() }));
  await batch.commit();
  deleted += slice.length;
  console.log(`배치 ${n}/${totalBatches} commit (${deleted}/${targets.length})`);
}
console.log(`완료: ${deleted}건 삭제`);
process.exit(0);
