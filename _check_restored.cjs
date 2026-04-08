const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}

const restoredDb = admin.app().firestore('restored-backup0306');

(async () => {
  const collections = await restoredDb.listCollections();
  for (const col of collections) {
    const snap = await col.get();
    console.log(`${col.id}: ${snap.size} docs`);
    if (col.id === 'students') {
      snap.forEach(d => console.log(`  ${d.id}: ${d.data().name || '(no name)'}`));
    }
  }
  process.exit(0);
})();
