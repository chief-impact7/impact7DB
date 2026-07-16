import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { todayKST } from '@impact7/shared/datetime';
import { generateText } from './vertex.js';
import { assertAuthorizedStaff } from './authGuards.js';
import { isoWeekKST } from './isoWeek.js';

// impact7board 칸반 보드(board_cards)의 주간 스냅샷을 Gemini로 요약하는 콜러블.
// student-report-ai(studentReportAiHandler.js)와 동일 구조: deps 주입으로 테스트, 실패는 HttpsError.
// 결과는 board_briefings/{board}_{isoWeek}에 merge 저장하고, 같은 주 문서가 이미 있으면
// force!==true일 때 Gemini 호출 없이 캐시를 그대로 반환한다(무의미한 재생성 방지).

const MODEL = 'gemini-3.1-pro-preview'; // studentReportAiHandler와 동일 모델
const STALE_DAYS = 7;
const LIST_LIMIT = 10;
const WEEK_SPAN_DAYS = 7; // 오늘 포함 7일(이번 주 마감 예정 범위)

const BOARDS = ['ops', 'students'];
const BOARD_NAME = { ops: '학원 업무', students: '학생 관리' };
// firestore.rules boardCardColumnValid()의 컬럼 목록과 동일 — 컬럼 추가 시 함께 갱신할 것.
const BOARD_COLUMNS = {
  ops: [
    { id: 'ideas', title: '아이디어' },
    { id: 'todo', title: '할 일' },
    { id: 'doing', title: '진행 중' },
    { id: 'review', title: '확인 요청' },
    { id: 'done', title: '완료' },
  ],
  students: [
    { id: 'intake', title: '상담 접수' },
    { id: 'placement', title: '테스트/배치' },
    { id: 'enrolling', title: '등록 진행' },
    { id: 'followup', title: '팔로업' },
    { id: 'done', title: '완료' },
  ],
};

function columnTitle(board, columnId) {
  return BOARD_COLUMNS[board].find((c) => c.id === columnId)?.title || columnId;
}

function addDaysIso(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// updated_at은 Firestore Timestamp(admin SDK) — 없거나 형태가 다르면 null(정체 판정에서 제외).
function updatedAtMs(card) {
  const v = card.updated_at;
  return typeof v?.toMillis === 'function' ? v.toMillis() : null;
}

function daysAgo(ms, nowMs) {
  return Math.floor((nowMs - ms) / 86400000);
}

function columnCountsLines(board, cards) {
  return BOARD_COLUMNS[board]
    .map((col) => `- ${col.title}: ${cards.filter((c) => c.column === col.id).length}건`)
    .join('\n');
}

// 마감 지남 — done 컬럼 제외, due_date < today. 가장 오래 지난 카드가 위로 오도록 오름차순.
function overdueLines(board, cards, todayIso) {
  const list = cards
    .filter((c) => c.column !== 'done' && c.due_date && c.due_date < todayIso)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, LIST_LIMIT);
  if (list.length === 0) return '없음';
  return list.map((c) => `- ${c.title} (마감 ${c.due_date}, ${columnTitle(board, c.column)})`).join('\n');
}

// 정체 카드 — done 컬럼 제외, 마지막 수정이 STALE_DAYS일 이상 경과. 가장 오래 정체된 카드부터.
function staleLines(board, cards, nowMs) {
  const list = cards
    .filter((c) => c.column !== 'done')
    .map((c) => ({ card: c, ms: updatedAtMs(c) }))
    .filter((x) => x.ms != null && daysAgo(x.ms, nowMs) >= STALE_DAYS)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, LIST_LIMIT);
  if (list.length === 0) return '없음';
  return list
    .map((x) => `- ${x.card.title} (${columnTitle(board, x.card.column)}, ${daysAgo(x.ms, nowMs)}일째 정체)`)
    .join('\n');
}

// 이번 주 마감 예정 — done 컬럼 제외, due_date가 [today, today+6일] 구간.
function dueThisWeekLines(board, cards, todayIso) {
  const until = addDaysIso(todayIso, WEEK_SPAN_DAYS - 1);
  const list = cards
    .filter((c) => c.column !== 'done' && c.due_date && c.due_date >= todayIso && c.due_date <= until)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, LIST_LIMIT);
  if (list.length === 0) return '없음';
  return list.map((c) => `- ${c.title} (${c.due_date}, ${columnTitle(board, c.column)})`).join('\n');
}

function buildPrompt(board, cards, todayIso, nowMs) {
  return `
너는 Impact7 학원의 운영 담당자다.
아래는 "${BOARD_NAME[board]}" 칸반 보드의 오늘(${todayIso}) 기준 스냅샷이다. 이 스냅샷만 보고
팀이 읽을 주간 브리핑을 작성하라.

규칙:
- 출력은 마크다운 텍스트만(코드블록 금지), 200~300자 내외 한국어.
- 정체된 카드(오래 안 움직인 카드)가 있으면 구체적으로 지적한다.
- 이번 주 집중해야 할 포인트를 1~2가지 제안한다.
- 목록을 그대로 나열하지 말고 문장으로 종합할 것.

컬럼별 카드 수:
${columnCountsLines(board, cards)}

마감 지남(최대 ${LIST_LIMIT}건):
${overdueLines(board, cards, todayIso)}

${STALE_DAYS}일 이상 정체(최대 ${LIST_LIMIT}건):
${staleLines(board, cards, nowMs)}

이번 주 마감 예정(최대 ${LIST_LIMIT}건):
${dueThisWeekLines(board, cards, todayIso)}
`.trim();
}

async function fetchBoardCards(firestore, board) {
  const snap = await firestore
    .collection('board_cards')
    .where('board', '==', board)
    .where('archived', '==', false)
    .get();
  return snap.docs.map((d) => d.data());
}

export async function handleGenerateBoardBriefing(request, deps = {}) {
  assertAuthorizedStaff(request.auth);

  const board = String(request.data?.board || '');
  if (!BOARDS.includes(board)) {
    throw new HttpsError('invalid-argument', 'board는 ops 또는 students여야 합니다.');
  }
  const force = request.data?.force === true;

  const firestore = deps.firestore || getFirestore();
  const generate = deps.generateText || generateText;
  const today = deps.todayKST ? deps.todayKST() : todayKST();
  const now = deps.now ? deps.now() : Date.now();
  const email = request.auth.token?.email || '';

  const week = isoWeekKST(today);
  const ref = firestore.collection('board_briefings').doc(`${board}_${week}`);

  try {
    if (!force) {
      const existing = await ref.get();
      const existingData = existing.exists ? existing.data() : null;
      if (existingData?.markdown) {
        return { markdown: existingData.markdown, cached: true };
      }
    }

    const cards = await fetchBoardCards(firestore, board);
    const prompt = buildPrompt(board, cards, today, now);
    const markdown = String((await generate(MODEL, prompt, { temperature: 0.3 })) || '').trim();
    if (!markdown) throw new HttpsError('internal', 'AI 응답이 비어 있습니다.');

    await ref.set(
      {
        board,
        week,
        markdown,
        generated_at: FieldValue.serverTimestamp(),
        generated_by: email,
      },
      { merge: true },
    );

    return { markdown, cached: false };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', '주간 브리핑 생성 실패');
  }
}
