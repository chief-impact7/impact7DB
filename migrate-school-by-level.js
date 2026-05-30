import admin from 'firebase-admin';
import { studentFullLabel, currentSchool, SCHOOL_FIELD } from '@impact7/shared/student-label';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, 'service-account.json'), 'utf8'))), projectId: 'impact7db' });
const db = admin.firestore();
const RUN = process.argv.includes('--run');
const CURRENT_SEMS = new Set(['2026-Spring', '2026-Spring1', '2026-Spring2']);
const inCurrentSem = (x) => (x.enrollments || []).some(e => CURRENT_SEMS.has(e.semester));

const snap = await db.collection('students').get();
const changes = [];
snap.forEach(d => {
  const x = d.data();
  if (!inCurrentSem(x)) return;
  const field = SCHOOL_FIELD[x.level];
  const update = {};
  if (field && !x[field] && x.school) update[field] = x.school;
  const merged = { ...x, ...update };
  const label = studentFullLabel(merged);
  if (x.school_level_grade !== label) update.school_level_grade = label;
  const mirror = currentSchool(merged);
  if (mirror && x.school !== mirror) update.school = mirror;
  if (Object.keys(update).length) changes.push({ id: d.id, ref: d.ref, update, status: x.status, level: x.level, grade: x.grade });
});

const labelCount = changes.filter(c => c.update.school_level_grade).length;
const grad = changes.filter(c => (c.update.school_level_grade || '').includes('(졸업+'));
console.log(`대상 ${changes.length}/${snap.size}건 (라벨 ${labelCount})`);
console.log(`"(졸업+" 포함 라벨: ${grad.length}건`);
grad.slice(0, 5).forEach(c => console.log(`  [졸업오판?] ${c.id} ${c.status} ${c.level}/${c.grade} → ${c.update.school_level_grade}`));
changes.slice(0, 25).forEach(c => console.log(`  ${c.id} [${c.status}]: ${JSON.stringify(c.update)}`));
if (changes.length > 25) console.log(`  ... 외 ${changes.length - 25}건`);
if (!RUN) { console.log('\n[dry-run] --run 으로 반영'); process.exit(0); }

const BATCH = 200;
for (let i = 0; i < changes.length; i += BATCH) {
  const batch = db.batch();
  changes.slice(i, i + BATCH).forEach(c => batch.update(c.ref, c.update));
  await batch.commit();
  console.log(`커밋 ${Math.min(i + BATCH, changes.length)}/${changes.length}`);
}
console.log('완료');
process.exit(0);
