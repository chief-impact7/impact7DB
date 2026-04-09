// 목적: 김도영2 병합 후 남은 orphan contacts/김도영_2_1043638213 삭제
const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const EXECUTE = process.argv.includes('--execute');
const ORPHAN_ID = '김도영_2_1043638213';

(async () => {
  console.log(`\n=== 모드: ${EXECUTE ? '★ 실제 실행 ★' : 'DRY-RUN'} ===\n`);

  const [cSnap, sSnap] = await Promise.all([
    db.collection('contacts').doc(ORPHAN_ID).get(),
    db.collection('students').doc(ORPHAN_ID).get(),
  ]);

  if (sSnap.exists) {
    console.log(`  ⚠️  students/${ORPHAN_ID}가 여전히 존재. orphan이 아님. 중단.`);
    process.exit(1);
  }
  if (!cSnap.exists) {
    console.log(`  ⚠️  contacts/${ORPHAN_ID} 이미 없음.`);
    process.exit(0);
  }

  console.log(`  contacts/${ORPHAN_ID} 내용:`);
  const data = cSnap.data();
  for (const k of Object.keys(data).sort()) {
    let v = data[k];
    if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    console.log(`    ${k}: ${String(v ?? '').slice(0, 120)}`);
  }

  // 새 students/김도영2_1043638213가 존재하는지 확인 (병합이 올바로 완료됐는지)
  const newStudent = await db.collection('students').doc('김도영2_1043638213').get();
  if (!newStudent.exists) {
    console.log(`  ❌ 새 students/김도영2_1043638213 존재 안 함! 병합 미완료. 중단.`);
    process.exit(1);
  }
  console.log(`  ✓ 새 students/김도영2_1043638213 존재 확인 (status=${newStudent.data().status})`);

  if (EXECUTE) {
    await db.collection('contacts').doc(ORPHAN_ID).delete();
    console.log(`  ✅ contacts/${ORPHAN_ID} 삭제 완료`);
  } else {
    console.log(`  [DRY-RUN] contacts/${ORPHAN_ID} 삭제 예정`);
  }

  process.exit(0);
})();
