import { and, eq, inArray } from 'drizzle-orm';
import { PLATFORM_LIMITS, platformLimit } from '#lib/domain/editor-limits.js';
import {
	ALLOWED_IMAGE_MIMES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_SEGMENT,
	MAX_VIDEO_BYTES,
	platformImageCap
} from '#lib/domain/media-limits.js';
import { platformName, PLATFORM_IDS, type PlatformId } from '#lib/domain/platforms.js';
import {
	codecName,
	formatDuration,
	videoLimitsFor,
	type VideoRuleMeta
} from '#lib/domain/video-rules.js';
import { parseJson, type AppDb } from './db/client';
import { connections } from './db/schema';
import { TIKTOK_PRIVACY_LEVELS, tiktokPrivacyOptions } from '#lib/domain/tiktok.js';
import { MAX_ALT_LENGTH, MAX_FILES_PER_DRAFT } from './draft-media';
import { UPLOAD_PART_BYTES } from './media-uploads';
import { getProvider, type ConnectionMeta, type PlatformProvider } from './providers/index';

/**
 * What each platform takes, for an agent to read before it builds a post.
 * Everything here is derived from the limits the composer and the providers
 * already enforce (provider capabilities and requirements, the video rules,
 * the text limits), so a platform added behind the Provider interface is
 * described without touching this file.
 */

export interface VideoRequirements {
	supported: boolean;
	mimes: string[];
	/** Codecs the platform takes (`avc` is H.264); null when any CogSend can read. */
	codecs: string[] | null;
	maxBytes: number;
	minBytes: number | null;
	minDurationMs: number | null;
	maxDurationMs: number | null;
	aspectRatio: { min: number; max: number; label: string } | null;
	maxWidth: number | null;
	maxPixels: number | null;
	minFps: number | null;
	maxFps: number | null;
	/** The file's index (moov) must come before its data. */
	faststart: boolean;
	/** A chosen cover image (set_video_cover) is sent with the video. */
	cover: boolean;
	perPost: 1;
	notes: string[];
}

export interface PlatformRequirements {
	platform: string;
	name: string;
	summary: string;
	text: { maxCharacters: number | null };
	threads: {
		supported: boolean;
		/** The thread is joined into one post, so media limits count every segment together. */
		flattened: boolean;
	};
	media: {
		required: boolean;
		mixImagesAndVideo: false;
		/** Whether the image and video counts below are per post or for the whole thread. */
		limitsApplyTo: 'segment' | 'post';
	};
	images: {
		maxPerPost: number;
		/** CogSend keeps at most this many attachments on one segment (one card in the composer). */
		maxPerSegment: number;
		mimes: string[];
		maxBytes: number;
		maxBytesByMime: Record<string, number>;
		aspectRatio: { min: number; max: number; label: string } | null;
	};
	video: VideoRequirements;
	altText: { images: boolean; videos: boolean; maxLength: number };
	notes: string[];
	/** TikTok only: the choices every post must carry (see TiktokPostChoice). */
	tiktok?: TiktokRequirements;
}

export interface TiktokRequirements {
	perPostChoices: {
		required: true;
		privacyLevels: string[];
		fields: Record<string, string>;
		rules: string[];
	};
}

/** What creator_info last said about one TikTok account. */
export interface TiktokAccountRequirements {
	/** Empty until creator_info was read; the composer or a reconnect reads it. */
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maxVideoSec: number | null;
}

export interface AccountRequirements {
	connectionId: string;
	platform: string;
	handle: string | null;
	displayName: string | null;
	status: string;
	text: { maxCharacters: number | null };
	video: VideoRequirements;
	tiktok?: TiktokAccountRequirements;
	summary: string;
}

/** The ways into CogSend's media store and their ceilings, whatever the platform. */
export interface StoreLimits {
	imageMimes: string[];
	videoMimes: string[];
	maxImageBytes: number;
	maxVideoBytes: number;
	maxMediaPerSegment: number;
	maxFilesPerDraft: number;
	maxAltTextLength: number;
	uploadPartBytes: number;
}

const TIKTOK_REQUIREMENTS: TiktokRequirements = {
	perPostChoices: {
		required: true,
		privacyLevels: [...TIKTOK_PRIVACY_LEVELS],
		fields: {
			privacy:
				'Who can see the post: one of the levels the account offers (accounts[].tiktok.privacyOptions)',
			allowComment: 'true or false',
			allowDuet: 'true or false',
			allowStitch: 'true or false',
			disclose: 'true when the post promotes a brand, product or service',
			yourBrand: "with disclose: promotes the operator's own business",
			brandedContent: 'with disclose: paid partnership promoting a third party',
			draft:
				'true to send the video to the TikTok inbox as a draft instead, with no other field: the creator adds the caption, picks who can see it and posts it in the TikTok app'
		},
		rules: [
			'Nothing has a default: every field but yourBrand, brandedContent and draft must be chosen for each post, unless draft is true',
			'A draft lands in the inbox without the caption; TikTok holds at most 5 waiting drafts from apps a day',
			'With disclose true, at least one of yourBrand and brandedContent must be true',
			'Branded content cannot be SELF_ONLY',
			'An interaction the creator turned off in the TikTok app stays off'
		]
	}
};

function megabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

function videoRequirements(
	provider: PlatformProvider,
	meta: VideoRuleMeta | null | undefined
): VideoRequirements {
	const limits = videoLimitsFor(provider.id, meta) ?? {};
	const notes = limits.maxMsNote ? [limits.maxMsNote] : [];
	return {
		supported: !provider.requirements?.noVideo,
		mimes: ['video/mp4'],
		codecs: limits.codecs ?? null,
		// CogSend stores nothing larger, whatever the platform would take.
		maxBytes: Math.min(limits.maxBytes ?? MAX_VIDEO_BYTES, MAX_VIDEO_BYTES),
		minBytes: limits.minBytes ?? null,
		minDurationMs: limits.minMs ?? null,
		maxDurationMs: limits.maxMs ?? null,
		aspectRatio: limits.aspect
			? { min: limits.aspect[0], max: limits.aspect[1], label: limits.aspect[2] }
			: null,
		maxWidth: limits.maxWidth ?? null,
		maxPixels: limits.maxPixels ?? null,
		minFps: limits.minFps ?? null,
		maxFps: limits.maxFps ?? null,
		faststart: Boolean(limits.faststart),
		cover: Boolean(provider.requirements?.videoCover),
		perPost: 1,
		notes
	};
}

function textLimit(platform: string, meta?: ConnectionMeta | null): number | null {
	if (!(platform in PLATFORM_LIMITS)) return null;
	return platformLimit(platform, meta ? [{ platform, metaJson: meta }] : []);
}

function videoSummary(video: VideoRequirements): string {
	if (!video.supported) return 'no video';
	const parts = [`MP4 up to ${megabytes(video.maxBytes)}`];
	if (video.minDurationMs && video.maxDurationMs) {
		parts.push(`${video.minDurationMs / 1000}s to ${formatDuration(video.maxDurationMs)}`);
	} else if (video.maxDurationMs) {
		parts.push(`up to ${formatDuration(video.maxDurationMs)}`);
	}
	if (video.codecs) parts.push(video.codecs.map(codecName).join(' or '));
	return `one video (${parts.join(', ')})`;
}

function summarize(r: Omit<PlatformRequirements, 'summary'>): string {
	const text = r.text.maxCharacters
		? `text up to ${r.text.maxCharacters.toLocaleString('en-US')} characters`
		: 'text';
	const types = r.images.mimes.map((m) => m.replace('image/', '').toUpperCase()).join('/');
	const where = r.media.limitsApplyTo === 'post' ? ' across the whole post' : ' per post';
	const images = `up to ${r.images.maxPerPost} images${where} (${types}, ${megabytes(r.images.maxBytes)} each)`;
	const parts = [text];
	if (r.images.maxPerPost === 0) {
		parts.push(
			`${r.media.required ? 'needs' : 'takes'} exactly ${videoSummary(r.video)}, no images`
		);
	} else {
		if (r.media.required) parts.push('needs at least one image or video');
		parts.push(`${images} or ${videoSummary(r.video)}, never both`);
	}
	if (r.threads.supported) parts.push('threads supported');
	else parts.push('no threads (segments are joined into one post)');
	if (r.tiktok)
		parts.push(
			'each post needs its privacy, comments, Duet, Stitch and disclosure chosen, no default, or draft: true to send it to the TikTok inbox (until TikTok audits the app, Direct Post is Only me and a draft is the way to a public post)'
		);
	return `${r.name}: ${parts.join('; ')}.`;
}

/** One platform, as its provider and the shared limits describe it. */
export function platformRequirements(
	platform: PlatformId | string,
	opts: { canMakeJpegCopies?: boolean } = {}
): PlatformRequirements {
	const provider = getProvider(platform);
	const declared = provider.requirements ?? {};
	const flattened = !provider.capabilities.supportsThreads;
	// Only the composer makes a JPEG copy at upload; an image attached through
	// MCP or the API gets one only from the Images binding.
	const mimes = [
		...(declared.imageMimes ?? ALLOWED_IMAGE_MIMES),
		...(opts.canMakeJpegCopies ? (declared.jpegCopyMimes ?? []) : [])
	];
	const maxBytesByMime: Record<string, number> = {};
	for (const mime of mimes) {
		maxBytesByMime[mime] = Math.min(
			platformImageCap(provider.id, mime) ?? provider.capabilities.maxImageBytes,
			MAX_IMAGE_BYTES
		);
	}
	const altText = declared.altText ?? { images: true, videos: true };
	const base: Omit<PlatformRequirements, 'summary'> = {
		platform: provider.id,
		name: platformName(provider.id),
		text: { maxCharacters: textLimit(provider.id) },
		threads: { supported: provider.capabilities.supportsThreads, flattened },
		media: {
			required: Boolean(declared.requiresMedia),
			mixImagesAndVideo: false,
			limitsApplyTo: flattened ? 'post' : 'segment'
		},
		images: {
			maxPerPost: flattened
				? provider.capabilities.maxImages
				: Math.min(provider.capabilities.maxImages, MAX_IMAGES_PER_SEGMENT),
			maxPerSegment: MAX_IMAGES_PER_SEGMENT,
			mimes,
			maxBytes: Math.min(
				maxBytesByMime['image/jpeg'] ?? provider.capabilities.maxImageBytes,
				MAX_IMAGE_BYTES
			),
			maxBytesByMime,
			aspectRatio: declared.imageAspect ? { ...declared.imageAspect } : null
		},
		video: videoRequirements(provider, null),
		altText: {
			images: altText.images,
			videos: altText.videos,
			maxLength: Math.min(altText.maxLength ?? MAX_ALT_LENGTH, MAX_ALT_LENGTH)
		},
		notes: [...(declared.notes ?? [])],
		...(provider.id === 'tiktok' ? { tiktok: TIKTOK_REQUIREMENTS } : {})
	};
	return { ...base, summary: summarize(base) };
}

