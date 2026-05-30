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
let empty = 0;
let copy = 0;
const risky = [];

snap.forEach((d) => {
  total++;
  const x = d.data();
  const v = (x.school || '').trim();
  if (v === '') { empty++; return; }
  const fields = [
    (x.school_elementary || '').trim(),
    (x.school_middle || '').trim(),
    (x.school_high || '').trim(),
  ];
  if (fields.includes(v)) { copy++; return; }
  risky.push({
    id: d.id,
    name: x.name || '',
    level: x.level || '',
    status: x.status || '',
    school: x.school || '',
    school_elementary: x.school_elementary || '',
    school_middle: x.school_middle || '',
    school_high: x.school_high || '',
  });
});

console.log('=== school 미러 삭제 안전성 audit (read-only) ===');
console.log(`전체 students: ${total}`);
console.log(`안전(empty): ${empty}`);
console.log(`안전(사본): ${copy}`);
console.log(`위험(손실): ${risky.length}`);

// status 분류 (위험 건)
const byStatus = {};
const activeStatuses = new Set(['재원', '등원예정']);
let activeRisky = 0;
for (const r of risky) {
  byStatus[r.status || '(없음)'] = (byStatus[r.status || '(없음)'] || 0) + 1;
  if (activeStatuses.has(r.status)) activeRisky++;
}
console.log('\n--- 위험 건 status 분류 ---');
Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => console.log(`  ${s}: ${c}`));
console.log(`\n>>> 위험 중 활성(재원·등원예정): ${activeRisky}`);

// 위험 원인 추정 분류
let allFieldsEmpty = 0;   // 학부필드 3개 전부 비어있음 (백필 누락)
let levelFieldEmptyOnly = 0; // 해당 level 필드만 비어있고 다른 학부필드엔 값 있음 (진급 stale 가능)
let mismatch = 0;          // 학부필드에 값이 있는데 school과 불일치 (깨진/stale)
for (const r of risky) {
  const fe = (r.school_elementary || '').trim();
  const fm = (r.school_middle || '').trim();
  const fh = (r.school_high || '').trim();
  const anyField = fe || fm || fh;
  if (!anyField) { allFieldsEmpty++; continue; }
  const levelField = { '초등': fe, '중등': fm, '고등': fh }[r.level] || '';
  if (!levelField && anyField) { levelFieldEmptyOnly++; continue; }
  mismatch++;
}
console.log('\n--- 위험 원인 추정 ---');
console.log(`  학부필드 3개 전부 빔 (백필 누락): ${allFieldsEmpty}`);
console.log(`  현재 level 필드만 빔, 다른 학부필드엔 값 (진급 stale): ${levelFieldEmptyOnly}`);
console.log(`  학부필드 값 존재하나 school과 불일치 (깨짐/stale): ${mismatch}`);

console.log('\n--- 위험 샘플 (최대 15건) ---');
risky.slice(0, 15).forEach((r) => {
  console.log(`  [${r.status}/${r.level}] ${r.name} | school="${r.school}" | e="${r.school_elementary}" m="${r.school_middle}" h="${r.school_high}"`);
});

// 활성 위험 건은 전부 출력 (핵심)
const activeList = risky.filter((r) => activeStatuses.has(r.status));
if (activeList.length) {
  console.log('\n--- 활성(재원·등원예정) 위험 전체 ---');
  activeList.forEach((r) => {
    console.log(`  [${r.status}/${r.level}] ${r.name} | school="${r.school}" | e="${r.school_elementary}" m="${r.school_middle}" h="${r.school_high}"`);
  });
}

console.log('\n=== GATE ===');
console.log(JSON.stringify({ total, empty, copy, risky: risky.length, activeRisky }));
process.exit(0);
