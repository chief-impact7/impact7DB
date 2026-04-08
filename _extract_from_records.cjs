const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  // Collect all student IDs and branches from daily_records
  const dr = await db.collection('daily_records').get();
  const students = {};
  dr.forEach(d => {
    const data = d.data();
    const sid = data.student_id;
    if (!sid) return;
    if (!students[sid]) {
      const parts = sid.split('_');
      students[sid] = { name: parts[0], phone: parts[1] || '', branch: '' };
    }
    if (data.branch) students[sid].branch = data.branch;
  });

  // Also check test_fail_tasks and hw_fail_tasks for student names
  for (const col of ['test_fail_tasks', 'hw_fail_tasks']) {
    try {
      const snap = await db.collection(col).get();
      snap.forEach(d => {
        const data = d.data();
        if (data.student_id && data.student_name) {
          if (!students[data.student_id]) {
            students[data.student_id] = { name: data.student_name, phone: '', branch: '' };
          }
          if (data.branch) students[data.student_id].branch = data.branch;
        }
      });
    } catch (e) {}
  }

  const list = Object.entries(students).map(([id, s]) => ({
    docId: id, name: s.name, phone: s.phone, branch: s.branch
  }));
  list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  console.log(`추출된 학생 수: ${list.length}`);
  console.log('---');
  list.forEach(s => console.log(`${s.name}\t${s.phone}\t${s.branch}\t${s.docId}`));

  process.exit(0);
})();
