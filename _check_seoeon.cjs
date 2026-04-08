const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // Find 김서은
  const snap = await db.collection('students').where('name', '==', '김서은').get();
  console.log(`=== 김서은 학생 목록: ${snap.size}명 ===`);
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`\n--- ${doc.id} ---`);
    console.log(JSON.stringify(d, null, 2));
  });

  // Check leave_requests for 김서은
  const lrSnap = await db.collection('leave_requests').where('student_name', '==', '김서은').get();
  console.log(`\n=== 김서은 leave_requests: ${lrSnap.size}건 ===`);
  lrSnap.forEach(doc => {
    const d = doc.data();
    console.log(`\n--- ${doc.id} ---`);
    console.log(JSON.stringify(d, null, 2));
  });

  process.exit(0);
})();
