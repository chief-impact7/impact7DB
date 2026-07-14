import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { isAttendedStatus } from '@impact7/shared/history';
import { ATTENDANCE_ACTIONS } from '@impact7/shared/attendance-action';
import { formatDateKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';

export function previousKstDate(now = new Date()) {
  const [year, month, day] = formatDateKST(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function queueIdsForStatus(studentId, status, checkins, events) {
  const ids = [];
  for (const item of checkins) {
    if (item.student_id === studentId && item.status === status && item.queue_id) ids.push(item.queue_id);
  }
  const eventTypes = status === '조퇴'
    ? new Set([ATTENDANCE_ACTIONS.departure])
    : new Set([ATTENDANCE_ACTIONS.arrival, '재등원']);
  for (const item of events) {
    if (item.student_id !== studentId || !eventTypes.has(item.type)) continue;
    ids.push(...(Array.isArray(item.queue_ids) ? item.queue_ids : [item.queue_id]).filter(Boolean));
  }
  return [...new Set(ids)];
}

function notificationStatusOf(statuses) {
  if (statuses.length === 0) return 'not_queued';
  if (statuses.some((value) => value === 'failed_permanent' || value === 'failed_retryable')) return 'failed';
  return 'pending';
}

export function buildAttendanceNotificationGaps({ daily, checkins, events, queueStatuses, studentNames }) {
  const items = [];
  for (const record of daily) {
    const status = record.attendance?.status;
    if (!record.student_id || !isAttendedStatus(status)) continue;
    const queueIds = queueIdsForStatus(record.student_id, status, checkins, events);
    const statuses = [...new Set(queueIds.map((id) => queueStatuses.get(id)).filter(Boolean))];
    if (statuses.includes('sent')) continue;
    items.push({
      student_id: record.student_id,
      student_name: studentNames.get(record.student_id) || record.student_name || '(이름 미확인)',
      attendance_status: status,
      notification_status: notificationStatusOf(statuses),
      queue_statuses: statuses,
    });
  }
  return items.sort((a, b) => a.student_name.localeCompare(b.student_name, 'ko'));
}

export async function runAttendanceNotificationGapSnapshot(deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const dateKST = previousKstDate(deps.now ?? new Date());
  const [dailySnap, checkinSnap, eventSnap] = await Promise.all([
    db.collection('daily_records').where('date', '==', dateKST).get(),
    db.collection('attendance_checkins').where('date_kst', '==', dateKST).get(),
    db.collection('attendance_events').where('date_kst', '==', dateKST).get(),
  ]);
  const daily = dailySnap.docs.map((doc) => doc.data());
  const checkins = checkinSnap.docs.map((doc) => doc.data());
  const events = eventSnap.docs.map((doc) => doc.data());
  const queueIds = [...new Set([
    ...checkins.map((item) => item.queue_id),
    ...events.flatMap((item) => Array.isArray(item.queue_ids) ? item.queue_ids : [item.queue_id]),
  ].filter(Boolean))];
  const attendedIds = [...new Set(daily.filter((item) => isAttendedStatus(item.attendance?.status)).map((item) => item.student_id).filter(Boolean))];

  const [queueSnaps, studentSnaps] = await Promise.all([
    queueIds.length ? db.getAll(...queueIds.map((id) => db.collection('message_queue').doc(id))) : [],
    attendedIds.length ? db.getAll(...attendedIds.map((id) => db.collection('students').doc(id))) : [],
  ]);
  const queueStatuses = new Map(queueSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data().status]));
  const studentNames = new Map(studentSnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data().name]));
  const items = buildAttendanceNotificationGaps({ daily, checkins, events, queueStatuses, studentNames });

  await db.collection('attendance_notification_gaps').doc(dateKST).set({
    date_kst: dateKST,
    generated_at: FieldValue.serverTimestamp(),
    attended_count: attendedIds.length,
    missing_count: items.length,
    items,
  });
  return { dateKST, attendedCount: attendedIds.length, missingCount: items.length };
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
