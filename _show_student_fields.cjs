const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  const snap = await db.collection('students').limit(3).get();
  snap.forEach(d => {
    console.log('=== ' + d.id + ' ===');
    console.log(JSON.stringify(d.data(), null, 2));
  });
  process.exit(0);
})();
