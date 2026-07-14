import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { isAttendedStatus } from '@impact7/shared/history';
import { applyNaesinFreeDerivation, enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { getDayName, normalizedDays, resolveNaesinCsKey } from '@impact7/shared/expected-arrival';
import { formatDateKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';

export function previousKstDate(now = new Date()) {
  const [year, month, day] = formatDateKST(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function activeEnrollmentsAt(enrollments, dateKST) {
  return (enrollments ?? []).filter((enrollment) => {
    if (!enrollment) return false;
    if (/^\d{4}-/.test(enrollment.start_date ?? '') && enrollment.start_date > dateKST) return false;
    if (/^\d{4}-/.test(enrollment.end_date ?? '') && enrollment.end_date < dateKST) return false;
    return true;
  });
}

export function isRegularStudentOnDate(student, classSettings, dateKST) {
  const derived = applyNaesinFreeDerivation(activeEnrollmentsAt(student?.enrollments, dateKST), {
    classSettings,
    dateStr: dateKST,
    resolveNaesinCsKey,
    enrollmentCode,
  });
  const dayName = getDayName(dateKST);
  const scheduled = derived.filter((enrollment) => normalizedDays(enrollment.day).includes(dayName));
  if (!scheduled.length) return false;
  const primaryType = scheduled[0]?.class_type;
  if (primaryType === '내신' || primaryType === '자유학기') return false;
  return !scheduled.every((enrollment) => enrollment.class_type === '특강');
}

function reportQueuesForStudent(studentId, queues) {
  return queues.filter((queue) => {
    if (queue.student_id !== studentId) return false;
    if (queue.kind === 'parent_notice') return queue.template_key === 'report';
    return queue.kind === 'direct' && queue.source === 'parent_report';
  });
}

function notificationStatusOf(statuses) {
  if (statuses.length === 0) return 'not_queued';
  if (statuses.includes('failed_permanent')) return 'retry_failed';
  if (statuses.includes('failed_retryable')) return 'retrying';
  return 'pending';
}

export function buildAttendanceNotificationGaps({ daily, students, classSettings, queues, dateKST }) {
  const studentMap = new Map(students.map((student) => [student.id, student]));
  const eligible = daily.filter((record) => {
    const student = studentMap.get(record.student_id);
    return record.student_id
      && isAttendedStatus(record.attendance?.status)
      && isRegularStudentOnDate(student, classSettings, dateKST);
  });
  const items = [];
  for (const record of eligible) {
    const student = studentMap.get(record.student_id);
    const statuses = [...new Set(reportQueuesForStudent(record.student_id, queues).map((queue) => queue.status).filter(Boolean))];
    if (statuses.includes('sent')) continue;
    items.push({
      student_id: record.student_id,
      student_name: student?.name || record.student_name || '(이름 미확인)',
      attendance_status: record.attendance.status,
      notification_status: notificationStatusOf(statuses),
      queue_statuses: statuses,
    });
  }
  return {
    attendedCount: eligible.length,
    items: items.sort((a, b) => a.student_name.localeCompare(b.student_name, 'ko')),
  };
}

export async function runAttendanceNotificationGapSnapshot(deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const dateKST = previousKstDate(deps.now ?? new Date());
  const [dailySnap, queueSnap] = await Promise.all([
    db.collection('daily_records').where('date', '==', dateKST).get(),
    db.collection('message_queue').where('report_date_kst', '==', dateKST).get(),
  ]);
  const daily = dailySnap.docs.map((doc) => doc.data());
  const attendedIds = [...new Set(daily
    .filter((record) => isAttendedStatus(record.attendance?.status))
    .map((record) => record.student_id)
    .filter(Boolean))];
  const studentSnaps = attendedIds.length
    ? await db.getAll(...attendedIds.map((id) => db.collection('students').doc(id)))
    : [];
  const students = studentSnaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...snap.data() }));
  const classCodes = [...new Set(students.flatMap((student) => (student.enrollments ?? []).flatMap((enrollment) => [
    enrollmentCode(enrollment),
    enrollment.naesin_class_override,
  ])).filter(Boolean))];
  const classSnaps = classCodes.length
    ? await db.getAll(...classCodes.map((code) => db.collection('class_settings').doc(code)))
    : [];
  const classSettings = Object.fromEntries(classSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data()]));
  const { attendedCount, items } = buildAttendanceNotificationGaps({
    daily,
    students,
    classSettings,
    queues: queueSnap.docs.map((doc) => doc.data()),
    dateKST,
  });

  await db.collection('attendance_notification_gaps').doc(dateKST).set({
    date_kst: dateKST,
    generated_at: FieldValue.serverTimestamp(),
    attended_count: attendedCount,
    missing_count: items.length,
    items,
  });
  return { dateKST, attendedCount, missingCount: items.length };
}

export async function handleGetAttendanceNotificationGaps(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const db = deps.firestore ?? getFirestore();
  const dateKST = previousKstDate(deps.now ?? new Date());
  const snap = await db.collection('attendance_notification_gaps').doc(dateKST).get();
  if (!snap.exists) return { dateKST, generated: false, items: [] };
  const data = snap.data();
  return {
    dateKST,
    generated: true,
    generatedAt: data.generated_at?.toMillis?.() ?? null,
    attendedCount: data.attended_count ?? 0,
    missingCount: data.missing_count ?? 0,
    items: data.items ?? [],
  };
}
