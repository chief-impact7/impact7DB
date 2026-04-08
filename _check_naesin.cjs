const admin = require('firebase-admin');
const sa = require('./service-account.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

(async () => {
  const snap = await db.collection('students')
    .where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원'])
    .get();

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const naesinStudents = [];

  snap.forEach(d => {
    const data = d.data();
    const enrollments = data.enrollments || [];
    const naesinList = enrollments.filter(e => e.class_type === '내신');
    if (naesinList.length > 0) {
      for (const n of naesinList) {
        const active = n.start_date <= today && n.end_date >= today;
        naesinStudents.push({
          name: data.name,
          docId: d.id,
          status: data.status,
          start_date: n.start_date,
          end_date: n.end_date,
          day: (n.day || []).join(','),
          start_time: n.start_time || '-',
          semester: n.semester || '-',
          active: active ? '✓ 활성' : (n.start_date > today ? '예정' : '종료'),
        });
      }
    }
  });

  console.log(`오늘: ${today}`);
  console.log(`내신 enrollment이 있는 학생: ${naesinStudents.length}명\n`);

  if (naesinStudents.length === 0) {
    console.log('⚠ 내신 enrollment이 하나도 없습니다!');
    console.log('DB에서 내신시간표 저장이 정상적으로 완료되었는지 확인하세요.');
  } else {
    // 기간별 그룹핑
    const byPeriod = {};
    for (const s of naesinStudents) {
      const key = `${s.start_date} ~ ${s.end_date}`;
      if (!byPeriod[key]) byPeriod[key] = [];
      byPeriod[key].push(s);
    }

    for (const [period, students] of Object.entries(byPeriod)) {
      console.log(`━━━ 내신 기간: ${period} (${students[0].active}) ━━━`);
      console.log(`학생 수: ${students.length}명`);
      students.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      for (const s of students) {
        console.log(`  ${s.name} | ${s.day} | ${s.start_time} | 학기:${s.semester} | ${s.status}`);
      }
      console.log('');
    }
  }

  process.exit(0);
})();
