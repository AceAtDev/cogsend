import type { PlatformId } from '#lib/domain/platforms.js';
import { PROCESSING_MARK } from '#lib/domain/video-rules.js';
import type { TiktokPostChoice } from '#lib/domain/tiktok.js';
import type { MetricCounts } from '#lib/domain/metrics.js';
import type { PublicMediaVariant } from '../public-media';
export type { PlatformId } from '#lib/domain/platforms.js';
export { PLATFORM_IDS, isPlatformId } from '#lib/domain/platforms.js';
export { PROCESSING_MARK };

export interface MediaAttachment {
	storageKey?: string;
	bytes?: Uint8Array;
	size?: number;
	mime: string;
	alt?: string;
	width?: number;
	height?: number;
	/** What the server read from a video when it was stored (draft_media.meta_json). */
	video?: {
		durationMs?: number | null;
		videoCodec?: string | null;
		audioCodec?: string | null;
		fps?: number | null;
		faststart?: boolean | null;
	} | null;
	/** The chosen cover of a video, a JPEG in the media store. */
	coverKey?: string;
	/** A JPEG copy of a PNG or WebP image is stored beside it (jpegKey()). */
	hasJpegCopy?: boolean;
}

export function mediaByteLength(media: MediaAttachment): number {
	if (typeof media.size === 'number' && media.size >= 0) return media.size;
	if (media.bytes) return media.bytes.length;
	return 0;
}

export interface NormalizedPost {
	text: string;
	media?: MediaAttachment[];
	thread?: NormalizedPost[];
	options?: {
		visibility?: 'public' | 'unlisted' | 'private' | 'direct';
		spoilerText?: string;
		langs?: string[];
		poll?: {
			options: string[];
			expiresIn: number;
			multiple?: boolean;
			hideTotals?: boolean;
		};
		/** TikTok: what the creator chose for this post to this account. */
		tiktok?: TiktokPostChoice;
	};
}

export interface ValidationIssue {
	field?: string;
	message: string;
	code?: string;
}

export interface PublishResult {
	/** The provider's id for the first segment. Optional on purpose: a 200 whose
	 *  body carries no id is still a published post, and the pipeline records it
	 *  by status rather than by this value. */
	remotePostId?: string;
	remoteUrl?: string;
	segmentIds?: string[];
	segmentCids?: string[];
}

export interface ConnectionCredentials {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	tokenType?: string;
	scopes?: string[];
	clientId?: string;
	clientSecret?: string;
	instanceUrl?: string;
	handle?: string;
	appPassword?: string;
	accessJwt?: string;
	refreshJwt?: string;
	did?: string;
	pdsHost?: string;
	/** LinkedIn OpenID sub; author is urn:li:person:{sub} */
	personUrn?: string;
	openIdSub?: string;
	/** Threads numeric user id (also the publish target) */
	threadsUserId?: string;
	threadsUsername?: string;
	/** Instagram professional account id (`/me` user_id), the publish target */
	igUserId?: string;
	igUsername?: string;
	/** TikTok's id for the user within this app (`open_id`) */
	tiktokOpenId?: string;
	/** TikTok username without @ (for permalinks) */
	tiktokUsername?: string;
	/** When the refresh token itself runs out (TikTok's lasts a year). */
	refreshExpiresAt?: number;
	/** X numeric user id */
	xUserId?: string;
	/** X handle without @ (for permalinks) */
	xUsername?: string;
	/** Zernio-backed accounts: the API key and the Zernio SocialAccount id. */
	zernioApiKey?: string;
	zernioAccountId?: string;
}

