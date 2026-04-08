const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  // 1. DELETE 로그 전체 확인
  console.log('=== DELETE 로그 ===');
  const delSnap = await db.collection('history_logs')
    .where('change_type', '==', 'DELETE')
    .get();
  console.log('총 DELETE 로그:', delSnap.size);
  delSnap.forEach(d => {
    const data = d.data();
    const ts = data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate() : data.timestamp) : '?';
    console.log(`  ${ts} | ${data.doc_id || d.id} | by: ${data.google_login_id || '?'}`);
  });

  // 2. ENROLL 로그 확인 (학생 등록 기록)
  console.log('\n=== ENROLL 로그 (최근 20개) ===');
  try {
    const enrollSnap = await db.collection('history_logs')
      .where('change_type', '==', 'ENROLL')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    console.log('총 ENROLL 로그:', enrollSnap.size);
    enrollSnap.forEach(d => {
      const data = d.data();
      const ts = data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate() : data.timestamp) : '?';
      console.log(`  ${ts} | ${data.doc_id || d.id} | by: ${data.google_login_id || '?'}`);
    });
  } catch (e) {
    console.log('ENROLL 쿼리 에러:', e.message);
  }

  // 3. 전체 로그 타입별 카운트
  console.log('\n=== 전체 로그 타입별 ===');
  const allSnap = await db.collection('history_logs').get();
  const byType = {};
  allSnap.forEach(d => {
    const t = d.data().change_type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  });
  console.log(JSON.stringify(byType, null, 2));

  process.exit(0);
})();
