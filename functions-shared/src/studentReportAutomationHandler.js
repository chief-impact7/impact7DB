import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isAuthorizedStaffEmail } from './authGuards.js';
import { tsToMillis } from './timestampUtil.js';
import { runStudentReportChunk, AUTOMATION_DOC } from './studentReportBatch.js';

// scheduled(runStudentReportAutomation): 5분마다 깨어나 automation_settings를 보고
//  - 진행 중 배치(batch_active)면 다음 청크를 이어받고,
//  - 아니면 interval/run_day/run_hour가 현재 KST 시각과 맞을 때 새 배치를 시작한다.
//  한 청크는 시간 예산 내로 끝나고 미처리분은 다음 5분 틱이 이어받는다(500+ 명도 timeout 회피).
// manual(runStudentReportBatchManual): director 등급 이상이 새 배치를 즉시 시작(첫 청크).
//  미완료분은 scheduled 5분 틱이 이어받는다.

// run_day 규약:
// - weekly: 0=일,1=월,...,6=토 (JS Date.getDay와 동일)
// - monthly: 1~31 (그 달의 날짜). 해당 월에 그 날짜가 없으면(예: 31일/2월) 그 달은 실행 안 함.

// KST 기준 시각 부품 추출(서버 TZ 무관). Intl로 Asia/Seoul 고정.
export function kstParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // 일부 환경에서 자정을 24로 포맷
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    weekday: weekdayMap[parts.weekday],
    dateStr: `${parts.year}-${parts.month}-${parts.day}`, // 같은 슬롯(날짜) 중복 판정용
  };
}

// 현재 KST 시각이 설정 스케줄 슬롯과 일치하는가.
// catch-up 윈도우: 정확한 시 매칭(hour===run_hour) 대신 hour>=run_hour로 완화해
// run_hour에 틱 지연·콜드스타트·크래시로 놓쳐도 같은 날 다음 틱이 따라잡는다.
// 당일 중복은 alreadyRanThisSlot(완료 시각 기준)이 막는다.
// 단 weekly/monthly는 run_day가 "오늘"(요일/날짜)일 때만 매칭이라 윈도우가 그날 안으로 한정된다
// (지난 요일/날짜를 다음날 따라잡지 않음). daily는 매일 run_hour 이후로 자연히 한정.
export function scheduleMatches(settings, parts) {
  if (!settings || settings.enabled !== true) return false;
  const runHour = Number(settings.run_hour);
  if (parts.hour < runHour) return false;

  switch (settings.interval) {
    case 'daily':
      return true;
    case 'weekly':
      return parts.weekday === Number(settings.run_day);
    case 'monthly':
      return parts.day === Number(settings.run_day);
    default:
      return false;
  }
}

// 배치 완료 시각(last_run_at)이 이미 이번 슬롯(같은 KST 날짜) 안이면 중복 실행 방지.
// last_run_at은 배치 완료 시점에만 기록되므로(시작 시점 아님), 크래시로 중단된 슬롯은
// 미완료로 남아 catch-up 윈도우(scheduleMatches hour>=run_hour)의 다음 틱이 재시도한다.
function alreadyRanThisSlot(settings, parts) {
  const ms = tsToMillis(settings?.last_run_at);
  if (ms == null) return false;
  const lastParts = kstParts(new Date(ms));
  return lastParts.dateStr === parts.dateStr;
}

export async function handleRunStudentReportAutomation(deps = {}) {
  const firestore = deps.firestore || getFirestore();
  const now = deps.now || new Date();
  const parts = kstParts(now);

  const snap = await firestore.doc(AUTOMATION_DOC).get();
  const settings = (snap.exists && snap.data()) || {};

  const chunkOpts = {
    firestore,
    generateWithUsage: deps.generateWithUsage,
    getChat: deps.getChat,
    today: deps.today,
    clock: deps.clock,
    maxRunMs: deps.maxRunMs,
    nowMs: now.getTime(),
  };

  // 1) 진행 중 배치면 다음 청크 이어받기(trigger·actor·pending은 worker가 상태에서 복원).
  if (settings.batch_active === true) {
    const r = await runStudentReportChunk(chunkOpts);
    // chunk_lock이 이미 잡혀(다른 틱/manual 처리 중) locked면 skip.
    return { ...r, batch_ok: r.ok, ok: true, ran: r.ok };
  }

  // 2) 새 시작 조건: 스케줄 매칭(catch-up) + 이번 슬롯 미완료(last_run_at 기준).
  if (!scheduleMatches(settings, parts)) return { ok: true, ran: false, reason: 'no_match' };
  if (alreadyRanThisSlot(settings, parts)) return { ok: true, ran: false, reason: 'already_ran_slot' };

  const r = await runStudentReportChunk({ ...chunkOpts, trigger: 'scheduled' });
  // 핸들러는 정상 동작이므로 ok:true 고정. ran은 청크가 실제 돌았는지(locked 아님).
  return { ...r, batch_ok: r.ok, ok: true, ran: r.ok };
}

export async function handleRunStudentReportBatchManual(request, deps = {}) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const email = request.auth.token?.email || '';
  if (!isAuthorizedStaffEmail(email)) throw new HttpsError('permission-denied', '허용되지 않은 계정입니다.');

  const firestore = deps.firestore || getFirestore();

  // rules의 canRunAiBatch와 동일 의미: HR_users/{uid}.role ∈ owner/principal/director.
  const userSnap = await firestore.collection('HR_users').doc(request.auth.uid).get();
  const role = userSnap.exists ? userSnap.data().role : null;
  if (!['owner', 'principal', 'director'].includes(role)) {
    throw new HttpsError('permission-denied', 'AI 일괄 생성 권한이 없습니다.');
  }

  // 첫 청크만 즉시 처리(시간 예산 내). 미완료분은 scheduled 5분 틱이 이어받는다.
  // chunk_lock이 잡혀있으면(이미 누가 처리 중) {ok:false, reason:'locked'} → UI에 "이미 실행 중".
  // UI는 automation_settings의 progress_done/progress_total/batch_active를 onSnapshot 구독.
  const r = await runStudentReportChunk({
    firestore,
    generateWithUsage: deps.generateWithUsage,
    getChat: deps.getChat,
    today: deps.today,
    clock: deps.clock,
    maxRunMs: deps.maxRunMs,
    actor: { uid: request.auth.uid, email },
    trigger: 'manual',
  });
  return r;
}
