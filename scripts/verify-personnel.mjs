import admin from 'firebase-admin';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-impact7' });
const db = admin.firestore();

async function verify() {
  const staff = await db.collection('staff').get();
  const byDept = {};
  let emptyPhoneKey = 0;
  for (const d of staff.docs) {
    const s = d.data();
    byDept[s.department || '(없음)'] = (byDept[s.department || '(없음)'] || 0) + 1;
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
  if (copied < src) { console.error('계약 복사 누락!'); process.exit(2); }
}

verify().catch(e => { console.error(e); process.exit(1); });
