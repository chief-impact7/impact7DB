import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { todayKST } from '@impact7/shared/datetime';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { findSpecialVisit as selectSpecialVisit } from '../../functions-shared/src/expectedArrivalLoader.js';

const TARGETS = new Set(['권태윤_1037777841', '이하진_1088105008']);

const dateArg = process.argv.find((arg) => arg.startsWith('--date='));
const dateKST = dateArg?.slice('--date='.length) || todayKST();

initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
const db = getFirestore();

async function findSpecialVisit(student) {
  const codes = [...new Set((student.enrollments || []).map(enrollmentCode).filter(Boolean))];
  const entries = await Promise.all(codes.map(async (code) => {
    const snap = await db.collection('class_settings').doc(code).get();
    return [code, snap.exists ? snap.data() : null];
  }));
  return selectSpecialVisit(student.enrollments, Object.fromEntries(entries.filter(([, value]) => value)), dateKST);
}

const studentsSnap = await db.collection('students').where('status', 'in', ['실휴원', '가휴원']).get();
const historySnap = await db.collection('history_logs')
  .where('google_login_id', '==', 'one-off-paused-special-attendance-fix')
  .get();
const affected = [];
const corrected = [];

for (const studentDoc of studentsSnap.docs) {
  if (!TARGETS.has(studentDoc.id)) continue;
  const specialVisit = await findSpecialVisit(studentDoc.data());
  if (!specialVisit) continue;
  const dailySnap = await db.collection('daily_records').doc(`${studentDoc.id}_${dateKST}`).get();
  if (!dailySnap.exists) continue;
  const student = studentDoc.data();
  const daily = dailySnap.data();
  if (!daily.attendance?.status && daily.visit2?.status && daily.visit2.status !== '미확인') {
    corrected.push({
      studentId: studentDoc.id,
      name: student.name || '',
      status: student.status,
      visit2: daily.visit2,
    });
    continue;
  }
  if (!daily.attendance?.status) continue;
  affected.push({
    studentId: studentDoc.id,
    name: student.name || '',
    status: student.status,
    primary: daily.attendance.status,
    primaryArrival: daily.arrival_time || '',
    visit2: daily.visit2 || null,
    specialVisit,
  });
}

console.log(JSON.stringify({
  dateKST,
  affectedCount: affected.length,
  affected,
  correctedCount: corrected.length,
  corrected,
  historyCount: historySnap.docs.filter((doc) => doc.data().after?.startsWith(dateKST)).length,
}, null, 2));
