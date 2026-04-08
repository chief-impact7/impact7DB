const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const ids = [
    '김지후_0107658688501090944944',
    '김지후_1089234636',
  ];

  for (const id of ids) {
    console.log(`\n=== History for ${id} ===`);
    const logs = await db.collection('history_logs')
      .where('student_id', '==', id)
      .limit(20)
      .get();

    if (logs.empty) {
      console.log('  No history logs found');
    } else {
      const sorted = logs.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .sort((a, b) => {
          const ta = a.timestamp?.toDate?.() || new Date(0);
          const tb = b.timestamp?.toDate?.() || new Date(0);
          return tb - ta;
        });
      sorted.forEach(d => {
        const ts = d.timestamp?.toDate?.() || d.timestamp;
        console.log(`  [${ts}] action: ${d.action}, by: ${d.changed_by || '?'}`);
        if (d.changes) console.log(`    changes:`, JSON.stringify(d.changes));
      });
    }
  }

  process.exit(0);
})();
