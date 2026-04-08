const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // Check both document IDs
  const ids = [
    '김지후_0107658688501090944944',  // 대일고3
    '김지후_1089234636',               // 양정고4
  ];

  for (const id of ids) {
    const doc = await db.collection('students').doc(id).get();
    if (doc.exists) {
      const d = doc.data();
      console.log(`\n[EXISTS] ${id}`);
      console.log(`  name: ${d.name}, school: ${d.school}, grade: ${d.grade}, level: ${d.level}, status: ${d.status}`);
      if (d.enrollments?.length) console.log(`  enrollments:`, JSON.stringify(d.enrollments));
    } else {
      console.log(`\n[DELETED] ${id}`);
    }
  }

  // Also search by name for any 김지후 with 대일 or 양정
  const snap = await db.collection('students').where('name', '==', '김지후').get();
  console.log(`\n--- All "김지후" (no suffix) in Firestore: ${snap.size} docs ---`);
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`  ${doc.id}: school=${d.school}, grade=${d.grade}, level=${d.level}, status=${d.status}`);
  });

  process.exit(0);
})();
