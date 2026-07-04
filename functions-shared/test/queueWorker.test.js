import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const { processQueueDoc, runRetrySweep, runDeliveryResultSweep, purgeExpiredPii, __testing } = await import('../src/queueWorker.js');

// message_queue/message_logs/kakao_channel_friends를 흉내내는 인메모리 Firestore.
function makeDb(initialQueue = {}, initialFriends = {}) {
  const queue = new Map(Object.entries(initialQueue));
  const logs = [];
  const friends = new Map(Object.entries(initialFriends));

  function docRef(collMap, id) {
    return {
      id,
      async update(patch) {
        collMap.set(id, { ...(collMap.get(id) ?? {}), ...patch });
      },
      async set(data, opts) {
        if (opts?.merge) {
          collMap.set(id, { ...(collMap.get(id) ?? {}), ...data });
        } else {
          collMap.set(id, data);
        }
      },
      async delete() {
        collMap.delete(id);
      },
    };
  }

  function query(collMap) {
    const filters = [];
    let limitN = null;
    let orderField = null;
    let orderDir = 'asc';
    const q = {
      where(field, op, val) {
        filters.push([field, op, val]);
        return q;
      },
      orderBy(field, dir = 'asc') {
        orderField = field;
        orderDir = dir;
        return q;
      },
      limit(n) {
        limitN = n;
        return q;
      },
      async get() {
        let docs = [];
        for (const [id, data] of collMap) {
          const ok = filters.every(([f, op, v]) => {
            if (op === '==') return data[f] === v;
            if (op === 'in') return Array.isArray(v) && v.includes(data[f]);
            if (op === '<=') return data[f] != null && data[f] <= v;
            return true;
          });
          if (ok) docs.push({ id, data: () => data, ref: docRef(collMap, id) });
        }
        if (orderField) {
          docs.sort((a, b) => {
            const av = a.data()[orderField];
            const bv = b.data()[orderField];
            const c = av < bv ? -1 : av > bv ? 1 : 0;
            return orderDir === 'desc' ? -c : c;
          });
        }
        if (limitN != null) docs = docs.slice(0, limitN);
        return { docs };
      },
    };
    return q;
  }

  return {
    collection(name) {
      if (name === 'message_logs') {
        return { add: async (entry) => { logs.push(entry); return { id: `log${logs.length}` }; } };
      }
      if (name === 'kakao_channel_friends') {
        return {
          doc: (id) => docRef(friends, id),
          where: (...a) => query(friends).where(...a),
        };
      }
      return {
        doc: (id) => docRef(queue, id),
        where: (...a) => query(queue).where(...a),
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); },
        update(ref, patch) { ops.push(() => ref.update(patch)); },
        async commit() { for (const op of ops) await op(); },
      };
    },
    runTransaction(fn) {
      const tx = {
        async get(ref) {
          const data = queue.get(ref.id);
          return { exists: data !== undefined, data: () => data, ref };
        },
        update(ref, patch) {
          queue.set(ref.id, { ...(queue.get(ref.id) ?? {}), ...patch });
        },
        set(ref, data) {
          queue.set(ref.id, data);
        },
      };
      return Promise.resolve(fn(tx));
    },
    _queue: queue,
    _logs: logs,
    _friends: friends,
  };
}

const baseQueueDoc = (overrides = {}) => ({
  kind: 'attendance',
  checkin_id: 'c1',
  student_id: 's1',
  recipient_phone: '01012345678',
  template_code: 'TPL_ATT',
  template_variables: { '#{학생명}': '김학생' },
  fallback_text: '출결 안내',
  status: 'pending',
  attempt_count: 0,
  ...overrides,
});

