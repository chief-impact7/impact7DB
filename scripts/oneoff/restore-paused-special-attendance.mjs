import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { todayKST } from '@impact7/shared/datetime';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { findSpecialVisit as selectSpecialVisit } from '../../functions-shared/src/expectedArrivalLoader.js';

const EXPECTED = {
  권태윤_1037777841: { status: '출석', arrivalTime: '13:44' },
  이하진_1088105008: { status: '출석', arrivalTime: '12:33' },
};

const execute = process.argv.includes('--execute');
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
const candidates = [];

for (const studentDoc of studentsSnap.docs) {
  const expected = EXPECTED[studentDoc.id];
  if (!expected) continue;
  const student = studentDoc.data();
  const specialVisit = await findSpecialVisit(student);
  if (!specialVisit) continue;
  const dailyRef = db.collection('daily_records').doc(`${studentDoc.id}_${dateKST}`);
  const dailySnap = await dailyRef.get();
  if (!dailySnap.exists) continue;
  const daily = dailySnap.data();
  if (daily.attendance?.status !== expected.status || daily.arrival_time !== expected.arrivalTime) continue;
  if (daily.visit2?.status && daily.visit2.status !== '미확인') continue;
  const visit2 = {
    ...(daily.visit2 || {}),
    ...specialVisit,
    status: daily.visit2?.status && daily.visit2.status !== '미확인'
      ? daily.visit2.status
      : daily.attendance.status,
    arrival_time: daily.visit2?.arrival_time || daily.arrival_time || '',
  };
  if (!visit2.arrival_time) delete visit2.arrival_time;
  if (!visit2.reason && daily.attendance.reason) visit2.reason = daily.attendance.reason;
  candidates.push({ studentDoc, student, dailyRef, dailySnap, daily, visit2 });
}

console.log(`대상일: ${dateKST}`);
console.log(`수정 대상: ${candidates.length}명`);
for (const { studentDoc, student, daily, visit2 } of candidates) {
  console.log(`${student.name || studentDoc.id} (${student.status}) | 정규 ${daily.attendance.status} ${daily.arrival_time || '-'} -> 특강 ${visit2.code} ${visit2.status} ${visit2.arrival_time || '-'}`);
}

if (!execute) {
  console.log('[DRY-RUN] 실제 변경 없음. 검토 후 --execute로 실행.');
  process.exit(0);
}
if (candidates.length === 0) {
  console.log('변경할 문서가 없습니다.');
  process.exit(0);
}
if (candidates.length > 200) throw new Error(`안전 상한 초과: ${candidates.length}명`);

const batch = db.batch();
for (const { studentDoc, student, dailyRef, dailySnap, daily, visit2 } of candidates) {
  batch.update(dailyRef, {
    attendance: FieldValue.delete(),
    arrival_time: FieldValue.delete(),
    visit2,
    updated_by: 'one-off-paused-special-attendance-fix',
    updated_at: FieldValue.serverTimestamp(),
  }, { lastUpdateTime: dailySnap.updateTime });
  batch.set(db.collection('history_logs').doc(), {
    doc_id: studentDoc.id,
    target_doc_id: dailyRef.id,
    change_type: 'RESTORE',
    before: `${dateKST} 정규 출결 ${daily.attendance.status} ${daily.arrival_time || '시각없음'}`,
    after: `${dateKST} 휴원 중 특강 ${visit2.code} 출결로 이동: ${visit2.status} ${visit2.arrival_time || '시각없음'} [paused-special-attendance-fix]`,
    google_login_id: 'one-off-paused-special-attendance-fix',
    timestamp: FieldValue.serverTimestamp(),
  });
}

await batch.commit();
console.log(`복구 완료: ${candidates.length}명`);
