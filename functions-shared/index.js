import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { handleLlmGenerate } from './src/llmHandler.js';
import { handleGenerateStudentConsultationAi } from './src/consultationAiHandler.js';
import { computeLabelUpdate } from './src/studentLabelSync.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// App Check은 후속 과제: 현재 유일 호출자인 DSC가 App Check 미설정이라 false로 시작.
// 호출자 보호는 handleLlmGenerate의 request.auth(로그인 직원만)로 유지.
export const llmGenerate = onCall({ enforceAppCheck: false }, handleLlmGenerate);
export const generateStudentConsultationAi = onCall({ enforceAppCheck: false }, handleGenerateStudentConsultationAi);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);

// === 카카오/결제/출결 (골격 — 본문은 2026 하반기) ===

// 카카오 알림톡/친구톡 발송 (Callable). 실 API 연동은 나중.
export const sendKakao = onCall({ enforceAppCheck: false }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  throw new HttpsError('unimplemented', 'sendKakao: not implemented (카카오 API 확정 후)');
});

// PG 결제 웹훅 (HTTP). 서명검증·멱등은 src 유틸로 위임 예정.
export const paymentHook = onRequest({ invoker: 'public' }, (req, res) => {
  console.warn('[paymentHook] not implemented — received webhook, ignoring');
  res.status(503).json({ error: 'not implemented' });
});

// 출결 변경 → 카톡 알림 트리거. 컬렉션 경로는 DSC 출결 스키마 확정 후 조정.
export const onAttendance = onDocumentWritten(
  { document: 'attendance/{docId}' },
  async (event) => {
    console.log('[onAttendance] not implemented — change observed', event.params.docId);
    return null;
  }
);

// 어떤 경로로 쓰이든 school/level/grade → school_level_grade 자동 동기화(stale 차단).
export const onStudentLabelSync = onDocumentWritten(
  { document: 'students/{docId}' },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return null; // 삭제는 무시
    const update = computeLabelUpdate(after.data());
    if (!update) return null; // 라벨 동일 → write 스킵(무한루프 방지)
    await after.ref.update(update);
    return null;
  }
);
