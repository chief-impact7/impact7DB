const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const restoredDb = admin.app().firestore('restored-backup0303');
(async () => {
  const snap = await restoredDb.collection('students').get();
  console.log('students 수:', snap.size);
  if (snap.size > 0) {
    snap.forEach(d => { console.log(' ', d.id, '-', d.data().name, '|', d.data().branch || ''); });
  }
  process.exit(0);
})();
