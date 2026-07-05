import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { normalizeAttendanceLabel } from '@impact7/shared/attendance-action';
import { assertManagerOrAbove } from './authGuards.js';
import { STAFF_DAY_STATES, nextStaffDayState } from './staffAttendanceState.js';

// 근태 레코드 보정 — staff_attendance는 write:false(서버전용)이므로 보정도 callable 경유만 가능.
// manager+가 출근/퇴근/외출/복귀 시각을 교정하고 메모를 단다. 보정 사실은 edited/editedBy/editedAt로 감사된다.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ACTIONS = new Set(['출근', '퇴근', '외출', '귀원', '복귀']);

function isValidIso(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function normalizeEvent(event) {
  const action = normalizeAttendanceLabel(String(event?.action ?? '').trim());
  const at = String(event?.at ?? '').trim();
  if (!EVENT_ACTIONS.has(action)) {
    throw new HttpsError('invalid-argument', 'events.action이 올바르지 않습니다.');
  }
  if (!isValidIso(at)) {
    throw new HttpsError('invalid-argument', 'events.at는 유효한 ISO 문자열이어야 합니다.');
  }
  return { action, at, at_ms: Date.parse(at) };
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    throw new HttpsError('invalid-argument', 'events는 배열이어야 합니다.');
  }
  return events.map(normalizeEvent).sort((a, b) => a.at.localeCompare(b.at));
}

function replayStaffEvents(events) {
  let state = STAFF_DAY_STATES.NONE;
  let lastEvent = null;
  for (const event of events) {
    const nextState = nextStaffDayState(state, event.action);
    if (!nextState) {
      throw new HttpsError('invalid-argument', 'events 순서가 직원 근태 상태와 맞지 않습니다.');
    }
    state = nextState;
    lastEvent = { action: event.action, at_ms: event.at_ms };
  }
  return { state, lastEvent };
}

function deriveClockFields(events) {
  const clockIns = events.filter((event) => event.action === '출근');
  const clockOuts = events.filter((event) => event.action === '퇴근');
  return {
    arriveAt: clockIns[0]?.at ?? null,
    departAt: clockOuts.at(-1)?.at ?? null,
  };
}

export async function handleEditStaffAttendance(request, deps = {}) {
  const db = deps.firestore || getFirestore();
  await assertManagerOrAbove(request.auth, db);

  const data = request.data ?? {};
  const date = String(data.date ?? '').trim();
  const staffId = String(data.staffId ?? '').trim();
  if (!DATE_RE.test(date)) throw new HttpsError('invalid-argument', 'date(YYYY-MM-DD)가 필요합니다.');
  if (!staffId) throw new HttpsError('invalid-argument', 'staffId가 필요합니다.');

  // 제공된 필드만 갱신. null은 "지움"(merge로 null 기록). ISO 형식은 서버에서 재검증한다.
  const update = {};
  if (data.arriveAt !== undefined) {
    if (data.arriveAt !== null && !isValidIso(data.arriveAt)) {
      throw new HttpsError('invalid-argument', 'arriveAt는 유효한 ISO 문자열이거나 null이어야 합니다.');
    }
    update.arriveAt = data.arriveAt;
  }
  if (data.departAt !== undefined) {
    if (data.departAt !== null && !isValidIso(data.departAt)) {
      throw new HttpsError('invalid-argument', 'departAt는 유효한 ISO 문자열이거나 null이어야 합니다.');
    }
    update.departAt = data.departAt;
  }
  if (data.memo !== undefined) {
    if (typeof data.memo !== 'string') {
      throw new HttpsError('invalid-argument', 'memo는 문자열이어야 합니다.');
    }
    update.memo = data.memo;
  }
  if (data.events !== undefined) {
    const events = normalizeEvents(data.events);
    const replayed = replayStaffEvents(events);
    const clocks = deriveClockFields(events);
    update.events = events;
    update.state = replayed.state;
    update.last_event = replayed.lastEvent;
    update.arriveAt = clocks.arriveAt;
    update.departAt = clocks.departAt;
  }

  const ref = db.collection('staff_attendance').doc(`${date}_${staffId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', '근태 레코드를 찾을 수 없습니다.');

  update.edited = true;
  update.editedBy = request.auth.uid;
  update.editedAt = FieldValue.serverTimestamp();

  await ref.set(update, { merge: true });
  return { ok: true };
}
