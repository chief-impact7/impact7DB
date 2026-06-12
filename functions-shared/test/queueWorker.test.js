import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const { processQueueDoc, runRetrySweep, purgeExpiredPii, __testing } = await import('../src/queueWorker.js');

// message_queue/message_logs를 흉내내는 인메모리 Firestore.
function makeDb(initialQueue = {}) {
  const queue = new Map(Object.entries(initialQueue));
  const logs = [];

  function docRef(id) {
    return {
      id,
      async update(patch) {
        queue.set(id, { ...(queue.get(id) ?? {}), ...patch });
      },
    };
  }

  function query() {
    const filters = [];
    let limitN = null;
    const q = {
      where(field, op, val) {
        filters.push([field, op, val]);
        return q;
      },
      limit(n) {
        limitN = n;
        return q;
      },
      async get() {
        let docs = [];
        for (const [id, data] of queue) {
          const ok = filters.every(([f, op, v]) => {
            if (op === '==') return data[f] === v;
            if (op === 'in') return Array.isArray(v) && v.includes(data[f]);
            if (op === '<=') return data[f] != null && data[f] <= v;
            return true;
          });
          if (ok) docs.push({ id, data: () => data, ref: docRef(id) });
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
      return {
        doc: (id) => docRef(id),
        where: (...a) => query().where(...a),
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

  it('kind 화이트리스트: promo는 발송 없이 failed_permanent(kind_not_allowed)', async () => {
    const db = makeDb({ q1: baseQueueDoc({ kind: 'promo' }) });
    const sender = vi.fn();
    await processQueueDoc(eventFor(db, 'q1'), { db, sender });
    expect(sender).not.toHaveBeenCalled();
    const doc = db._queue.get('q1');
    expect(doc.status).toBe('failed_permanent');
    expect(doc.last_error_code).toBe('kind_not_allowed');
    expect(db._logs[0]).toMatchObject({ status: 'failed', status_code: 'kind_not_allowed' });
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
