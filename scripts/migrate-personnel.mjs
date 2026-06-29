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
  const plan = [];
  for (const d of emps.docs) plan.push({ id: d.id, src: 'employees', data: employeeToStaff(d.data()) });
  for (const d of sts.docs) plan.push({ id: d.id, src: 'shortTermStaff', data: shortTermToStaff(d.data()) });
  const conflicts = plan.filter(p => existingIds.has(p.id));
  console.log(`[migrate] employees=${emps.size} shortTerm=${sts.size} staff(기존)=${staffSnap.size}`);
  console.log(`[migrate] 이전 대상=${plan.length}, ID충돌=${conflicts.length}`);
  if (conflicts.length) { console.error('ID 충돌:', conflicts.map(c => c.id)); process.exit(2); }
  if (!APPLY) { console.log('[dry-run] 쓰기 없음. --apply 로 실행.'); return; }
  throw new Error('apply path not implemented (Task 4)');
}
run().catch(e => { console.error(e); process.exit(1); });
