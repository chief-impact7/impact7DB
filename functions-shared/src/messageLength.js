import { HttpsError } from 'firebase-functions/v2/https';

export const LMS_MAX_BYTES = 2000;
export const ALIMTALK_MAX_CHARS = 1000;

const SPLIT_BODY_MAX_BYTES = LMS_MAX_BYTES - 8;
const MAX_SPLIT_PARTS = 99;

export function smsByteLength(text) {
  let bytes = 0;
  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0);
    bytes += codePoint > 0xffff ? 4 : codePoint > 0x7f ? 2 : 1;
  }
  return bytes;
}

export function messageCharLength(text) {
  return [...String(text ?? '')].length;
}

function splitBodies(text) {
  const chars = [...String(text ?? '').trim()];
  const bodies = [];
  let start = 0;

  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    let lastBreak = -1;
    while (end < chars.length) {
      const nextBytes = smsByteLength(chars[end]);
      if (bytes + nextBytes > SPLIT_BODY_MAX_BYTES) break;
      bytes += nextBytes;
      end += 1;
      if (/\s/.test(chars[end - 1])) lastBreak = end;
    }
    if (end < chars.length && lastBreak > start) {
      let tokenBytes = 0;
      let tokenEnd = lastBreak;
      while (tokenEnd < chars.length && !/\s/.test(chars[tokenEnd])) {
        tokenBytes += smsByteLength(chars[tokenEnd]);
        tokenEnd += 1;
      }
      if (tokenBytes <= SPLIT_BODY_MAX_BYTES) end = lastBreak;
    }
    bodies.push(chars.slice(start, end).join(''));
    start = end;
  }
  return bodies;
}

export function splitSmsText(text) {
  const source = String(text ?? '').trim();
  if (smsByteLength(source) <= LMS_MAX_BYTES) return [source];

  const bodies = splitBodies(source);
  if (bodies.length > MAX_SPLIT_PARTS) {
    throw new HttpsError(
      'invalid-argument',
      `문자가 너무 길어 최대 ${MAX_SPLIT_PARTS}건으로도 나눌 수 없습니다.`,
      { reason: 'too_many_message_parts', maxParts: MAX_SPLIT_PARTS },
    );
  }
  return bodies.map((body, index) => `[${index + 1}/${bodies.length}] ${body}`);
}

export function smsLengthDetails(text) {
  const bytes = smsByteLength(text);
  return {
    reason: 'message_too_long',
    channel: 'sms',
    actualBytes: bytes,
    maxBytes: LMS_MAX_BYTES,
    canSplit: true,
    splitParts: bytes > LMS_MAX_BYTES ? splitSmsText(text).length : 1,
  };
}

export function alimtalkLengthDetails(renderedText, fallbackText) {
  const actualChars = messageCharLength(renderedText);
  const fallbackBytes = smsByteLength(fallbackText);
  const overLimit = actualChars > ALIMTALK_MAX_CHARS || fallbackBytes > LMS_MAX_BYTES;
  return {
    reason: 'message_too_long',
    channel: 'alimtalk',
    actualChars,
    maxChars: ALIMTALK_MAX_CHARS,
    fallbackBytes,
    maxFallbackBytes: LMS_MAX_BYTES,
    canSplit: true,
    splitParts: overLimit ? splitSmsText(fallbackText).length : 1,
    overLimit,
  };
}

export function assertSmsTextFits(text, { canSplit = true } = {}) {
  const details = smsLengthDetails(text);
  if (details.actualBytes <= details.maxBytes) return details;
  throw new HttpsError(
    'invalid-argument',
    `Solapi 발송 제한으로 보낼 수 없습니다. 문자는 ${details.maxBytes}byte까지 가능하며 현재 ${details.actualBytes}byte입니다. 내용을 줄이거나 일반폰으로 보내세요.`,
    { ...details, canSplit },
  );
}

export function assertAlimtalkPayloadFits(renderedText, fallbackText) {
  const details = alimtalkLengthDetails(renderedText, fallbackText);
  if (!details.overLimit) return details;
  throw new HttpsError(
    'invalid-argument',
    `Solapi 발송 제한으로 보낼 수 없습니다. 알림톡은 치환 후 ${details.maxChars}자, 대체문자는 ${details.maxFallbackBytes}byte까지 가능하며 현재 ${details.actualChars}자 / ${details.fallbackBytes}byte입니다. 내용을 줄이거나 일반폰으로 보내세요.`,
    details,
  );
}
