import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForFinalizedStudent } from '../leave-request-sync.js';

test('최종 승인 처리가 끝난 뒤 서버의 최신 학생을 반환한다', async () => {
    const student = { id: 'student-1', status: '등원예정' };

    const result = await waitForFinalizedStudent({
        watchRequest: (next) => {
            queueMicrotask(() => next({}));
            queueMicrotask(() => next({ finalize_error: '재시도 중' }));
            queueMicrotask(() => next({ finalized_at: true }));
            return () => {};
        },
        loadStudent: async () => student,
    });

    assert.equal(result, student);
});

test('서버 오류만 지속되면 제한 시간 후 구독을 정리하고 마지막 오류를 전달한다', async () => {
    let timeout;
    let unsubscribed = false;
    const pending = waitForFinalizedStudent({
        watchRequest: (next) => {
            queueMicrotask(() => next({ finalize_error: '반 정보 없음' }));
            return () => { unsubscribed = true; };
        },
        loadStudent: async () => null,
        setTimer: (callback) => { timeout = callback; },
        clearTimer: () => {},
    });

    await new Promise(resolve => queueMicrotask(resolve));
    timeout();

    await assert.rejects(pending, /반 정보 없음/);
    assert.equal(unsubscribed, true);
});

test('구독 오류는 전달한다', async () => {
    await assert.rejects(
        waitForFinalizedStudent({
            watchRequest: (_next, error) => {
                queueMicrotask(() => error(new Error('구독 실패')));
                return () => {};
            },
            loadStudent: async () => null,
        }),
        /구독 실패/,
    );
});
