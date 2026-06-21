import admin from 'firebase-admin';
import { studentFullLabel, SCHOOL_FIELD } from '@impact7/shared/student-label';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, 'service-account.json'), 'utf8'))), projectId: 'impact7db' });
const db = admin.firestore();
const RUN = process.argv.includes('--run');

const snap = await db.collection('students').get();
const changes = [];
snap.forEach(d => {
  const x = d.data();
  const field = SCHOOL_FIELD[x.level];
  const update = {};
  if (field && !x[field] && x.school) update[field] = x.school;
  const merged = { ...x, ...update };
  const hasAnySchool = !!(merged.school_elementary || merged.school_middle || merged.school_high);
  if (!hasAnySchool) return;
  const label = studentFullLabel(merged);
  if (x.school_level_grade !== label) update.school_level_grade = label;
  // 폐기된 school 미러 write 제거(O-02) — school_* 가 SSoT. Admin SDK는 rules를 우회하므로
  // 여기서 school을 다시 쓰면 삭제한 미러가 되살아난다.
  if (Object.keys(update).length) changes.push({ id: d.id, ref: d.ref, update });
});

const gradCount = changes.filter(c => (c.update.school_level_grade || '').includes('(졸업+')).length;
console.log(`대상 ${changes.length}/${snap.size}건 (졸업 라벨 ${gradCount})`);
changes.slice(0, 25).forEach(c => console.log(`  ${c.id}: ${JSON.stringify(c.update)}`));
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
