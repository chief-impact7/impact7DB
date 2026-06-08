import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, 'service-account.json'), 'utf8'))),
  projectId: 'impact7db',
});
const db = admin.firestore();
const RUN = process.argv.includes('--run');

const normalize = s => (s || '').replace(/\D/g, '');

const snap = await db.collection('students').get();
const changes = [];
const warnings = [];

snap.forEach(d => {
  const s = d.data();
  const p1 = s.parent_phone_1 || '';
  if (!p1.includes(',')) return;

  const idx = p1.indexOf(',');
  const newP1 = p1.slice(0, idx).trim();
  const extra = p1.slice(idx + 1).trim();
  if (!extra) return;
  if (!newP1) {
    warnings.push(`${d.id} (${s.name}): parent_phone_1이 쉼표로 시작 — 건너뜀 [값: ${p1}]`);
    return;
  }

  const p2 = (s.parent_phone_2 || '').trim();
  const update = { parent_phone_1: newP1 };

  if (!p2) {
    update.parent_phone_2 = extra;
  } else if (normalize(p2) === normalize(extra)) {
    // 동일 — parent_phone_2 그대로, parent_phone_1만 정리
  } else {
    if (s.other_phone) {
      warnings.push(`${d.id} (${s.name}): other_phone 이미 존재 → 건너뜀 [기존: ${s.other_phone}, 신규: ${extra}]`);
      return;
    }
    update.other_phone = extra;
  }

  changes.push({ id: d.id, name: s.name, ref: d.ref, update, before: p1, p2 });
});

console.log(`대상 ${changes.length}/${snap.size}건`);
if (warnings.length) {
  console.log(`\n⚠️  other_phone 충돌 ${warnings.length}건:`);
  warnings.forEach(w => console.log('  ' + w));
}

console.log('\n변경 목록:');
changes.slice(0, 30).forEach(c => {
  const detail = Object.entries(c.update).map(([k, v]) => `${k}: "${v}"`).join(', ');
  console.log(`  ${c.name} (${c.id}): [${c.before}] → ${detail}${c.p2 ? ` | p2 기존: ${c.p2}` : ''}`);
});
if (changes.length > 30) console.log(`  ... 외 ${changes.length - 30}건`);

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
