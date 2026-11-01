import { tiktokMediaProblems } from '#lib/domain/media-limits.js';
import {
	tiktokChoiceProblem,
	tiktokPostInfo,
	TIKTOK_PRIVACY_MISSING_MESSAGE,
	type TiktokPrivacy
} from '#lib/domain/tiktok.js';
import { TIKTOK_MAX_CHARS, validateTiktokText } from '#lib/domain/validation/text.js';
import { singlePost } from './flatten';
import { providerFetch } from './timed-fetch';
import { processingError, ProviderError, resumedVideoState, unconfirmedPostError } from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import {
	PART_UPLOAD_MS,
	pollVideo,
	readVideoSlice,
	requireMediaReader,
	segmentVideo,
	storedVideoSize,
	videoValidation
} from './video';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const TOKEN_URL = `${API}/oauth/token/`;
// video.publish covers creator_info, Direct Post and the status fetch;
// creator_info also names the account, so user.info.profile is not needed.
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'];
const USER_FIELDS = 'open_id,union_id,avatar_url,display_name';
// The access token lives 24 hours. An hour of slack covers a video that
// parks and resumes across several runs.
const REFRESH_SKEW_MS = 60 * 60_000;

/**
 * TikTok takes parts of 5 to 64 MB, the last up to 128 MB, and does not say
 * whether a MB is 10^6 or 2^20 bytes; 20,000,000 is inside both readings. Each
 * part is read into memory to be sent, so the last one (under 40 MB) stays far
 * from the isolate's 128 MB, and a 300 MB video is 15 parts.
 */
export const TIKTOK_CHUNK_BYTES = 20_000_000;

// Calls a part needs (a storage read and the upload), and those kept back for
// a status read and publish.ts's own writes.
const PART_CALLS = 2;
const STATUS_RESERVE = 4;
// TikTok usually finishes within a minute, but moderation can take longer:
// wait while it is cheap to, then park.
const STATUS_POLLS = 8;
const STATUS_POLL_MS = 4000;
const PART_RETRY_MS = 15_000;
const STATUS_RETRY_MS = 60_000;
/**
 * A video TikTok has had in full and still reports as processing after this
 * long ends as unconfirmed instead of parking again: publish.ts gives up on a
 * parked video after 45 minutes and offers a Retry that starts over, and
 * starting over on a post that may yet go live would post it twice.
 */
const CONFIRM_WINDOW_MS = 40 * 60_000;
// TikTok's own caps (posts a creator makes a day, accounts an app posts for)
// reset over a day, so another try in an hour is soon enough.
const DAILY_CAP_RETRY_MS = 60 * 60_000;

/** Failure reasons the status fetch reports for a post that a new upload may fix. */
const RETRIED_FAIL_REASONS = new Set(['internal', 'spam_risk_too_many_posts']);

export const UNAUDITED_MESSAGE =
	'TikTok only lets an app it has not audited post to a private account, visible to the creator alone. Make the TikTok account private, or have the app audited by TikTok (docs: OAuth apps → TikTok)';

const URL_UNVERIFIED_MESSAGE =
	"TikTok has not verified this instance's address for the app — verify the URL prefix under URL properties (docs: OAuth apps → TikTok)";

type TiktokErrorFields = { code?: string; message?: string };

function parseTiktokError(body: string): TiktokErrorFields {
	try {
		const parsed = JSON.parse(body) as {
			error?: unknown;
			error_description?: unknown;
		};
		const err = parsed?.error;
		// The token endpoint answers `{error, error_description}`; the rest of
		// the API nests `{code, message}` under `error`.
		if (typeof err === 'string') {
			return {
				code: err,
				...(typeof parsed.error_description === 'string'
					? { message: parsed.error_description }
					: {})
			};
		}
		if (!err || typeof err !== 'object') return {};
		const { code, message } = err as { code?: unknown; message?: unknown };
		return {
			...(typeof code === 'string' ? { code } : {}),
			...(typeof message === 'string' && message ? { message } : {})
		};
	} catch {
		return {};
	}
}

/**
 * Classify a TikTok API failure by its error code, which is the only reliable
 * signal: creator_info reports a creator who may not post right now with HTTP
 * 200. Anything not known to pass is a problem a retry would only repeat.
 */
