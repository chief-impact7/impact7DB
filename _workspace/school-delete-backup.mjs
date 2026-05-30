import admin from 'firebase-admin';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, '../service-account.json'), 'utf8'))),
  projectId: 'impact7db',
});
const db = admin.firestore();

const snap = await db.collection('students').get();

const backup = [];
let total = 0;
snap.forEach((d) => {
  total++;
  const x = d.data();
  if (!Object.prototype.hasOwnProperty.call(x, 'school')) return; // 'school' 키가 존재하는 문서만
  backup.push({
    docId: d.id,
    school: x.school ?? null,
    level: x.level ?? null,
    school_elementary: x.school_elementary ?? null,
    school_middle: x.school_middle ?? null,
    school_high: x.school_high ?? null,
  });
});

const outPath = resolve(__dirname, 'school-mirror-backup.json');
writeFileSync(outPath, JSON.stringify(backup, null, 2), 'utf8');

console.log('=== school 미러 백업 (read-only) ===');
console.log(`전체 students 스캔: ${total}`);
console.log(`'school' 키 보유(백업 대상): ${backup.length}`);
console.log(`백업 파일: ${outPath}`);
console.log(JSON.stringify({ total, backedUp: backup.length }));
process.exit(0);
