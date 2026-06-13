import { JWT } from 'google-auth-library';

// Google Chat 메시지 수집 (DWD: 서비스 계정이 chief@impact7.kr를 가장).
// chief가 멤버인 모든 스페이스를 순회해 최근 메시지 중 학생 이름이 언급된 것을 수집.
// 키워드 검색 API가 없어 스페이스 메시지를 나열 후 텍스트 매칭하는 구조 — 비용을 고려해 최근 기간만 스캔.

const IMPERSONATE = 'chief@impact7.kr';
const SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
];
const SPACE_PAGE = 100;
const MSG_PAGE = 100;
const MAX_MSG_PER_SPACE = 300;   // 스페이스당 스캔 상한 (폭주 방지)
const MAX_MENTIONS = 20;         // 학생당 수집 상한

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

async function listRecentMessages(client, space, sinceIso) {
  const messages = [];
  let pageToken;
  do {
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    url.searchParams.set('pageSize', String(MSG_PAGE));
    url.searchParams.set('filter', `createTime > "${sinceIso}"`);
    // orderBy 방향은 대문자(ASC/DESC). 소문자면 400 → graceful이 삼켜 조용히 0건이 되므로 주의.
    url.searchParams.set('orderBy', 'createTime DESC');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await client.request({ url: url.toString() });
    for (const m of res.data.messages || []) {
      messages.push({ text: m.text || '', createTime: m.createTime || '', space });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken && messages.length < MAX_MSG_PER_SPACE);
  return messages;
}

function sinceIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// 학생 이름이 언급된 최근 Chat 메시지를 수집. 실패 시 호출자가 graceful 처리하도록 throw.
// name이 너무 짧으면(2자 미만) 오탐 위험이 커 빈 배열 반환.
export async function collectStudentChatMentions(saKeyJson, studentName, days = 45) {
  const name = String(studentName || '').trim();
  if (name.length < 2) return [];

  const client = makeClient(saKeyJson);
  const since = sinceIso(days);
  const spaces = await listSpaces(client);

  const mentions = [];
  for (const space of spaces) {
    const msgs = await listRecentMessages(client, space, since);
    for (const m of msgs) {
      if (m.text.includes(name)) {
        mentions.push({ date: m.createTime.slice(0, 10), text: m.text.slice(0, 200) });
        if (mentions.length >= MAX_MENTIONS) return mentions;
      }
    }
  }
  return mentions;
}