export interface ConnectionMeta {
	maxCharacters?: number;
	handle?: string;
	displayName?: string;
	avatarUrl?: string;
	did?: string;
	pdsHost?: string;
	personUrn?: string;
	threadsUserId?: string;
	igUserId?: string;
	/** Instagram: `Business` or `Media_Creator`, the only kinds that can post. */
	igAccountType?: string;
	tiktokOpenId?: string;
	/** TikTok: what creator_info last reported for the account. Who may see a
	 *  post, and what it allows, are chosen per post (NormalizedPost.options). */
	tiktokPrivacyOptions?: string[];
	tiktokMaxVideoSec?: number;
	tiktokCommentDisabled?: boolean;
	tiktokDuetDisabled?: boolean;
	tiktokStitchDisabled?: boolean;
	xUserId?: string;
	/** X: the last `subscription_type` seen, and the operator's long-post switch. */
	xSubscription?: string;
	longPosts?: boolean;
	provider?: 'zernio';
	/** Mastodon: the instance's video limits (`configuration.media_attachments`). */
	videoSizeLimit?: number;
	videoMatrixLimit?: number;
	videoFrameRateLimit?: number;
	zernioAccountId?: string;
	zernioProfileId?: string;
	/** LinkedIn: the company page (urn:li:organization:…) this connection posts as. */
	organizationUrn?: string;
}

export type FetchLike = typeof fetch;

/**
 * A video the platform is still taking in or processing, picked up on a later
 * run instead of waited for: a large upload or a slow transcode outlasts one
 * request. `state` belongs to the provider (a container id, an upload offset);
 * publish.ts adds the timing.
 */
export interface PublishPending {
	segment: number;
	storageKey: string;
	state: Record<string, unknown>;
	/** When the first run started on this video, for the overall deadline. */
	startedAt: number;
}

export interface PublishResume {
	segmentIds: string[];
	segmentCids?: string[];
	remoteUrl?: string | null;
	pending?: PublishPending | null;
}

/**
 * Progress callback for publishes spanning several remote posts. Providers
 * report each segment as it lands so publish.ts can persist the ids; without
 * it a Worker abort mid-thread leaves no record, and the stale-claim reclaim
 * would publish from segment 0 again (duplicate live posts). Implementations
 * must never throw — a checkpoint is best effort by definition.
 */
export interface PublishCheckpoint {
	segmentIds: string[];
	segmentCids?: string[];
	remoteUrl?: string | null;
}

/** Reads a stored video in slices or as a stream; a video never fits in memory whole. */
export type MediaReader = Required<Pick<MediaStore, 'getRange' | 'size' | 'open'>>;

/**
 * Structured provider failure. `code` drives two decisions in publish.ts
 * that string-matching alone gets wrong:
 * - `auth` → the credential is dead: mark the connection expired.
 * - `forbidden` (HTTP 403) → the platform refused this action but the
 *   credential was accepted: do NOT expire the connection. Retrying
 *   unchanged content is pointless, so it is also non-retryable.
 * - `unconfirmed` → the post request went out and no clear answer came back,
 *   so it may be live. Non-retryable: see unconfirmedPostError.
 * - `processing` → a video is not ready yet: park and resume, see processingError.
 * Unknown/legacy errors fall back to the previous regex classification.
 */
export type ProviderErrorCode =
	'auth' | 'forbidden' | 'rate_limited' | 'network' | 'upstream' | 'unconfirmed' | 'processing';

export class ProviderError extends Error {
	readonly status?: number;
	readonly code?: ProviderErrorCode;
	readonly retryable: boolean;
	/**
	 * Capped upstream response body for diagnosis (never the user-facing
	 * message). publish.ts persists it on the attempt so support can see
	 * codes/subcodes the 300-char message slice cuts off.
	 */
	readonly detail?: string;
	/** What the failure proved about the account, merged into its metaJson. */
	readonly metaPatch?: Record<string, unknown>;
	/** `processing`: where to pick up, and how soon to look again. */
	readonly pending?: ParkedVideo;
	readonly retryAfterMs?: number;

	constructor(
		message: string,
		opts: {
			status?: number;
			code?: ProviderErrorCode;
			detail?: string;
			metaPatch?: Record<string, unknown>;
			pending?: ParkedVideo;
			retryAfterMs?: number;
		} = {}
	) {
		super(message);
		this.name = 'ProviderError';
		this.status = opts.status;
		this.code = opts.code;
		this.detail = opts.detail;
		this.metaPatch = opts.metaPatch;
		this.pending = opts.pending;
		this.retryAfterMs = opts.retryAfterMs;
		this.retryable =
			opts.code === 'rate_limited' ||
			opts.code === 'network' ||
			opts.code === 'upstream' ||
			opts.code === 'processing';
	}
}

