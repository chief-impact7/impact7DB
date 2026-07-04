import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, updateDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx } from './firestore-rules-helpers.js';

// enrollmentStatusConsistent: 비재원 상태(퇴원/종강/상담)는 enrollments가 비어 있어야 한다.
// 일괄 퇴원/상태변경(applyBulkStatus·confirmBulkDelete)이 enrollments를 비우지 않으면
// 이 규칙이 batch 전체를 거부한다 → 클라는 reconcileEnrollments로 비워야 한다(M-05).
const ENROLL = [{ class_number: '101', level_symbol: 'HA' }];
const base = { name: '홍길동', enrollments: ENROLL, status: '재원', parent_phone_1: '010-1111-2222', branch: '본원' };

describe('students enrollment↔status 정합성 규칙 (M-05)', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-student-enroll'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(id, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `students/${id}`), data);
    });
  }

  test('퇴원 전환 + enrollments 잔존 → 거부 (현 일괄퇴원 버그 조건)', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertFails(updateDoc(doc(db, 'students/s1'), { status: '퇴원' }));
  });

  test('퇴원 전환 + enrollments 비움 → 허용 (reconcile 결과)', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertSucceeds(updateDoc(doc(db, 'students/s1'), { status: '퇴원', enrollments: [] }));
  });

  test('재원 유지 + enrollments 잔존 → 허용', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertSucceeds(updateDoc(doc(db, 'students/s1'), { status: '재원', enrollments: ENROLL }));
  });

  test('상담 전환 + enrollments 잔존 → 거부', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertFails(updateDoc(doc(db, 'students/s1'), { status: '상담' }));
  });

  test('생성: 종강 + enrollments 비움 → 허용', async () => {
    const db = authedCtx(env, 't1');
    await assertSucceeds(setDoc(doc(db, 'students/s2'), { name: '김학생', enrollments: [], status: '종강' }));
  });

  test('40개 필드(>36) 정상 문서도 저장 허용 (O-04: 한도 36→48)', async () => {
    const db = authedCtx(env, 't1');
    const big = {
      name: '홍길동', enrollments: ENROLL, status: '재원', parent_phone_1: '010-1111-2222', branch: '본원',
      level: '중등', grade: 1, school_middle: '봉영여중', school_level_grade: '봉영여중1',
      student_phone: '010-2', parent_phone_2: '010-3', other_phone: '010-4',
      guardian_name_1: '모', guardian_name_2: '부', status2: '',
      pause_start_date: '', pause_end_date: '', scheduled_leave_status: '', pre_withdrawal_status: '',
      day: [], class_type: '정규', level_code: 'HA', level_symbol: 'HA', class_number: '101',
      start_date: '2026-01-01', special_start_date: '', special_end_date: '', first_registered: '2026-01-01',
      has_memo: false, memo: '', return_consult_done: false, return_consult_note: '',
      return_consult_done_by: '', return_consult_done_at: '', updated_at: '', updated_by: '',
      nameNormalized: 'hgd', studentNumber: 1, studentNumberSource: 'manual', studentNumberIssuedAt: '',
    };
    await assertSucceeds(setDoc(doc(db, 'students/big1'), big)); // 40 fields — 과거 withinFieldLimit(36)이면 거부됐음
  });

  // message_consent는 서버(promoConsent/optOut080Sync)가 admin SDK로 기록하는 필드.
  // allowed 목록에 없으면 보유 학생의 모든 클라 편집이 hasOnly 위반으로 조용히 거부된다
  // (2026-07-04 발견, school_* 사고와 동일 클래스).
  test('message_consent 보유 학생도 클라 편집 허용', async () => {
    await seed('s1', { ...base, message_consent: { promo: { agreed: true, at: '2026-07-04' } } });
    const db = authedCtx(env, 't1');
    await assertSucceeds(updateDoc(doc(db, 'students/s1'), { memo: '상담 예정', has_memo: true }));
  });

  test('50개 전 필드 문서(message_consent 포함) 저장 허용 (한도 49→50)', async () => {
    const db = authedCtx(env, 't1');
    const full = {
      name: '홍길동', level: '중등', grade: 1,
      school_elementary: '', school_middle: '봉영여중', school_high: '', school_level_grade: '봉영여중1',
      student_phone: '010-2', parent_phone_1: '010-1111-2222', parent_phone_2: '010-3', other_phone: '010-4',
      guardian_name_1: '모', guardian_name_2: '부',
      branch: '본원', status: '재원', status2: '', enrollments: ENROLL,
      enrollments_cleared_at: '', enrollments_cleared_by: '',
      pause_start_date: '', pause_end_date: '',
      scheduled_leave_status: '', pre_withdrawal_status: '',
      day: [], class_type: '정규', level_code: 'HA', level_symbol: 'HA', class_number: '101',
      start_date: '2026-01-01', special_start_date: '', special_end_date: '',
      first_registered: '2026-01-01',
      has_memo: false, memo: '',
      return_consult_done: false, return_consult_note: '',
      return_consult_done_by: '', return_consult_done_at: '',
      updated_at: '', updated_by: '', withdrawal_date: '',
      status_changed_at: '', status_changed_by: '', status_previous: '',
      nameNormalized: 'hgd', studentNumber: 1, studentNumberSource: 'manual', studentNumberIssuedAt: '',
      studentNumberHistory: [],
      message_consent: { promo: { agreed: true } },
    };
    await assertSucceeds(setDoc(doc(db, 'students/full1'), full)); // 정확히 50 fields
  });
});
