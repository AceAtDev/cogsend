import type { FetchLike } from './types';

/** JSON/API calls. Hung providers must fail well before STALE_CLAIM_MS (15m). */
export const PROVIDER_FETCH_TIMEOUT_MS = 15_000;
/** Media byte uploads (Mastodon 16MB, LinkedIn 8MB video) need a longer budget. */
export const PROVIDER_UPLOAD_TIMEOUT_MS = 60_000;
/**
 * A whole video streamed from storage (Mastodon and Bluesky take one request
 * for the file, up to a few hundred MB). Waiting on the network costs no CPU
 * time, so this can be generous; it only has to end before a stale claim.
 */
export const PROVIDER_STREAM_TIMEOUT_MS = 5 * 60_000;

function isStreamedBody(init?: RequestInit): boolean {
	const body = init?.body;
	if (body == null) return false;
	return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

function isUploadRequest(init?: RequestInit): boolean {
	const method = (init?.method || 'GET').toUpperCase();
	if (method === 'PUT') return true;
	const body = init?.body;
	if (body == null) return false;
	if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
	if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
	if (isStreamedBody(init)) return true;
	return false;
}

function mergeSignals(timeoutMs: number, existing?: AbortSignal | null): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!existing) return timeout;
	if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, existing]);
	return timeout;
}

function isTimeoutError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === 'TimeoutError' || err.name === 'AbortError';
}

export function timedFetch(timeoutMs: number): FetchLike {
	return async (input, init) => {
		const signal = mergeSignals(timeoutMs, init?.signal);
		try {
			return await fetch(input, { ...init, signal });
		} catch (err) {
			if (isTimeoutError(err)) {
				throw Object.assign(new Error('Provider request timed out'), { status: 504 });
			}
			throw err;
		}
	};
}

/** Outbound fetch: 15s for JSON, 60s for binary/FormData/PUT uploads, 5 min for a streamed file. */
export function providerTimeoutMs(init?: RequestInit): number {
	if (isStreamedBody(init)) return PROVIDER_STREAM_TIMEOUT_MS;
	return isUploadRequest(init) ? PROVIDER_UPLOAD_TIMEOUT_MS : PROVIDER_FETCH_TIMEOUT_MS;
}

export const providerFetch: FetchLike = (input, init) =>
	timedFetch(providerTimeoutMs(init))(input, init);
