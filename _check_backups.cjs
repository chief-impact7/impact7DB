const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}

(async () => {
  // Try listing Firestore export operations via REST API
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ credentials: sa, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();

  // List Firestore backups/exports
  const url = 'https://firestore.googleapis.com/v1/projects/impact7db/databases/(default)/backupSchedules';
  try {
    const res = await client.request({ url });
    console.log('Backup schedules:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.log('Backup schedules API error:', err.message);
  }

  // List export operations
  const opsUrl = 'https://firestore.googleapis.com/v1/projects/impact7db/databases/(default)/operations';
  try {
    const res = await client.request({ url: opsUrl });
    const ops = res.data.operations || [];
    console.log('\nExport operations:', ops.length);
    ops.slice(0, 5).forEach(op => {
      const meta = op.metadata || {};
      console.log(`  ${op.name} | ${meta.operationState} | ${meta.startTime} | ${meta.outputUriPrefix || ''}`);
    });
  } catch (err) {
    console.log('Operations API error:', err.message);
  }

  // Also check GCS for backup files
  const storage = admin.storage();
  const buckets = ['impact7db.appspot.com', 'impact7db-backups', 'impact7db-firestore-backup'];
  for (const b of buckets) {
    try {
      const [files] = await storage.bucket(b).getFiles({ maxResults: 5 });
      console.log(`\nBucket ${b}: ${files.length} files`);
      files.forEach(f => console.log(`  ${f.name}`));
    } catch (e) {
      console.log(`\nBucket ${b}: ${e.message.substring(0, 80)}`);
    }
  }

  process.exit(0);
})();