const eventFor = (db, id) => ({ data: { ref: db.collection('message_queue').doc(id) }, params: { id } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processQueueDoc', () => {
  it('성공(알림톡) → status sent + message_logs(sent, channel kakao)', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({
      ok: true, channel: 'kakao', messageId: 'm1', groupId: 'g1', statusCode: '2000',
    });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });

    expect(sender).toHaveBeenCalledTimes(1);
    expect(db._queue.get('q1')).toMatchObject({ status: 'sent', attempt_count: 1, next_attempt_at: null });
    expect(db._logs).toHaveLength(1);
    expect(db._logs[0]).toMatchObject({
      status: 'sent', channel: 'kakao', solapi_message_id: 'm1', queue_id: 'q1', provider: 'solapi',
    });
    expect(db._logs[0].request_summary.recipient_masked).toBe('***-****-5678');
    expect(db._logs[0].request_summary).not.toHaveProperty('recipient_phone');
  });

  it('대체발송 채널(sms)도 sent로 기록 — 워커는 SMS를 따로 보내지 않음', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'sms', messageId: 'm2', statusCode: '2000' });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(db._queue.get('q1').status).toBe('sent');
    expect(db._logs[0].channel).toBe('sms');
  });

  it('중복 트리거(이미 sent) → 클레임 실패, sender 미호출, 로그 없음', async () => {
    const db = makeDb({ q1: baseQueueDoc({ status: 'sent' }) });
    const sender = vi.fn();
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(sender).not.toHaveBeenCalled();
    expect(db._logs).toHaveLength(0);
  });

  it('transient 실패(sender throw) → failed_retryable, attempt 1, next_attempt_at 설정, 로그 없음', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    const doc = db._queue.get('q1');
    expect(doc.status).toBe('failed_retryable');
    expect(doc.attempt_count).toBe(1);
    expect(doc.next_attempt_at).toBeInstanceOf(Date);
    expect(db._logs).toHaveLength(0);
  });

  it('provider retryable:true(429 rate limit) → 재시도, last_error_code 기록', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: true, statusCode: '429', errorMessage: 'rate limit' });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(db._queue.get('q1').status).toBe('failed_retryable');
    expect(db._queue.get('q1').last_error_code).toBe('429');
  });

  it('provider retryable:false(잘못된 번호/템플릿 거부) → 즉시 failed_permanent + 로그(failed)', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: false, statusCode: 'invalid_recipient', errorMessage: '잘못된 번호' });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    const doc = db._queue.get('q1');
    expect(doc.status).toBe('failed_permanent');
    expect(doc.next_attempt_at).toBeNull();
    expect(db._logs).toHaveLength(1);
    expect(db._logs[0]).toMatchObject({ status: 'failed', status_code: 'invalid_recipient', error_message: '잘못된 번호' });
  });

  it('kind 화이트리스트: 미허용 kind는 발송 없이 failed_permanent(kind_not_allowed)', async () => {
    const db = makeDb({ q1: baseQueueDoc({ kind: 'unknown_kind' }) });
    const sender = vi.fn();
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(sender).not.toHaveBeenCalled();
    const doc = db._queue.get('q1');
    expect(doc.status).toBe('failed_permanent');
    expect(doc.last_error_code).toBe('kind_not_allowed');
    expect(db._logs[0]).toMatchObject({ status: 'failed', status_code: 'kind_not_allowed' });
  });

  it('report kind → 정보형 BMS payload(targeting I, adFlag false, disableSms) + 접수 후 발송결과 대기', async () => {
    const db = makeDb({ q1: baseQueueDoc({ kind: 'report', content: '[6/16] 수업 결과...', targeting: 'I', ad_flag: false }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm1', groupId: 'grp1', statusCode: '2000' });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'report', to: '01012345678', content: '[6/16] 수업 결과...', targeting: 'I', adFlag: false, disableSms: true,
    }));
    // 접수 2000 ≠ 카톡 도달 — parent_bms처럼 폴링으로 도달/비친구를 확정한다(친구명단 오차 self-correct).
    const d = db._queue.get('q1');
    expect(d.status).toBe('awaiting_delivery_result');
    expect(d.solapi_group_id).toBe('grp1');
  });

  it('성공 시 종결 doc에 purge_after(보존기간) 설정', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    const doc = db._queue.get('q1');
    expect(doc.purge_after).toBeInstanceOf(Date);
    expect(doc.purge_after.getTime()).toBeGreaterThan(Date.now());
  });

  it('재시도 상한 도달(attempt 2 + transient) → failed_permanent로 종결 + 로그', async () => {
    const db = makeDb({ q1: baseQueueDoc({ status: 'pending', attempt_count: 2 }) });
    const sender = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    const doc = db._queue.get('q1');
    expect(doc.status).toBe('failed_permanent');
    expect(doc.attempt_count).toBe(3);
    expect(db._logs).toHaveLength(1);
    expect(db._logs[0].status).toBe('failed');
  });

  it('백오프 간격: attempt 1→1분, attempt 2→5분', async () => {
    const t0 = Date.now();
    const db1 = makeDb({ q1: baseQueueDoc({ attempt_count: 0 }) });
    await processQueueDoc(eventFor(db1, 'q1'), { db: db1, sender: vi.fn().mockRejectedValue(new Error('x')) });
    const delta1 = db1._queue.get('q1').next_attempt_at.getTime() - t0;
    expect(delta1).toBeGreaterThanOrEqual(60_000 - 1000);
    expect(delta1).toBeLessThan(5 * 60_000);

    const db2 = makeDb({ q1: baseQueueDoc({ attempt_count: 1 }) });
    await processQueueDoc(eventFor(db2, 'q1'), { db: db2, sender: vi.fn().mockRejectedValue(new Error('x')) });
    const delta2 = db2._queue.get('q1').next_attempt_at.getTime() - t0;
    expect(delta2).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
  });
});

