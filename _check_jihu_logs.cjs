const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // Check history_logs for both students
  const ids = [
    '김지후_0107658688501090944944',
    '김지후_1089234636',
  ];

  for (const id of ids) {
    console.log(`\n=== History for ${id} ===`);
    const logs = await db.collection('history_logs')
      .where('student_id', '==', id)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (logs.empty) {
      console.log('  No history logs found');
    } else {
      logs.forEach(doc => {
        const d = doc.data();
        const ts = d.timestamp?.toDate?.() || d.timestamp;
        console.log(`  [${ts}] action: ${d.action}, changed_by: ${d.changed_by || 'unknown'}`);
        if (d.changes) console.log(`    changes:`, JSON.stringify(d.changes));
        if (d.details) console.log(`    details:`, d.details);
      });
    }
  }

  process.exit(0);
})();
