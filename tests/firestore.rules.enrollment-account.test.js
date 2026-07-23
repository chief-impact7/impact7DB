import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, updateDoc, deleteField } from 'firebase/firestore';
import { createTestEnv, authedCtx } from './firestore-rules-helpers.js';

describe('수강계정 규칙', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-enrollment-account'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  test('class_settings는 account_type·branch와 22개 필드를 허용하고 잘못된 값은 거부한다', async () => {
    const db = authedCtx(env, 't1');
    const full = {
      domains: [], test_sections: [], teacher: '', sub_teacher: '',
      default_time: '', default_time_updated_by: '', default_time_updated_at: '',
      naesin_start: '', naesin_end: '', schedule: {},
      free_schedule: {}, free_start: '', free_end: '',
      special_start: '', special_end: '', class_type: '', fee_type: '',
      updated_at: '', updated_by: '', default_days: [],
      account_type: '정규', branch: '본원',
    };

    await assertSucceeds(setDoc(doc(db, 'class_settings/HA101'), full));
    await assertFails(setDoc(doc(db, 'class_settings/HA102'), { account_type: '오류', branch: '본원' }));
    await assertFails(setDoc(doc(db, 'class_settings/HA103'), { account_type: '특강', branch: 1 }));
  });

  test('leave_requests create는 account_target 스키마를 검증한다', async () => {
    const db = authedCtx(env, 't1');
    const base = { student_id: 's1', status: 'requested' };

    await assertSucceeds(setDoc(doc(db, 'leave_requests/l1'), {
      ...base,
      account_target: {
        account_id: 'account-1',
        account_type: '기타',
        class_code: 'HA101',
        class_types: ['정규'],
        branch: '본원',
        label: '본원 정규',
      },
    }));
    await assertFails(setDoc(doc(db, 'leave_requests/l2'), {
      ...base,
      account_target: { account_type: '정규' },
    }));
    await assertFails(setDoc(doc(db, 'leave_requests/l3'), {
      ...base,
      account_target: { account_id: 'account-1', account_type: '오류' },
    }));
    await assertFails(setDoc(doc(db, 'leave_requests/l4'), {
      ...base,
      account_target: { account_id: 'account-1', finalized: true },
    }));
    for (const [field, value] of Object.entries({
      class_code: 1,
      class_types: '정규',
      branch: 1,
      label: [],
    })) {
      await assertFails(setDoc(doc(db, `leave_requests/invalid-${field}`), {
        ...base,
        account_target: { account_id: 'account-1', [field]: value },
      }));
    }
  });

  test('leave_requests create는 서버 finalize 필드 위조를 거부한다', async () => {
    const db = authedCtx(env, 't1');
    const base = { student_id: 's1', status: 'requested' };

    for (const [field, value] of Object.entries({
      finalized_at: '2026-07-23T00:00:00Z',
      finalize_error: 'forged',
      finalize_attempts: 99,
    })) {
      await assertFails(setDoc(doc(db, `leave_requests/forged-${field}`), {
        ...base,
        [field]: value,
      }));
    }
  });

  test('leave_requests update는 account_target 전체를 불변으로 유지한다', async () => {
    const db = authedCtx(env, 't1');
    const target = { account_id: 'account-1', account_type: '정규' };
    await seed('leave_requests/with-target', { student_id: 's1', status: 'requested', account_target: target });
    await seed('leave_requests/without-target', { student_id: 's2', status: 'requested' });

    await assertSucceeds(updateDoc(doc(db, 'leave_requests/with-target'), { status: 'approved' }));
    await assertSucceeds(updateDoc(doc(db, 'leave_requests/without-target'), { status: 'approved' }));
    await assertFails(updateDoc(doc(db, 'leave_requests/with-target'), {
      account_target: { ...target, account_type: '특강' },
    }));
    await assertFails(updateDoc(doc(db, 'leave_requests/with-target'), {
      account_target: deleteField(),
    }));
  });

  test('history_logs는 수강계정 변경 유형 3개를 허용한다', async () => {
    const db = authedCtx(env, 't1');
    const base = {
      doc_id: 's1',
      before: '{}',
      after: '{}',
      google_login_id: 'teacher@impact7.kr',
      timestamp: '2026-07-23T00:00:00Z',
    };

    for (const changeType of ['ACCOUNT_PAUSE', 'ACCOUNT_RESUME', 'ACCOUNT_END']) {
      await assertSucceeds(setDoc(doc(db, `history_logs/${changeType}`), {
        ...base,
        change_type: changeType,
      }));
    }
  });
});
