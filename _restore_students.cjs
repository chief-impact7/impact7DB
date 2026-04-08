// Usage: node _restore_students.cjs <restored-database-id>
// Example: node _restore_students.cjs restored-backup

const admin = require('firebase-admin');
const sa = require('./service-account.json');

const restoredDbId = process.argv[2] || 'restored-backup0306';

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}

// Original (default) database
const defaultDb = admin.firestore();
// Restored database
const restoredDb = admin.app().firestore(restoredDbId);

(async () => {
  console.log(`Restoring students from database: ${restoredDbId}`);

  // 1. Read all students from restored DB
  const snap = await restoredDb.collection('students').get();
  console.log(`Found ${snap.size} students in restored backup`);

  if (snap.size === 0) {
    console.log('No students found in restored DB. Check the database ID.');
    process.exit(1);
  }

  // 2. Write to default DB in batches of 500
  let batch = defaultDb.batch();
  let count = 0;
  let total = 0;

  for (const doc of snap.docs) {
    batch.set(defaultDb.collection('students').doc(doc.id), doc.data());
    count++;
    total++;

    if (count >= 450) {
      await batch.commit();
      console.log(`  Committed ${total} students...`);
      batch = defaultDb.batch();
      count = 0;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  console.log(`\nDone! Restored ${total} students to default database.`);
  process.exit(0);
})();