export function tiktokApiError(prefix: string, status: number, body: string): ProviderError {
	const { code, message: said } = parseTiktokError(body);
	const detail = body ? body.slice(0, 2000) : undefined;
	// These messages carry no status code: the composer's generic wording for a
	// 403 would otherwise replace the one thing the reader can act on.
	switch (code) {
		case 'unaudited_client_can_only_post_to_private_accounts':
			return new ProviderError(UNAUDITED_MESSAGE, { status, code: 'forbidden', detail });
		case 'privacy_level_option_mismatch':
			return new ProviderError(
				'TikTok does not offer the privacy chosen for this post — choose another in the composer',
				{ status, code: 'forbidden', detail }
			);
		case 'url_ownership_unverified':
			return new ProviderError(URL_UNVERIFIED_MESSAGE, { status, code: 'forbidden', detail });
		case 'spam_risk_too_many_posts':
			return new ProviderError(
				"TikTok's daily post limit for this account is reached — it is tried again in an hour",
				{ status, code: 'rate_limited', detail, retryAfterMs: DAILY_CAP_RETRY_MS }
			);
		case 'reached_active_user_cap':
			return new ProviderError(
				'This TikTok app has reached its daily limit of accounts that post through it — it is tried again in an hour',
				{ status, code: 'rate_limited', detail, retryAfterMs: DAILY_CAP_RETRY_MS }
			);
		case 'spam_risk_user_banned_from_posting':
			return new ProviderError('TikTok is not letting this account post through apps right now', {
				status,
				code: 'forbidden',
				detail
			});
	}
	const message = `${prefix} failed (${status}): ${said || body.slice(0, 300)}${code ? ` [${code}]` : ''}`;
	if (
		status === 401 ||
		code === 'access_token_invalid' ||
		code === 'scope_not_authorized' ||
		code === 'scope_permission_missed'
	) {
		return new ProviderError(`${message} — reconnect`, { status: 401, code: 'auth', detail });
	}
	if (status === 429 || code === 'rate_limit_exceeded') {
		return new ProviderError(message, { status, code: 'rate_limited', detail });
	}
	if (status >= 500 || code === 'internal_error') {
		return new ProviderError(message, { status, code: 'upstream', detail });
	}
	return new ProviderError(message, { status, code: 'forbidden', detail });
}

/**
 * creator_info's answers for a creator who may not post right now (TikTok
 * sends them with HTTP 200), worded for the composer, which stops there.
 */
const CANNOT_POST: Record<string, string> = {
	spam_risk_too_many_posts: 'This TikTok account has reached its daily post limit',
	spam_risk_user_banned_from_posting: 'TikTok is not letting this account post right now',
	reached_active_user_cap:
		'This TikTok app has reached its daily limit of accounts that post through it'
};

/** Why creator_info said the creator cannot post at the moment, or null for any other failure. */
export function tiktokCannotPostReason(err: unknown): string | null {
	if (!(err instanceof ProviderError) || !err.detail) return null;
	const { code } = parseTiktokError(err.detail);
	return (code && CANNOT_POST[code]) || null;
}

/** `data` of a TikTok answer, or the classified error. `error.code` is "ok" on success. */
async function tiktokData<T>(res: Response, label: string): Promise<T> {
	const text = await res.text().catch(() => '');
	let body: { data?: T; error?: { code?: unknown } } = {};
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		/* an unreadable 2xx is checked by the caller's own field checks */
	}
	const code = body?.error && typeof body.error === 'object' ? body.error.code : undefined;
	if (!res.ok || (code !== undefined && code !== 'ok'))
		throw tiktokApiError(label, res.status, text);
	return (body?.data ?? {}) as T;
}

