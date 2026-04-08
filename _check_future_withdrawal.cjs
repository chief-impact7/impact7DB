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
    if (d.status === '퇴원' && d.withdrawal_date && d.withdrawal_date > today) {
      premature.push({ id: doc.id, name: d.name, withdrawal_date: d.withdrawal_date });
    }
  });

  console.log(`\n=== 퇴원 상태인데 withdrawal_date가 미래인 학생: ${premature.length}명 ===`);
  premature.forEach(s => {
    console.log(`  ${s.id} (${s.name}) withdrawal_date=${s.withdrawal_date}`);
  });

  process.exit(0);
})();
