const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // students에서 황시윤 검색
  const snap = await db.collection('students').where('name', '>=', '황시윤').where('name', '<=', '황시윤\uf8ff').get();
  console.log(`=== students: ${snap.size}건 ===`);
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`\n--- ${doc.id} ---`);
    console.log(JSON.stringify(d, null, 2));
  });

  // contacts에서도 확인
  const cSnap = await db.collection('contacts').where('name', '>=', '황시윤').where('name', '<=', '황시윤\uf8ff').get();
  console.log(`\n=== contacts: ${cSnap.size}건 ===`);
  cSnap.forEach(doc => {
    const d = doc.data();
    console.log(`\n--- ${doc.id} ---`);
    console.log(JSON.stringify(d, null, 2));
  });

  // history_logs 확인
  for (const doc of snap.docs) {
    const logs = await db.collection('history_logs').where('doc_id', '==', doc.id).limit(10).get();
    if (!logs.empty) {
      console.log(`\n=== history for ${doc.id}: ${logs.size}건 ===`);
      logs.forEach(l => {
        const d = l.data();
        const ts = d.timestamp?.toDate?.() || '?';
        console.log(`  [${ts}] ${d.change_type} by ${d.google_login_id}`);
        console.log(`    before: ${d.before}`);
        console.log(`    after: ${d.after}`);
      });
    }
  }

  process.exit(0);
})();
