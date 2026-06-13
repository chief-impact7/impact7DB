import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { generateTextWithUsage } from './vertex.js';
import { generateReportForStudent } from './studentReportAiHandler.js';
import { tsToMillis } from './timestampUtil.js';
import { writeLog } from './notifyLog.js';

// 전체 재원생(500+ )을 "타임박스 + 커서 재개" 청크 모델로 순회한다.
// 한 함수 실행 = 한 청크(시간 예산 MAX_RUN_MS 내). 미처리분(run_pending_ids)을
// automation_settings/student_report에 남겨 다음 틱(scheduled 5분 / manual)이 이어받는다.
// 어떤 단일 실행도 함수 timeout(540s)에 닿지 않는다.
//
// 상태 플래그 분리:
//  - batch_active: 배치 시작됨 + pending 남음(여러 청크에 걸쳐 true).
//  - chunk_lock + run_started_at: "지금 이 청크를 처리 중인 작업자 락". 청크 시작 claim,
//    종료/중단 해제. stale(STALE_RUNNING_MS) 넘으면 다른 작업자가 탈취.

export const AUTOMATION_DOC = 'automation_settings/student_report';
const SYSTEM_ACTOR = { uid: 'system', email: 'automation@impact7.kr' };
const CONCURRENCY = 3;
const PROGRESS_FLUSH_EVERY = 5;          // progress_done를 5건마다 Firestore에 반영
const STALE_RUNNING_MS = 30 * 60 * 1000; // run_started_at이 30분 넘게 박혀 있으면 stale → 탈취 허용
const SUMMARY_GET_CHUNK = 300;           // getAll 청크 크기(skip 판정 병렬 조회)
const MAX_RUN_MS = 480_000;              // 한 청크 시간 예산(8분). 540s timeout 전 안전 마진.

// run_pending_ids는 string[]로 문서에 저장한다. 재원생 500~수천이면 id 길이×N이 수십~수백KB로
// Firestore 1MB 문서 한도 내 안전. 단 1만 명 이상으로 커지면 한도에 근접할 수 있다 →
// 그 규모면 pending을 별도 컬렉션(청크 doc) 또는 students 커서(startAfter) 방식으로 전환할 것.

// gemini-3.1-pro-preview 단가(USD/1M tokens). 추정치 — Vertex 공식 단가 확정 시 갱신할 것.
// (입력/출력 분리 과금 가정; 정확한 청구는 GCP 빌링이 정본, 여기 값은 대시보드 표시용 근사.)
const PRICE_INPUT_PER_M = 1.25;   // 추정
const PRICE_OUTPUT_PER_M = 5.0;   // 추정

function estimateCostUsd(promptTokens, candidateTokens) {
  return (promptTokens / 1_000_000) * PRICE_INPUT_PER_M
    + (candidateTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
}

function isWithinDays(generatedAt, days, nowMs) {
  if (!days || days <= 0) return false;
  const ms = tsToMillis(generatedAt);
  if (ms == null) return false;
  return (nowMs - ms) < days * 86400000;
}

async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (err) {
    console.warn('[runStudentReportChunk] writeLog 실패:', String(err?.message || err));
  }
}

// chunk_lock을 원자적으로 claim. 트랜잭션 안에서 읽고 판정해 scheduled 틱과 manual이 동시에
// 들어와도 둘 중 하나만 통과한다(TOCTOU 제거). chunk_lock이 잡혀있고 run_started_at이 stale가
// 아니면 claimed:false(write 없음). 아니면 chunk_lock=true + run_started_at=serverTimestamp() claim.
async function claimChunk(firestore, settingsRef, nowMs) {
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(settingsRef);
    const settings = (snap.exists && snap.data()) || {};
    if (settings.chunk_lock === true) {
      const startedMs = tsToMillis(settings.run_started_at);
      if (startedMs != null && (nowMs - startedMs) < STALE_RUNNING_MS) {
        return { claimed: false, settings };
      }
      console.warn('[runStudentReportChunk] stale chunk_lock 감지 — 탈취');
    }
    tx.set(settingsRef, { chunk_lock: true, run_started_at: FieldValue.serverTimestamp() }, { merge: true });
    return { claimed: true, settings };
  });
}

