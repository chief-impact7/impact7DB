import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isAttendedStatus } from '@impact7/shared/history';
import { applyNaesinFreeDerivation, enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { getDayName, normalizedDays, resolveNaesinCsKey } from '@impact7/shared/expected-arrival';
import { formatDateKST } from '@impact7/shared/datetime';
import { classSettingsGet } from '@impact7/shared/class-code';
import { staffLabel } from '@impact7/shared/staff-label';
import { teacherDisplayName } from '@impact7/shared/teacher-label';
import { assertAuthorizedStaff } from './authGuards.js';

export function previousKstDate(now = new Date()) {
  const [year, month, day] = formatDateKST(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function requestedPastDate(value, latestDateKST) {
  if (value == null || value === '') return latestDateKST;
  const dateKST = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKST) || getDayName(dateKST) === '' || dateKST > latestDateKST) {
    throw new HttpsError('invalid-argument', '조회 날짜는 전날 이전의 YYYY-MM-DD 형식이어야 합니다.');
  }
  return dateKST;
}

function activeEnrollmentsAt(enrollments, dateKST) {
  return (enrollments ?? []).filter((enrollment) => {
    if (!enrollment) return false;
    if (/^\d{4}-/.test(enrollment.start_date ?? '') && enrollment.start_date > dateKST) return false;
    if (/^\d{4}-/.test(enrollment.end_date ?? '') && enrollment.end_date < dateKST) return false;
    return true;
  });
}

export function reportClassOnDate(student, classSettings, dateKST) {
  const derived = applyNaesinFreeDerivation(activeEnrollmentsAt(student?.enrollments, dateKST), {
    classSettings,
    dateStr: dateKST,
    resolveNaesinCsKey,
    enrollmentCode,
  });
  const dayName = getDayName(dateKST);
  const scheduled = derived.filter((enrollment) => normalizedDays(enrollment.day).includes(dayName));
  const primary = scheduled.find((enrollment) => enrollment.class_type !== '특강');
  if (!primary || !['정규', '자유학기'].includes(primary.class_type || '정규')) return '';
  return enrollmentCode(primary);
}

function legacyReportDateLabel(dateKST) {
  const [, month, day] = dateKST.split('-').map(Number);
  return `${month}/${day}(${getDayName(dateKST)})`;
}

function isReportQueue(queue, dateKST) {
  if (queue.kind === 'parent_notice') {
    if (queue.template_key === 'report' && queue.report_date_kst === dateKST) return true;
    const variables = queue.template_variables ?? {};
    return variables['#{날짜}'] === legacyReportDateLabel(dateKST)
      && Object.hasOwn(variables, '#{내용}');
  }
  return queue.kind === 'direct'
    && queue.source === 'parent_report'
    && queue.report_date_kst === dateKST;
}

function reportQueuesForStudent(studentId, queues, dateKST) {
  return queues.filter((queue) => {
    if (queue.student_id !== studentId) return false;
    return isReportQueue(queue, dateKST);
  });
}

function reportStatusesForStudent(studentId, queues, dateKST) {
  return [...new Set(reportQueuesForStudent(studentId, queues, dateKST).map((queue) => queue.status).filter(Boolean))];
}

function notificationStatusOf(statuses) {
  if (statuses.length === 0) return 'not_queued';
  if (statuses.includes('sent')) return 'complete';
  if (statuses.includes('failed_permanent')) return 'retry_failed';
  if (statuses.includes('failed_retryable')) return 'retrying';
  return 'pending';
}

async function loadReportQueues(db, dateKST) {
  const [tagged, recent] = await Promise.all([
    db.collection('message_queue').where('report_date_kst', '==', dateKST).get(),
    db.collection('message_queue').where('created_at', '>=', Timestamp.fromDate(new Date(`${dateKST}T00:00:00+09:00`))).get(),
  ]);
  return [...tagged.docs, ...recent.docs].map((doc) => doc.data());
}

export function buildAttendanceNotificationGaps({ daily, students, classSettings, queues, dateKST }) {
  const studentMap = new Map(students.map((student) => [student.id, student]));
  const eligible = daily.map((record) => {
    const student = studentMap.get(record.student_id);
    if (!record.student_id || !isAttendedStatus(record.attendance?.status)) return null;
    const className = reportClassOnDate(student, classSettings, dateKST);
    if (!className) return null;
    const teacherName = teacherDisplayName(staffLabel(classSettingsGet(classSettings, className)?.teacher));
    return { record, className, teacherName };
  }).filter(Boolean);
  const items = [];
  for (const { record, className, teacherName } of eligible) {
    const student = studentMap.get(record.student_id);
    const statuses = reportStatusesForStudent(record.student_id, queues, dateKST);
    if (statuses.includes('sent')) continue;
    items.push({
      student_id: record.student_id,
      student_name: student?.name || record.student_name || '(이름 미확인)',
      class_name: className,
      teacher_name: teacherName,
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
  const [dailySnap, queues] = await Promise.all([
    db.collection('daily_records').where('date', '==', dateKST).get(),
    loadReportQueues(db, dateKST),
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
    queues,
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
  const latestDateKST = previousKstDate(deps.now ?? new Date());
  const dateKST = requestedPastDate(request.data?.dateKST, latestDateKST);
  const snap = await db.collection('attendance_notification_gaps').doc(dateKST).get();
  if (!snap.exists) return { dateKST, generated: false, items: [] };
  const data = snap.data();
  const queues = await loadReportQueues(db, dateKST);
  const items = (data.items ?? []).map((item) => {
    const statuses = reportStatusesForStudent(item.student_id, queues, dateKST);
    return { ...item, notification_status: notificationStatusOf(statuses), queue_statuses: statuses };
  });
  return {
    dateKST,
    generated: true,
    generatedAt: data.generated_at?.toMillis?.() ?? null,
    attendedCount: data.attended_count ?? 0,
    missingCount: items.filter((item) => item.notification_status !== 'complete').length,
    items,
  };
}
