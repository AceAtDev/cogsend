import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedFetch } from '#lib/server/providers/timed-fetch.js';

describe('timedFetch', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('fails a hung request with a retryable timeout', async () => {
		vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
			return new Promise((_resolve, reject) => {
				const abort = () => {
					const err = new Error('The operation was aborted');
					err.name = 'TimeoutError';
					reject(err);
				};
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener('abort', abort, { once: true });
			});
		});
		const run = timedFetch(20);
		await expect(run('https://example.com/api')).rejects.toMatchObject({
			message: 'Provider request timed out',
			status: 504
		});
	});

	it('returns a fast response', async () => {
		vi.stubGlobal('fetch', () => Promise.resolve(new Response('ok')));
		const run = timedFetch(200);
		const res = await run('https://example.com/api');
		expect(res.ok).toBe(true);
		expect(await res.text()).toBe('ok');
	});
});

describe('providerTimeoutMs', () => {
	it('gives a whole streamed file minutes, uploads a minute, and JSON calls 15 seconds', async () => {
		const {
			providerTimeoutMs,
			PROVIDER_STREAM_TIMEOUT_MS,
			PROVIDER_UPLOAD_TIMEOUT_MS,
			PROVIDER_FETCH_TIMEOUT_MS
		} = await import('#lib/server/providers/timed-fetch.js');
		const stream = new ReadableStream({ start: (c) => c.close() });
		expect(providerTimeoutMs({ method: 'POST', body: stream })).toBe(PROVIDER_STREAM_TIMEOUT_MS);
		expect(providerTimeoutMs({ method: 'POST', body: new Uint8Array(4) })).toBe(
			PROVIDER_UPLOAD_TIMEOUT_MS
		);
		expect(providerTimeoutMs({ method: 'POST', body: '{}' })).toBe(PROVIDER_FETCH_TIMEOUT_MS);
		expect(PROVIDER_STREAM_TIMEOUT_MS).toBeGreaterThan(PROVIDER_UPLOAD_TIMEOUT_MS);
	});
});