export function storeLimits(): StoreLimits {
	return {
		imageMimes: [...ALLOWED_IMAGE_MIMES],
		videoMimes: ['video/mp4'],
		maxImageBytes: MAX_IMAGE_BYTES,
		maxVideoBytes: MAX_VIDEO_BYTES,
		maxMediaPerSegment: MAX_IMAGES_PER_SEGMENT,
		maxFilesPerDraft: MAX_FILES_PER_DRAFT,
		maxAltTextLength: MAX_ALT_LENGTH,
		uploadPartBytes: UPLOAD_PART_BYTES
	};
}

function accountRequirements(
	row: {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		status: string;
		metaJson: string | null;
	},
	platform: PlatformRequirements
): AccountRequirements {
	const meta = parseJson<ConnectionMeta>(row.metaJson, {});
	const provider = getProvider(row.platform);
	const video = videoRequirements(provider, meta);
	const maxCharacters = textLimit(row.platform, meta);
	const label = `${platform.name} ${row.handle ?? row.id}`;
	const tiktok: TiktokAccountRequirements | undefined =
		row.platform === 'tiktok'
			? {
					privacyOptions: tiktokPrivacyOptions({ privacyOptions: meta.tiktokPrivacyOptions }),
					commentDisabled: meta.tiktokCommentDisabled === true,
					duetDisabled: meta.tiktokDuetDisabled === true,
					stitchDisabled: meta.tiktokStitchDisabled === true,
					maxVideoSec: meta.tiktokMaxVideoSec ?? null
				}
			: undefined;
	const choices = tiktok
		? `; each post needs its TikTok choices${tiktok.privacyOptions.length ? `, privacy one of ${tiktok.privacyOptions.join(', ')}` : ''}`
		: '';
	const text = maxCharacters
		? `text up to ${maxCharacters.toLocaleString('en-US')} characters`
		: 'text';
	return {
		connectionId: row.id,
		platform: row.platform,
		handle: row.handle,
		displayName: row.displayName,
		status: row.status,
		text: { maxCharacters },
		video,
		...(tiktok ? { tiktok } : {}),
		summary: `${label}: ${text}; ${videoSummary(video)}${choices}${row.status === 'active' ? '' : `; account is ${row.status}`}.`
	};
}

/**
 * Every platform (or the ones asked for), plus each account asked for with
 * what its own connection changes: a Mastodon instance's limits, an X plan.
 */
export async function loadPlatformRequirements(
	db: AppDb,
	userId: string,
	opts: { platforms?: string[]; connectionIds?: string[]; canMakeJpegCopies?: boolean } = {}
): Promise<{
	platforms: PlatformRequirements[];
	accounts: AccountRequirements[];
	store: StoreLimits;
}> {
	const wanted = new Set<string>(opts.platforms ?? []);
	const rows = opts.connectionIds?.length
		? await db
				.select({
					id: connections.id,
					platform: connections.platform,
					handle: connections.handle,
					displayName: connections.displayName,
					status: connections.status,
					metaJson: connections.metaJson
				})
				.from(connections)
				.where(and(eq(connections.userId, userId), inArray(connections.id, opts.connectionIds)))
		: [];
	const known = rows.filter((row) => (PLATFORM_IDS as string[]).includes(row.platform));
	const missing = (opts.connectionIds ?? []).filter((id) => !known.some((row) => row.id === id));
	if (missing.length) {
		throw Object.assign(new Error(`Connection not found: ${missing.join(', ')}`), { status: 404 });
	}
	for (const row of known) wanted.add(row.platform);
	const platforms = PLATFORM_IDS.filter((p) => !wanted.size || wanted.has(p)).map((p) =>
		platformRequirements(p, { canMakeJpegCopies: opts.canMakeJpegCopies })
	);
	const byPlatform = new Map(platforms.map((p) => [p.platform, p]));
	const accounts = known.map((row) => accountRequirements(row, byPlatform.get(row.platform)!));
	return { platforms, accounts, store: storeLimits() };
}