export type ParkedVideo = Pick<PublishPending, 'segment' | 'storageKey' | 'state'>;

/**
 * Park a video the platform has not finished with. The run ends, the target is
 * due again after `retryAfterMs`, and the next run resumes from `state` without
 * counting the wait as a failed attempt (publish.ts). Segments already posted
 * travel separately, in the checkpoint.
 */
export function processingError(
	platformLabel: string,
	pending: ParkedVideo,
	retryAfterMs = 30_000
): ProviderError {
	return new ProviderError(
		`${platformLabel} ${PROCESSING_MARK} — it publishes on its own in a minute or two`,
		{ code: 'processing', pending, retryAfterMs }
	);
}

/** Calls kept back after a step for its checkpoint, the failure write and the caller's reads. */
export const STEP_RESERVE_CALLS = 8;
/** Calls a fresh run spends before a provider starts (claim, reads, refresh). */
export const RUN_OVERHEAD_CALLS = 16;
/** The `storageKey` of a run parked for want of calls, not for a video. */
export const BUDGET_PARK_KEY = 'budget:';

/**
 * Before a step that creates something on the platform (an image upload, a
 * thread segment): when this request has too few calls left to finish it and
 * record it, stop here and continue on the next tick instead of running out
 * part-way, which on X, LinkedIn and Threads could post a segment twice. It
 * parks like a processing video: the attempt is handed back, and segments
 * already posted resume from the checkpoint. A step too big for even a fresh
 * request is attempted anyway, so nothing can park for ever.
 */
export function ensureCalls(
	opts: { callsLeft?: () => number; callsLimit?: number } | undefined,
	platformLabel: string,
	segment: number,
	needed: number
): void {
	const left = opts?.callsLeft?.() ?? Infinity;
	if (left >= needed + STEP_RESERVE_CALLS) return;
	const limit = opts?.callsLimit ?? Infinity;
	if (needed + STEP_RESERVE_CALLS + RUN_OVERHEAD_CALLS > limit) return;
	throw new ProviderError(
		`${platformLabel}: the rest of this post goes out on the next run (request limit reached)`,
		{
			code: 'processing',
			pending: { segment, storageKey: `${BUDGET_PARK_KEY}${segment}`, state: { budget: true } },
			retryAfterMs: 15_000
		}
	);
}

/** The provider state a resume carries for this segment's video, or null to start it fresh. */
export function resumedVideoState(
	resume: PublishResume | undefined,
	segment: number,
	storageKey: string | undefined
): Record<string, unknown> | null {
	const pending = resume?.pending;
	if (!pending || pending.segment !== segment || pending.storageKey !== storageKey) return null;
	return pending.state;
}

/** In every unconfirmed-post message; publish.ts reads it to keep the row from retrying. */
export const UNCONFIRMED_POST_MARK = 'may have been published';

/**
 * The request that creates a post failed without an answer (timeout, dropped
 * connection) or with a server error, so the platform may have published it.
 * X, LinkedIn, Threads, Instagram and TikTok take no idempotency key, so a retry cannot
 * be recognised as the same post: retrying on its own would risk a duplicate,
 * and the person has to look first.
 * The wording avoids the words humanizedCause and the auth matchers react to,
 * so it reaches the reader as written.
 */
export function unconfirmedPostError(platformLabel: string, cause: unknown): ProviderError {
	return new ProviderError(
		`${platformLabel} did not confirm the post in time, so it ${UNCONFIRMED_POST_MARK}. Check ${platformLabel} before you retry.`,
		{ code: 'unconfirmed', detail: cause instanceof Error ? cause.message : String(cause) }
	);
}

/**
 * Classify an upstream HTTP failure. 401 means the credential was rejected
 * (auth). 403 means the credential was accepted but the action refused
 * (policy/permission — must not expire the connection). 429 is rate
 * limiting. Anything else stays unclassified so legacy handling applies.
 */
export function providerErrorForStatus(
	prefix: string,
	status: number,
	body: string
): ProviderError {
	const message = `${prefix} failed (${status}): ${body.slice(0, 300)}`;
	if (status === 401) return new ProviderError(message, { status, code: 'auth' });
	if (status === 403) return new ProviderError(message, { status, code: 'forbidden' });
	if (status === 429) return new ProviderError(message, { status, code: 'rate_limited' });
	return new ProviderError(message, { status });
}

