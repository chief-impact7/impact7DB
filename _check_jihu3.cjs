const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const doc = await db.collection('students').doc('김지후_0107658688501090944944').get();
  if (!doc.exists) {
    console.log('DOCUMENT DOES NOT EXIST');
    process.exit(1);
  }
  const data = doc.data();

  // Check exact status value
  console.log('Raw status:', JSON.stringify(data.status));
  console.log('Status length:', data.status?.length);
  console.log('Status char codes:', [...(data.status || '')].map(c => c.charCodeAt(0)));

  // Check all fields
  console.log('\nAll fields:');
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }

  process.exit(0);
})();
