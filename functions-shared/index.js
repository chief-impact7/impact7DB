import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// codebase 슬롯 예약용 no-op 헬스체크.
// 실함수(sendKakao, payment 웹훅 등) 추가 후 이 함수는 제거 가능.
export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);

// 향후 추가 예정:
//   sendKakao    — 카카오 알림톡/친구톡 발송 (Callable)
//   paymentHook  — PG 웹훅 수신·검증·멱등 처리 (HTTP)
//   onAttendance — 출결 Firestore 트리거 → 카톡 알림 (onDocumentWritten)
