const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const snap = await db.collection('students').limit(5).get();
  console.log('students count (limit 5):', snap.size);
  snap.forEach(d => console.log(d.id, d.data().name, d.data().status));
  process.exit(0);
})();
