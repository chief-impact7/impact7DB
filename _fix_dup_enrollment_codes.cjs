// 정규+특강이 동일 level_symbol+class_number를 공유하는 케이스에서 특강 enrollment 삭제
// Usage:
//   node _fix_dup_enrollment_codes.cjs           # dry-run
//   node _fix_dup_enrollment_codes.cjs --apply   # 실제 적용

const admin = require('firebase-admin');
const sa = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'impact7db' });
}
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');
const codeOf = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
const validDate = (d) => d && /^\d{4}-/.test(d);

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
  const current = active.filter(e => !validDate(e.end_date) || e.end_date >= today);
  const hasActiveNaesin = current.some(e =>
    e.class_type === '내신' && validDate(e.start_date) && e.start_date <= today
  );
  return hasActiveNaesin ? current.filter(e => e.class_type !== '정규') : current;
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY (실제 쓰기)' : 'DRY-RUN (변경 없음)'}\n`);

  const snap = await db.collection('students').get();
  const targets = [];

  snap.forEach(doc => {
    const s = doc.data();
    if (!['재원', '실휴원', '가휴원', '등원예정'].includes(s.status)) return;

    const active = getActiveEnrollments(s);
    if (active.length < 2) return;

    // 정규 enrollment의 코드 집합
    const regularCodes = new Set(
      active.filter(e => (e.class_type || '정규') === '정규')
            .map(codeOf)
            .filter(Boolean)
    );

    // 정규 코드와 동일 코드를 가진 특강 enrollment 추출
    const dupTeukang = active.filter(e =>
      e.class_type === '특강' && regularCodes.has(codeOf(e))
    );

    if (dupTeukang.length === 0) return;

    // 전체 enrollments 배열에서 해당 특강 객체들 제거
    const allEnr = s.enrollments || [];
    const removeSet = new Set(dupTeukang);
    const newEnr = allEnr.filter(e => !removeSet.has(e));

    targets.push({
      id: doc.id,
      name: s.name,
      status: s.status,
      removed: dupTeukang.map(e => ({
        code: codeOf(e),
        day: (e.day || []).join(''),
        start_date: e.start_date || '',
        end_date: e.end_date || ''
      })),
      newEnr,
    });
  });

  if (targets.length === 0) { console.log('대상 없음.'); process.exit(0); }

  console.log(`대상 학생: ${targets.length}명\n`);
  for (const t of targets) {
    console.log(`[${t.status}] ${t.name} (${t.id})`);
    for (const r of t.removed) {
      const range = (r.start_date || r.end_date) ? ` ${r.start_date}~${r.end_date}` : '';
      console.log(`  - 삭제: 특강 ${r.code} (${r.day || '요일없음'})${range}`);
    }
  }
  console.log('');

  if (!APPLY) {
    console.log('※ DRY-RUN 종료. 실제 적용하려면 --apply 옵션 추가.');
    process.exit(0);
  }

  // 실제 batch write
  const BATCH_SIZE = 200;
  let written = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const t of chunk) {
      batch.update(db.collection('students').doc(t.id), {
        enrollments: t.newEnr,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      const removedDesc = t.removed.map(r =>
        `특강 ${r.code}${r.day ? '(' + r.day + ')' : ''}${r.start_date ? ' ' + r.start_date + '~' + r.end_date : ''}`
      ).join(', ');
      const histRef = db.collection('history_logs').doc();
      batch.set(histRef, {
        doc_id: t.id,
        change_type: 'UPDATE',
        before: '—',
        after: `중복 코드 정리: ${removedDesc} 삭제`,
        google_login_id: 'cleanup_script_2026-04-08',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  ✓ batch: ${written}/${targets.length}`);
  }
  console.log(`\n완료: ${written}명 정리`);
  process.exit(0);
})();