/**
 * Read structured failure info off any thrown value. Legacy enriched errors
 * (`Object.assign(new Error(...), { status })`) classify by status; anything
 * else returns no code so callers fall back to message matching.
 */
export function classifyProviderError(err: unknown): {
	status?: number;
	code?: ProviderErrorCode;
	retryable?: boolean;
} {
	if (err instanceof ProviderError) {
		return { status: err.status, code: err.code, retryable: err.retryable };
	}
	const status =
		typeof err === 'object' && err !== null && 'status' in err
			? (err as { status?: unknown }).status
			: undefined;
	if (typeof status !== 'number') return {};
	if (status === 401) return { status, code: 'auth', retryable: false };
	if (status === 403) return { status, code: 'forbidden', retryable: false };
	if (status === 429) return { status, code: 'rate_limited', retryable: true };
	return { status };
}

export class PublishPartialError extends Error {
	readonly segmentIds: string[];
	readonly segmentCids?: string[];
	readonly remoteUrl?: string | null;
	/** Carried over from the ProviderError that stopped the thread. */
	readonly metaPatch?: Record<string, unknown>;
	/** A later segment's video is still processing: park, as for a ProviderError. */
	readonly pending?: ParkedVideo;
	readonly retryAfterMs?: number;

	constructor(
		message: string,
		opts: {
			segmentIds: string[];
			segmentCids?: string[];
			remoteUrl?: string | null;
			metaPatch?: Record<string, unknown>;
			/** The error that stopped the thread; a parked video carries over. */
			cause?: unknown;
		}
	) {
		super(message);
		this.name = 'PublishPartialError';
		this.segmentIds = opts.segmentIds;
		this.segmentCids = opts.segmentCids;
		this.metaPatch = opts.metaPatch;
		this.remoteUrl = opts.remoteUrl;
		if (opts.cause instanceof ProviderError && opts.cause.code === 'processing') {
			this.pending = opts.cause.pending;
			this.retryAfterMs = opts.cause.retryAfterMs;
		}
	}
}

/**
 * A provider's media rules beyond `capabilities`, for the requirements an
 * agent reads before it builds a post (server/platform-requirements). Every
 * field is optional: a provider that declares none is described from its
 * capabilities, the video rules and the text limits alone, with CogSend's own
 * defaults for the rest. Keep these in step with what `validate` refuses.
 */
export interface ProviderRequirements {
	/** Image types the platform takes. Unset: every type CogSend stores. */
	imageMimes?: readonly string[];
	/** Types sent as the JPEG copy kept beside them (jpegKey), so only once one exists. */
	jpegCopyMimes?: readonly string[];
	/** Narrowest and widest width:height of a photo. */
	imageAspect?: { min: number; max: number; label: string };
	/** A post with no photo or video is refused. */
	requiresMedia?: boolean;
	/** The platform takes no video at all. */
	noVideo?: boolean;
	/** A chosen video cover is sent with the video. */
	videoCover?: boolean;
	/** Which attachments carry their alt text, and the longest it keeps. */
	altText?: { images: boolean; videos: boolean; maxLength?: number };
	/** Rules the numbers cannot say, one sentence each. */
	notes?: readonly string[];
}

/** What a platform said about one post when its metrics were read. */
export type MetricsOutcome =
	| { kind: 'ok'; counts: MetricCounts }
	/** The platform no longer returns the post: deleted, or hidden from this reader. */
	| { kind: 'not_found' }
	/** This post cannot be read, for a reason the sentence gives. */
	| { kind: 'unavailable'; reason: string };

/**
 * A metrics read that failed for every post in the request.
 * - `reconnect`: the token is dead or lacks the permission; the account must be
 *   connected again. Unlike a publish, a metrics read never marks the
 *   connection expired: a missing read scope says nothing about posting.
 * - `rate_limited`: back off, for `retryAfterMs` when the platform said.
 * - `unsupported`: this account gives no metrics (a LinkedIn personal profile).
 * - `transient`: network or platform trouble; tried again later.
 */
