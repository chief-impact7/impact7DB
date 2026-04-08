const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const snap = await db.collection('students').get();

  const naesinStudents = [];
  const emptyEnrollActive = [];  // 재원인데 enrollments 비어있는 학생
  const semesterOnlyEnroll = []; // semester만 있는 enrollment
  const classTypes = {};

  snap.forEach(doc => {
    const d = doc.data();
    const enrollments = d.enrollments || [];

    // 재원/등원예정/휴원인데 enrollment 없는 학생
    if (['재원', '등원예정', '실휴원', '가휴원'].includes(d.status) && enrollments.length === 0) {
      emptyEnrollActive.push({ id: doc.id, name: d.name, status: d.status, school: d.school, grade: d.grade });
    }

    enrollments.forEach(e => {
      const ct = e.class_type || '(없음)';
      classTypes[ct] = (classTypes[ct] || 0) + 1;

      if (ct === '내신') {
        naesinStudents.push({ id: doc.id, name: d.name, status: d.status, enrollment: e });
      }

      // semester만 있고 다른 필드 없는 enrollment
      const keys = Object.keys(e);
      if (keys.length === 1 && keys[0] === 'semester') {
        semesterOnlyEnroll.push({ id: doc.id, name: d.name, status: d.status, semester: e.semester });
      }
    });
  });

  console.log('=== class_type 분포 ===');
  for (const [type, count] of Object.entries(classTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}명`);
  }

  console.log(`\n=== "내신" class_type 학생: ${naesinStudents.length}명 ===`);
  naesinStudents.forEach(s => console.log(`  ${s.id} (${s.name}, ${s.status})`));

  console.log(`\n=== 재원/등원예정/휴원인데 enrollment 없는 학생: ${emptyEnrollActive.length}명 ===`);
  emptyEnrollActive.forEach(s => console.log(`  ${s.id} (${s.name}, ${s.status}, ${s.school || ''}${s.grade || ''})`));

  console.log(`\n=== semester만 있는 enrollment: ${semesterOnlyEnroll.length}명 ===`);
  semesterOnlyEnroll.forEach(s => console.log(`  ${s.id} (${s.name}, ${s.status}, ${s.semester})`));

  process.exit(0);
})();
