const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const docId = '황시윤_1082646149';

  // students 삭제
  await db.collection('students').doc(docId).delete();
  console.log(`students/${docId} 삭제 완료`);

  // contacts도 삭제
  await db.collection('contacts').doc(docId).delete();
  console.log(`contacts/${docId} 삭제 완료`);

  process.exit(0);
})();
