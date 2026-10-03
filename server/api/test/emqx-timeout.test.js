import test from 'node:test';
import assert from 'node:assert/strict';

test('EMQX admin API calls fail with a clear timeout error', async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = process.env.EMQX_API_TIMEOUT_MS;
    process.env.EMQX_API_TIMEOUT_MS = '10';
    let aborted = false;
    let pendingRequests = 0;
    let requestSignal;
    // AbortSignal.timeout() uses an unref'd timer. A real HTTP request keeps the
    // event loop alive; this mock must do the same until its abort is observed.
    const keepAlive = setInterval(() => {}, 1_000);

    globalThis.fetch = (url, options) => {
        requestSignal = options.signal;
        pendingRequests++;
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                aborted = true;
                pendingRequests--;
                reject(options.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        });
    };

    try {
        const { createDeviceUser } = await import(`../src/services/emqx.js?timeout=${Date.now()}`);

        await assert.rejects(
            () => createDeviceUser('aa:bb:cc:dd:ee:ff', 'secret-key'),
            /EMQX API POST .* timed out after 10ms/
        );
        assert.equal(aborted, true);
        assert.equal(requestSignal.aborted, true);
        assert.equal(pendingRequests, 0);
    } finally {
        clearInterval(keepAlive);
        globalThis.fetch = originalFetch;
        if (originalTimeout === undefined) {
            delete process.env.EMQX_API_TIMEOUT_MS;
        } else {
            process.env.EMQX_API_TIMEOUT_MS = originalTimeout;
        }
    }
});
