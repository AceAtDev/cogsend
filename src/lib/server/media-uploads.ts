import { randomHex, timingSafeEqual, utf8Bytes } from '#lib/domain/bytes.js';
import { hmacHex } from './crypto';

/**
 * Every part but the last has this size: R2 wants equal parts of at least
 * 5 MiB, and one part per request keeps each well inside the 100 MB a request
 * may carry.
 */
export const UPLOAD_PART_BYTES = 10 * 1024 * 1024;

export interface UploadClaim {
	draftId: string;
	key: string;
	uploadId: string;
	size: number;
	segmentIndex: number;
}

// Key separation, as in public-media.ts: a sub-key only these tokens use.
async function signingKey(secret: string): Promise<string> {
	return hmacHex(secret, 'subkey:media-upload:v1');
}

function messageFor(claim: UploadClaim): string {
	return [
		'media-upload',
		claim.draftId,
		claim.key,
		claim.uploadId,
		claim.size,
		claim.segmentIndex
	].join(':');
}

/**
 * What the client carries between the parts of one upload. Signing the whole
 * claim keeps the routes stateless: a part cannot be steered into another
 * draft's object, and the size the checks ran against cannot grow afterwards.
 */
export async function signUploadClaim(secret: string, claim: UploadClaim): Promise<string> {
	return hmacHex(await signingKey(secret), messageFor(claim));
}

export async function verifyUploadClaim(
	secret: string,
	claim: UploadClaim,
	token: string
): Promise<boolean> {
	const expected = await signUploadClaim(secret, claim);
	const a = utf8Bytes(String(token));
	const b = utf8Bytes(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function newVideoKey(): string {
	return `${Date.now()}-${randomHex(8)}.mp4`;
}

export function partCount(size: number): number {
	return Math.max(1, Math.ceil(size / UPLOAD_PART_BYTES));
}

/** The exact length part `n` (1-based) must have. */
export function expectedPartLength(size: number, n: number): number {
	const parts = partCount(size);
	if (n < 1 || n > parts) return -1;
	return n < parts ? UPLOAD_PART_BYTES : size - UPLOAD_PART_BYTES * (parts - 1);
}

/** The claim fields from a request body or query, typed; null when malformed. */
export function readClaim(draftId: string, source: Record<string, unknown>): UploadClaim | null {
	const key = typeof source.key === 'string' ? source.key : '';
	const uploadId = typeof source.uploadId === 'string' ? source.uploadId : '';
	const size = Number(source.size);
	const segmentIndex = Number(source.segmentIndex);
	if (!key || !uploadId || !Number.isInteger(size) || size <= 0) return null;
	if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null;
	return { draftId, key, uploadId, size, segmentIndex };
}

/** How long an upload link works. Long enough for a batch, short enough that a leaked one dies soon. */
export const UPLOAD_LINK_TTL_MS = 60 * 60_000;

/**
 * One upload link: one file into one place on one draft, for the person who
 * asked for it, written as the credential that asked (so an agent's file is
 * held for review like any other agent write). `sortOrder` fixes where the
 * file lands in the carousel whatever order the uploads finish in, and makes
 * the link single-use.
 */
export interface UploadLinkClaim {
	userId: string;
	draftId: string;
	segmentIndex: number;
	sortOrder: number;
	exp: number;
	credential: 'session' | 'personal_api_key' | 'api_token';
	apiKeyId?: string;
	apiKeyPrefix?: string;
}

function base64url(text: string): string {
	return btoa(String.fromCharCode(...utf8Bytes(text)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64url(text: string): string {
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

async function linkKey(secret: string): Promise<string> {
	return hmacHex(secret, 'subkey:media-upload-link:v1');
}

export async function signUploadLink(secret: string, claim: UploadLinkClaim): Promise<string> {
	const body = base64url(JSON.stringify(claim));
	return `${body}.${await hmacHex(await linkKey(secret), body)}`;
}

/** The claim a link carries, or why it cannot be used. */
export async function verifyUploadLink(
	secret: string,
	token: string,
	nowMs = Date.now()
): Promise<{ ok: true; claim: UploadLinkClaim } | { ok: false; error: string }> {
	const [body, sig, extra] = String(token).split('.');
	if (!body || !sig || extra !== undefined) return { ok: false, error: 'Bad upload link' };
	const expected = utf8Bytes(await hmacHex(await linkKey(secret), body));
	const given = utf8Bytes(sig);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return { ok: false, error: 'Bad upload link' };
	}
	let claim: UploadLinkClaim;
	try {
		claim = JSON.parse(fromBase64url(body)) as UploadLinkClaim;
	} catch {
		return { ok: false, error: 'Bad upload link' };
	}
	if (!Number.isInteger(claim.exp) || claim.exp <= nowMs) {
		return { ok: false, error: 'This upload link has expired; ask for new ones' };
	}
	if (claim.exp - nowMs > UPLOAD_LINK_TTL_MS + 60_000)
		return { ok: false, error: 'Bad upload link' };
	return { ok: true, claim };
}
