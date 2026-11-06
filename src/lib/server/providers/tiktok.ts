import {
	MAX_IMAGE_BYTES,
	TIKTOK_MAX_PHOTOS,
	tiktokMediaProblems
} from '#lib/domain/media-limits.js';
import {
	tiktokChoiceMade,
	tiktokChoiceProblem,
	tiktokPostInfo,
	TIKTOK_PRIVACY_MISSING_MESSAGE,
	type TiktokPrivacy
} from '#lib/domain/tiktok.js';
import { TIKTOK_MAX_CHARS, validateTiktokText } from '#lib/domain/validation/text.js';
import { TIKTOK_RECONNECT_MESSAGE } from '#lib/domain/metrics.js';
import { singlePost } from './flatten';
import { providerFetch } from './timed-fetch';
import {
	MetricsError,
	processingError,
	ProviderError,
	resumedVideoState,
	retryAfterFrom,
	unconfirmedPostError,
	credentialsAfterRefreshFailure
} from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	MetricsOutcome,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import {
	PART_UPLOAD_MS,
	pollVideo,
	openVideoRange,
	requireMediaReader,
	segmentVideo,
	storedVideoSize,
	videoValidation
} from './video';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
const TOKEN_URL = `${API}/oauth/token/`;
const REVOKE_URL = `${API}/oauth/revoke/`;
// video.publish covers creator_info, Direct Post and the status fetch;
// creator_info also names the account, so user.info.profile is not needed.
// video.upload sends a video to the creator's inbox as a draft; TikTok bundles
// it with the Content Posting API, so every app that can post has it.
// video.list reads the counts of the account's own videos (metrics). A
// connection made before it was asked for keeps working for posting and is
// shown "reconnect to enable metrics".
export const TIKTOK_METRICS_SCOPE = 'video.list';
export const TIKTOK_DRAFT_SCOPE = 'video.upload';
export const TIKTOK_POSTING_SCOPES = ['user.info.basic', 'video.publish', TIKTOK_DRAFT_SCOPE];
export const TIKTOK_SCOPES = [...TIKTOK_POSTING_SCOPES, TIKTOK_METRICS_SCOPE];

/** What to ask TikTok for: video.list only when the app has it (TIKTOK_METRICS). */
export function tiktokScopes(metrics: boolean): string[] {
	return metrics ? TIKTOK_SCOPES : TIKTOK_POSTING_SCOPES;
}
/** /v2/video/query/ takes up to 20 video ids per request. */
export const TIKTOK_METRICS_BATCH = 20;
const VIDEO_METRIC_FIELDS = 'id,view_count,like_count,comment_count,share_count';
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

