import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import { TABLET_ELIGIBLE_STATUSES } from './attendanceState.js';

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60_000;

function isoOf(ts) {
  try {
    if (ts?.toDate) return ts.toDate().toISOString();
    if (typeof ts === 'string') return ts;
    return null;
  } catch {
    return null;
  }
}

// 조회 PIN 검증 — PIN은 서버 전용 kiosk_settings/global에만 둔다(클라 번들 노출 금지).
// 연속 실패 5회면 1분 잠금(키오스크 화면 무차별 대입 차단). 미설정이면 실패-클로즈드.
async function verifyKioskPin(fs, rawPin, now = Date.now()) {
  const ref = fs.collection('kiosk_settings').doc('global');
  const cfg = (await ref.get()).data() ?? {};
  const adminPin = String(cfg.admin_pin ?? '');
  if (!/^\d{6}$/.test(adminPin)) {
    // 키패드가 6자리 고정이라 PIN도 6자리여야 입력 가능하다 — 형식 불량은 미설정으로 취급.
    throw new HttpsError('failed-precondition', '조회 PIN이 설정되지 않았어요. 관리자에게 문의하세요.');
  }
  if ((cfg.pin_locked_until ?? 0) > now) {
    throw new HttpsError('resource-exhausted', 'PIN 오류가 반복돼 잠시 잠겼어요. 1분 후 다시 시도하세요.');
  }
  const pin = String(rawPin ?? '');
  // 빈/형식불량 pin(구버전 클라의 pin 없는 호출 포함)은 대입 시도가 아니다 — 카운터 없이 거부.
  if (!/^\d{6}$/.test(pin)) {
    throw new HttpsError('permission-denied', 'PIN이 올바르지 않아요.');
  }
  if (pin !== adminPin) {
    // 원자 증가(트랜잭션) — 동시 시도로 카운트가 유실되면 잠금이 무력화된다.
    await fs.runTransaction(async (tx) => {
      const fails = ((await tx.get(ref)).data()?.pin_fail_count ?? 0) + 1;
      tx.set(
        ref,
        fails >= PIN_MAX_FAILS ? { pin_fail_count: 0, pin_locked_until: now + PIN_LOCK_MS } : { pin_fail_count: fails },
        { merge: true },
      );
    });
    throw new HttpsError('permission-denied', 'PIN이 올바르지 않아요.');
  }
  if (cfg.pin_fail_count) await ref.set({ pin_fail_count: 0 }, { merge: true });
}

// 태블릿 조회용: 그 날(기본 오늘) 출결 이벤트·상태·대상 학생 명단 반환(정렬은 클라).
export async function handleTabletAttendanceLog(request, deps = {}) {
  assertAuthorizedStaff(request.auth);
  const fs = deps.firestore || getFirestore();
  await verifyKioskPin(fs, request.data?.pin, deps.now);
  const dateKST = (request.data?.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? request.data.date : todayKST();

  const [evSnap, dailySnap, stuSnap] = await Promise.all([
    fs.collection('attendance_events').where('date_kst', '==', dateKST).get(),
    fs.collection('daily_records').where('date', '==', dateKST).get(),
    fs.collection('students').where('status', 'in', [...TABLET_ELIGIBLE_STATUSES]).get(),
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

  const students = stuSnap.docs.map((d) => ({ student_id: d.id, name: d.data().name }));

  return { events, daily, students };
}
