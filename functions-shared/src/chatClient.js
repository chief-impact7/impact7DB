import { JWT } from 'google-auth-library';

// Google Chat 메시지 수집 (DWD: 서비스 계정이 chief@impact7.kr를 가장).
// 키워드 검색 API가 없어 스페이스 메시지를 나열한다. 동기화 함수(chatSyncHandler)가
// chief 멤버 스페이스의 신규 메시지를 증분 수집해 Firestore chat_messages에 적재한다.

const IMPERSONATE = 'chief@impact7.kr';
const SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
];
const SPACE_PAGE = 100;
const MSG_PAGE = 100;
const MAX_MSG_PER_SPACE = 500;     // 스페이스당 1회 수집 상한 (폭주 방지)
const MAX_TOTAL_MESSAGES = 2000;   // 전체 합산 상한 (최초 소급 시 메모리 폭증 방지)

function makeClient(saKeyJson) {
  const key = typeof saKeyJson === 'string' ? JSON.parse(saKeyJson) : saKeyJson;
  return new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: IMPERSONATE,
  });
}

async function listSpaces(client) {
  const names = [];
  let pageToken;
  do {
    const url = new URL('https://chat.googleapis.com/v1/spaces');
    url.searchParams.set('pageSize', String(SPACE_PAGE));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await client.request({ url: url.toString() });
    for (const s of res.data.spaces || []) names.push(s.name);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return names;
}

async function listMessagesSince(client, space, sinceIso) {
  const messages = [];
  let pageToken;
  do {
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    url.searchParams.set('pageSize', String(MSG_PAGE));
    url.searchParams.set('filter', `createTime > "${sinceIso}"`);
    // orderBy 방향은 대문자(ASC/DESC). 소문자면 400이 나고 호출자가 삼키면 조용히 0건이 되므로 주의.
    url.searchParams.set('orderBy', 'createTime DESC');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await client.request({ url: url.toString() });
    for (const m of res.data.messages || []) {
      messages.push({ id: m.name || '', text: m.text || '', createTime: m.createTime || '', space });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && messages.length < MAX_MSG_PER_SPACE);
  return messages;
}

// chief 멤버 스페이스 전체에서 sinceIso 이후 생성된 메시지를 수집(학생 무관).
// 동기화 함수가 호출해 Firestore에 적재한다. 실패 시 호출자가 처리하도록 throw.
export async function fetchSpaceMessagesSince(saKeyJson, sinceIso) {
  const client = makeClient(saKeyJson);
  const spaces = await listSpaces(client);
  const all = [];
  for (const space of spaces) {
    const msgs = await listMessagesSince(client, space, sinceIso);
    all.push(...msgs);
    if (all.length >= MAX_TOTAL_MESSAGES) {
      console.warn(`[chatClient] 수집 상한(${MAX_TOTAL_MESSAGES}) 도달 — 일부 스페이스 미스캔. since 범위를 좁히거나 주기를 늘리세요.`);
      return all.slice(0, MAX_TOTAL_MESSAGES);
    }
  }
  return all;
}
