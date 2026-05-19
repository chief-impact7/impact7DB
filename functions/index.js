import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { finalize } from './src/finalize.js';
import { runClassCleanup } from './src/cleanup.js';
import { syncNaesinPeriod } from './src/syncNaesinPeriod.js';

initializeApp();
getFirestore();

// 모든 함수 기본 옵션
setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// 매일 03:00 KST에 종료된 + 0명인 class_settings 자동 정리
// 특강: special_end + 7일, 내신: naesin_end + 30일 grace period
export const onScheduleClassCleanup = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'Asia/Seoul',
    retryCount: 0,
  },
  async () => {
    const db = getFirestore();
    try {
      const result = await runClassCleanup(db);
      console.log('[onScheduleClassCleanup] 완료:', JSON.stringify(result));
    } catch (err) {
      console.error('[onScheduleClassCleanup] 실패:', err);
      throw err;
    }
  }
);

// leave_requests/{docId} 승인 전이 트리거
export const onLeaveRequestApproved = onDocumentUpdated(
  { document: 'leave_requests/{docId}', retry: true },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;

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

// class_settings(내신반)의 naesin_start/end 변경 시 매핑된 학생들의 명시적 내신 enrollment.end_date 자동 동기화.
// 5/19 사고(cs.naesin_end만 수정되고 학생 enrollment.end_date가 drift) 재발 방지.
export const onClassSettingsNaesinPeriodChanged = onDocumentUpdated(
  { document: 'class_settings/{code}', retry: false },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return null;
    if (after.class_type !== '내신') return null;
    if (before.naesin_start === after.naesin_start && before.naesin_end === after.naesin_end) return null;

    const csKey = event.params.code;
    const db = getFirestore();
    try {
      const result = await syncNaesinPeriod(db, csKey, before, after);
      console.log('[onClassSettingsNaesinPeriodChanged]', csKey, JSON.stringify(result));
    } catch (err) {
      console.error('[onClassSettingsNaesinPeriodChanged] failed:', csKey, err);
      // retry: false라 단순 로그만 (재실행은 수동 oneoff 스크립트로)
    }
    return null;
  }
);
