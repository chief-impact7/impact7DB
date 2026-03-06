/**
 * backup-students.cjs
 * students 컬렉션을 로컬 JSON으로 백업
 *
 * Usage: node backup-students.cjs
 * Output: backups/students_YYYY-MM-DD.json
 */
const admin = require('firebase-admin');
const sa = require('./service-account.json');
const fs = require('fs');
const path = require('path');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  const date = new Date().toISOString().slice(0, 10);
  const collections = ['students', 'contacts', 'class_settings'];

  for (const colName of collections) {
    const snap = await db.collection(colName).get();
    const data = {};
    snap.forEach(d => { data[d.id] = d.data(); });

    const filePath = path.join(backupDir, `${colName}_${date}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`✅ ${colName}: ${snap.size}건 → ${filePath}`);
  }

  process.exit(0);
})();