function apiPost(
	path: string,
	token: string,
	body: unknown,
	fetchImpl: FetchLike
): Promise<Response> {
	return fetchImpl(`${API}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json; charset=UTF-8'
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
}

export interface TiktokCreator {
	username?: string;
	nickname?: string;
	avatarUrl?: string;
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maxVideoSec?: number;
}

/** creator_info: who the post goes to and what TikTok lets them post right now. */
export async function tiktokCreatorInfo(
	token: string,
	fetchImpl: FetchLike = providerFetch
): Promise<TiktokCreator> {
	const data = await tiktokData<Record<string, unknown>>(
		await apiPost('/post/publish/creator_info/query/', token, undefined, fetchImpl),
		'TikTok creator info'
	);
	const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const max = data.max_video_post_duration_sec;
	return {
		username: text(data.creator_username),
		nickname: text(data.creator_nickname),
		avatarUrl: text(data.creator_avatar_url),
		privacyOptions: Array.isArray(data.privacy_level_options)
			? data.privacy_level_options.filter((o): o is string => typeof o === 'string')
			: [],
		commentDisabled: data.comment_disabled === true,
		duetDisabled: data.duet_disabled === true,
		stitchDisabled: data.stitch_disabled === true,
		...(typeof max === 'number' && max > 0 ? { maxVideoSec: max } : {})
	};
}

/** What creator_info says about the account, as stored on the connection. */
export function creatorMeta(creator: TiktokCreator | null): Partial<ConnectionMeta> {
	if (!creator) return {};
	return {
		...(creator.privacyOptions.length ? { tiktokPrivacyOptions: creator.privacyOptions } : {}),
		...(creator.maxVideoSec ? { tiktokMaxVideoSec: creator.maxVideoSec } : {}),
		tiktokCommentDisabled: creator.commentDisabled,
		tiktokDuetDisabled: creator.duetDisabled,
		tiktokStitchDisabled: creator.stitchDisabled
	};
}

export interface ChunkPlan {
	chunkSize: number;
	count: number;
}

/**
 * How TikTok is told to expect the file: `total_chunk_count` is the size over
 * the part size, rounded down, so the last part carries the remainder too.
 * Anything under two parts goes whole, which keeps every part at least
 * `chunk` bytes and the whole-file case inside the 64 MB a part may be.
 */
export function tiktokChunkPlan(size: number, chunk = TIKTOK_CHUNK_BYTES): ChunkPlan {
	if (size < 2 * chunk) return { chunkSize: size, count: 1 };
	return { chunkSize: chunk, count: Math.floor(size / chunk) };
}

/** First and last byte (inclusive) of part `index`. */
export function tiktokChunkRange(plan: ChunkPlan, size: number, index: number): [number, number] {
	const start = index * plan.chunkSize;
	return [start, index === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1];
}

/**
 * Where an upload stands, carried across runs. `sent` is set once the last
 * part has gone out, answered or not: from then on the post may be on its way,
 * and only the status fetch decides what happens next. `confirmed` records that
 * TikTok acknowledged that last part.
 */
interface UploadState {
	publishId: string;
	uploadUrl: string;
	size: number;
	chunkSize: number;
	count: number;
	next: number;
	sent?: boolean;
	confirmed?: boolean;
}

function uploadState(raw: Record<string, unknown> | null): UploadState | null {
	if (!raw) return null;
	const { publishId, uploadUrl, size, chunkSize, count, next } = raw;
	if (typeof publishId !== 'string' || !publishId || typeof uploadUrl !== 'string') return null;
	if (![size, chunkSize, count, next].every((n) => typeof n === 'number' && n >= 0)) return null;
	return {
		publishId,
		uploadUrl,
		size: size as number,
		chunkSize: chunkSize as number,
		count: count as number,
		next: next as number,
		...(raw.sent === true ? { sent: true } : {}),
		...(raw.confirmed === true ? { confirmed: true } : {})
	};
}

interface PostStatus {
	status: string;
	failReason?: string;
	postId?: string;
	uploadedBytes?: number;
}

/** What the status fetch says, or null when it could not be read. */
async function postStatus(
	token: string,
	publishId: string,
	fetchImpl: FetchLike
): Promise<PostStatus | null> {
	let res: Response;
	try {
		res = await apiPost('/post/publish/status/fetch/', token, { publish_id: publishId }, fetchImpl);
	} catch {
		return null;
	}
	const text = await res.text().catch(() => '');
	let body: { data?: Record<string, unknown>; error?: { code?: unknown } } = {};
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return null;
	}
	const code = body?.error && typeof body.error === 'object' ? body.error.code : undefined;
	if (!res.ok || (code !== undefined && code !== 'ok')) {
		// A dead token never recovers, and a parked video would otherwise wait
		// out its whole deadline before anyone heard about it.
		const err = tiktokApiError('TikTok status', res.status, text);
		if (err.code === 'auth') throw err;
		return null;
	}
	const data = body.data ?? {};
	if (typeof data.status !== 'string') return null;
	// Post ids are 19-digit int64s, past what a JS number holds exactly, so the
	// first one is read from the raw text. The misspelling is TikTok's own.
	const postId = text.match(/"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/)?.[1];
	return {
		status: data.status,
		...(typeof data.fail_reason === 'string' && data.fail_reason
			? { failReason: data.fail_reason }
			: {}),
		...(postId ? { postId } : {}),
		...(typeof data.uploaded_bytes === 'number' ? { uploadedBytes: data.uploaded_bytes } : {})
	};
}

/** The post's public link. TikTok returns an id only for a public post, once it passes moderation. */
export function tiktokPostUrl(username: string | undefined, postId: string | undefined) {
	if (!username || !postId) return undefined;
	return `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${postId}`;
}

/** A FAILED post, as the error it is, or `restart` when a fresh upload may succeed. */
function failedPost(reason: string | undefined): 'restart' {
	if (reason && RETRIED_FAIL_REASONS.has(reason)) return 'restart';
	if (reason === 'auth_removed') {
		throw new ProviderError('TikTok says the account removed this app — reconnect', {
			status: 401,
			code: 'auth',
			detail: reason
		});
	}
	if (reason === 'spam_risk_user_banned_from_posting') {
		throw tiktokApiError('TikTok publish', 403, JSON.stringify({ error: { code: reason } }));
	}
	throw new ProviderError(`TikTok could not publish the video: ${reason || 'no reason given'}`, {
		code: 'forbidden',
		detail: reason
	});
}

/**
 * `post_info` from the creator's own choices for this post, checked against a
 * creator_info read moments ago: TikTok's guidelines want the choice made per
 * post, with no default, so a post without one is refused rather than sent
 * with something CogSend picked.
 */
function postInfo(
	text: string,
	content: NormalizedPost,
	creator: TiktokCreator,
	video: MediaAttachment
): Record<string, unknown> {
	const choice = content.options?.tiktok;
	const problem = tiktokChoiceProblem(choice, creator, video.video?.durationMs);
	if (problem) {
		throw new ProviderError(
			problem === TIKTOK_PRIVACY_MISSING_MESSAGE
				? `${problem}: open the post in the composer and pick who can see it`
				: problem,
			{
				code: 'forbidden',
				metaPatch: creatorMeta(creator),
				detail: creator.privacyOptions.join(',')
			}
		);
	}
	return tiktokPostInfo(
		choice as NonNullable<typeof choice> & { privacy: TiktokPrivacy },
		creator,
		text
	);
}

export const tiktokProvider: PlatformProvider = {
	id: 'tiktok',
	capabilities: {
		maxImages: 0,
		maxImageBytes: 0,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},

	validate(content, meta): ValidationIssue[] {
		const { text, media } = singlePost(content);
		const issues: ValidationIssue[] = [];
		const checked = validateTiktokText(text);
		if (!checked.ok) issues.push({ field: 'text', message: checked.message ?? 'Caption too long' });
		const problems = tiktokMediaProblems(media);
		for (const message of problems) issues.push({ field: 'media', message, code: 'tiktok_media' });
		if (problems.length) return issues;
		issues.push(...videoValidation('tiktok', media, meta, 'media'));
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		const token = creds.accessToken;
		if (!token) {
			throw new ProviderError('TikTok credentials are missing a token (reconnect)', {
				code: 'auth'
			});
		}
		// A run that published and then lost its answer resumes here: never twice.
		const done = opts?.resume?.segmentIds?.[0];
		if (done) return { remotePostId: done, remoteUrl: opts?.resume?.remoteUrl ?? undefined };
		const { text, media } = singlePost(content);
		const video = segmentVideo(media);
		if (!video?.storageKey) {
			throw new ProviderError(tiktokMediaProblems(media)[0] ?? 'TikTok needs a video', {
				code: 'forbidden'
			});
		}
		if (!content.options?.tiktok?.privacy) {
			throw new ProviderError(
				`${TIKTOK_PRIVACY_MISSING_MESSAGE}: open the post in the composer and pick who can see it`,
				{ code: 'forbidden' }
			);
		}
		const storageKey = video.storageKey;
		const pullUrl = opts?.verifiedMediaUrlFor ? await opts.verifiedMediaUrlFor(storageKey) : null;
		const callsLeft = opts?.callsLeft ?? (() => Infinity);
		const timeLeft = opts?.timeLeft ?? (() => Infinity);
		const startedAt = opts?.resume?.pending?.startedAt;
		const park = (state: UploadState, retryAfterMs: number): never => {
			throw processingError(
				'TikTok',
				{ segment: 0, storageKey, state: { ...state } as Record<string, unknown> },
				retryAfterMs
			);
		};

		/**
		 * TikTok's guidelines want a video already on a server pulled from
		 * there, which needs the URL on an address verified with TikTok. The
		 * state that comes back has nothing left to send, only a status to
		 * wait for. Null when TikTok has not verified the address: the same
		 * video then goes up from storage instead.
		 */
		async function beginPull(info: Record<string, unknown>): Promise<UploadState | null> {
			let res: Response;
			try {
				res = await apiPost(
					'/post/publish/video/init/',
					token!,
					{ post_info: info, source_info: { source: 'PULL_FROM_URL', video_url: pullUrl } },
					fetchImpl
				);
			} catch {
				// No answer may still have started a download that publishes, and
				// a second init would post twice.
				throw unconfirmedPostError('TikTok', new Error('no answer to the pull request'));
			}
			let data: { publish_id?: unknown };
			try {
				data = await tiktokData<{ publish_id?: unknown }>(res, 'TikTok upload start');
			} catch (err) {
				if (err instanceof ProviderError && err.message === URL_UNVERIFIED_MESSAGE) return null;
				// TikTok's own failure may have come after the download started.
				if (err instanceof ProviderError && err.code === 'upstream') {
					throw unconfirmedPostError('TikTok', err);
				}
				throw err;
			}
			if (typeof data.publish_id !== 'string' || !data.publish_id) {
				throw new ProviderError('TikTok returned no publish id', { code: 'upstream' });
			}
			return {
				publishId: data.publish_id,
				uploadUrl: '',
				size: 0,
				chunkSize: 0,
				count: 0,
				next: 0,
				sent: true,
				confirmed: true
			};
		}

		/** A new upload. Starting one publishes nothing, so a lost answer here is safe to redo. */
		async function begin(): Promise<UploadState> {
			const creator = await tiktokCreatorInfo(token!, fetchImpl);
			const info = postInfo(text, content, creator, video!);
			if (pullUrl) {
				const pulled = await beginPull(info);
				if (pulled) return pulled;
			}
			const reader = requireMediaReader(opts?.mediaReader);
			const size = await storedVideoSize(reader, storageKey);
			const plan = tiktokChunkPlan(size);
			const data = await tiktokData<{ publish_id?: unknown; upload_url?: unknown }>(
				await apiPost(
					'/post/publish/video/init/',
					token!,
					{
						post_info: info,
						source_info: {
							source: 'FILE_UPLOAD',
							video_size: size,
							chunk_size: plan.chunkSize,
							total_chunk_count: plan.count
						}
					},
					fetchImpl
				),
				'TikTok upload start'
			);
			if (typeof data.publish_id !== 'string' || typeof data.upload_url !== 'string') {
				throw new ProviderError('TikTok returned no upload address', { code: 'upstream' });
			}
			return {
				publishId: data.publish_id,
				uploadUrl: data.upload_url,
				size,
				...plan,
				next: 0
			};
		}

		/**
		 * After TikTok refused a part, its status says whether the upload is
		 * already whole (and on its way), or dead and safe to start over.
		 */
		async function afterRefusedPart(
			state: UploadState,
			cause: Error
		): Promise<UploadState | 'restart'> {
			const status = await postStatus(token!, state.publishId, fetchImpl);
			if (!status) return park(state, PART_RETRY_MS);
			if (status.status === 'FAILED') return 'restart';
			const lastStart = (state.count - 1) * state.chunkSize;
			const bytes = status.uploadedBytes;
			if (status.status === 'PROCESSING_UPLOAD' && typeof bytes === 'number') {
				// The last part never arrived, and only this run holds the upload
				// address, so this upload cannot publish anything.
				if (bytes < lastStart) return 'restart';
				if (bytes >= state.size - 1) return { ...state, sent: true };
			}
			if (status.status === 'PUBLISH_COMPLETE' || status.status === 'SEND_TO_USER_INBOX') {
				return { ...state, sent: true };
			}
			throw unconfirmedPostError('TikTok', cause);
		}

		/** Send the parts still to go, parking before the request runs out. */
		async function upload(state: UploadState): Promise<UploadState | 'restart'> {
			let current = state;
			while (current.next < current.count) {
				if (callsLeft() < STATUS_RESERVE + PART_CALLS || timeLeft() < PART_UPLOAD_MS) {
					park(current, PART_RETRY_MS);
				}
				const [start, end] = tiktokChunkRange(current, current.size, current.next);
				const slice = await readVideoSlice(
					requireMediaReader(opts?.mediaReader),
					storageKey,
					start,
					end
				);
				const last = current.next === current.count - 1;
				let res: Response;
				try {
					res = await fetchImpl(current.uploadUrl, {
						method: 'PUT',
						headers: {
							'Content-Type': 'video/mp4',
							'Content-Range': `bytes ${start}-${end}/${current.size}`
						},
						body: slice as unknown as BodyInit
					});
				} catch {
					// A part sent again goes into the same upload, so it cannot post
					// twice. The last one may have landed, and then the post is on its
					// way: only the status fetch may say otherwise.
					if (last) return { ...current, next: current.count, sent: true };
					return park(current, PART_RETRY_MS);
				}
				if (res.ok) {
					await res.body?.cancel().catch(() => {});
					current = {
						...current,
						next: current.next + 1,
						...(last ? { sent: true, confirmed: true } : {})
					};
					continue;
				}
				const body = await res.text().catch(() => '');
				if (res.status >= 500) {
					if (last) return { ...current, next: current.count, sent: true };
					return park(current, PART_RETRY_MS);
				}
				return afterRefusedPart(
					current,
					new Error(`TikTok upload part failed (${res.status}): ${body.slice(0, 300)}`)
				);
			}
			return { ...current, sent: true };
		}

		/** Wait for TikTok to publish what it has, then park if it is still working. */
		async function settle(
			state: UploadState,
			sentThisRun: boolean
		): Promise<PublishResult | 'restart'> {
			const lastStart = (state.count - 1) * state.chunkSize;
			const outcome = await pollVideo(
				{
					polls: STATUS_POLLS,
					delayMs: STATUS_POLL_MS,
					reserve: STATUS_RESERVE,
					callsLeft,
					timeLeft
				},
				async (): Promise<{ postId?: string } | 'restart' | null> => {
					const status = await postStatus(token!, state.publishId, fetchImpl);
					if (!status) return null;
					if (status.status === 'PUBLISH_COMPLETE' || status.status === 'SEND_TO_USER_INBOX') {
						return { postId: status.postId };
					}
					if (status.status === 'FAILED') return failedPost(status.failReason);
					// Only a later run trusts a short byte count, and only for a last
					// part TikTok never acknowledged: right after a part lands the
					// count may not have caught up yet.
					if (
						!sentThisRun &&
						!state.confirmed &&
						status.status === 'PROCESSING_UPLOAD' &&
						typeof status.uploadedBytes === 'number' &&
						status.uploadedBytes < lastStart
					) {
						return 'restart';
					}
					return null;
				}
			);
			if (outcome === 'restart') return 'restart';
			if (outcome) {
				const remotePostId = outcome.postId ?? state.publishId;
				await opts?.checkpoint?.({ segmentIds: [remotePostId] });
				return {
					remotePostId,
					remoteUrl: tiktokPostUrl(creds.tiktokUsername, outcome.postId)
				};
			}
			if (!sentThisRun && startedAt && Date.now() - startedAt > CONFIRM_WINDOW_MS) {
				throw unconfirmedPostError(
					'TikTok',
					new Error(`still processing publish ${state.publishId}`)
				);
			}
			return park(state, STATUS_RETRY_MS);
		}

		let state = uploadState(resumedVideoState(opts?.resume, 0, storageKey));
		let restarted = false;
		const restart = (): null => {
			// Once per run: a second dead upload in a row is TikTok's trouble, and
			// the retry the error allows is the next run's.
			if (restarted) {
				throw new ProviderError('TikTok did not take the upload — it is tried again', {
					code: 'upstream'
				});
			}
			restarted = true;
			return null;
		};
		for (;;) {
			let sentThisRun = false;
			if (!state) state = await begin();
			if (!state.sent) {
				const uploaded = await upload(state);
				if (uploaded === 'restart') {
					state = restart();
					continue;
				}
				state = uploaded;
				sentThisRun = true;
			}
			const result = await settle(state, sentThisRun);
			if (result !== 'restart') return result;
			state = restart();
		}
	},

	refreshImpossibleReason(creds): string | null {
		if (creds.refreshExpiresAt && creds.refreshExpiresAt <= Date.now()) {
			return 'TikTok sign-in lasts a year and this one has run out — reconnect';
		}
		if (creds.refreshToken && creds.clientId && creds.clientSecret) return null;
		if (!creds.expiresAt || creds.expiresAt > Date.now()) return null;
		return 'TikTok token expired and cannot be refreshed (incomplete credentials) — reconnect';
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch): Promise<ConnectionCredentials> {
		if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return creds;
		if (creds.expiresAt && creds.expiresAt - Date.now() > REFRESH_SKEW_MS) return creds;
		let res: Response;
		try {
			res = await fetchImpl(TOKEN_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_key: creds.clientId,
					client_secret: creds.clientSecret,
					grant_type: 'refresh_token',
					refresh_token: creds.refreshToken
				})
			});
		} catch {
			return creds;
		}
		const text = await res.text().catch(() => '');
		// A rate limit or TikTok's own trouble keeps the current token for the
		// next try; a refusal of the refresh token expires the account.
		if (res.status === 429 || res.status >= 500) return creds;
		const tok = tokenFields(text);
		if (!tok.accessToken) {
			const { code } = parseTiktokError(text);
			if (res.ok && !code) return creds;
			throw new ProviderError(
				`TikTok token refresh rejected${code ? ` (${code})` : ''} — reconnect`,
				{
					status: 401,
					code: 'auth',
					detail: text.slice(0, 2000)
				}
			);
		}
		return {
			...creds,
			accessToken: tok.accessToken,
			// TikTok may hand back a new refresh token, and then only it works.
			refreshToken: tok.refreshToken ?? creds.refreshToken,
			expiresAt: tok.expiresAt ?? creds.expiresAt,
			refreshExpiresAt: tok.refreshExpiresAt ?? creds.refreshExpiresAt,
			...(tok.scopes ? { scopes: tok.scopes } : {})
		};
	}
};

function tokenFields(text: string): {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	refreshExpiresAt?: number;
	scopes?: string[];
	openId?: string;
} {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
	const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
	const at = (v: unknown) => (typeof v === 'number' && v > 0 ? Date.now() + v * 1000 : undefined);
	const scope = str(raw.scope);
	return {
		accessToken: str(raw.access_token),
		refreshToken: str(raw.refresh_token),
		expiresAt: at(raw.expires_in),
		refreshExpiresAt: at(raw.refresh_expires_in),
		...(scope
			? {
					scopes: scope
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				}
			: {}),
		openId: str(raw.open_id)
	};
}

export function tiktokCallbackUrl(appUrl: string): string {
	return `${appUrl.replace(/\/$/, '')}/api/connections/tiktok/callback`;
}

export function tiktokAuthorizeUrl(clientKey: string, appUrl: string, state: string): string {
	const params = new URLSearchParams({
		client_key: clientKey,
		scope: TIKTOK_SCOPES.join(','),
		response_type: 'code',
		redirect_uri: tiktokCallbackUrl(appUrl),
		state
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

type TiktokUser = { open_id?: string; display_name?: string; avatar_url?: string };

async function fetchUser(token: string, fetchImpl: FetchLike): Promise<TiktokUser> {
	const data = await tiktokData<{ user?: TiktokUser }>(
		await fetchImpl(`${API}/user/info/?fields=${USER_FIELDS}`, {
			headers: { Authorization: `Bearer ${token}` }
		}),
		'TikTok profile'
	);
	return data.user ?? {};
}

const NO_POSTING_MESSAGE =
	'TikTok did not allow this app to post — check that the app has the Content Posting API with Direct Post and the video.publish scope, then connect again';

/**
 * creator_info at connect: it names the account and what it may post, but a
 * creator who may not post right now is still an account worth connecting. A
 * token refused for posting is not.
 */
async function creatorAtConnect(token: string, fetchImpl: FetchLike) {
	try {
		return await tiktokCreatorInfo(token, fetchImpl);
	} catch (err) {
		if (err instanceof ProviderError && err.code === 'auth') {
			throw Object.assign(new Error(NO_POSTING_MESSAGE), { status: 401 });
		}
		return null;
	}
}

function identity(user: TiktokUser, creator: TiktokCreator | null) {
	const username = creator?.username;
	return {
		username,
		handle: username ? `@${username}` : undefined,
		displayName: creator?.nickname || user.display_name?.trim() || username || 'TikTok',
		avatarUrl: user.avatar_url || creator?.avatarUrl
	};
}

export async function tiktokExchangeCode(
	args: { clientKey: string; clientSecret: string; code: string; appUrl: string },
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & ConnectionMeta> {
	const res = await fetchImpl(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_key: args.clientKey,
			client_secret: args.clientSecret,
			code: args.code,
			grant_type: 'authorization_code',
			redirect_uri: tiktokCallbackUrl(args.appUrl)
		})
	});
	const text = await res.text().catch(() => '');
	const tok = tokenFields(text);
	if (!res.ok || !tok.accessToken) {
		const { code, message } = parseTiktokError(text);
		throw Object.assign(
			new Error(
				`TikTok token exchange failed (${res.status}): ${message || code || text.slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	// The person can untick a scope on TikTok's consent page; without this one
	// nothing could ever be posted.
	if (tok.scopes && !tok.scopes.includes('video.publish')) throw new Error(NO_POSTING_MESSAGE);
	const user = await fetchUser(tok.accessToken, fetchImpl);
	const creator = await creatorAtConnect(tok.accessToken, fetchImpl);
	const openId = user.open_id || tok.openId;
	if (!openId) throw new Error('TikTok did not say which account this is');
	const who = identity(user, creator);
	return {
		accessToken: tok.accessToken,
		refreshToken: tok.refreshToken,
		expiresAt: tok.expiresAt,
		refreshExpiresAt: tok.refreshExpiresAt,
		tokenType: 'bearer',
		scopes: tok.scopes ?? TIKTOK_SCOPES,
		clientId: args.clientKey,
		clientSecret: args.clientSecret,
		tiktokOpenId: openId,
		tiktokUsername: who.username,
		handle: who.handle,
		displayName: who.displayName,
		avatarUrl: who.avatarUrl,
		maxCharacters: TIKTOK_MAX_CHARS,
		...creatorMeta(creator)
	};
}

export async function tiktokVerify(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<{
	displayName?: string;
	avatarUrl?: string;
	handle?: string;
	openId?: string;
	username?: string;
	meta: Partial<ConnectionMeta>;
}> {
	if (!creds.accessToken) throw new Error('Missing accessToken');
	const user = await fetchUser(creds.accessToken, fetchImpl);
	const creator = await creatorAtConnect(creds.accessToken, fetchImpl);
	const who = identity(user, creator);
	return {
		displayName: who.displayName,
		avatarUrl: who.avatarUrl,
		handle: who.handle,
		openId: user.open_id,
		username: who.username,
		meta: creatorMeta(creator)
	};
}
