const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  console.log(`Today: ${today}`);

  const snap = await db.collection('students').get();
  const premature = [];

  snap.forEach(doc => {
    const d = doc.data();
    if ((d.status === '실휴원' || d.status === '가휴원') && d.pause_start_date && d.pause_start_date > today) {
      premature.push({ id: doc.id, name: d.name, status: d.status, pause_start_date: d.pause_start_date, pause_end_date: d.pause_end_date });
    }
  });

  console.log(`\n=== 아직 시작 전인데 휴원 상태인 학생: ${premature.length}명 ===`);
  premature.forEach(s => {
    console.log(`  ${s.id} (${s.name}) status=${s.status} pause=${s.pause_start_date}~${s.pause_end_date}`);
  });

  if (premature.length === 0) {
    console.log('No premature leaves to fix.');
    process.exit(0);
  }

  // Fix: revert to 재원, store scheduled_leave_status
  const batch = db.batch();
  for (const s of premature) {
    const ref = db.collection('students').doc(s.id);
    batch.update(ref, {
      status: '재원',
      scheduled_leave_status: s.status,
    });
    console.log(`  → ${s.name}: ${s.status} → 재원 (scheduled: ${s.status})`);
  }

  await batch.commit();
  console.log(`\nDone! ${premature.length}명 복구 완료`);
  process.exit(0);
})();
