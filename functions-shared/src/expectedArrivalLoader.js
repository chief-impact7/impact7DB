import { getFirestore } from 'firebase-admin/firestore';
import {
  computeExpectedArrival, getDayName, normalizedDays, startTime,
} from '@impact7/shared/expected-arrival';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { normalizeClassCode } from '@impact7/shared/class-code';

const validDate = (value) => /^\d{4}-/.test(value || '');
const timeMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : Infinity;
};

export function findSpecialVisit(enrollments, classSettings, dateKST) {
  const dayName = getDayName(dateKST);
  return (enrollments || [])
    .filter((e) => e?.class_type === '특강'
      && (!validDate(e.start_date) || e.start_date <= dateKST)
      && (!validDate(e.end_date) || e.end_date >= dateKST)
      && normalizedDays(e.day).includes(dayName))
    .map((e) => ({
      code: enrollmentCode(e),
      scheduled_time: startTime(e, dayName, classSettings),
    }))
    .sort((a, b) => timeMinutes(a.scheduled_time) - timeMinutes(b.scheduled_time))[0] || null;
}

// 학생 1명의 당일 등원 예정 시각을 계산한다(트랜잭션 밖에서 호출 — where 쿼리 사용).
// 실패(데이터 누락 등)는 지각 판정을 막지 않도록 호출자가 빈 문자열로 처리한다.
export async function loadExpectedArrivalContext(firestore, studentId, dateKST) {
  const fs = firestore || getFirestore();
  const studentSnap = await fs.collection('students').doc(studentId).get();
  const enrollments = studentSnap.exists ? (studentSnap.data().enrollments || []) : [];

  // 반코드 + 내신 override csKey만 class_settings 조회(전량 로드 회피).
  // 표기 차이(ks132 ≡ KS132) 대비 정규화 코드도 병행 fetch — canonical 문서가 맵에 실려야
  // shared 파생(classSettingsGet)이 흡수할 수 있다.
  const codes = [...new Set(enrollments
    .flatMap((e) => [enrollmentCode(e), e.naesin_class_override])
    .filter(Boolean)
    .flatMap((code) => [code, normalizeClassCode(code)])
    .filter(Boolean))];
  const csEntries = await Promise.all(codes.map(async (code) => {
    const s = await fs.collection('class_settings').doc(code).get();
    return [code, s.exists ? s.data() : null];
  }));
  const classSettings = Object.fromEntries(csEntries.filter(([, v]) => v));

  const [dailySnap, hwSnap, testSnap, absSnap] = await Promise.all([
    fs.collection('daily_records').doc(`${studentId}_${dateKST}`).get(),
    fs.collection('hw_fail_tasks').where('student_id', '==', studentId).where('scheduled_date', '==', dateKST).get(),
    fs.collection('test_fail_tasks').where('student_id', '==', studentId).where('scheduled_date', '==', dateKST).get(),
    fs.collection('absence_records').where('student_id', '==', studentId).where('makeup_date', '==', dateKST).get(),
  ]);
  const rec = dailySnap.exists ? dailySnap.data() : {};
  const hwTasks = hwSnap.docs.map((d) => d.data());
  const testTasks = testSnap.docs.map((d) => d.data());
  const absences = absSnap.docs.map((d) => d.data());

  const expectedArrival = computeExpectedArrival({
    enrollments, classSettings, rec, hwTasks, testTasks, absences, date: dateKST,
  });
  const specialVisit = findSpecialVisit(enrollments, classSettings, dateKST);

  return { expectedArrival, specialVisit };
}

export async function loadExpectedArrival(firestore, studentId, dateKST) {
  return (await loadExpectedArrivalContext(firestore, studentId, dateKST)).expectedArrival;
}