// 동시성 제한 + 시간 예산 순회. 새 학생을 집기 전에 deadline을 확인해 도달하면 멈추고
// in-flight만 마무리한다. picker(next)는 더 줄 게 없거나(deadline) 끝나면 undefined.
async function runChunkWithDeadline(items, limit, clock, deadline, worker) {
  let next = 0;
  async function pick() {
    while (next < items.length) {
      if (clock() >= deadline) return undefined; // 시간 소진 — 새 학생 안 집음
      return items[next++];
    }
    return undefined;
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let item = await pick(); item !== undefined; item = await pick()) {
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// skip_within_days 판정: student_status_summaries를 getAll로 청크 병렬 조회(직렬 get 제거).
async function selectTargets(firestore, studentIds, skipDays, nowMs) {
  if (skipDays <= 0) return { targets: studentIds, skipped: 0 };

  const summaryCol = firestore.collection('student_status_summaries');
  const targets = [];
  let skipped = 0;
  for (let i = 0; i < studentIds.length; i += SUMMARY_GET_CHUNK) {
    const chunk = studentIds.slice(i, i + SUMMARY_GET_CHUNK);
    const refs = chunk.map(id => summaryCol.doc(id));
    const snaps = await firestore.getAll(...refs);
    snaps.forEach((snap, j) => {
      const generatedAt = snap.exists ? snap.data().generated_at : null;
      if (isWithinDays(generatedAt, skipDays, nowMs)) skipped++;
      else targets.push(chunk[j]);
    });
  }
  return { targets, skipped };
}

// 새 배치 대상 확정(첫 청크에서만). 전체 재원생 → skip 판정 → run_pending_ids 고정.
// 한 번 고정하면 재개 시 재평가하지 않는다(아래 resume 경로) — 진행 중 방금 생성분이
// skip_within_days로 빠지는 일을 막기 위함(의도된 동작).
async function buildNewRun(firestore, settings, nowMs) {
  const skipDays = Number(settings.skip_within_days || 0);
  const studentsSnap = await firestore.collection('students')
    .where('status', 'in', [...ENROLLABLE_STATUSES]) // 4개라 'in' 10개 제한 내
    .get();
  const studentIds = studentsSnap.docs.map(d => d.id);
  return selectTargets(firestore, studentIds, skipDays, nowMs);
}

// 한 청크를 처리한다. claim → (새 시작이면 대상 확정) → 시간 예산 내 처리 → 완료/부분/크래시 마감.
// 반환: {ok:true, status:'in_progress'|'complete', done, total, ...} | {ok:false, reason:'locked'}.
export async function runStudentReportChunk(opts = {}) {
  const firestore = opts.firestore || getFirestore();
  const generateWithUsage = opts.generateWithUsage || generateTextWithUsage;
  const getChat = opts.getChat;
  const today = opts.today;
  const clock = opts.clock || Date.now;
  const maxRunMs = opts.maxRunMs || MAX_RUN_MS;
  const nowMs = opts.nowMs || clock();

  const settingsRef = firestore.doc(AUTOMATION_DOC);

  // 원자적 chunk_lock claim — 동시 작업자 차단.
  const { claimed, settings } = await claimChunk(firestore, settingsRef, nowMs);
  if (!claimed) return { ok: false, reason: 'locked' };

  // 재개 vs 새 시작.
  const resuming = settings.batch_active === true;
  const actor = resuming ? (settings.run_actor || SYSTEM_ACTOR) : (opts.actor || SYSTEM_ACTOR);
  const trigger = resuming ? (settings.run_trigger || 'scheduled') : (opts.trigger || 'manual');

  // 누적 상태(여러 청크 합산).
  let pendingIds;
  let total;
  let generated = resuming ? Number(settings.run_generated || 0) : 0;
  let skippedTotal = resuming ? Number(settings.run_skipped || 0) : 0;
  let promptTokens = resuming ? Number(settings.run_prompt_tokens || 0) : 0;
  let candidateTokens = resuming ? Number(settings.run_candidate_tokens || 0) : 0;
  let totalTokens = resuming ? Number(settings.run_total_tokens || 0) : 0;
  let failed = 0;

  try {
    if (resuming) {
      pendingIds = Array.isArray(settings.run_pending_ids) ? [...settings.run_pending_ids] : [];
      total = Number(settings.progress_total || pendingIds.length);
    } else {
      const { targets, skipped } = await buildNewRun(firestore, settings, nowMs);
      pendingIds = targets;
      total = targets.length;
      skippedTotal = skipped;
      // 새 run 시작 표시 + 대상 고정.
      await settingsRef.set({
        batch_active: true,
        run_pending_ids: pendingIds,
        progress_total: total,
        progress_done: 0,
        run_generated: 0,
        run_skipped: skipped,
        run_prompt_tokens: 0,
        run_candidate_tokens: 0,
        run_total_tokens: 0,
        run_trigger: trigger,
        run_actor: actor,
      }, { merge: true });
    }

    const deadline = clock() + maxRunMs;
    const remaining = [...pendingIds]; // 처리 성공/실패한 id는 여기서 제거
    let sinceFlush = 0;

    await runChunkWithDeadline(pendingIds, CONCURRENCY, clock, deadline, async (studentId) => {
      try {
        const r = await generateReportForStudent({
          firestore, generateWithUsage, getChat, today, studentId, actor,
        });
        generated++;
        promptTokens += r.usage.promptTokenCount;
        candidateTokens += r.usage.candidatesTokenCount;
        totalTokens += r.usage.totalTokenCount;
      } catch (err) {
        failed++;
        console.warn('[runStudentReportChunk] 학생 실패(계속):', studentId, String(err?.message || err));
      } finally {
        // 처리 착수했으면 pending에서 제거(성공/실패 무관 — 무한 재시도 방지).
        const idx = remaining.indexOf(studentId);
        if (idx >= 0) remaining.splice(idx, 1);
        sinceFlush++;
        if (sinceFlush % PROGRESS_FLUSH_EVERY === 0) {
          await settingsRef.set({
            run_pending_ids: [...remaining],
            progress_done: total - remaining.length,
          }, { merge: true }).catch(() => {});
        }
      }
    });

    if (remaining.length === 0) {
      // 완료: last_run_* 기록 + batch_active=false + chunk_lock 해제 + run_* 클리어.
      const status = failed === 0 ? 'success' : (generated > 0 ? 'partial' : 'failed');
      await settingsRef.set({
        batch_active: false,
        chunk_lock: false,
        run_started_at: FieldValue.delete(),
        run_pending_ids: FieldValue.delete(),
        run_generated: FieldValue.delete(),
        run_skipped: FieldValue.delete(),
        run_prompt_tokens: FieldValue.delete(),
        run_candidate_tokens: FieldValue.delete(),
        run_total_tokens: FieldValue.delete(),
        run_trigger: FieldValue.delete(),
        run_actor: FieldValue.delete(),
        progress_done: total,
        progress_total: total,
        last_run_at: FieldValue.serverTimestamp(),
        last_run_status: status,
        last_run_generated: generated,
        last_run_skipped: skippedTotal,
        last_run_total_tokens: totalTokens,
        last_run_cost_usd: estimateCostUsd(promptTokens, candidateTokens),
      }, { merge: true });
      await safeLog({
        channel: 'student_report_batch', ok: status !== 'failed', trigger,
        generated, skipped: skippedTotal, total_tokens: totalTokens, complete: true,
      });
      return { ok: true, status: 'complete', done: total, total, generated, skipped: skippedTotal, total_tokens: totalTokens };
    }

    // 부분: 미처리분·누적·진행 저장 + batch_active 유지 + chunk_lock 해제(다음 틱이 이어받음).
    await settingsRef.set({
      batch_active: true,
      chunk_lock: false,
      run_started_at: FieldValue.delete(),
      run_pending_ids: remaining,
      progress_done: total - remaining.length,
      progress_total: total,
      run_generated: generated,
      run_skipped: skippedTotal,
      run_prompt_tokens: promptTokens,
      run_candidate_tokens: candidateTokens,
      run_total_tokens: totalTokens,
      run_trigger: trigger,
      run_actor: actor,
    }, { merge: true });
    await safeLog({
      channel: 'student_report_batch', ok: true, trigger,
      generated, skipped: skippedTotal, remaining: remaining.length, complete: false,
    });
    return { ok: true, status: 'in_progress', done: total - remaining.length, total, generated, skipped: skippedTotal, total_tokens: totalTokens };
  } catch (err) {
    // 본문 크래시: chunk_lock만 해제(batch_active·pending 유지 → 다음 틱 재개). last_run 미기록.
    await settingsRef.set({ chunk_lock: false, run_started_at: FieldValue.delete() }, { merge: true }).catch(() => {});
    await safeLog({ channel: 'student_report_batch', ok: false, trigger, error: String(err?.message || err) });
    throw err;
  }
}
