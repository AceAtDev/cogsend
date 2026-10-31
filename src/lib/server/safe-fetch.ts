import { isBlockedInstanceHost } from '#lib/domain/instance-host.js';
import type { FetchLike } from './providers/types';

/**
 * A URL a user or an agent handed the server, refused unless it is plain
 * http(s) to a host that is not loopback, private, link-local, cloud metadata
 * or a wildcard-DNS helper. Credentials in the URL are refused too: they would
 * travel to whatever the URL redirects to.
 */
export function assertPublicHttpUrl(raw: string): URL {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw Object.assign(new Error('Invalid URL'), { status: 400 });
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		throw Object.assign(new Error('Only http(s) URLs are supported'), { status: 400 });
	}
	if (u.username || u.password) {
		throw Object.assign(new Error('URLs with credentials are not supported'), { status: 400 });
	}
	if (isBlockedInstanceHost(u.hostname)) {
		throw Object.assign(new Error('URL host not allowed'), { status: 400 });
	}
	return u;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface PublicResponse {
	response: Response;
	url: string;
	/** Disarm the timeout once the body has been read, or given up on. */
	done(): void;
}

/**
 * GET a public URL, following redirects by hand so every hop is checked
 * again: a public host that answers 302 to `http://169.254.169.254/` must not
 * get the server to fetch it. The timeout covers the body as well (the signal
 * aborts the stream), so call `done()` once it has been read.
 *
 * Every hop is one outbound call, which `fetchImpl` counts when it is a
 * counting fetch (server/budget).
 */
export async function fetchPublic(
	raw: string,
	fetchImpl: FetchLike,
	opts: { accept: string; userAgent: string; timeoutMs: number; maxRedirects: number }
): Promise<PublicResponse> {
	let current = assertPublicHttpUrl(raw).toString();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
	const done = () => clearTimeout(timer);
	try {
		for (let hop = 0; hop <= opts.maxRedirects; hop++) {
			assertPublicHttpUrl(current);
			let res: Response;
			try {
				res = await fetchImpl(current, {
					headers: { 'User-Agent': opts.userAgent, Accept: opts.accept },
					redirect: 'manual',
					signal: ctrl.signal
				} as RequestInit);
			} catch (err) {
				const name = (err as Error)?.name;
				if (name === 'AbortError' || name === 'TimeoutError') {
					throw Object.assign(new Error('Fetching the URL timed out'), { status: 504 });
				}
				throw Object.assign(new Error('Could not fetch the URL'), { status: 502 });
			}
			if (REDIRECTS.has(res.status)) {
				await res.body?.cancel().catch(() => {});
				const location = res.headers.get('location');
				if (!location) {
					throw Object.assign(new Error('The URL redirected without a location'), { status: 502 });
				}
				try {
					current = new URL(location, current).toString();
				} catch {
					throw Object.assign(new Error('The URL redirected to an invalid URL'), { status: 502 });
				}
				continue;
			}
			// Some fetch implementations follow redirects whatever `redirect`
			// says; the URL they ended on must still be public.
			if (res.url) assertPublicHttpUrl(res.url);
			return { response: res, url: res.url || current, done };
		}
		throw Object.assign(new Error('Too many redirects'), { status: 400 });
	} catch (err) {
		done();
		throw err;
	}
}
