const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const docId = '김지후_0107658688501090944944';
  const ref = db.collection('students').doc(docId);

  const doc = await ref.get();
  if (!doc.exists) {
    console.log('Document not found!');
    process.exit(1);
  }

  console.log('Before:', JSON.stringify(doc.data().enrollments));

  await ref.update({
    enrollments: [{ semester: '2026-Spring' }]
  });

  const updated = await ref.get();
  console.log('After:', JSON.stringify(updated.data().enrollments));
  console.log('Done!');
  process.exit(0);
})();
