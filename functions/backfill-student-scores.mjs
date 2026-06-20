// F-11 백필(일회성): 기존 results/external_score_events → student_scores 재구성.
// helper는 Cloud Function과 동일한 src/syncStudentScores.js 사용(로직 drift 방지).
// --dry: write 없이 academy 역조회 매핑률만 측정.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveStudentId, syncResultScore, syncExternalScore } from './src/syncStudentScores.js';

initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
const db = getFirestore();
const DRY = process.argv.includes('--dry');
console.log(`${DRY ? '[DRY-RUN]' : '[EXECUTE]'} backfill student_scores\n`);

let academyTotal = 0, academyMapped = 0;
const academyUnmapped = [];
const exams = await db.collection('exams').get();
for (const ex of exams.docs) {
  const students = await db.collection('results').doc(ex.id).collection('students').get();
  for (const r of students.docs) {
    academyTotal++;
    const data = r.data();
    if (DRY) {
      const sid = await resolveStudentId(db, data);
      if (sid) academyMapped++;
      else academyUnmapped.push({ examId: ex.id, reg: data.registrationNo, name: data.studentName });
    } else {
      const res = await syncResultScore(db, ex.id, data, null);
      if (res.action === 'set') academyMapped++;
      else academyUnmapped.push({ examId: ex.id, reg: data.registrationNo, name: data.studentName });
    }
  }
}

let extTotal = 0;
const events = await db.collection('external_score_events').get();
for (const ev of events.docs) {
  const students = await db.collection('external_score_events').doc(ev.id).collection('students').get();
  for (const s of students.docs) {
    extTotal++;
    if (!DRY) await syncExternalScore(db, ev.id, s.id, s.data());
  }
}

console.log({ academyTotal, academyMapped, academyUnmapped: academyUnmapped.length, extTotal });
if (academyUnmapped.length) console.log('미매핑 academy(샘플):', academyUnmapped.slice(0, 10));
process.exit(0);
