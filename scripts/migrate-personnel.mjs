import admin from 'firebase-admin';
import { employeeToStaff, shortTermToStaff } from './lib/personnelMapping.mjs';

const APPLY = process.argv.includes('--apply');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'impact7db' });
const db = admin.firestore();

async function run() {
  const [emps, sts, staffSnap] = await Promise.all([
    db.collection('employees').get(),
    db.collection('shortTermStaff').get(),
    db.collection('staff').get(),
  ]);
  const existingIds = new Set(staffSnap.docs.map(d => d.id));
  const plan = [
    ...emps.docs.map(d => ({ id: d.id, data: employeeToStaff(d.data()) })),
    ...sts.docs.map(d => ({ id: d.id, data: shortTermToStaff(d.data()) })),
  ];
  const conflicts = plan.filter(p => existingIds.has(p.id));
  console.log(`[migrate] employees=${emps.size} shortTerm=${sts.size} staff(기존)=${staffSnap.size}`);
  console.log(`[migrate] 이전 대상=${plan.length}, ID충돌=${conflicts.length}`);
  if (conflicts.length) {
    console.warn('[migrate] 기존 staff와 ID충돌(merge로 업데이트):', conflicts.map(c => c.id).slice(0, 3));
  }
  const needBackfill = staffSnap.docs.filter(d => !d.data().department);
  if (!APPLY) {
    console.log(`[dry-run] 쓰기 없음. 기존 staff department='교수' 백필 예정 ${needBackfill.length}건. --apply 로 실행.`);
    return;
  }
  const bulk = db.bulkWriter();
  for (const p of plan) {
    bulk.set(db.collection('staff').doc(p.id), p.data, { merge: true });
  }
  await bulk.close();
  // 단기 계약 서브컬렉션 복사: shortTermStaff/{id}/contracts -> staff/{id}/contracts
  for (const d of sts.docs) {
    const subs = await db.collection('shortTermStaff').doc(d.id).collection('contracts').get();
    if (subs.empty) continue;
    const w = db.bulkWriter();
    for (const c of subs.docs) {
      w.set(db.collection('staff').doc(d.id).collection('contracts').doc(c.id), c.data(), { merge: true });
    }
    await w.close();
  }
  console.log(`[apply] staff 이전 ${plan.length}건 완료(merge), 단기 계약 서브컬렉션 복사 포함`);
  // employees 계약 서브컬렉션 복사: employees/{id}/contracts → staff/{id}/contracts
  for (const d of emps.docs) {
    const subs = await db.collection('employees').doc(d.id).collection('contracts').get();
    if (subs.empty) continue;
    const w = db.bulkWriter();
    for (const c of subs.docs) {
      w.set(db.collection('staff').doc(d.id).collection('contracts').doc(c.id), c.data(), { merge: true });
    }
    await w.close();
  }
  console.log('[apply] employees 계약 서브컬렉션 복사 포함');
  // 기존 staff(교사) 중 department 미설정 → '교수' 백필 (staffSnap은 이전 복사 전 원본)
  const writer = db.bulkWriter();
  for (const d of needBackfill) {
    writer.set(d.ref, { department: '교수' }, { merge: true });
  }
  await writer.close();
  console.log(`[apply] 기존 staff department='교수' 백필 ${needBackfill.length}건`);
}
run().catch(e => { console.error(e); process.exit(1); });
