import { and, eq, inArray } from 'drizzle-orm';
import { jpegCopyExpected } from '#lib/domain/media-limits.js';
import { platformName } from '#lib/domain/platforms.js';
import { first, parseJson } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets } from '#lib/server/db/schema.js';
import type { StoredImageMeta } from '#lib/server/media.js';
import { buildNormalizedPost } from '#lib/server/publish.js';
import {
	providerFor,
	type ConnectionMeta,
	type MediaAttachment,
	type NormalizedPost,
	type ValidationIssue
} from '#lib/server/providers/index.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import type { OperationContext } from '#lib/server/api/operations.js';

/**
 * A draft checked the way publishing will check it, once per account: the
 * provider's own `validate` over the post that would be sent, so what this
 * reports is exactly what would fail later, in words an agent can act on.
 */

export interface DraftIssue {
	kind: 'media' | 'text' | 'post' | 'account';
	message: string;
	code?: string;
	field?: string;
	/** 1-based position in the thread as it would be published. */
	post?: number;
	attached?: { images: number; videos: number };
}

export interface AccountCheck {
	connectionId: string;
	platform: string;
	handle: string | null;
	label: string;
	ok: boolean;
	issues: DraftIssue[];
}

export interface DraftCheck {
	draftId: string;
	ok: boolean;
	accounts: AccountCheck[];
	/** Every issue as one line, `Platform @handle: what is wrong`. */
	problems: string[];
}

const MEDIA_CODES = new Set([
	'video',
	'video_mix',
	'instagram_media',
	'max_images',
	'max_videos',
	'max_gifs',
	'gif_with_images',
	'video_with_images',
	'max_image_bytes',
	'bad_image_type',
	'mime'
]);

function kindOf(issue: ValidationIssue): DraftIssue['kind'] {
	const field = issue.field ?? '';
	if (/media/.test(field) || (issue.code && MEDIA_CODES.has(issue.code))) return 'media';
	if (/text|poll/.test(field) || issue.code === 'max_length') return 'text';
	return 'post';
}

function counts(media: MediaAttachment[] | undefined) {
	const list = media ?? [];
	const videos = list.filter((m) => (m.mime || '').toLowerCase().startsWith('video/')).length;
	return { images: list.length - videos, videos };
}

function accountLabel(platform: string, handle: string | null): string {
	if (!handle) return platformName(platform);
	return `${platformName(platform)} ${handle.startsWith('@') ? handle : `@${handle}`}`;
}

/** The whole post's media for a platform that joins a thread into one post. */
function allMedia(content: NormalizedPost): MediaAttachment[] {
	return content.thread?.length
		? content.thread.flatMap((seg) => seg.media ?? [])
		: (content.media ?? []);
}

function describe(issue: ValidationIssue, content: NormalizedPost, flattened: boolean): DraftIssue {
	const kind = kindOf(issue);
	const segment = /^thread\[(\d+)\]/.exec(issue.field ?? '');
	const index = segment ? Number(segment[1]) : null;
	const out: DraftIssue = { kind, message: issue.message };
	if (issue.code) out.code = issue.code;
	if (issue.field) out.field = issue.field;
	if (index !== null && (content.thread?.length ?? 0) > 1) out.post = index + 1;
	if (kind === 'media') {
		const media =
			index !== null && content.thread?.length
				? content.thread[index]?.media
				: flattened
					? allMedia(content)
					: content.media;
		out.attached = counts(media);
	}
	return out;
}

function line(label: string, issue: DraftIssue): string {
	const where = issue.post ? ` (post ${issue.post})` : '';
	let message = issue.message;
	if (issue.attached && (issue.code === 'max_images' || issue.code === 'max_videos')) {
		const { images, videos } = issue.attached;
		message += issue.code === 'max_images' ? `, ${images} attached` : `, ${videos} attached`;
	}
	return `${label}${where}: ${message}`;
}

/**
 * Instagram's PNG and WebP go as a JPEG copy, which the Images binding makes
 * when the post is scheduled. Checked before that, the copy is not there yet,
 * so count the ones it will make, as the composer does.
 */
