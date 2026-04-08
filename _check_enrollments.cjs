const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  const snap = await db.collection('students').get();
  let fridayStudents = 0;
  let withEnroll = 0;
  const statuses = {};
  const fridayList = [];

  snap.forEach(d => {
    const data = d.data();
    const s = data.status || '';
    statuses[s] = (statuses[s] || 0) + 1;

    const enrollments = data.enrollments || [];
    if (enrollments.length > 0 && (enrollments[0].level_symbol || enrollments[0].class_number)) withEnroll++;

    for (const e of enrollments) {
      if ((e.day || []).includes('금')) {
        fridayStudents++;
        if (s === '재원' || s === '등원예정') {
          fridayList.push(`${data.name} (${d.id}) ${e.level_symbol}${e.class_number} ${s}`);
        }
        break;
      }
    }
  });

  console.log('전체 학생:', snap.size);
  console.log('enrollment 있는 학생:', withEnroll);
  console.log('금요일 수업 학생 (전체):', fridayStudents);
  console.log('금요일 + 재원/등원예정:', fridayList.length);
  console.log('\n상태별:', JSON.stringify(statuses, null, 2));
  console.log('\n금요일 재원/등원예정 학생:');
  fridayList.forEach(s => console.log(' ', s));
  process.exit(0);
})();