export class MetricsError extends Error {
	readonly kind: 'reconnect' | 'rate_limited' | 'unsupported' | 'transient';
	readonly retryAfterMs?: number;
	readonly status?: number;

	constructor(
		kind: MetricsError['kind'],
		message: string,
		opts: { retryAfterMs?: number; status?: number } = {}
	) {
		super(message);
		this.name = 'MetricsError';
		this.kind = kind;
		this.retryAfterMs = opts.retryAfterMs;
		this.status = opts.status;
	}
}

/** Seconds (Retry-After) or an epoch/ISO reset time, as milliseconds from now. */
export function retryAfterFrom(headers: Headers, now = Date.now()): number | undefined {
	const retry = headers.get('retry-after');
	if (retry) {
		const secs = Number(retry);
		if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
		const at = Date.parse(retry);
		if (Number.isFinite(at)) return Math.max(0, at - now);
	}
	const reset = headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset');
	if (reset) {
		const n = Number(reset);
		// An epoch in seconds is ~1.7e9; anything smaller is seconds from now.
		if (Number.isFinite(n)) return n > 1e9 ? Math.max(0, n * 1000 - now) : n * 1000;
		const at = Date.parse(reset);
		if (Number.isFinite(at)) return Math.max(0, at - now);
	}
	return undefined;
}

/** The usual HTTP failure of a metrics read, classified. */
export function metricsErrorForStatus(prefix: string, res: Response, body: string): MetricsError {
	const message = `${prefix} failed (${res.status}): ${body.slice(0, 200)}`;
	if (res.status === 401) return new MetricsError('reconnect', message, { status: 401 });
	if (res.status === 429)
		return new MetricsError('rate_limited', message, {
			status: 429,
			retryAfterMs: retryAfterFrom(res.headers)
		});
	return new MetricsError('transient', message, { status: res.status });
}

export interface PlatformProvider {
	id: PlatformId;
	/**
	 * The platform fetches attachments from `mediaUrlFor` URLs and is never
	 * handed the bytes, so publish does not read them from storage: on the
	 * Workers Free plan every read spends one of the request's 50 calls, and a
	 * carousel's images would otherwise all sit in isolate memory for nothing.
	 */
	mediaByUrl?: boolean;
	capabilities: {
		maxImages: number;
		maxImageBytes: number;
		supportsCW: boolean;
		supportsVisibility: boolean;
		supportsThreads: boolean;
	};
	/** What `capabilities` and the shared limits cannot say; see ProviderRequirements. */
	requirements?: ProviderRequirements;
	validate(content: NormalizedPost, meta?: ConnectionMeta): ValidationIssue[];
	publish(
		content: NormalizedPost,
		creds: ConnectionCredentials,
		meta?: ConnectionMeta,
		fetchImpl?: FetchLike,
		opts?: {
			resume?: PublishResume;
			/** Allow localhost/private Mastodon hosts. True only for a local
			 *  instance — see #lib/domain/app-url. */
			allowLocalHosts?: boolean;
			/** A public URL for the stored object, or for the JPEG kept beside
			 *  it (`jpeg`: an image's JPEG copy; `cover`: a video's cover). */
			mediaUrlFor?: (storageKey: string, variant?: PublicMediaVariant) => Promise<string> | string;
			/** A URL for the stored object on an address the operator verified
			 *  with the platform (TikTok's URL properties), or null when there
			 *  is none and the bytes have to be sent instead. */
			verifiedMediaUrlFor?: (
				storageKey: string,
				variant?: PublicMediaVariant
			) => Promise<string | null> | string | null;
			checkpoint?: (state: PublishCheckpoint) => Promise<void> | void;
			/** Videos are read through this; they are never in `media[].bytes`. */
			mediaReader?: MediaReader;
			/** Calls left in this request, so a long upload parks before it runs
			 *  out instead of failing half-way. Infinity without a budget. */
			callsLeft?: () => number;
			/** The whole request's call budget (50 on the Free plan), so a
			 *  provider can tell a step that fits a fresh run from one that
			 *  never will. Infinity without a budget. */
			callsLimit?: number;
			/** Milliseconds this run may still spend on uploads and waits before
			 *  it must park. A run started by a browser request is cut off 30s
			 *  after the tab goes away; Infinity in the scheduler. */
			timeLeft?: () => number;
			/** A stable key for (target, segment), so a retry after a lost
			 *  response is recognised by the platform instead of posting twice.
			 *  Providers that support it use it; the rest ignore it. */
			idempotencyKey?: (segmentIndex: number) => string;
			/** The same guarantee for AT Protocol, where it has to be a record
			 *  key of the collection's declared type (a TID for posts). */
			recordKey?: (segmentIndex: number) => string;
		}
	): Promise<PublishResult>;
	/**
	 * Optional credential healing before publish: reconcile stored identity
	 * with the live credential (Threads: the id GET /me reports). Returning
	 * creds makes publish.ts persist them so the correction sticks; null
	 * means nothing needed changing or the lookup was unavailable.
	 */
	alignCredentials?(
		creds: ConnectionCredentials,
		meta: ConnectionMeta | undefined,
		fetchImpl: FetchLike
	): Promise<ConnectionCredentials | null>;
	refreshIfNeeded?(
		creds: ConnectionCredentials,
		fetchImpl?: FetchLike
	): Promise<ConnectionCredentials>;
	/**
	 * Pure check for tokens that cannot possibly work: the access token is
	 * known-expired AND no refresh path exists (missing refresh token or
	 * OAuth client). Returns a human reconnect reason, or null when a
	 * publish attempt is still worthwhile. Providers without refreshable
	 * short-lived tokens (Mastodon, Bluesky) omit this.
	 */
	refreshImpossibleReason?(creds: ConnectionCredentials): string | null;
	/**
	 * Read the public counts of published posts, at most `metricsBatchSize` at
	 * once. Keyed by `remotePostId`; a post missing from the map was not
	 * answered for and is tried again. A failure of the whole request throws
	 * MetricsError. Providers without it are shown as "not collected yet".
	 */
	fetchMetrics?(
		remotePostIds: string[],
		creds: ConnectionCredentials,
		meta: ConnectionMeta | undefined,
		fetchImpl: FetchLike,
		opts?: { instanceUrl?: string | null; allowLocalHosts?: boolean }
	): Promise<Map<string, MetricsOutcome>>;
	metricsBatchSize?: number;
}

