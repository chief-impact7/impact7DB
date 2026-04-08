const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();
(async () => {
  const snap = await db.collection('students').get();

  // Enrollment이 없는 재원생 중 active한 학생 목록
  const noEnroll = [];
  const hasEnroll = [];

  snap.forEach(d => {
    const data = d.data();
    const e = data.enrollments || [];
    const hasData = e.length > 0 && (e[0].level_symbol || e[0].class_number);

    if (hasData) {
      hasEnroll.push(data);
    } else {
      noEnroll.push({ docId: d.id, name: data.name, branch: data.branch || '', status: data.status || '' });
    }
  });

  // CSV header
  const header = 'name,parent_phone_1,branch,level_symbol,class_number,class_type,day,start_date,semester,status';

  // Export template with existing info pre-filled
  const lines = [header];
  // Only include students that need enrollment - skip obvious non-students
  for (const s of noEnroll) {
    const name = (s.name || '').replace(/,/g, '');
    const phone = s.docId.replace(name + '_', '');
    // Format phone back: 1022955746 → 010-2295-5746
    let fmt = phone;
    if (/^\d{10}$/.test(phone)) {
      fmt = `0${phone.slice(0,2)}-${phone.slice(2,6)}-${phone.slice(6)}`;
    }
    lines.push(`${name},${fmt},${s.branch},,,,,,2026-Spring,${s.status}`);
  }

  require('fs').writeFileSync('enrollment_template.csv', '\uFEFF' + lines.join('\n'), 'utf8');
  console.log(`템플릿 생성 완료: enrollment_template.csv`);
  console.log(`enrollment 필요한 학생: ${noEnroll.length}명`);
  console.log(`enrollment 있는 학생: ${hasEnroll.length}명`);
  process.exit(0);
})();