async function withExpectedJpegCopies(
	ctx: OperationContext,
	draftId: string,
	content: NormalizedPost
): Promise<NormalizedPost> {
	const canMake = Boolean((ctx.bindings as { IMAGES?: unknown } | undefined)?.IMAGES);
	if (!canMake) return content;
	const rows = await ctx.db
		.select({ storageKey: draftMedia.storageKey, metaJson: draftMedia.metaJson })
		.from(draftMedia)
		.where(eq(draftMedia.draftId, draftId));
	const expected = new Set(
		rows
			.filter((row) => jpegCopyExpected(parseJson<StoredImageMeta>(row.metaJson, {}), true))
			.map((row) => row.storageKey)
	);
	const mark = (media?: MediaAttachment[]) =>
		media?.map((m) =>
			m.storageKey && expected.has(m.storageKey) ? { ...m, hasJpegCopy: true } : m
		);
	return {
		...content,
		media: mark(content.media),
		thread: content.thread?.map((seg) => ({ ...seg, media: mark(seg.media) }))
	};
}

/**
 * Check a draft for each account it would go to: `connectionIds` when given,
 * else the draft's own selection, else every active account.
 */
export async function checkDraft(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	connectionIds?: string[]
): Promise<DraftCheck> {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) throw new ApiOperationError('Not found', 404);
	const selected = parseJson<unknown>(draft.selectedConnectionIds, null);
	const ids = connectionIds?.length
		? connectionIds
		: Array.isArray(selected)
			? selected.filter((id): id is string => typeof id === 'string')
			: null;
	const rows = await ctx.db
		.select()
		.from(connections)
		.where(
			ids
				? and(eq(connections.userId, userId), inArray(connections.id, ids.length ? ids : ['']))
				: and(eq(connections.userId, userId), eq(connections.status, 'active'))
		);
	if (connectionIds?.length) {
		const missing = connectionIds.filter((id) => !rows.some((row) => row.id === id));
		if (missing.length) {
			throw new ApiOperationError(`Connection not found: ${missing.join(', ')}`, 404);
		}
	}
	const posts = new Map<string, NormalizedPost>();
	const accounts: AccountCheck[] = [];
	for (const row of rows) {
		const label = accountLabel(row.platform, row.handle);
		const issues: DraftIssue[] = [];
		if (row.status !== 'active') {
			issues.push({ kind: 'account', message: 'Account needs reconnect', code: 'inactive' });
		}
		let provider;
		try {
			provider = providerFor(row);
		} catch {
			issues.push({ kind: 'account', message: 'CogSend cannot post to this platform' });
		}
		if (provider) {
			let content = posts.get(row.platform);
			if (!content) {
				content = await buildNormalizedPost(ctx.db, draftId, row.platform);
				if (row.platform === 'instagram') {
					content = await withExpectedJpegCopies(ctx, draftId, content);
				}
				posts.set(row.platform, content);
			}
			const meta = parseJson<ConnectionMeta>(row.metaJson, {});
			const found = provider.validate(content, {
				...meta,
				handle: meta.handle || row.handle || undefined
			});
			const flattened = !provider.capabilities.supportsThreads;
			for (const issue of found) issues.push(describe(issue, content, flattened));
		}
		accounts.push({
			connectionId: row.id,
			platform: row.platform,
			handle: row.handle,
			label,
			ok: issues.length === 0,
			issues
		});
	}
	const problems = accounts.flatMap((account) =>
		account.issues.map((issue) => line(account.label, issue))
	);
	return { draftId, ok: problems.length === 0, accounts, problems };
}

/**
 * Refuse a publish or schedule whose media a platform is certain to refuse,
 * before anything is written, naming every account and what to fix. Accounts
 * already published are left out: they will not be sent again.
 */
export async function refuseMediaProblems(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	connectionIds: string[]
): Promise<void> {
	const owned = await ctx.db
		.select({ id: connections.id })
		.from(connections)
		.where(and(eq(connections.userId, userId), inArray(connections.id, connectionIds)));
	// Unknown accounts are the operation's to refuse, with its own message.
	if (owned.length !== new Set(connectionIds).size) return;
	const published = await ctx.db
		.select({ connectionId: publishTargets.connectionId, status: publishTargets.status })
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	const done = new Set(
		published.filter((t) => t.status === 'published').map((t) => t.connectionId)
	);
	const pending = connectionIds.filter((id) => !done.has(id));
	if (!pending.length) return;
	const check = await checkDraft(ctx, userId, draftId, pending);
	const accounts = check.accounts
		.map((account) => ({
			...account,
			issues: account.issues.filter((issue) => issue.kind === 'media')
		}))
		.filter((account) => account.issues.length > 0);
	if (!accounts.length) return;
	const problems = accounts.flatMap((account) =>
		account.issues.map((issue) => line(account.label, issue))
	);
	const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
	throw new ApiOperationError(`${problems[0]}${more}`, 400, {
		problems,
		accounts: accounts.map(({ connectionId, platform, handle, label, issues }) => ({
			connectionId,
			platform,
			handle,
			label,
			issues
		}))
	});
}
