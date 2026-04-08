const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // 1. Check daily_stats for recent snapshots
  const statsSnap = await db.collection('daily_stats').orderBy('date', 'desc').limit(3).get();
  console.log('=== daily_stats (recent) ===');
  statsSnap.forEach(d => {
    const data = d.data();
    console.log(d.id, '| date:', data.date, '| total:', data.total, '| active:', data.active_total);
  });

  // 2. Check history_logs for DELETE events on students
  console.log('\n=== Recent history_logs (DELETE) ===');
  try {
    const logSnap = await db.collection('history_logs')
      .where('change_type', '==', 'DELETE')
      .orderBy('timestamp', 'desc')
      .limit(5).get();
    logSnap.forEach(d => {
      const data = d.data();
      console.log(d.id, '|', data.doc_id, '|', data.change_type, '|', data.timestamp, '|', data.google_login_id);
    });
    if (logSnap.empty) console.log('  (none)');
  } catch (e) {
    console.log('  Error:', e.message);
  }

  // 3. Check if there are any students subcollections (memos) - would indicate docs existed
  console.log('\n=== Checking for orphaned student subcollections ===');
  // Try a known student ID from daily_records
  const drSnap = await db.collection('daily_records').limit(3).get();
  drSnap.forEach(d => {
    console.log('daily_record:', d.id, '| student_id:', d.data().student_id, '| date:', d.data().date);
  });

  // 4. Count daily_records to see how many students were active
  const allDr = await db.collection('daily_records').where('date', '==', '2026-03-06').get();
  const uniqueStudents = new Set();
  allDr.forEach(d => uniqueStudents.add(d.data().student_id));
  console.log('\n오늘 daily_records에 있는 고유 학생 수:', uniqueStudents.size);

  process.exit(0);
})();