describe('runRetrySweep', () => {
  it('재시도 시각 도래분만 재투입하고 미도래/상한초과는 건너뛴다', async () => {
    const now = new Date('2026-06-12T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);
    const db = makeDb({
      due: baseQueueDoc({ status: 'failed_retryable', attempt_count: 1, next_attempt_at: past }),
      notDue: baseQueueDoc({ status: 'failed_retryable', attempt_count: 1, next_attempt_at: future }),
      maxed: baseQueueDoc({ status: 'failed_retryable', attempt_count: 3, next_attempt_at: past }),
      done: baseQueueDoc({ status: 'sent', next_attempt_at: null }),
    });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' });

    const res = await runRetrySweep({ db, sender, now });

    expect(res.processed).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(db._queue.get('due').status).toBe('sent');
    expect(db._queue.get('notDue').status).toBe('failed_retryable');
    expect(db._queue.get('maxed').status).toBe('failed_retryable');
  });

  it('도래분 재투입 후 다시 실패하면 attempt가 증가한다', async () => {
    const now = new Date('2026-06-12T10:00:00Z');
    const past = new Date(now.getTime() - 1000);
    const db = makeDb({
      due: baseQueueDoc({ status: 'failed_retryable', attempt_count: 1, next_attempt_at: past }),
    });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: true, statusCode: '500', errorMessage: 'x' });
    await runRetrySweep({ db, sender, now });
    expect(db._queue.get('due')).toMatchObject({ status: 'failed_retryable', attempt_count: 2 });
  });

  it('크래시 고착: 리스 만료된 processing doc을 회수해 재발송한다(이중 카운트 없음)', async () => {
    const now = new Date('2026-06-12T10:00:00Z');
    const expiredLease = new Date(now.getTime() - 1000); // 리스 만료
    const db = makeDb({
      stuck: baseQueueDoc({ status: 'processing', attempt_count: 0, next_attempt_at: expiredLease }),
    });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' });

    const res = await runRetrySweep({ db, sender, now });

    expect(res.processed).toBe(1);
    expect(sender).toHaveBeenCalledTimes(1);
    const doc = db._queue.get('stuck');
    expect(doc.status).toBe('sent');
    expect(doc.attempt_count).toBe(1); // 클레임이 attempt를 올리지 않아 이중 카운트되지 않음
  });

  it('리스 미만료 processing doc은 건드리지 않는다', async () => {
    const now = new Date('2026-06-12T10:00:00Z');
    const future = new Date(now.getTime() + 60_000);
    const db = makeDb({
      live: baseQueueDoc({ status: 'processing', attempt_count: 0, next_attempt_at: future }),
    });
    const sender = vi.fn();
    const res = await runRetrySweep({ db, sender, now });
    expect(res.processed).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    expect(db._queue.get('live').status).toBe('processing');
  });

  it('클레임이 processing 전이 시 next_attempt_at에 리스를 설정한다', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    // sender가 멈춰 dispatch가 markSent/markRetry로 덮어쓰기 전 리스 상태를 관찰한다.
    let leaseAtClaim = 'unset';
    const sender = vi.fn().mockImplementation(async () => {
      leaseAtClaim = db._queue.get('q1').next_attempt_at;
      return { ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' };
    });
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(leaseAtClaim).toBeInstanceOf(Date);
    expect(leaseAtClaim.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('purgeExpiredPii', () => {
  it('보존기간 경과 종결 doc만 평문 PII 삭제 + 마스킹 참조 보존', async () => {
    const now = new Date('2026-06-20T00:00:00Z');
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 1000);
    const db = makeDb({
      expired: baseQueueDoc({ status: 'sent', purge_after: past }),
      fresh: baseQueueDoc({ status: 'sent', purge_after: future }),
      active: baseQueueDoc({ status: 'pending' }), // purge_after 없음
    });

    const res = await purgeExpiredPii({ db, now });

    expect(res.purged).toBe(1);
    const purged = db._queue.get('expired');
    // 평문 필드는 삭제 sentinel로 치환
    expect(purged.recipient_phone).toBe('<delete>');
    expect(purged.fallback_text).toBe('<delete>');
    expect(purged.template_variables).toBe('<delete>');
    expect(purged.purge_after).toBe('<delete>'); // 재선정 방지
    // 마스킹 참조·감사 필드는 남김
    expect(purged.recipient_masked).toBe('***-****-5678');
    expect(purged.pii_purged_at).toBe('<ts>');
    expect(purged.status).toBe('sent'); // 큐 doc 자체는 보존

    // 미도래/활성 doc은 무손상
    expect(db._queue.get('fresh').recipient_phone).toBe('01012345678');
    expect(db._queue.get('active').recipient_phone).toBe('01012345678');
  });

  it('1회 purge는 상한(500건)까지만 처리한다', async () => {
    const now = new Date('2026-06-20T00:00:00Z');
    const past = new Date(now.getTime() - 1000);
    const initial = {};
    for (let i = 0; i < 600; i++) {
      initial[`exp${i}`] = baseQueueDoc({ status: 'sent', purge_after: past });
    }
    const db = makeDb(initial);

    const res = await purgeExpiredPii({ db, now });

    expect(res.purged).toBe(500); // limit(500) 적용
    // 처리된 doc은 평문 삭제됨, 미처리분은 남아있음
    expect(db._queue.get('exp0').recipient_phone).toBe('<delete>');
    expect(db._queue.get('exp599').recipient_phone).toBe('01012345678');
  });
});

describe('kind=parent_bms 접수 → 발송결과 대기', () => {
  it('sendKakaoBrandMessage로 라우팅 + 접수 성공 시 발송결과 대기(awaiting_delivery_result)', async () => {
    const db = makeDb({ pb1: baseQueueDoc({ kind: 'parent_bms', content: '[진단평가] 6/25(수) 오후 2시 실시 예정입니다.', targeting: 'I', ad_flag: false }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm1', groupId: 'g1', statusCode: '2000' });
    await processQueueDoc(eventFor(db, 'pb1'), { db, sender });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'parent_bms' }));
    // 접수 성공은 카톡 도달이 아님 — 폴링이 확정할 때까지 대기한다.
    const d = db._queue.get('pb1');
    expect(d.status).toBe('awaiting_delivery_result');
    expect(d.solapi_group_id).toBe('g1');
    expect(d.delivery_check_at).toBeInstanceOf(Date);
  });

  it('payload: targeting I, adFlag false, disableSms true', async () => {
    const db = makeDb({ pb2: baseQueueDoc({ kind: 'parent_bms', content: '안내', ad_flag: false, targeting: 'I' }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm2', groupId: 'g2', statusCode: '2000' });
    await processQueueDoc(eventFor(db, 'pb2'), { db, sender });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'parent_bms', to: '01012345678', content: '안내', targeting: 'I', adFlag: false, disableSms: true,
    }));
  });

  it('접수 성공 시 콜백 보류(폴링이 도달/전환 확정 후 1회 콜백)', async () => {
    const resultCallback = { url: 'https://example.com/callback', applicationId: 'app_bms' };
    const db = makeDb({ pb3: baseQueueDoc({ kind: 'parent_bms', content: '안내', result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm3', groupId: 'g3', statusCode: '2000' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);
    await processQueueDoc(eventFor(db, 'pb3'), { db, sender, notifyResultCallback });
    expect(notifyResultCallback).not.toHaveBeenCalled();
    expect(db._queue.get('pb3').status).toBe('awaiting_delivery_result');
  });

  it('접수 단계 영구실패 시 status:failed로 콜백 호출', async () => {
    const resultCallback = { url: 'https://example.com/callback', applicationId: 'app_bms' };
    const db = makeDb({ pb4: baseQueueDoc({ kind: 'parent_bms', content: '안내', result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: false, statusCode: 'invalid', errorMessage: '에러', channel: null });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);
    await processQueueDoc(eventFor(db, 'pb4'), { db, sender, notifyResultCallback });
    expect(notifyResultCallback).toHaveBeenCalledWith(resultCallback.url, expect.objectContaining({
      applicationId: 'app_bms', status: 'failed', queueId: 'pb4',
    }));
    expect(db._queue.get('pb4').status).toBe('failed_permanent');
  });

  it('야간(21시 KST) 접수 시 scheduled_date를 다음 08:00로 보정해 예약 발송', async () => {
    const db = makeDb({ pb5: baseQueueDoc({ kind: 'parent_bms', content: '안내', targeting: 'I', ad_flag: false }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm5', groupId: 'g5', statusCode: '2000' });
    const night = new Date('2026-06-25T12:00:00Z'); // 21:00 KST
    await processQueueDoc(eventFor(db, 'pb5'), { db, sender, now: night });
    expect(sender.mock.calls[0][0].scheduledDate).toBe('2026-06-26 08:00:00');
    const d = db._queue.get('pb5');
    expect(d.scheduled_date).toBe('2026-06-26 08:00:00');
    // 폴링 시작은 예약 발송(08:00 KST = 23:00Z) 이후여야 — 조기 타임아웃 오전환 방지(리뷰 HIGH).
    expect(d.delivery_check_at.getTime()).toBeGreaterThanOrEqual(new Date('2026-06-25T23:00:00Z').getTime());
  });
});

describe('parent_bms 접수 단계 실패(동기) — 친구명단·문자전환 없음', () => {
  const bmsDoc = (overrides = {}) => baseQueueDoc({
    kind: 'parent_bms',
    content: '[진단평가] 6/25(수) 오후 2시',
    recipient_phone: '01099887766',
    result_callback: { url: 'https://example.com/cb', applicationId: 'app_bms' },
    ...overrides,
  });

  it('접수 retryable 코드 → 기존 retry 경로(발송결과 대기 아님)', async () => {
    const db = makeDb({ pb_retry: bmsDoc() }, { '01099887766': { phone: '01099887766' } });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: true, statusCode: '429', errorMessage: 'rate limit' });
    const notifyResultCallback = vi.fn();

    await processQueueDoc(eventFor(db, 'pb_retry'), { db, sender, notifyResultCallback });

    expect(db._queue.get('pb_retry').status).toBe('failed_retryable');
    expect(db._friends.has('01099887766')).toBe(true); // 친구명단 유지
    expect(db._queue.has('pb_retry_sms')).toBe(false);
    expect(notifyResultCallback).not.toHaveBeenCalled();
  });

  it('접수 permanent 코드 → failed_permanent + 콜백(failed)', async () => {
    const db = makeDb({ pb_perm: bmsDoc() }, { '01099887766': { phone: '01099887766' } });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: false, statusCode: 'invalid_recipient', errorMessage: '번호 오류' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await processQueueDoc(eventFor(db, 'pb_perm'), { db, sender, notifyResultCallback });

    expect(db._queue.get('pb_perm').status).toBe('failed_permanent');
    expect(db._friends.has('01099887766')).toBe(true);
    expect(db._queue.has('pb_perm_sms')).toBe(false);
    expect(notifyResultCallback).toHaveBeenCalledWith('https://example.com/cb', expect.objectContaining({ status: 'failed' }));
  });
});

describe('parent_bms 발송결과 폴링 (runDeliveryResultSweep)', () => {
  const PAST = new Date('2026-06-25T00:00:00Z');
  const NOW = new Date('2026-06-25T00:05:00Z');
  const awaitingDoc = (overrides = {}) => ({
    kind: 'parent_bms',
    content: '[진단평가] 6/25(수) 오후 2시',
    recipient_phone: '01099887766',
    result_callback: { url: 'https://example.com/cb', applicationId: 'app_bms' },
    status: 'awaiting_delivery_result',
    solapi_group_id: 'grp1',
    delivery_check_at: PAST,
    delivery_check_count: 0,
    attempt_count: 1,
    ...overrides,
  });

  it('도달(4000) → sent + 친구 학습 + 콜백(channel=kakao)', async () => {
    const db = makeDb({ pb_ok: awaitingDoc() });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'delivered', statusCode: '4000' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await runDeliveryResultSweep({ db, resultFetcher, notifyResultCallback, now: NOW });

    expect(resultFetcher).toHaveBeenCalledWith('grp1', 'parent_bms');
    expect(db._queue.get('pb_ok').status).toBe('sent');
    expect(db._friends.has('01099887766')).toBe(true);
    expect(db._friends.get('01099887766')).toMatchObject({ phone: '01099887766' });
    expect(notifyResultCallback).toHaveBeenCalledTimes(1);
    expect(notifyResultCallback).toHaveBeenCalledWith('https://example.com/cb', expect.objectContaining({
      status: 'sent', channel: 'kakao', applicationId: 'app_bms',
    }));
  });

  it('도달 → 친구 학습 실패해도 sent + 콜백', async () => {
    const db = makeDb({ pb_ok2: awaitingDoc() });
    const orig = db.collection.bind(db);
    db.collection = (name) => {
      if (name === 'kakao_channel_friends') return { doc: () => ({ set: async () => { throw new Error('DB 오류'); } }) };
      return orig(name);
    };
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'delivered', statusCode: '4000' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await runDeliveryResultSweep({ db, resultFetcher, notifyResultCallback, now: NOW });

    expect(db._queue.get('pb_ok2').status).toBe('sent');
    expect(notifyResultCallback).toHaveBeenCalledWith('https://example.com/cb', expect.objectContaining({ status: 'sent' }));
  });

  it('비친구(3120) → 친구명단 제거 + kind=direct 문자 doc + 원 doc converted_to_sms + 원 doc 콜백 없음', async () => {
    const db = makeDb({ pb_nf: awaitingDoc() }, { '01099887766': { phone: '01099887766' } });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'not_friend', statusCode: '3120' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await runDeliveryResultSweep({ db, resultFetcher, notifyResultCallback, now: NOW });

    expect(db._friends.has('01099887766')).toBe(false);
    const smsDoc = db._queue.get('pb_nf_sms');
    expect(smsDoc).toBeDefined();
    expect(smsDoc.kind).toBe('direct');
    expect(smsDoc.status).toBe('pending');
    // sms_suffix 미지정 → 기본 채널 가입 유도가 자동으로 덧붙는다(원문 유지).
    expect(smsDoc.content).toContain('[진단평가] 6/25(수) 오후 2시');
    expect(smsDoc.content).toContain('talk.impact7.kr/kakao');
    expect(smsDoc.result_callback).toMatchObject({ url: 'https://example.com/cb', applicationId: 'app_bms' });
    expect(db._queue.get('pb_nf').status).toBe('converted_to_sms');
    expect(db._queue.get('pb_nf').last_error_code).toBe('3120');
    expect(notifyResultCallback).not.toHaveBeenCalled();
  });

  it('비친구 → content/result_callback/scheduled_date를 문자 doc에 복제', async () => {
    const db = makeDb({
      pb_copy: awaitingDoc({ scheduled_date: '2026-06-25 14:00:00', result_callback: { url: 'https://cb.example', applicationId: 'app2' } }),
    });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'not_friend', statusCode: '3120' });

    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });

    const smsDoc = db._queue.get('pb_copy_sms');
    expect(smsDoc.content).toContain('[진단평가] 6/25(수) 오후 2시');
    expect(smsDoc.scheduled_date).toBe('2026-06-25 14:00:00');
    expect(smsDoc.result_callback).toMatchObject({ url: 'https://cb.example', applicationId: 'app2' });
    expect(smsDoc.created_by).toBe('bms_fallback');
    expect(smsDoc.attempt_count).toBe(0);
  });

  it('비친구 → 지난 scheduled_date는 문자 doc에 복사하지 않는다(즉시 발송, 2026-07-04 사고)', async () => {
    // NOW(00:05Z)=09:05 KST — 08:00 KST 예약은 이미 지난 시각.
    const db = makeDb({ pb_past: awaitingDoc({ scheduled_date: '2026-06-25 08:00:00' }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'not_friend', statusCode: '3120' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(db._queue.get('pb_past_sms').scheduled_date).toBeNull();
  });

  it('비친구(3120) + sms_suffix → 문자 본문에 채널 가입 유도 문구 덧붙임', async () => {
    const db = makeDb({ pb_sfx: awaitingDoc({ sms_suffix: '채널 추가: https://pf.kakao.com/_x' }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'not_friend', statusCode: '3120' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(db._queue.get('pb_sfx_sms').content).toBe('[진단평가] 6/25(수) 오후 2시\n\n채널 추가: https://pf.kakao.com/_x');
  });

  it('야간(3108) → 문자 전환 (sms_suffix 있어도 비친구 확정 아니라 원문만)', async () => {
    const db = makeDb({ pb_nb: awaitingDoc({ sms_suffix: '채널 추가: https://pf.kakao.com/_x' }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'night_blocked', statusCode: '3108' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(db._queue.get('pb_nb').status).toBe('converted_to_sms');
    expect(db._queue.get('pb_nb_sms').kind).toBe('direct');
    expect(db._queue.get('pb_nb_sms').content).toBe('[진단평가] 6/25(수) 오후 2시');
  });

  it('SMS 전환 batch 실패 → 원본 converted_to_sms 아님 + SMS doc 미생성(유실 방지, H-08)', async () => {
    const db = makeDb({ pb_fail: awaitingDoc() });
    db.batch = () => ({ set() {}, update() {}, commit: async () => { throw new Error('batch commit failed'); } });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'not_friend', statusCode: '3120' });

    await expect(runDeliveryResultSweep({ db, resultFetcher, now: NOW })).rejects.toThrow(/batch commit failed/);

    expect(db._queue.get('pb_fail').status).not.toBe('converted_to_sms');
    expect(db._queue.has('pb_fail_sms')).toBe(false);
  });

  it('발송 실패(failed) → failed_permanent + 콜백(failed)', async () => {
    const db = makeDb({ pb_pf: awaitingDoc() });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'failed', statusCode: '3014', statusMessage: '수신번호 오류' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await runDeliveryResultSweep({ db, resultFetcher, notifyResultCallback, now: NOW });

    expect(db._queue.get('pb_pf').status).toBe('failed_permanent');
    expect(notifyResultCallback).toHaveBeenCalledWith('https://example.com/cb', expect.objectContaining({ status: 'failed' }));
  });

  it('미확정(pending) → 재조회 카운트 증가 + delivery_check_at 재연장(종결 안 함)', async () => {
    const db = makeDb({ pb_pend: awaitingDoc({ delivery_check_count: 2 }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'pending', statusCode: 'no_messages' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    const d = db._queue.get('pb_pend');
    expect(d.status).toBe('awaiting_delivery_result');
    expect(d.delivery_check_count).toBe(3);
    expect(d.delivery_check_at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('미확정 상한 초과 → 유실 방지로 문자 전환', async () => {
    const db = makeDb({ pb_to: awaitingDoc({ delivery_check_count: 14 }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'pending' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(db._queue.get('pb_to').status).toBe('converted_to_sms');
    expect(db._queue.get('pb_to').last_error_code).toBe('delivery_result_timeout');
  });

  it('delivery_check_at 미도래 doc은 폴링하지 않는다', async () => {
    const FUTURE = new Date('2026-06-25T01:00:00Z');
    const db = makeDb({ pb_future: awaitingDoc({ delivery_check_at: FUTURE }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'delivered', statusCode: '4000' });
    const res = await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(res.processed).toBe(0);
    expect(resultFetcher).not.toHaveBeenCalled();
    expect(db._queue.get('pb_future').status).toBe('awaiting_delivery_result');
  });
});

describe('kind=direct 즉석 SMS', () => {
  it('sends a plain SMS when kind=direct', async () => {
    const sender = vi.fn(async () => ({ ok: true, retryable: false, channel: 'sms', messageId: 'm', groupId: 'g', statusCode: '2000' }));
    const db = makeDb({ 'd1': { kind: 'direct', status: 'pending', recipient_phone: '01012345678', content: '안내문', attempt_count: 0 } });
    await processQueueDoc(eventFor(db, 'd1'), { db, sender });

    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'direct', to: '01012345678', text: '안내문' }));
    // 접수 성공도 통신사 도달은 미확정 — 발송결과 폴링 대기로 전이(즉시 sent 아님).
    const d1 = db._queue.get('d1');
    expect(d1.status).toBe('awaiting_delivery_result');
    expect(d1.solapi_group_id).toBe('g');
  });

  it('groupId 없는 접수성공 → 폴링 없이 즉시 sent(사후조회 불가, 중복 방지)', async () => {
    const sender = vi.fn(async () => ({ ok: true, retryable: false, channel: 'sms', groupId: null, statusCode: 'count_missing' }));
    const db = makeDb({ d2: { kind: 'direct', status: 'pending', recipient_phone: '01012345678', content: '안내문', attempt_count: 0 } });
    await processQueueDoc(eventFor(db, 'd2'), { db, sender });
    expect(db._queue.get('d2').status).toBe('sent');
  });
});

describe('kind=promo_sms 비친구 광고 SMS', () => {
  it('sendSms로 라우팅되고 payload가 to/text 형태', async () => {
    const sender = vi.fn(async () => ({ ok: true, retryable: false, channel: 'sms', messageId: 'm', groupId: 'g', statusCode: '2000' }));
    const db = makeDb({ ps1: { kind: 'promo_sms', status: 'pending', recipient_phone: '01012345678', content: '(광고)안내 무료거부 080', ad_flag: true, attempt_count: 0 } });
    await processQueueDoc(eventFor(db, 'ps1'), { db, sender });

    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'promo_sms', to: '01012345678', text: '(광고)안내 무료거부 080' }));
    expect(db._queue.get('ps1').status).toBe('awaiting_delivery_result');
  });
});

describe('SMS 발송결과 폴링 (runDeliveryResultSweep, kind=direct/promo_sms)', () => {
  const PAST = new Date('2026-06-25T00:00:00Z');
  const NOW = new Date('2026-06-25T00:05:00Z');
  const smsAwaiting = (overrides = {}) => ({
    kind: 'direct',
    content: '안내문',
    recipient_phone: '01012345678',
    status: 'awaiting_delivery_result',
    solapi_group_id: 'grpS',
    delivery_check_at: PAST,
    delivery_check_count: 0,
    attempt_count: 1,
    ...overrides,
  });

  it('도달(4000) → sent + 로그(channel=sms), 친구 학습 없음', async () => {
    const db = makeDb({ s_ok: smsAwaiting() });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'delivered', statusCode: '4000' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(resultFetcher).toHaveBeenCalledWith('grpS', 'direct');
    expect(db._queue.get('s_ok').status).toBe('sent');
    expect(db._friends.has('01012345678')).toBe(false); // SMS는 친구 학습 안 함
    expect(db._logs.at(-1)).toMatchObject({ status: 'sent', channel: 'sms' });
  });

  it('통신사 미도달(3058) + attempt<3 → 재발송 예약(failed_retryable, 로그 없음)', async () => {
    const db = makeDb({ s_rt: smsAwaiting({ attempt_count: 1 }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'failed', statusCode: '3058', statusMessage: '전송경로 없음' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    const d = db._queue.get('s_rt');
    expect(d.status).toBe('failed_retryable');
    expect(d.next_attempt_at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.last_error_code).toBe('3058');
    expect(d.delivery_check_at).toBe(null);
    expect(db._logs).toHaveLength(0);
  });

  it('미도달 + attempt 상한(3) → failed_permanent + 콜백(failed, channel=sms)', async () => {
    const db = makeDb({ s_pf: smsAwaiting({ attempt_count: 3, result_callback: { url: 'https://cb', applicationId: 'a' } }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'failed', statusCode: '3058' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);
    await runDeliveryResultSweep({ db, resultFetcher, notifyResultCallback, now: NOW });
    expect(db._queue.get('s_pf').status).toBe('failed_permanent');
    expect(notifyResultCallback).toHaveBeenCalledWith('https://cb', expect.objectContaining({ status: 'failed', channel: 'sms' }));
  });

  it('미확정(pending) 상한 초과 → 재발송 없이 미확정 종결(중복 방지, 문자 전환 doc 안 만듦)', async () => {
    const db = makeDb({ s_to: smsAwaiting({ delivery_check_count: 14, attempt_count: 1 }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'pending' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    const d = db._queue.get('s_to');
    expect(d.status).toBe('failed_permanent');
    expect(d.last_error_code).toBe('delivery_result_timeout');
    expect(db._queue.has('s_to_sms')).toBe(false);
  });

  it('promo_sms도 SMS 결과 조회로 라우팅된다', async () => {
    const db = makeDb({ ps_ok: smsAwaiting({ kind: 'promo_sms', solapi_group_id: 'grpP' }) });
    const resultFetcher = vi.fn().mockResolvedValue({ outcome: 'delivered', statusCode: '4000' });
    await runDeliveryResultSweep({ db, resultFetcher, now: NOW });
    expect(resultFetcher).toHaveBeenCalledWith('grpP', 'promo_sms');
    expect(db._queue.get('ps_ok').status).toBe('sent');
  });
});

describe('result_callback', () => {
  const resultCallback = { url: 'https://example.com/callback', applicationId: 'app1', chatMessageName: 'msg1' };

  it('result_callback 있고 성공 → notify가 status:sent, channel로 1회 호출', async () => {
    const db = makeDb({ q1: baseQueueDoc({ result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'sms', messageId: 'm1', statusCode: '2000' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await processQueueDoc(eventFor(db, 'q1'), { db, sender, notifyResultCallback });

    expect(notifyResultCallback).toHaveBeenCalledTimes(1);
    expect(notifyResultCallback).toHaveBeenCalledWith(resultCallback.url, {
      applicationId: 'app1',
      status: 'sent',
      channel: 'sms',
      queueId: 'q1',
      at: expect.any(String),
    });
    expect(db._queue.get('q1').status).toBe('sent');
  });

  it('영구실패 → notify가 status:failed 1회 호출', async () => {
    const db = makeDb({ q1: baseQueueDoc({ result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: false, statusCode: 'invalid', errorMessage: '에러', channel: 'sms' });
    const notifyResultCallback = vi.fn().mockResolvedValue(undefined);

    await processQueueDoc(eventFor(db, 'q1'), { db, sender, notifyResultCallback });

    expect(notifyResultCallback).toHaveBeenCalledTimes(1);
    expect(notifyResultCallback).toHaveBeenCalledWith(resultCallback.url, {
      applicationId: 'app1',
      status: 'failed',
      channel: 'sms',
      queueId: 'q1',
      at: expect.any(String),
    });
    expect(db._queue.get('q1').status).toBe('failed_permanent');
  });

  it('재시도(markRetry 경로) → notify 미호출', async () => {
    const db = makeDb({ q1: baseQueueDoc({ result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: false, retryable: true, statusCode: '429', errorMessage: 'rate limit' });
    const notifyResultCallback = vi.fn();

    await processQueueDoc(eventFor(db, 'q1'), { db, sender, notifyResultCallback });

    expect(notifyResultCallback).not.toHaveBeenCalled();
    expect(db._queue.get('q1').status).toBe('failed_retryable');
  });

  it('result_callback 없음 → notify 미호출, 발송 정상', async () => {
    const db = makeDb({ q1: baseQueueDoc() });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' });
    const notifyResultCallback = vi.fn();

    await processQueueDoc(eventFor(db, 'q1'), { db, sender, notifyResultCallback });

    expect(notifyResultCallback).not.toHaveBeenCalled();
    expect(db._queue.get('q1').status).toBe('sent');
  });

  it('콜백이 throw해도 dispatch 정상 완료(큐 상태 정상 종결)', async () => {
    const db = makeDb({ q1: baseQueueDoc({ result_callback: resultCallback }) });
    const sender = vi.fn().mockResolvedValue({ ok: true, channel: 'kakao', messageId: 'm', statusCode: '2000' });
    const notifyResultCallback = vi.fn().mockRejectedValue(new Error('network error'));

    await expect(processQueueDoc(eventFor(db, 'q1'), { db, sender, notifyResultCallback })).resolves.toBeNull();
    expect(db._queue.get('q1').status).toBe('sent');
  });
});

describe('__testing helpers', () => {
  it('buildSendPayload: 큐 doc → provider payload(templateVariables 키)', () => {
    const { buildSendPayload } = __testing;
    const payload = buildSendPayload(baseQueueDoc());
    expect(payload).toEqual({
      to: '01012345678',
      templateCode: 'TPL_ATT',
      templateVariables: { '#{학생명}': '김학생' },
      fallbackText: '출결 안내',
      kind: 'attendance',
    });
  });

  it('maskPhone: ***-****-뒤4자리 포맷(공용 phoneMask)', () => {
    const { maskPhone } = __testing;
    expect(maskPhone('01012345678')).toBe('***-****-5678');
    expect(maskPhone('010-1234-5678')).toBe('***-****-5678');
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
  });
});