export interface MediaStore {
	get(storageKey: string): Promise<Uint8Array | null>;
	// Inclusive byte range for Range/206 serving. Optional for forward
	// compatibility: callers fall back to full get() when absent.
	getRange?(storageKey: string, start: number, end: number): Promise<Uint8Array | null>;
	// Total object size for Content-Range validation. Optional; callers fall
	// back to get().length when absent.
	size?(storageKey: string): Promise<number | null>;
	put(storageKey: string, bytes: Uint8Array, mime: string): Promise<void>;
	delete(storageKey: string): Promise<void>;
	// The object (or one inclusive byte range) as a stream plus the object's
	// total size, so serving a large file never holds it in isolate memory
	// (128MB limit vs 95MB videos). Optional: callers fall back to get/getRange.
	open?(
		storageKey: string,
		range?: { start: number; end: number }
	): Promise<{ body: ReadableStream; size: number } | null>;
	// Uploads in parts, for videos past the 100 MB a request may carry. Every
	// part but the last has the same size (R2 requires it); parts stream into
	// storage without passing through isolate memory.
	multipart?: {
		create(storageKey: string, mime: string): Promise<string>;
		uploadPart(
			storageKey: string,
			uploadId: string,
			partNumber: number,
			body: ReadableStream | Uint8Array
		): Promise<{ partNumber: number; etag: string }>;
		/** The completed object's size. */
		complete(
			storageKey: string,
			uploadId: string,
			parts: { partNumber: number; etag: string }[]
		): Promise<number>;
		abort(storageKey: string, uploadId: string): Promise<void>;
	};
	// Server-side copy, streamed. False when the source is gone.
	copy?(from: string, to: string): Promise<boolean>;
	// Bulk delete for the account wipe: R2 takes up to 1,000 keys in one call,
	// and each call is a subrequest (50 per invocation on Workers Free), so
	// deleting one at a time cannot finish a library of any size. Optional:
	// callers fall back to delete() per key.
	deleteMany?(storageKeys: string[]): Promise<void>;
}
