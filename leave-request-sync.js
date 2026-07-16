export function waitForFinalizedStudent({
    watchRequest,
    loadStudent,
    timeoutMs = 60_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        let lastFinalizeError = '';
        let settled = false;
        let timer;
        const stop = () => {
            if (settled) return false;
            settled = true;
            clearTimer(timer);
            unsubscribe();
            return true;
        };
        const fail = (error) => {
            if (stop()) reject(error);
        };

        timer = setTimer(() => {
            fail(new Error(lastFinalizeError || '서버 처리 완료를 확인하지 못했습니다.'));
        }, timeoutMs);
        unsubscribe = watchRequest(async (request) => {
            if (request?.finalize_error) lastFinalizeError = request.finalize_error;
            if (!request?.finalized_at) return;
            if (!stop()) return;
            try {
                resolve(await loadStudent());
            } catch (error) {
                reject(error);
            }
        }, fail);
    });
}
