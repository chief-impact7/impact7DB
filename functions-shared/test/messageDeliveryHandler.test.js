import { describe, it, expect } from 'vitest';

const { handleGetMessageDeliveryStatus } = await import('../src/messageDeliveryHandler.js');

const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr' } };

function snapOf(docs) {
  return { forEach: (fn) => docs.forEach(fn), docs };
}

function makeFirestore({ queue = [], logs = [] } = {}) {
  // where/orderBy/limit는 Firestore처럼 새 query를 반환(불변) — 같은 컬렉션 핸들을 여러 번
  // where해도 필터가 누적되지 않는다. count()/get()/in 연산을 지원한다.
  function makeChain(rows, filters) {
    const match = () => rows.filter(r => filters.every(([f, op, v]) => {
      if (op === '==') return r[f] === v;
      if (op === 'in') return Array.isArray(v) && v.includes(r[f]);
      if (op === '>=') return r[f] >= v;
      if (op === '<=') return r[f] <= v;
      return true;
    }));
    return {
      where(f, op, v) { return makeChain(rows, [...filters, [f, op, v]]); },
      orderBy() { return makeChain(rows, filters); },
      limit() { return makeChain(rows, filters); },
      count() {
        return { async get() { return { data: () => ({ count: match().length }) }; } };
      },
      async get() {
        return snapOf(match().map(r => ({ id: r.id, data: () => r })));
      },
    };
  }
  return {
    collection(name) {
      return makeChain(name === 'message_queue' ? queue : logs, []);
    },
  };
}

describe('handleGetMessageDeliveryStatus', () => {
  it('requires auth', async () => {
    await expect(handleGetMessageDeliveryStatus({ data: {} }, { firestore: makeFirestore() }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleGetMessageDeliveryStatus(
      { auth: { uid: 'x', token: { email: 'x@gmail.com' } }, data: {} },
      { firestore: makeFirestore() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('aggregates queue counts and returns masked failures only (no plaintext phone)', async () => {
    const firestore = makeFirestore({
      queue: [
        { id: 'q1', status: 'pending', recipient_phone: '01011112222' },
        { id: 'q2', status: 'sent', recipient_phone: '01033334444' },
        { id: 'q3', status: 'failed_permanent', student_id: 's3', recipient_phone: '01055556666', last_error_code: '4000', fallback_text: '홍길동 학생이 등원하였습니다.', updated_at: { toMillis: () => 1700000000000 } },
        { id: 'q4', status: 'failed_retryable', student_id: 's4', recipient_phone: '01077778888' },
      ],
      logs: [
        { id: 'l1', status: 'sent', channel: 'kakao' },
        { id: 'l2', status: 'sent', channel: 'sms' },
        { id: 'l3', status: 'sent', channel: 'lms' },
        { id: 'l4', status: 'failed', channel: 'kakao' },
        { id: 'l5', status: 'sent', channel: 'mms' },
      ],
    });
    const res = await handleGetMessageDeliveryStatus({ auth, data: {} }, { firestore });

    expect(res.queueCounts).toMatchObject({ pending: 1, sent: 1, failed_permanent: 1, failed_retryable: 1, processing: 0 });
    expect(res.channelCounts).toEqual({ kakao: 1, sms: 2, mms: 1 });
    expect(res.sentCount).toBe(4);
    expect(res.failedCount).toBe(1);

    expect(res.failures).toHaveLength(2);
    const f = res.failures.find(x => x.id === 'q3');
    expect(f).toMatchObject({ studentId: 's3', status: 'failed_permanent', lastErrorCode: '4000', recipientMasked: '***-****-6666', updatedAt: 1700000000000, content: '홍길동 학생이 등원하였습니다.' });

    // 평문 번호가 응답 어디에도 없어야 한다.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('01055556666');
    expect(serialized).not.toContain('01077778888');
  });

  it('filters both queue summary and log stats by fromMs/toMs range', async () => {
    const day = (n) => new Date(Date.UTC(2026, 6, n)); // 2026-07-0n
    const firestore = makeFirestore({
      queue: [
        { id: 'q1', status: 'pending', recipient_phone: '01011112222', created_at: day(3) },
        { id: 'q2', status: 'sent', recipient_phone: '01033334444', created_at: day(1) },
      ],
      logs: [
        { id: 'l1', status: 'sent', channel: 'kakao', created_at: day(1) },
        { id: 'l2', status: 'sent', channel: 'sms', created_at: day(3) },
        { id: 'l3', status: 'failed', channel: 'kakao', created_at: day(4) },
      ],
    });
    const res = await handleGetMessageDeliveryStatus(
      { auth, data: { fromMs: day(3).getTime(), toMs: day(4).getTime() } }, { firestore },
    );
    expect(res.sentCount).toBe(1);   // l2만 기간 내 sent
    expect(res.failedCount).toBe(1); // l3
    expect(res.channelCounts).toMatchObject({ kakao: 0, sms: 1 });
    expect(res.queueCounts.pending).toBe(1);
    expect(res.queueCounts.sent).toBe(0);
    expect(res.queueDetails.pending[0]).toMatchObject({ id: 'q1', recipientMasked: '***-****-2222' });
    expect(res.logLimitReached).toBe(false);
  });

  it('rejects an inverted range (from > to)', async () => {
    await expect(handleGetMessageDeliveryStatus(
      { auth, data: { fromMs: 2000, toMs: 1000 } }, { firestore: makeFirestore() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('uses the stored recipient_masked after PII purge (no plaintext phone field)', async () => {
    const firestore = makeFirestore({
      queue: [
        // purge 후: recipient_phone 삭제됨, recipient_masked만 남음.
        // 저장 포맷과 표시 포맷이 공용 maskPhone으로 통일됐다(***-****-6666). 재마스킹 없음.
        { id: 'q9', status: 'failed_permanent', student_id: 's9', recipient_masked: '***-****-6666', last_error_code: '4000' },
      ],
    });
    const res = await handleGetMessageDeliveryStatus({ auth, data: {} }, { firestore });
    const f = res.failures.find(x => x.id === 'q9');
    expect(f.recipientMasked).toBe('***-****-6666'); // 저장값 그대로 표시
    expect(f.content).toBeNull(); // purge로 본문(fallback_text)도 삭제된 상태
  });
});
