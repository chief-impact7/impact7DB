import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2';
import { finalize } from './src/finalize.js';
import { runClassCleanup } from './src/cleanup.js';
import { syncNaesinPeriod } from './src/syncNaesinPeriod.js';
import { runScheduledWithdrawals } from './src/scheduledWithdrawals.js';
import { generateDailyStats } from './src/dailyStats.js';

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

export const onScheduleWithdrawals = onSchedule(
  {
    schedule: '10 3 * * *',
    timeZone: 'Asia/Seoul',
    retryCount: 0,
  },
  async () => {
    const db = getFirestore();
    try {
      const result = await runScheduledWithdrawals(db);
      console.log('[onScheduleWithdrawals] 완료:', JSON.stringify(result));
    } catch (err) {
      console.error('[onScheduleWithdrawals] 실패:', err);
      throw err;
    }
  }
);

// 매일 03:20 KST 인원현황 스냅샷 생성 — 예약 퇴원 처리(03:10) 이후 상태 기준.
// 클라이언트 생성은 인원현황 권한자 로그인 시에만 동작하므로 서버에서 결손 없이 보장.
export const onScheduleDailyStats = onSchedule(
  {
    schedule: '20 3 * * *',
    timeZone: 'Asia/Seoul',
    retryCount: 2,
  },
  async () => {
    const db = getFirestore();
    try {
      const result = await generateDailyStats(db);
      console.log('[onScheduleDailyStats] 완료:', JSON.stringify(result));
    } catch (err) {
      console.error('[onScheduleDailyStats] 실패:', err);
      throw err;
    }
  }
);

// 퇴원 불변식: status가 '퇴원'인데 정규반(enrollments)이 남아 있으면 자동으로 비운다.
// import 재유입·편집 누락 등 어떤 경로로 stale 정규반이 생겨도 잡는 마지막 안전망 (재발 방지).
// 상담은 제외(실제 재원일 수 있어 자동삭제 위험) — 상담은 import/편집 폼(A/B)에서 처리.
export const onStudentWithdrawnClearEnrollments = onDocumentWritten(
  { document: 'students/{studentId}', retry: false },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return null;                            // 삭제됨
    if (after.status !== '퇴원') return null;            // 퇴원만
    const enr = after.enrollments;
    if (!Array.isArray(enr) || enr.length === 0) return null;  // 이미 0 → 무한루프 방지

    const db = getFirestore();
    await event.data.after.ref.update({
      enrollments: [],
      enrollments_cleared_at: FieldValue.serverTimestamp(),
      enrollments_cleared_by: 'fn-withdrawn-invariant',
    });
    await db.collection('history_logs').add({
      doc_id: event.params.studentId,
      change_type: 'UPDATE',
      before: JSON.stringify({ status: '퇴원', enrollments: enr }),
      after: '정규반 자동정리 (퇴원 불변식: 퇴원생 정규반 0)',
      reason: 'fn-withdrawn-invariant',
      google_login_id: 'fn-withdrawn-invariant',
      timestamp: FieldValue.serverTimestamp(),
    });
    console.log(`[withdrawn-invariant] ${event.params.studentId} 정규반 ${enr.length}건 자동정리`);
    return null;
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

// F-11: 학생 중심 성적 요약(student_scores) 동기화 — results·external_score_events 쓰기 trigger.
export { onExternalScoreWritten, onResultScoreWritten } from './src/syncStudentScores.js';
