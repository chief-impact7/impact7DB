import admin from 'firebase-admin';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-impact7' });
const db = admin.firestore();

async function verify() {
  const staff = await db.collection('staff').get();
  const byDept = {};
  let emptyPhoneKey = 0;
  for (const d of staff.docs) {
    const s = d.data();
    const dept = s.department || '(없음)';
    byDept[dept] = (byDept[dept] || 0) + 1;
    if (!s.phoneKey) emptyPhoneKey++;
  }
  console.log('[verify] staff 부서별:', byDept);
  console.log('[verify] 빈 phoneKey 건수:', emptyPhoneKey, '(키오스크 미매칭 — 편집 필요)');

  // 단기 계약 서브컬렉션 복사 확인
  const sts = await db.collection('shortTermStaff').get();
  let copied = 0, src = 0;
  for (const d of sts.docs) {
    const a = await db.collection('shortTermStaff').doc(d.id).collection('contracts').get();
    const b = await db.collection('staff').doc(d.id).collection('contracts').get();
    src += a.size; copied += b.size;
  }
  console.log(`[verify] 단기 계약 원본 ${src} → staff 복사 ${copied}`);
  if (copied < src) {
    console.error('계약 복사 누락!');
    process.exit(2);
  }

  // employees 계약 서브컬렉션 복사 확인
  const empsAll = await db.collection('employees').get();
  let eSrc = 0, eCopied = 0;
  for (const d of empsAll.docs) {
    const a = await db.collection('employees').doc(d.id).collection('contracts').get();
    const b = await db.collection('staff').doc(d.id).collection('contracts').get();
    eSrc += a.size; eCopied += b.size;
  }
  console.log(`[verify] employees 계약 원본 ${eSrc} → staff 복사 ${eCopied}`);
  if (eCopied < eSrc) {
    console.error('employees 계약 복사 누락!');
    process.exit(2);
  }

  // 인사메모(performanceNotes) 서브컬렉션 복사 확인 (shortTermStaff·employees → staff)
  let pnSrc = 0, pnCopied = 0;
  for (const [parent, snap] of [['shortTermStaff', sts], ['employees', empsAll]]) {
    for (const d of snap.docs) {
      const a = await db.collection(parent).doc(d.id).collection('performanceNotes').get();
      const b = await db.collection('staff').doc(d.id).collection('performanceNotes').get();
      pnSrc += a.size; pnCopied += b.size;
    }
  }
  console.log(`[verify] 인사메모 원본 ${pnSrc} → staff 복사 ${pnCopied}`);
  if (pnCopied < pnSrc) {
    console.error('인사메모(performanceNotes) 복사 누락!');
    process.exit(2);
  }
}

verify().catch(e => { console.error(e); process.exit(1); });
