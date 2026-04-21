import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { finalize } from './src/finalize.js';

initializeApp();
getFirestore();

// 모든 함수 기본 옵션
setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// leave_requests/{docId} 승인 전이 트리거
export const onLeaveRequestApproved = onDocumentUpdated(
  { document: 'leave_requests/{docId}', retry: true },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;

    // 마이그레이션 플래그 (Phase 6에서 제거)
    if (!after.use_server_finalize) return null;
    // 승인 전이만 처리
    if (before.status === 'approved' || after.status !== 'approved') return null;
    // 중복 발동 방어
    if (after.finalized_at) return null;

    try {
      await finalize(event.data.after.ref, after);
    } catch (err) {
      console.error('[onLeaveRequestApproved] finalize failed:', err);
      // 에러를 leave_request에 기록 (재시도용 상태)
      try {
        await event.data.after.ref.update({
          finalize_error: String(err?.message || err),
          finalize_attempts: FieldValue.increment(1),
        });
      } catch (writeErr) {
        console.error('[onLeaveRequestApproved] failed to write finalize_error:', writeErr);
      }
      throw err; // Functions 런타임이 자동 재시도 (retry: true 설정 시)
    }
  }
);
