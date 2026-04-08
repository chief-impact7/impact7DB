const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const ids = [
    '김지후_0107658688501090944944',  // 대일고3
    '김지후_1089234636',               // 양정고4
  ];

  for (const id of ids) {
    const doc = await db.collection('students').doc(id).get();
    if (doc.exists) {
      console.log(`\n=== ${id} ===`);
      console.log(JSON.stringify(doc.data(), null, 2));
    } else {
      console.log(`\n[DELETED] ${id}`);
    }
  }

  process.exit(0);
})();
