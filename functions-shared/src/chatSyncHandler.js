import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { fetchSpaceMessagesSince } from './chatClient.js';
import { writeLog } from './notifyLog.js';

// 하루 1회 chief 스페이스 신규 메시지를 증분 수집 → 재원생 이름 태깅 → chat_messages 적재.
// generateStudentReportAi는 풀스캔 대신 이 컬렉션을 array-contains로 조회한다.

const SYNC_STATE_DOC = 'sync_state/chat_messages';
const DEFAULT_LOOKBACK_DAYS = 3;   // 최초 실행(상태 없음) 시 소급 범위 — 최초 폭증 완화
const MAX_TEXT = 500;
const BATCH_LIMIT = 400;

// now 주입 가능 — 테스트 결정성(고정 시계). 미주입 시 실시계.
function defaultSince(now) {
  const d = now ? new Date(now) : new Date();
  d.setDate(d.getDate() - DEFAULT_LOOKBACK_DAYS);
  return d.toISOString();
}

// Chat message name("spaces/X/messages/Y.Z")을 Firestore doc id로 (슬래시·점 불가).
function safeDocId(messageName) {
  return String(messageName).replace(/[^\w-]/g, '_');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 재원생(isEnrollableStatus) 이름을 정규식으로. 이름 뒤에 숫자가 더 오면 매칭 제외
// → '김민준3'이 '김민준30'을 오탐하지 않게(이름은 번호 포함 고유 전제).
async function loadEnrolledNamePatterns(firestore) {
  const snap = await firestore.collection('students').get();
  const patterns = [];
  for (const d of snap.docs) {
    const s = d.data();
    const name = String(s.name || '').trim();
    if (name.length >= 2 && isEnrollableStatus(s.status)) {
      patterns.push({ name, re: new RegExp(escapeRegex(name) + '(?![0-9])') });
    }
  }
  return patterns;
}

function matchNames(text, patterns) {
  const matched = [];
  for (const { name, re } of patterns) {
    if (re.test(text)) matched.push(name);
  }
  return matched;
}

async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (err) {
    console.warn('[syncChatMessages] writeLog 실패:', String(err?.message || err));
  }
}

export async function handleSyncChatMessages(deps = {}) {
  const firestore = deps.firestore || getFirestore();
  const fetchMessages = deps.fetchMessages || fetchSpaceMessagesSince;
  const chatKey = deps.chatKey ?? process.env.CHAT_SA_KEY;
  if (!chatKey) {
    console.warn('[syncChatMessages] CHAT_SA_KEY 없음 — 스킵');
    return { ok: false, reason: 'no_key' };
  }

  const stateRef = firestore.doc(SYNC_STATE_DOC);
  const stateSnap = await stateRef.get();
  const since = (stateSnap.exists && stateSnap.data().last_synced_time) || defaultSince(deps.now);

  let messages;
  try {
    messages = await fetchMessages(chatKey, since);
  } catch (err) {
    await safeLog({ channel: 'chat_sync', ok: false, error: String(err?.message || err) });
    throw err; // onSchedule 자동 재시도에 맡김
  }

  const patterns = await loadEnrolledNamePatterns(firestore);

  // 학생이 언급된 메시지만 적재. 동시에 최신 createTime을 추적해 다음 증분 기준으로 저장.
  let maxTime = since;
  const tagged = [];
  for (const m of messages) {
    if (m.createTime > maxTime) maxTime = m.createTime;
    const studentNames = matchNames(m.text, patterns);
    if (studentNames.length) tagged.push({ ...m, studentNames });
  }

  let written = 0;
  for (let i = 0; i < tagged.length; i += BATCH_LIMIT) {
    const batch = firestore.batch();
    for (const t of tagged.slice(i, i + BATCH_LIMIT)) {
      batch.set(firestore.collection('chat_messages').doc(safeDocId(t.id)), {
        space: t.space,
        create_time: t.createTime,
        text: t.text.slice(0, MAX_TEXT),
        student_names: t.studentNames,
        synced_at: FieldValue.serverTimestamp(),
      });
      written++;
    }
    await batch.commit();
  }

  // 커서는 batch 적재 성공 후 갱신. doc id가 message name으로 고정(멱등)이라,
  // 중간 batch 실패로 커서 미갱신 시 재시도해도 중복 적재가 아니라 덮어쓰기가 된다.
  await stateRef.set({ last_synced_time: maxTime, last_run_at: FieldValue.serverTimestamp() }, { merge: true });
  await safeLog({ channel: 'chat_sync', ok: true, fetched: messages.length, tagged: written });
  return { ok: true, fetched: messages.length, tagged: written, last_synced_time: maxTime };
}
