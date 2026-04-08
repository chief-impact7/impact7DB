const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  // 1. history_logs - ENROLL/UPDATE records may have enrollment info
  console.log('=== history_logs ===');
  const logs = await db.collection('history_logs').get();
  console.log('총:', logs.size);
  logs.forEach(d => {
    const data = d.data();
    console.log(`  ${data.change_type} | ${data.doc_id} | before: ${data.before} | after: ${data.after}`);
  });

  // 2. daily_records - has class info?
  console.log('\n=== daily_records sample (today) ===');
  const dr = await db.collection('daily_records').where('date', '==', '2026-03-06').limit(5).get();
  dr.forEach(d => {
    const data = d.data();
    console.log(`  ${d.id} | student: ${data.student_id} | class: ${data.class_name || data.class_number || '?'} | branch: ${data.branch || '?'}`);
    // Show all fields
    console.log('    fields:', Object.keys(data).join(', '));
  });

  // 3. class_settings
  console.log('\n=== class_settings ===');
  const cs = await db.collection('class_settings').get();
  console.log('총:', cs.size);
  cs.forEach(d => {
    console.log(`  ${d.id}:`, JSON.stringify(d.data()).substring(0, 150));
  });

  process.exit(0);
})();