const DRAFT_SCOPE_MESSAGE =
	'This TikTok account was connected before CogSend could send drafts — reconnect it on the Accounts page, or post it directly instead';

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
		case 'spam_risk_too_many_pending_share':
			return new ProviderError(
				'TikTok holds at most 5 drafts from apps waiting in the inbox a day — post or delete the ones there; it is tried again in an hour',
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

/** TikTok's photo post page, once a public post has an id. */
export function tiktokPhotoUrl(username: string | undefined, postId: string | undefined) {
	if (!username || !postId) return undefined;
	return `https://www.tiktok.com/@${encodeURIComponent(username)}/photo/${postId}`;
}

const PHOTO_URL_MESSAGE =
	'TikTok photo posts are pulled from a URL TikTok has verified for this app: set TIKTOK_SITE_VERIFICATION and verify the CogSend address in the TikTok developer portal';

interface PhotoPublishInput {
	token: string;
	text: string;
	content: NormalizedPost;
	photos: MediaAttachment[];
	creds: ConnectionCredentials;
	fetchImpl: FetchLike;
	opts: Parameters<PlatformProvider['publish']>[4];
}

/**
 * A photo post: TikTok pulls every image from a signed URL on the verified
 * address, so nothing is uploaded from here and one init call starts it. Like
 * a pulled video, an init that got no answer may still post, so it is never
 * sent twice; the publish id rides in the parked state until TikTok settles.
 */
async function publishTiktokPhotos(input: PhotoPublishInput): Promise<PublishResult> {
	const { token, text, content, photos, creds, fetchImpl, opts } = input;
	const firstKey = photos[0].storageKey!;
	const callsLeft = opts?.callsLeft ?? (() => Infinity);
	const timeLeft = opts?.timeLeft ?? (() => Infinity);
	const startedAt = opts?.resume?.pending?.startedAt;
	const draft = content.options?.tiktok?.draft === true;
	const park = (publishId: string, retryAfterMs: number): never => {
		throw processingError(
			'TikTok',
			{ segment: 0, storageKey: firstKey, state: { publishId, photo: true } },
			retryAfterMs
		);
	};

	const resumed = resumedVideoState(opts?.resume, 0, firstKey);
	let publishId = typeof resumed?.publishId === 'string' ? resumed.publishId : '';
	let sentThisRun = false;
	if (!publishId) {
		if (draft && creds.scopes && !creds.scopes.includes(TIKTOK_DRAFT_SCOPE)) {
			throw new ProviderError(DRAFT_SCOPE_MESSAGE, { code: 'forbidden' });
		}
		if (!tiktokChoiceMade(content.options?.tiktok)) {
			throw new ProviderError(
				`${TIKTOK_PRIVACY_MISSING_MESSAGE}: open the post in the composer and pick who can see it`,
				{ code: 'forbidden' }
			);
		}
		if (!opts?.verifiedMediaUrlFor) {
			throw new ProviderError(PHOTO_URL_MESSAGE, { code: 'forbidden' });
		}
		const urls: string[] = [];
		for (const photo of photos) {
			const mime = (photo.mime || '').toLowerCase();
			const asJpeg = mime === 'image/png' && photo.hasJpegCopy;
			const url = await opts.verifiedMediaUrlFor(photo.storageKey!, asJpeg ? 'jpeg' : undefined);
			if (!url) throw new ProviderError(PHOTO_URL_MESSAGE, { code: 'forbidden' });
			urls.push(url);
		}
		let postInfo: Record<string, unknown>;
		const title = content.options?.tiktok?.title;
		if (draft) {
			postInfo = {
				...(title ? { title } : {}),
				...(text ? { description: text } : {})
			};
		} else {
			const creator = await tiktokCreatorInfo(token, fetchImpl);
			const choice = content.options?.tiktok;
			const problem = tiktokChoiceProblem(choice, creator);
			if (problem) {
				throw new ProviderError(problem, {
					code: 'forbidden',
					metaPatch: creatorMeta(creator),
					detail: creator.privacyOptions.join(',')
				});
			}
			const made = choice as NonNullable<typeof choice> & { privacy: TiktokPrivacy };
			postInfo = {
				privacy_level: made.privacy,
				disable_comment: !made.allowComment || creator.commentDisabled === true,
				// TikTok adds a recommended sound, as a photo post in its own app does.
				auto_add_music: true,
				brand_content_toggle: made.disclose && made.brandedContent,
				brand_organic_toggle: made.disclose && made.yourBrand,
				...(title ? { title } : {}),
				...(text ? { description: text } : {})
			};
		}
		let res: Response;
		try {
			res = await apiPost(
				'/post/publish/content/init/',
				token,
				{
					post_info: postInfo,
					source_info: {
						source: 'PULL_FROM_URL',
						photo_cover_index: 0,
						photo_images: urls
					},
					post_mode: draft ? 'MEDIA_UPLOAD' : 'DIRECT_POST',
					media_type: 'PHOTO'
				},
				fetchImpl
			);
		} catch {
			throw unconfirmedPostError('TikTok', new Error('no answer to the photo post request'));
		}
		let data: { publish_id?: unknown };
		try {
			data = await tiktokData<{ publish_id?: unknown }>(res, 'TikTok photo post');
		} catch (err) {
			if (err instanceof ProviderError && err.message === URL_UNVERIFIED_MESSAGE) {
				throw new ProviderError(PHOTO_URL_MESSAGE, { code: 'forbidden' });
			}
			if (err instanceof ProviderError && err.code === 'upstream') {
				throw unconfirmedPostError('TikTok', err);
			}
			throw err;
		}
		if (typeof data.publish_id !== 'string' || !data.publish_id) {
			throw new ProviderError('TikTok returned no publish id', { code: 'upstream' });
		}
		publishId = data.publish_id;
		sentThisRun = true;
	}

	const outcome = await pollVideo(
		{ polls: STATUS_POLLS, delayMs: STATUS_POLL_MS, reserve: STATUS_RESERVE, callsLeft, timeLeft },
		async (): Promise<{ postId?: string } | null> => {
			const status = await postStatus(token, publishId, fetchImpl);
			if (!status) return null;
			if (status.status === 'PUBLISH_COMPLETE' || status.status === 'SEND_TO_USER_INBOX') {
				return { postId: status.postId };
			}
			if (status.status === 'FAILED') {
				// A photo pull that failed published nothing; a retry is a fresh post.
				if (failedPost(status.failReason) === 'restart') {
					throw new ProviderError('TikTok did not take the photos — it is tried again', {
						code: 'upstream'
					});
				}
			}
			return null;
		}
	);
	if (outcome) {
		const remotePostId = outcome.postId ?? publishId;
		await opts?.checkpoint?.({ segmentIds: [remotePostId] });
		return { remotePostId, remoteUrl: tiktokPhotoUrl(creds.tiktokUsername, outcome.postId) };
	}
	if (!sentThisRun && startedAt && Date.now() - startedAt > CONFIRM_WINDOW_MS) {
		throw unconfirmedPostError('TikTok', new Error(`still processing publish ${publishId}`));
	}
	return park(publishId, STATUS_RETRY_MS);
}

export const tiktokProvider: PlatformProvider = {
	id: 'tiktok',
	capabilities: {
		maxImages: TIKTOK_MAX_PHOTOS,
		maxImageBytes: MAX_IMAGE_BYTES,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: false
	},
	requirements: {
		imageMimes: ['image/jpeg', 'image/webp'],
		jpegCopyMimes: ['image/png'],
		requiresMedia: true,
		altText: { images: false, videos: false },
		notes: [
			'One video on its own, or a photo post (carousel) of 1 to 20 JPEG or WebP images in order, the first one the cover; TikTok wants photos at most 1080p',
			'Photo posts are pulled from the CogSend address TikTok verified for the app; TikTok adds a recommended sound to a direct photo post',
			'Who can see it, comments, Duet, Stitch and the commercial-content disclosure are chosen for each post, from what TikTok offers the account, with no default',
			'Until TikTok audits the app, Direct Post can only post as Only me',
			'For a public post before then, send it as a draft (draft: true): the video lands in the TikTok inbox without the caption, and the creator chooses who can see it and posts it in the TikTok app'
		]
	},

	validate(content, meta): ValidationIssue[] {
		const { text, media } = singlePost(content);
		const issues: ValidationIssue[] = [];
		const checked = validateTiktokText(text);
		if (!checked.ok) issues.push({ field: 'text', message: checked.message ?? 'Caption too long' });
		const problems = tiktokMediaProblems(media);
		for (const message of problems) issues.push({ field: 'media', message, code: 'tiktok_media' });
		if (problems.length) return issues;
		if (segmentVideo(media)) issues.push(...videoValidation('tiktok', media, meta, 'media'));
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
		const photos = media.filter(
			(m) => m.storageKey && (m.mime || '').toLowerCase().startsWith('image/')
		);
		if (!video && photos.length && !tiktokMediaProblems(media).length) {
			return publishTiktokPhotos({ token, text, content, photos, creds, fetchImpl, opts });
		}
		if (!video?.storageKey) {
			throw new ProviderError(tiktokMediaProblems(media)[0] ?? 'TikTok needs a video', {
				code: 'forbidden'
			});
		}
		const draft = content.options?.tiktok?.draft === true;
		if (draft && creds.scopes && !creds.scopes.includes(TIKTOK_DRAFT_SCOPE)) {
			throw new ProviderError(DRAFT_SCOPE_MESSAGE, { code: 'forbidden' });
		}
		// Inbox uploads take no post_info: the caption and every choice are the
		// creator's to make in the TikTok app.
		const initPath = draft ? '/post/publish/inbox/video/init/' : '/post/publish/video/init/';
		if (!tiktokChoiceMade(content.options?.tiktok)) {
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
		async function beginPull(info: Record<string, unknown> | null): Promise<UploadState | null> {
			let res: Response;
			try {
				res = await apiPost(
					initPath,
					token!,
					{
						...(info ? { post_info: info } : {}),
						source_info: { source: 'PULL_FROM_URL', video_url: pullUrl }
					},
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
			const info = draft
				? null
				: postInfo(text, content, await tiktokCreatorInfo(token!, fetchImpl), video!);
			if (pullUrl) {
				const pulled = await beginPull(info);
				if (pulled) return pulled;
			}
			const reader = requireMediaReader(opts?.mediaReader);
			const size = await storedVideoSize(reader, storageKey);
			const plan = tiktokChunkPlan(size);
			const data = await tiktokData<{ publish_id?: unknown; upload_url?: unknown }>(
				await apiPost(
					initPath,
					token!,
					{
						...(info ? { post_info: info } : {}),
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
				// Streamed, not read into memory: copying 20 MB a part costs CPU time.
				const part = await openVideoRange(
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
							'Content-Length': String(part.length),
							'Content-Range': `bytes ${start}-${end}/${current.size}`
						},
						body: part.body,
						duplex: 'half'
					} as RequestInit);
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
			return credentialsAfterRefreshFailure('TikTok', creds);
		}
		const text = await res.text().catch(() => '');
		// Keep a still-valid token during an outage, but defer if it has run out;
		// a refusal of the refresh token expires the account.
		if (res.status === 429 || res.status >= 500)
			return credentialsAfterRefreshFailure('TikTok', creds);
		const tok = tokenFields(text);
		if (!tok.accessToken) {
			const { code } = parseTiktokError(text);
			if (res.ok && !code) return credentialsAfterRefreshFailure('TikTok', creds);
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
	},

	metricsBatchSize: TIKTOK_METRICS_BATCH,
	fetchMetrics: (ids, creds, _meta, fetchImpl) => tiktokMetrics(ids, creds, fetchImpl)
};

/**
 * View, like, comment and share counts from the Display API's video query
 * (scope video.list), which only answers for the account's own public videos.
 * A post TikTok never gave a public id for (a private post, or one still in
 * moderation when CogSend stopped asking) is stored under its publish id and
 * cannot be looked up; an id TikTok leaves out of the answer is gone or no
 * longer public.
 */
export async function tiktokMetrics(
	ids: string[],
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<Map<string, MetricsOutcome>> {
	if (!creds.accessToken)
		throw new MetricsError('reconnect', 'TikTok sign-in is missing — reconnect');
	if (creds.scopes && !creds.scopes.includes(TIKTOK_METRICS_SCOPE))
		throw new MetricsError('reconnect', TIKTOK_RECONNECT_MESSAGE);
	const out = new Map<string, MetricsOutcome>();
	const videoIds: string[] = [];
	for (const id of ids.slice(0, TIKTOK_METRICS_BATCH)) {
		if (/^\d{5,25}$/.test(id)) videoIds.push(id);
		else
			out.set(id, {
				kind: 'unavailable',
				reason:
					'TikTok gave no public video id for this post (private, or not public yet when it was published), so it has no stats to read.'
			});
	}
	if (!videoIds.length) return out;
	let res: Response;
	try {
		res = await fetchImpl(`${API}/video/query/?fields=${VIDEO_METRIC_FIELDS}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ filters: { video_ids: videoIds } })
		});
	} catch (err) {
		throw new MetricsError(
			'transient',
			`TikTok video query: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	const text = await res.text().catch(() => '');
	let body: { data?: { videos?: unknown }; error?: { code?: unknown } } = {};
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		/* classified below by status */
	}
	const code = body?.error && typeof body.error === 'object' ? body.error.code : undefined;
	if (!res.ok || (code !== undefined && code !== 'ok')) {
		const { message } = parseTiktokError(text);
		const said = `TikTok video query failed (${res.status})${code ? ` [${String(code)}]` : ''}${message ? `: ${message}` : ''}`;
		if (code === 'scope_not_authorized' || code === 'scope_permission_missed')
			throw new MetricsError('reconnect', `${said} — reconnect to enable metrics`, {
				status: res.status
			});
		if (code === 'access_token_invalid' || res.status === 401)
			throw new MetricsError('reconnect', `${said} — reconnect`, { status: res.status });
		if (code === 'rate_limit_exceeded' || res.status === 429)
			throw new MetricsError('rate_limited', said, {
				status: res.status,
				retryAfterMs: retryAfterFrom(res.headers)
			});
		throw new MetricsError('transient', said, { status: res.status });
	}
	const videos = Array.isArray(body.data?.videos)
		? (body.data.videos as Array<Record<string, unknown>>)
		: [];
	const byId = new Map<string, Record<string, unknown>>();
	for (const video of videos) {
		if (video && (typeof video.id === 'string' || typeof video.id === 'number'))
			byId.set(String(video.id), video);
	}
	for (const id of videoIds) {
		const video = byId.get(id);
		if (!video) {
			out.set(id, { kind: 'not_found' });
			continue;
		}
		out.set(id, {
			kind: 'ok',
			counts: {
				views: countOf(video.view_count),
				likes: countOf(video.like_count),
				comments: countOf(video.comment_count),
				shares: countOf(video.share_count)
			}
		});
	}
	return out;
}

function countOf(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

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

export function tiktokAuthorizeUrl(
	clientKey: string,
	appUrl: string,
	state: string,
	scopes: string[] = TIKTOK_SCOPES
): string {
	const params = new URLSearchParams({
		client_key: clientKey,
		scope: scopes.join(','),
		response_type: 'code',
		redirect_uri: tiktokCallbackUrl(appUrl),
		state,
		// Always show TikTok's consent page, even when this user already granted access.
		disable_auto_auth: '1'
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

/**
 * Withdraws CogSend's access on TikTok, so a reconnect starts from a fresh
 * consent page. Best effort: a disconnect still goes through locally when
 * TikTok is unreachable or the token has already expired.
 */
export async function tiktokRevoke(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike = providerFetch
): Promise<boolean> {
	if (!creds.accessToken || !creds.clientId || !creds.clientSecret) return false;
	try {
		const res = await fetchImpl(REVOKE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_key: creds.clientId,
				client_secret: creds.clientSecret,
				token: creds.accessToken
			})
		});
		return res.ok;
	} catch {
		return false;
	}
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
