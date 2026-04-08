const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  const snap = await db.collection('students').get();
  let count = 0;
  const sample = [];
  snap.forEach(d => {
    const e = d.data().enrollments || [];
    if (e.length > 0 && (e[0].level_symbol || e[0].class_number)) {
      count++;
      if (sample.length < 5) sample.push({ id: d.id, enrollments: e });
    }
  });
  console.log('enrollment 있는 학생:', count);
  console.log('\n샘플 5명:');
  sample.forEach(s => {
    console.log(`  ${s.id}:`);
    s.enrollments.forEach(e => {
      console.log(`    ${JSON.stringify(e)}`);
    });
  });
  process.exit(0);
})();
