const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // 1. history_logs - UPDATE/ENROLL records contain student data in "after" field
  console.log('=== history_logs ===');
  const logs = await db.collection('history_logs').get();
  console.log('Total logs:', logs.size);
  const byType = {};
  logs.forEach(d => {
    const t = d.data().change_type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  });
  console.log('By type:', JSON.stringify(byType));
  // Show a sample
  let sample = 0;
  logs.forEach(d => {
    if (sample < 2) {
      console.log('Sample:', JSON.stringify(d.data()).substring(0, 200));
      sample++;
    }
  });

  // 2. contacts collection
  console.log('\n=== contacts ===');
  const contacts = await db.collection('contacts').get();
  console.log('Total contacts:', contacts.size);

  // 3. daily_records - unique student IDs
  console.log('\n=== daily_records ===');
  const dr = await db.collection('daily_records').get();
  const studentIds = new Set();
  const studentBranches = {};
  dr.forEach(d => {
    const sid = d.data().student_id;
    if (sid) {
      studentIds.add(sid);
      if (d.data().branch) studentBranches[sid] = d.data().branch;
    }
  });
  console.log('Total daily_records:', dr.size);
  console.log('Unique student IDs:', studentIds.size);

  // 4. Check if export sheets exist via history
  console.log('\n=== Looking for student names in daily_records ===');
  // student_id format is name_phone, so we can extract names
  let count = 0;
  for (const sid of studentIds) {
    if (count < 5) {
      const parts = sid.split('_');
      console.log(`  ${sid} → name: ${parts[0]}, phone: ${parts[1]}, branch: ${studentBranches[sid] || '?'}`);
      count++;
    }
  }

  process.exit(0);
})();
