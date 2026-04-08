const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const collections = await db.listCollections();
  for (const col of collections) {
    const snap = await col.count().get();
    console.log(`${col.id}: ${snap.data().count}건`);
  }
  process.exit(0);
})();
