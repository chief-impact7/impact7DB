const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // 1) PROMOTION 이력 확인
  try {
    const logs = await db.collection('history_logs').where('change_type', '==', 'PROMOTION').limit(5).get();
    console.log(`=== PROMOTION 이력: ${logs.size}건 ===`);
    logs.forEach(doc => {
      const d = doc.data();
      const ts = d.timestamp?.toDate?.() || '?';
      console.log(`  ${d.doc_id}: ${d.before} → ${d.after} (${ts})`);
    });
  } catch (e) {
    console.log(`=== PROMOTION 이력 조회 실패: ${e.message} ===`);
  }

  // 2) 현재 학년 분포 확인
  const snap = await db.collection('students').get();
  const dist = {};
  const oddCases = []; // 이상한 학년 (중4이상, 고4이상 등)

  snap.forEach(doc => {
    const d = doc.data();
    if (d.status === '퇴원') return;
    const grade = parseInt(d.grade, 10);
    const key = `${d.level} ${d.grade}학년`;
    dist[key] = (dist[key] || 0) + 1;

    if (d.level === '중등' && grade > 3) oddCases.push({ id: doc.id, name: d.name, level: d.level, grade: d.grade });
    if (d.level === '고등' && grade > 3) oddCases.push({ id: doc.id, name: d.name, level: d.level, grade: d.grade });
    if (d.level === '초등' && grade > 6) oddCases.push({ id: doc.id, name: d.name, level: d.level, grade: d.grade });
  });

  console.log('\n=== 재원생 학년 분포 ===');
  Object.entries(dist).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}명`));

  console.log(`\n=== 비정상 학년 (초7+, 중4+, 고4+): ${oddCases.length}명 ===`);
  oddCases.slice(0, 15).forEach(s => console.log(`  ${s.id} (${s.name}) ${s.level} ${s.grade}학년`));
  if (oddCases.length > 15) console.log(`  ... 외 ${oddCases.length - 15}명`);

  // 3) 3/6 백업과 비교해서 grade 변화 확인
  const backup = require('./backups/students_2026-03-06.json');
  let changed = 0, same = 0;
  const sampleChanges = [];
  snap.forEach(doc => {
    const cur = doc.data();
    const prev = backup[doc.id];
    if (!prev || cur.status === '퇴원') return;
    if (cur.grade !== prev.grade) {
      changed++;
      if (sampleChanges.length < 5) sampleChanges.push({ name: cur.name, before: `${prev.level}${prev.grade}`, after: `${cur.level}${cur.grade}` });
    } else {
      same++;
    }
  });

  console.log(`\n=== 3/6 백업 대비 학년 변화 ===`);
  console.log(`  변경: ${changed}명, 유지: ${same}명`);
  sampleChanges.forEach(s => console.log(`  ${s.name}: ${s.before} → ${s.after}`));

  process.exit(0);
})();
