import { getFirestore } from 'firebase-admin/firestore';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import { isTabletEligibleStatus } from './attendanceState.js';

function isoOf(ts) {
  try {
    if (ts?.toDate) return ts.toDate().toISOString();
    if (typeof ts === 'string') return ts;
    return null;
  } catch {
    return null;
  }
}

// 태블릿 조회용: 그 날(기본 오늘) 출결 이벤트·상태·대상 학생 명단 반환(정렬은 클라).
export async function handleTabletAttendanceLog(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const fs = deps.firestore || getFirestore();
  const dateKST = (request.data?.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? request.data.date : todayKST();

  const [evSnap, dailySnap, stuSnap] = await Promise.all([
    fs.collection('attendance_events').where('date_kst', '==', dateKST).get(),
    fs.collection('daily_records').where('date', '==', dateKST).get(),
    fs.collection('students').get(),
  ]);

  const events = evSnap.docs.map((d) => {
    const e = d.data();
    return { student_id: e.student_id, student_name: e.student_name, type: e.type, occurred_at: isoOf(e.occurred_at) };
  }).filter((e) => e.occurred_at);

  const daily = {};
  for (const d of dailySnap.docs) {
    const r = d.data();
    // 문서 ID는 `${studentId}_${date}`이므로 클라 조회 키(student_id)로 매핑한다.
    if (r.student_id) daily[r.student_id] = { day_state: r.day_state || '미등원', attendance: { status: r.attendance?.status || '' } };
  }

  const students = stuSnap.docs
    .map((d) => ({ student_id: d.id, ...d.data() }))
    .filter((s) => isTabletEligibleStatus(s.status))
    .map((s) => ({ student_id: s.student_id, name: s.name }));

  return { events, daily, students };
}
