const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const codeOf = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
const validDate = (d) => d && /^\d{4}-/.test(d);

// app.js의 getActiveEnrollments 와 동일한 로직 (활성 enrollment만 추출)
function getActiveEnrollments(s) {
  const enrollments = s.enrollments || [];
  if (enrollments.length === 0) return [];
  const byType = {};
  for (const e of enrollments) {
    const key = (e.class_type || '정규') + ':' + (e.class_number || '');
    if (!byType[key]) byType[key] = [];
    byType[key].push(e);
  }
  const active = [];
  for (const list of Object.values(byType)) {
    const started = list
      .filter(e => !validDate(e.start_date) || e.start_date <= today)
      .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
    if (started.length > 0) active.push(started[0]);
    else {
      const sorted = [...list].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
      active.push(sorted[0]);
    }
  }
  // end_date 지난 것 제외
  const current = active.filter(e => !validDate(e.end_date) || e.end_date >= today);
  // 내신 활성이면 정규 숨김
  const hasActiveNaesin = current.some(e =>
    e.class_type === '내신' && validDate(e.start_date) && e.start_date <= today
  );
  return hasActiveNaesin ? current.filter(e => e.class_type !== '정규') : current;
}

(async () => {
  const snap = await db.collection('students').get();
  const dups = [];
  let total = 0, withDup = 0;
  snap.forEach(doc => {
    const s = doc.data();
    if (!['재원', '실휴원', '가휴원', '등원예정'].includes(s.status)) return;
    total++;
    const active = getActiveEnrollments(s);
    if (active.length < 2) return;
    // 같은 코드를 가진 active enrollment 그룹화
    const byCode = {};
    for (const e of active) {
      const code = codeOf(e);
      if (!code) continue;
      (byCode[code] ||= []).push(e);
    }
    const dupCodes = Object.entries(byCode).filter(([, list]) => list.length > 1);
    if (dupCodes.length > 0) {
      withDup++;
      dups.push({
        name: s.name,
        id: doc.id,
        status: s.status,
        dupCodes: dupCodes.map(([code, list]) => ({
          code,
          types: list.map(e => `${e.class_type || '정규'}(${(e.day || []).join('')})`).join(' + ')
        }))
      });
    }
  });

  console.log(`총 활성 학생: ${total}명`);
  console.log(`중복 코드 보유: ${withDup}명`);
  console.log('');
  for (const d of dups) {
    console.log(`[${d.status}] ${d.name} (${d.id})`);
    for (const dc of d.dupCodes) {
      console.log(`  - ${dc.code}: ${dc.types}`);
    }
  }
  process.exit(0);
})();
