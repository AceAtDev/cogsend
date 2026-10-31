import { and, asc, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
	candidateLines,
	describeRef,
	displayAt,
	resolveChannelRef,
	UNBRANDED_COLOR,
	UNBRANDED_SLUG,
	type BrandRef,
	type Channel,
	type ChannelRef
} from '#lib/domain/channel-keys.js';
import { draftExcerpt } from '#lib/domain/excerpt.js';
import { isPlatformId, platformName, PLATFORM_ORDER } from '#lib/domain/platforms.js';
import {
	describeInstant,
	parseRunAt,
	zonedLocalToUtc,
	type InstantView,
	type RunAtInput
} from '#lib/domain/zoned-time.js';
import { loadChannels } from '#lib/server/brands.js';
import { chunkIds, first, parseJson } from '#lib/server/db/client.js';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets
} from '#lib/server/db/schema.js';
import { loadOwnedDraft } from '#lib/server/draft-record.js';
import { normalizeDraftContent } from '#lib/server/publish.js';
import { platformRequirements } from '#lib/server/platform-requirements.js';
import { refuseInFlightOrPublished } from '#lib/server/publish-plan.js';
import { providerFor, type ConnectionMeta } from '#lib/server/providers/index.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import {
	accountLabel,
	checkDraft,
	describeIssue,
	issueLine,
	refuseMediaProblems,
	withExpectedJpegCopies,
	type DraftIssue
} from '#lib/server/api/draft-checks.js';
import { attachMediaFromUrl } from '#lib/server/api/media-operations.js';
import {
	cancelDelivery,
	createDraft,
	deleteDraft,
	duplicateDraft,
	publishDraft,
	rescheduleDelivery,
	scheduleDraft,
	setDraftVariant,
	updateDraft,
	type OperationContext
} from '#lib/server/api/operations.js';
import {
	consumeConfirmation,
	hashPayload,
	issueConfirmation,
	peekIdempotent,
	withIdempotency
} from '#lib/server/api/mcp-safety.js';

/**
 * The workflows behind the MCP tools. Posts are drafts and deliveries are
 * publish targets, but an agent only ever sees channel keys, brands, handles
 * and times in the operator's zone, and every write is planned in full,
 * checked, and only then carried out.
 */

export interface AgentContext {
	ctx: OperationContext;
	userId: string;
	timeZone: string;
	now: Date;
}

type Directory = { brands: BrandRef[]; channels: Channel[] };

/** Same-channel posts closer than this are flagged in a preview. */
export const CONFLICT_WINDOW_MS = 60 * 60_000;
export const MAX_BATCH_POSTS = 10;
export const MAX_BATCH_DELIVERIES = 20;

const WAITING = ['scheduled', 'pending', 'failed'] as const;

function fail(message: string, details?: Record<string, unknown>, status = 400): never {
	throw new ApiOperationError(message, status, details);
}

export function channelView(c: Channel) {
	return {
		key: c.key,
		brand: c.brand.name,
		brandSlug: c.brand.slug,
		brandColor: c.brand.color,
		platform: c.platform,
		handle: c.handle ? displayAt(c.handle) : null,
		displayName: c.displayName,
		status: c.status,
		connectionId: c.connectionId
	};
}
export type ChannelView = ReturnType<typeof channelView>;

function channelLabel(c: Channel): string {
	return `${c.key} (${c.brand.name}, ${c.platformName} ${displayAt(c.handle)})`;
}

/** A delivery whose account was disconnected still shows what it was. */
function orphanView(row: { id: string; platform: string; handle: string | null }): ChannelView {
	return {
		key: '',
		brand: 'Disconnected',
		brandSlug: '',
		brandColor: UNBRANDED_COLOR,
		platform: row.platform,
		handle: row.handle ? displayAt(row.handle) : null,
		displayName: null,
		status: 'disconnected',
		connectionId: row.id
	};
}

interface Resolved {
	channels: Channel[];
	problems: string[];
	unresolved: Array<{ field: string; ref: string; reason: string; candidates: ChannelView[] }>;
}

function resolveRefs(
	refs: ChannelRef[],
	dir: Directory,
	field: string,
	requireActive: boolean
): Resolved {
	const out: Resolved = { channels: [], problems: [], unresolved: [] };
	const seen = new Map<string, string>();
	refs.forEach((ref, i) => {
		const where = `${field}[${i}]`;
		const result = resolveChannelRef(ref, dir.channels, dir.brands, { requireActive });
		if (!result.ok) {
			const valid = candidateLines(result.candidates.slice(0, 12));
			out.problems.push(
				`${where}: ${result.message}${valid.length ? ` Valid channels: ${valid.join('; ')}.` : ' No connected channel matches.'}`
			);
			out.unresolved.push({
				field: where,
				ref: result.ref,
				reason: result.reason,
				candidates: result.candidates.map(channelView)
			});
			return;
		}
		const earlier = seen.get(result.channel.connectionId);
		if (earlier) {
			out.problems.push(
				`${where}: "${describeRef(ref)}" is the same channel as ${earlier} (${result.channel.key}). List each channel once.`
			);
			return;
		}
		seen.set(result.channel.connectionId, where);
		out.channels.push(result.channel);
	});
	return out;
}

/** Resolve or refuse, naming every bad reference and what would have been valid. */
async function resolveOrFail(
	agent: AgentContext,
	refs: ChannelRef[],
	field: string,
	requireActive: boolean,
	example: string
): Promise<{ dir: Directory; channels: Channel[] }> {
	const dir = await loadChannels(agent.ctx.db, agent.userId);
	const resolved = resolveRefs(refs, dir, field, requireActive);
	if (resolved.problems.length) {
		fail(resolved.problems[0], {
			code: 'channel_unresolved',
			problems: resolved.problems,
			unresolved: resolved.unresolved,
			example
		});
	}
	return { dir, channels: resolved.channels };
}

function view(at: Date | number | null | undefined, timeZone: string): InstantView | null {
	if (at === null || at === undefined) return null;
	return describeInstant(at, timeZone);
}

function nowView(agent: AgentContext) {
	return describeInstant(agent.now, agent.timeZone);
}

export async function listChannelsOp(agent: AgentContext) {
	const { ctx, userId, timeZone } = agent;
	const dir = await loadChannels(ctx.db, userId);
	const groups = [
		...dir.brands.map((b) => ({ name: b.name, slug: b.slug, color: b.color, id: b.id })),
		{ name: 'Unbranded', slug: UNBRANDED_SLUG, color: UNBRANDED_COLOR, id: null as string | null }
	]
		.map((b) => ({
			name: b.name,
			slug: b.slug,
			color: b.color,
			channels: dir.channels.filter((c) => c.brand.id === b.id).map(channelView)
		}))
		.filter((b) => b.channels.length || b.slug !== UNBRANDED_SLUG);
	const platforms = PLATFORM_ORDER.filter((p) => dir.channels.some((c) => c.platform === p)).map(
		(p) => ({ platform: p, name: platformName(p), summary: platformRequirements(p).summary })
	);
	const lines = groups.map((g) => {
		const list = g.channels.length
			? g.channels
					.map(
						(c) =>
							`  ${c.key} — ${c.handle ?? '(no handle)'}${c.status === 'active' ? '' : ` [${c.status}]`}`
					)
					.join('\n')
			: '  (no channels)';
		return `${g.name}:\n${list}`;
	});
	const now = nowView(agent);
	return {
		now,
		timeZone,
		brands: groups,
		platforms,
		summary: [
			`Now: ${now.display} (${now.utc}).`,
			...lines,
			'Target channels by key exactly as listed. A bare platform such as "instagram" is refused when more than one channel posts there.'
		].join('\n')
	};
}

export interface ScheduleInputPost {
	channels: ChannelRef[];
	text?: string;
	title?: string;
	variants?: Array<{ for: string; text: string }>;
	media?: Array<{ url: string; altText?: string }>;
	draftId?: string;
	runAt: RunAtInput;
}

export interface ScheduleInput {
	posts: ScheduleInputPost[];
	dryRun?: boolean;
	confirmToken?: string;
	idempotencyKey?: string;
}

interface Group {
	channels: Channel[];
	/** platform -> body this draft must carry; absent means the draft's own copy. */
	variants: Record<string, string>;
}

interface PostPlan {
	index: number;
	title: string | null;
	runAt: { now: true } | { now: false; utc: Date };
	sourceDraftId: string | null;
	baseBody: string | null;
	mediaUrls: Array<{ url: string; altText?: string }>;
	groups: Group[];
	issues: Map<string, DraftIssue[]>;
	mediaSummary: string;
	bodies: Map<string, string>;
}

type MediaRow = typeof draftMedia.$inferSelect;
type VariantRow = typeof draftVariants.$inferSelect;

function mediaSummary(rows: Array<{ mime: string }>, urls: number): string {
	const videos = rows.filter((m) => m.mime.toLowerCase().startsWith('video/')).length;
	const images = rows.length - videos;
	const parts = [];
	if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
	if (videos) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
	if (urls) parts.push(`${urls} file${urls === 1 ? '' : 's'} to fetch by URL`);
	return parts.length ? parts.join(', ') : 'no media';
}

async function planSchedule(agent: AgentContext, input: ScheduleInput) {
	const { ctx, userId, timeZone, now } = agent;
	const dir = await loadChannels(ctx.db, userId);
	const problems: string[] = [];
	const unresolved: Resolved['unresolved'] = [];
	const plans: PostPlan[] = [];
	let deliveries = 0;
	for (const [index, post] of input.posts.entries()) {
		const at = `posts[${index}]`;
		const resolved = resolveRefs(post.channels, dir, `${at}.channels`, true);
		problems.push(...resolved.problems);
		unresolved.push(...resolved.unresolved);
		deliveries += post.channels.length;
		const when = parseRunAt(post.runAt, now, timeZone);
		if (!when.ok) problems.push(`${at}.runAt: ${when.message}`);
		if (post.text === undefined && !post.draftId)
			problems.push(`${at}: send text, or a draftId whose text and media should be scheduled.`);
		if (post.draftId && post.media?.length)
			problems.push(
				`${at}: media by URL cannot be added to an existing draft here. Attach it with attach_media first, then schedule the draft.`
			);
		let draft: typeof drafts.$inferSelect | undefined;
		let mediaRows: MediaRow[] = [];
		let draftVariantRows: VariantRow[] = [];
		if (post.draftId) {
			draft = await first(
				ctx.db
					.select()
					.from(drafts)
					.where(and(eq(drafts.id, post.draftId), eq(drafts.userId, userId)))
			);
			if (!draft)
				problems.push(
					`${at}.draftId: no draft "${post.draftId}". list_posts with status ["draft"] lists them.`
				);
			else {
				mediaRows = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, draft.id));
				draftVariantRows = await ctx.db
					.select()
					.from(draftVariants)
					.where(eq(draftVariants.draftId, draft.id));
			}
		}
		const byChannel = new Map<string, string>();
		const byPlatform = new Map<string, string>();
		for (const [vi, variant] of (post.variants ?? []).entries()) {
			const target = variant.for.trim().toLowerCase();
			if (isPlatformId(target)) {
				if (!resolved.channels.some((c) => c.platform === target))
					problems.push(
						`${at}.variants[${vi}]: no channel of this post is on ${platformName(target)}.`
					);
				byPlatform.set(target, variant.text);
				continue;
			}
			const match = resolveChannelRef(variant.for, dir.channels, dir.brands, {
				requireActive: false
			});
			if (
				!match.ok ||
				!resolved.channels.some((c) => c.connectionId === match.channel.connectionId)
			) {
				problems.push(
					`${at}.variants[${vi}].for: "${variant.for}" is neither a platform nor one of this post's channels (${resolved.channels.map((c) => c.key).join(', ') || 'none resolved'}).`
				);
				continue;
			}
			byChannel.set(match.channel.connectionId, variant.text);
		}
		const groups: Group[] = [];
		const slotsByPlatform = new Map<string, Array<string | null>>();
		for (const channel of resolved.channels) {
			const override =
				byChannel.get(channel.connectionId) ?? byPlatform.get(channel.platform) ?? null;
			const seen = slotsByPlatform.get(channel.platform) ?? [];
			let slot = seen.indexOf(override);
			if (slot === -1) {
				seen.push(override);
				slot = seen.length - 1;
			}
			slotsByPlatform.set(channel.platform, seen);
			groups[slot] ??= { channels: [], variants: {} };
			groups[slot].channels.push(channel);
			if (override !== null) groups[slot].variants[channel.platform] = override;
		}
		plans.push({
			index,
			title: post.title ?? draft?.title ?? null,
			runAt: when.ok ? (when.now ? { now: true } : { now: false, utc: when.utc }) : { now: true },
			sourceDraftId: draft?.id ?? null,
			baseBody: post.text ?? null,
			mediaUrls: post.media ?? [],
			groups,
			issues: new Map(),
			mediaSummary: mediaSummary(mediaRows, post.media?.length ?? 0),
			bodies: new Map()
		});
		if (draft) {
			const plan = plans[plans.length - 1];
			await checkPlannedContent(agent, plan, draft.baseBody, draftVariantRows, mediaRows);
		}
	}
	if (deliveries > MAX_BATCH_DELIVERIES)
		problems.push(
			`This batch has ${deliveries} deliveries; one call takes at most ${MAX_BATCH_DELIVERIES}. Split it into several calls.`
		);
	for (const plan of plans) {
		if (!plan.sourceDraftId) await checkPlannedContent(agent, plan, '', [], []);
		for (const group of plan.groups)
			for (const channel of group.channels)
				for (const issue of plan.issues.get(channel.connectionId) ?? [])
					problems.push(
						`posts[${plan.index}] ${issueLine(`${channel.key} (${accountLabel(channel.platform, channel.handle)})`, issue)}`
					);
	}
	if (problems.length) {
		fail(problems[0], {
			code: unresolved.length ? 'channel_unresolved' : 'invalid_posts',
			problems,
			unresolved
		});
	}
	return { dir, plans };
}

/**
 * Check what each channel would get, in memory, the way publishing checks it.
 * Media fetched by URL is not there yet, so its media problems wait for the
 * commit, which checks again after attaching and undoes everything on a miss.
 */
async function checkPlannedContent(
	agent: AgentContext,
	plan: PostPlan,
	draftBody: string,
	draftVariantRows: VariantRow[],
	mediaRows: MediaRow[]
) {
	const ids = plan.groups.flatMap((g) => g.channels.map((c) => c.connectionId));
	if (!ids.length) return;
	const rows = await agent.ctx.db
		.select({
			id: connections.id,
			platform: connections.platform,
			handle: connections.handle,
			metaJson: connections.metaJson
		})
		.from(connections)
		.where(inArray(connections.id, ids));
	const rowById = new Map(rows.map((r) => [r.id, r]));
	const base = plan.baseBody ?? draftBody;
	for (const group of plan.groups) {
		for (const channel of group.channels) {
			const row = rowById.get(channel.connectionId);
			if (!row) continue;
			const own = draftVariantRows.find((v) => v.platform === channel.platform);
			const variants = [
				{
					platform: channel.platform,
					body: group.variants[channel.platform] ?? own?.body ?? null,
					optionsJson: own?.optionsJson ?? '{}'
				}
			];
			let content = normalizeDraftContent(
				{ baseBody: base },
				variants,
				mediaRows,
				channel.platform
			);
			if (channel.platform === 'instagram' && plan.sourceDraftId)
				content = await withExpectedJpegCopies(agent.ctx, plan.sourceDraftId, content);
			plan.bodies.set(channel.connectionId, variants[0].body ?? base);
			const provider = providerFor(row);
			const meta = parseJson<ConnectionMeta>(row.metaJson, {});
			const found = provider
				.validate(content, { ...meta, handle: meta.handle || row.handle || undefined })
				.map((issue) => describeIssue(issue, content, !provider.capabilities.supportsThreads))
				.filter((issue) => !(plan.mediaUrls.length && issue.kind === 'media'));
			if (found.length) plan.issues.set(channel.connectionId, found);
		}
	}
}

async function conflictWarnings(
	agent: AgentContext,
	items: Array<{ label: string; channel: Channel; at: Date | null; ignoreDeliveryIds?: string[] }>
): Promise<string[]> {
	const timed = items.filter((i): i is typeof i & { at: Date } => i.at !== null);
	if (!timed.length) return [];
	const warnings: string[] = [];
	const ms = timed.map((i) => i.at.getTime());
	const existing = await agent.ctx.db
		.select({
			id: publishTargets.id,
			connectionId: publishTargets.connectionId,
			scheduledFor: publishTargets.scheduledFor,
			draftId: publishTargets.draftId
		})
		.from(publishTargets)
		.where(
			and(
				inArray(publishTargets.connectionId, [
					...new Set(timed.map((i) => i.channel.connectionId))
				]),
				inArray(publishTargets.status, ['scheduled', 'pending']),
				gte(publishTargets.scheduledFor, new Date(Math.min(...ms) - CONFLICT_WINDOW_MS)),
				lt(publishTargets.scheduledFor, new Date(Math.max(...ms) + CONFLICT_WINDOW_MS))
			)
		);
	const minutes = CONFLICT_WINDOW_MS / 60_000;
	for (const [i, item] of timed.entries()) {
		for (const row of existing) {
			if (row.connectionId !== item.channel.connectionId || !row.scheduledFor) continue;
			if (item.ignoreDeliveryIds?.includes(row.id)) continue;
			const gap = Math.abs(row.scheduledFor.getTime() - item.at.getTime());
			if (gap < CONFLICT_WINDOW_MS)
				warnings.push(
					`${item.label}: ${item.channel.key} already has post ${row.draftId} at ${describeInstant(row.scheduledFor, agent.timeZone).display}, ${Math.round(gap / 60_000)} min apart (less than ${minutes}).`
				);
		}
		for (const other of timed.slice(i + 1)) {
			if (other.channel.connectionId !== item.channel.connectionId) continue;
			const gap = Math.abs(other.at.getTime() - item.at.getTime());
			if (gap < CONFLICT_WINDOW_MS)
				warnings.push(
					`${item.label} and ${other.label} both go to ${item.channel.key} ${Math.round(gap / 60_000)} min apart.`
				);
		}
	}
	return warnings;
}

function scheduleHashInput(input: ScheduleInput, plans: PostPlan[]) {
	return {
		tool: 'schedule_posts',
		posts: input.posts,
		resolved: plans.map((p) => ({
			runAt: p.runAt.now ? 'now' : p.runAt.utc.toISOString(),
			groups: p.groups.map((g) => ({
				channels: g.channels.map((c) => c.connectionId),
				variants: g.variants
			}))
		}))
	};
}

function idempotentRequest<
	T extends { dryRun?: unknown; confirmToken?: unknown; idempotencyKey?: unknown }
>(input: T) {
	// The token changes with every dry run; a retry of the same commit with a
	// fresh token is still the same request.
	const { dryRun: _d, confirmToken: _c, idempotencyKey: _k, ...rest } = input;
	return rest;
}

export async function schedulePostsOp(agent: AgentContext, input: ScheduleInput) {
	const { ctx, userId, timeZone } = agent;
	if (input.posts.length > MAX_BATCH_POSTS)
		fail(`One call takes at most ${MAX_BATCH_POSTS} posts; split the batch.`);
	const request = idempotentRequest(input);
	if (!input.dryRun) {
		const replay = await peekIdempotent(
			ctx.db,
			userId,
			'schedule_posts',
			input.idempotencyKey,
			request,
			agent.now
		);
		if (replay) return replay;
	}
	const { plans } = await planSchedule(agent, input);
	const channelsUsed = new Map<string, Channel>();
	for (const plan of plans)
		for (const g of plan.groups) for (const c of g.channels) channelsUsed.set(c.connectionId, c);
	const brandsUsed = new Set([...channelsUsed.values()].map((c) => c.brand.slug));
	const publishesNow = plans.some((p) => p.runAt.now);
	const confirmationRequired = publishesNow || channelsUsed.size > 1 || brandsUsed.size > 1;
	const warnings = await conflictWarnings(
		agent,
		plans.flatMap((p) =>
			p.groups.flatMap((g) =>
				g.channels.map((channel) => ({
					label: `posts[${p.index}]`,
					channel,
					at: p.runAt.now ? null : p.runAt.utc
				}))
			)
		)
	);
	for (const plan of plans) {
		const slugs = new Set(plan.groups.flatMap((g) => g.channels.map((c) => c.brand.name)));
		if (slugs.size > 1)
			warnings.push(
				`posts[${plan.index}] goes to ${slugs.size} brands at once: ${[...slugs].join(', ')}. Check that is intended.`
			);
		if (plan.mediaUrls.length)
			warnings.push(
				`posts[${plan.index}]: media by URL is fetched and checked when you commit; if a platform would refuse it, nothing in this batch is scheduled.`
			);
		if (plan.groups.length > 1)
			warnings.push(
				`posts[${plan.index}] is saved as ${plan.groups.length} posts, because two channels on one platform get different text.`
			);
	}
	const preview = plans.map((plan) => ({
		index: plan.index,
		title: plan.title,
		runAt: plan.runAt.now
			? { now: true as const, ...nowView(agent) }
			: { now: false as const, ...describeInstant(plan.runAt.utc, timeZone) },
		media: plan.mediaSummary,
		deliveries: plan.groups.flatMap((g) =>
			g.channels.map((c) => ({
				channel: channelView(c),
				text: draftExcerpt(plan.bodies.get(c.connectionId) ?? plan.baseBody ?? '', 160),
				textLength: (plan.bodies.get(c.connectionId) ?? plan.baseBody ?? '').length
			}))
		)
	}));
	const payloadHash = await hashPayload(scheduleHashInput(input, plans));
	const previewLines = preview.flatMap((p) =>
		p.deliveries.map(
			(d) =>
				`posts[${p.index}] → ${d.channel.key} ${d.channel.handle ?? ''} at ${p.runAt.now ? 'NOW' : p.runAt.display}: "${d.text}" (${p.media})`
		)
	);
	if (input.dryRun || (confirmationRequired && !input.confirmToken)) {
		const { token, expiresAt } = await issueConfirmation(
			ctx.db,
			userId,
			'schedule_posts',
			payloadHash,
			agent.now
		);
		const status = input.dryRun ? 'preview' : 'confirmation_required';
		return {
			status,
			committed: false,
			confirmationRequired,
			confirmToken: token,
			confirmExpiresAt: expiresAt.toISOString(),
			now: nowView(agent),
			posts: preview,
			warnings,
			next: `Nothing is scheduled yet. Check every channel, handle and time above with the operator, then call schedule_posts again with the same posts and confirmToken "${token}" (valid 10 minutes). Change anything and you need a new dry run.`,
			summary: [
				status === 'preview'
					? 'DRY RUN — nothing scheduled.'
					: 'NOT SCHEDULED YET — confirmation required.',
				...previewLines,
				...warnings.map((w) => `Warning: ${w}`),
				`Commit with confirmToken "${token}".`
			].join('\n')
		};
	}
	return withIdempotency(
		ctx.db,
		userId,
		'schedule_posts',
		input.idempotencyKey,
		request,
		async () => {
			const spent = input.confirmToken
				? await consumeConfirmation(
						ctx.db,
						userId,
						'schedule_posts',
						input.confirmToken,
						payloadHash,
						agent.now
					)
				: null;
			try {
				return await commitSchedule(agent, plans, warnings);
			} catch (err) {
				await spent?.release().catch(() => {});
				throw err;
			}
		},
		agent.now
	);
}

interface DeliveryOut {
	deliveryId: string;
	postId: string;
	channel: ChannelView;
	status: string;
	runAt: InstantView | null;
	permalink?: string | null;
	error?: string | null;
}

async function commitSchedule(agent: AgentContext, plans: PostPlan[], warnings: string[]) {
	const { ctx, userId, timeZone } = agent;
	const created: string[] = [];
	const prepared: Array<{ plan: PostPlan; group: Group; draftId: string }> = [];
	const results: Array<{ index: number; postIds: string[]; deliveries: DeliveryOut[] }> = plans.map(
		(p) => ({
			index: p.index,
			postIds: [],
			deliveries: []
		})
	);
	let scheduledAny = false;
	try {
		// URL media first: it is the part a dry run could not check, so a refusal
		// here undoes drafts before anything else is touched.
		const ordered = [...plans].sort(
			(a, b) => Number(b.mediaUrls.length > 0) - Number(a.mediaUrls.length > 0)
		);
		for (const plan of ordered) {
			for (const [slot, group] of plan.groups.entries()) {
				const ids = group.channels.map((c) => c.connectionId);
				let draftId: string;
				if (plan.sourceDraftId && slot === 0) draftId = plan.sourceDraftId;
				else if (plan.sourceDraftId) {
					draftId = String((await duplicateDraft(ctx, userId, plan.sourceDraftId)).draft.id);
					created.push(draftId);
				} else {
					draftId = String(
						(
							await createDraft(ctx, userId, {
								title: plan.title,
								baseBody: plan.baseBody ?? '',
								selectedConnectionIds: ids
							})
						).draft.id
					);
					created.push(draftId);
				}
				if (plan.sourceDraftId) {
					await updateDraft(ctx, userId, draftId, {
						selectedConnectionIds: ids,
						...(plan.baseBody !== null ? { baseBody: plan.baseBody } : {}),
						...(plan.title !== null ? { title: plan.title } : {})
					});
				}
				for (const [platform, body] of Object.entries(group.variants))
					await setDraftVariant(ctx, userId, draftId, { platform, body });
				for (const media of plan.mediaUrls)
					await attachMediaFromUrl(ctx, userId, draftId, {
						url: media.url,
						altText: media.altText ?? null
					});
				// A copy carries only the media the store could copy, and URL media
				// was never seen by the dry run: both are checked as stored.
				if (plan.mediaUrls.length || (plan.sourceDraftId && slot > 0)) {
					const check = await checkDraft(ctx, userId, draftId, ids);
					if (!check.ok)
						fail(`posts[${plan.index}]: ${check.problems[0]}`, {
							code: 'invalid_posts',
							problems: check.problems.map((p) => `posts[${plan.index}] ${p}`)
						});
				}
				prepared.push({ plan, group, draftId });
			}
		}
		for (const { plan, group, draftId } of prepared) {
			const ids = group.channels.map((c) => c.connectionId);
			const byId = new Map(group.channels.map((c) => [c.connectionId, c]));
			const out = results.find((r) => r.index === plan.index)!;
			out.postIds.push(draftId);
			if (plan.runAt.now) {
				await refuseMediaProblems(ctx, userId, draftId, ids);
				const published = await publishDraft(ctx, userId, draftId, { connectionIds: ids });
				scheduledAny = true;
				for (const r of published.results)
					out.deliveries.push({
						deliveryId: r.targetId,
						postId: draftId,
						channel: channelView(byId.get(r.connectionId)!),
						status: r.status,
						runAt: nowView(agent),
						permalink: r.permalink,
						error: r.error
					});
				continue;
			}
			const scheduled = await scheduleDraft(ctx, userId, draftId, {
				connectionIds: ids,
				runAt: plan.runAt.utc.toISOString()
			});
			scheduledAny = true;
			for (const t of scheduled.targets)
				out.deliveries.push({
					deliveryId: t.id,
					postId: draftId,
					channel: channelView(byId.get(t.connectionId)!),
					status: t.status,
					runAt: view(t.scheduledFor, timeZone)
				});
		}
	} catch (err) {
		if (!scheduledAny) {
			for (const id of created) await deleteDraft(ctx, userId, id).catch(() => {});
			throw err;
		}
		const message = err instanceof Error ? err.message : 'Stopped early';
		const done = results.filter((r) => r.deliveries.length);
		return {
			status: 'partial',
			committed: true,
			complete: false,
			error: message,
			now: nowView(agent),
			posts: results,
			notCommitted: results.filter((r) => !r.deliveries.length).map((r) => r.index),
			warnings,
			next: `Only posts ${done.map((r) => r.index).join(', ')} were committed. Fix the error, then send the posts listed in notCommitted again with a NEW idempotencyKey; do not resend the committed ones.`,
			summary: `PARTIAL: ${done.length} of ${results.length} posts committed before an error: ${message}`
		};
	}
	const deliveries = results.flatMap((r) => r.deliveries);
	const publishedNow = plans.some((p) => p.runAt.now);
	const nowOutcome = overallOutcome(
		deliveries.map((d) => d.status),
		false
	);
	return {
		status: publishedNow ? nowOutcome : 'scheduled',
		committed: true,
		complete: true,
		now: nowView(agent),
		posts: results,
		warnings,
		next: 'Done. list_posts shows them; reschedule_posts changes a time, move_post changes a channel, cancel_posts stops one.',
		summary: [
			`${publishedNow && nowOutcome !== 'published' ? `${nowOutcome.toUpperCase()}: ` : ''}${publishedNow ? 'Published/queued' : 'Scheduled'} ${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'}:`,
			...deliveries.map(
				(d) =>
					`${d.channel.key} ${d.channel.handle ?? ''} — ${d.status}${d.runAt ? ` at ${d.runAt.display}` : ''} (post ${d.postId}, delivery ${d.deliveryId})${d.error ? ` — ${d.error}` : ''}`
			)
		].join('\n')
	};
}

type TargetRow = typeof publishTargets.$inferSelect;

async function ownedTargets(agent: AgentContext, where: SQL | undefined) {
	return agent.ctx.db
		.select({ t: publishTargets })
		.from(publishTargets)
		.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
		.where(and(eq(drafts.userId, agent.userId), where))
		.then((rows) => rows.map((r) => r.t));
}

async function channelsFor(agent: AgentContext, rows: TargetRow[], dir?: Directory) {
	const directory = dir ?? (await loadChannels(agent.ctx.db, agent.userId));
	const byId = new Map(directory.channels.map((c) => [c.connectionId, c]));
	const missing = [...new Set(rows.map((r) => r.connectionId))].filter((id) => !byId.has(id));
	const orphans = new Map<string, ChannelView>();
	for (const chunk of chunkIds(missing)) {
		const found = await agent.ctx.db
			.select({ id: connections.id, platform: connections.platform, handle: connections.handle })
			.from(connections)
			.where(inArray(connections.id, chunk));
		for (const row of found) orphans.set(row.id, orphanView(row));
	}
	return {
		directory,
		viewOf: (connectionId: string): ChannelView =>
			byId.has(connectionId)
				? channelView(byId.get(connectionId)!)
				: (orphans.get(connectionId) ??
					orphanView({ id: connectionId, platform: 'unknown', handle: null })),
		channelOf: (connectionId: string) => byId.get(connectionId)
	};
}

function deliveryOut(row: TargetRow, channel: ChannelView, timeZone: string): DeliveryOut {
	return {
		deliveryId: row.id,
		postId: row.draftId,
		channel,
		status: row.status,
		runAt: view(row.scheduledFor, timeZone),
		permalink: row.remoteUrl,
		error: row.errorMessage
	};
}

export type DeliverySelector = { deliveryId?: string; postId?: string; channels?: ChannelRef[] };

/** Every delivery the items name, or a refusal naming each one that does not exist. */
async function selectDeliveries(
	agent: AgentContext,
	items: DeliverySelector[],
	field: string,
	onlyStatuses?: readonly string[]
) {
	const problems: string[] = [];
	const dir = await loadChannels(agent.ctx.db, agent.userId);
	const picked: Array<{ item: number; rows: TargetRow[] }> = [];
	for (const [i, item] of items.entries()) {
		const at = `${field}[${i}]`;
		if (Boolean(item.deliveryId) === Boolean(item.postId)) {
			problems.push(`${at}: send exactly one of deliveryId or postId.`);
			continue;
		}
		if (item.deliveryId) {
			if (item.channels?.length) problems.push(`${at}: channels only narrows a postId.`);
			const rows = await ownedTargets(agent, eq(publishTargets.id, item.deliveryId));
			if (!rows.length)
				problems.push(`${at}: no delivery "${item.deliveryId}". list_posts shows delivery ids.`);
			else picked.push({ item: i, rows });
			continue;
		}
		let rows = await ownedTargets(agent, eq(publishTargets.draftId, item.postId!));
		if (!rows.length) {
			const draft = await first(
				agent.ctx.db
					.select({ id: drafts.id })
					.from(drafts)
					.where(and(eq(drafts.id, item.postId!), eq(drafts.userId, agent.userId)))
			);
			problems.push(
				draft
					? `${at}: post "${item.postId}" has no deliveries yet; schedule it with schedule_posts.`
					: `${at}: no post "${item.postId}". list_posts shows post ids.`
			);
			continue;
		}
		if (item.channels?.length) {
			const resolved = resolveRefs(item.channels, dir, `${at}.channels`, false);
			problems.push(...resolved.problems);
			const ids = new Set(resolved.channels.map((c) => c.connectionId));
			for (const c of resolved.channels)
				if (!rows.some((r) => r.connectionId === c.connectionId))
					problems.push(`${at}.channels: post "${item.postId}" does not go to ${c.key}.`);
			rows = rows.filter((r) => ids.has(r.connectionId));
		}
		if (onlyStatuses) rows = rows.filter((r) => onlyStatuses.includes(r.status));
		if (!rows.length && !problems.length)
			problems.push(
				`${at}: post "${item.postId}" has nothing ${onlyStatuses ? `in ${onlyStatuses.join('/')}` : ''} to change.`
			);
		picked.push({ item: i, rows });
	}
	if (problems.length) fail(problems[0], { code: 'invalid_selection', problems });
	return { dir, picked };
}

export async function reschedulePostsOp(
	agent: AgentContext,
	input: { items: Array<DeliverySelector & { runAt: RunAtInput }>; dryRun?: boolean }
) {
	const { ctx, userId, timeZone, now } = agent;
	const problems: string[] = [];
	const times = input.items.map((item, i) => {
		if (typeof item.runAt === 'string' && item.runAt.trim().toLowerCase() === 'now') {
			problems.push(
				`items[${i}].runAt: "now" is not a reschedule; publish_now sends a post immediately.`
			);
			return null;
		}
		const parsed = parseRunAt(item.runAt, now, timeZone);
		if (!parsed.ok) problems.push(`items[${i}].runAt: ${parsed.message}`);
		return parsed.ok ? parsed.utc : null;
	});
	if (problems.length) fail(problems[0], { code: 'invalid_time', problems });
	const { dir, picked } = await selectDeliveries(agent, input.items, 'items', WAITING);
	const { viewOf } = await channelsFor(
		agent,
		picked.flatMap((p) => p.rows),
		dir
	);
	const blocked: string[] = [];
	for (const { item, rows } of picked)
		for (const row of rows) {
			const why = refuseInFlightOrPublished(row, now);
			if (why)
				blocked.push(
					`items[${item}]: ${viewOf(row.connectionId).key || row.connectionId} — ${why}.`
				);
		}
	if (blocked.length) fail(blocked[0], { code: 'not_reschedulable', problems: blocked }, 409);
	const changes = picked.flatMap(({ item, rows }) =>
		rows.map((row) => ({ item, row, to: times[item]!, channel: viewOf(row.connectionId) }))
	);
	const ignore = changes.map((c) => c.row.id);
	const channelById = new Map(dir.channels.map((c) => [c.connectionId, c]));
	const warnings = await conflictWarnings(
		agent,
		changes
			.filter((c) => channelById.has(c.row.connectionId))
			.map((c) => ({
				label: `items[${c.item}]`,
				channel: channelById.get(c.row.connectionId)!,
				at: c.to,
				ignoreDeliveryIds: ignore
			}))
	);
	const out = [];
	for (const change of changes) {
		if (!input.dryRun)
			await rescheduleDelivery(ctx, userId, change.row.id, { runAt: change.to.toISOString() });
		out.push({
			deliveryId: change.row.id,
			postId: change.row.draftId,
			channel: change.channel,
			status: input.dryRun ? change.row.status : 'scheduled',
			before: view(change.row.scheduledFor, timeZone),
			after: describeInstant(change.to, timeZone)
		});
	}
	return {
		status: input.dryRun ? 'preview' : 'rescheduled',
		committed: !input.dryRun,
		now: nowView(agent),
		deliveries: out,
		warnings,
		next: input.dryRun
			? 'Nothing changed. Call again without dryRun to apply.'
			: 'Done. Calling again with the same times changes nothing more.',
		summary: [
			`${input.dryRun ? 'DRY RUN — would move' : 'Rescheduled'} ${out.length} deliver${out.length === 1 ? 'y' : 'ies'}:`,
			...out.map(
				(d) =>
					`${d.channel.key} ${d.channel.handle ?? ''}: ${d.before?.display ?? 'unscheduled'} → ${d.after.display} (delivery ${d.deliveryId})`
			),
			...warnings.map((w) => `Warning: ${w}`)
		].join('\n')
	};
}

export interface MoveInput {
	postId: string;
	from?: ChannelRef[];
	to: ChannelRef[];
	runAt?: RunAtInput;
	dryRun?: boolean;
	confirmToken?: string;
	idempotencyKey?: string;
}

export async function movePostOp(agent: AgentContext, input: MoveInput) {
	const { ctx, userId, timeZone, now } = agent;
	const request = idempotentRequest(input);
	if (!input.dryRun) {
		const replay = await peekIdempotent(
			ctx.db,
			userId,
			'move_post',
			input.idempotencyKey,
			request,
			now
		);
		if (replay) return replay;
	}
	const draft = await loadOwnedDraft(ctx.db, input.postId, userId);
	if (!draft)
		fail(`No post "${input.postId}". list_posts shows post ids.`, { code: 'not_found' }, 404);
	const example = `{"postId": "${input.postId}", "from": ["jobjob.instagram"], "to": ["465cal.instagram"], "dryRun": true}`;
	const { dir, channels: to } = await resolveOrFail(agent, input.to, 'to', true, example);
	const fromResolved = resolveRefs(input.from ?? [], dir, 'from', false);
	if (fromResolved.problems.length)
		fail(fromResolved.problems[0], {
			code: 'channel_unresolved',
			problems: fromResolved.problems,
			unresolved: fromResolved.unresolved,
			example
		});
	const targets = await ownedTargets(agent, eq(publishTargets.draftId, input.postId));
	const problems: string[] = [];
	const fromRows: TargetRow[] = [];
	for (const c of fromResolved.channels) {
		const row = targets.find((t) => t.connectionId === c.connectionId && t.status !== 'cancelled');
		if (!row) problems.push(`from: post "${input.postId}" has no live delivery on ${c.key}.`);
		else if (
			!(WAITING as readonly string[]).includes(row.status) ||
			refuseInFlightOrPublished(row, now)
		)
			problems.push(`from: the delivery on ${c.key} is ${row.status} and can no longer be moved.`);
		else fromRows.push(row);
	}
	for (const c of to) {
		const live = targets.find((t) => t.connectionId === c.connectionId && t.status !== 'cancelled');
		if (live)
			problems.push(
				`to: post "${input.postId}" already has a ${live.status} delivery on ${c.key}.`
			);
		if (fromResolved.channels.some((f) => f.connectionId === c.connectionId))
			problems.push(`to: ${c.key} is also in from.`);
	}
	let runAt: Date | null = null;
	if (input.runAt !== undefined) {
		const parsed = parseRunAt(input.runAt, now, timeZone);
		if (!parsed.ok) problems.push(`runAt: ${parsed.message}`);
		else if (parsed.now)
			problems.push('runAt: "now" is not a move; move it first, then use publish_now.');
		else runAt = parsed.utc;
	} else {
		const pool = fromRows.length ? fromRows : targets.filter((t) => t.status === 'scheduled');
		const distinct = [...new Set(pool.map((t) => t.scheduledFor?.getTime() ?? null))];
		if (distinct.length === 1 && distinct[0] !== null) runAt = new Date(distinct[0]);
		else
			problems.push(
				'runAt: the deliveries being replaced do not share one scheduled time; send runAt for the new channels.'
			);
		if (runAt && runAt.getTime() < now.getTime())
			problems.push(
				`runAt: the post's time ${describeInstant(runAt, timeZone).display} has passed; send a new runAt.`
			);
	}
	if (problems.length) fail(problems[0], { code: 'invalid_move', problems, example });
	const check = await checkDraft(
		ctx,
		userId,
		input.postId,
		to.map((c) => c.connectionId)
	);
	if (!check.ok) fail(check.problems[0], { code: 'invalid_posts', problems: check.problems });
	const { viewOf } = await channelsFor(agent, targets, dir);
	const live = targets.filter((t) => t.status !== 'cancelled');
	const before = live.map((t) => deliveryOut(t, viewOf(t.connectionId), timeZone));
	const warnings = await conflictWarnings(
		agent,
		to.map((channel) => ({ label: 'to', channel, at: runAt }))
	);
	const brandsAfter = new Set([
		...live
			.filter((t) => !fromRows.some((f) => f.id === t.id))
			.map((t) => viewOf(t.connectionId).brand),
		...to.map((c) => c.brand.name)
	]);
	if (brandsAfter.size > 1)
		warnings.push(
			`After the move this post goes to ${brandsAfter.size} brands: ${[...brandsAfter].join(', ')}.`
		);
	const plannedAfter = [
		...before.filter((d) => !fromRows.some((f) => f.id === d.deliveryId)),
		...to.map((c) => ({
			deliveryId: '(new)',
			postId: input.postId,
			channel: channelView(c),
			status: 'scheduled',
			runAt: view(runAt, timeZone)
		}))
	];
	const payloadHash = await hashPayload({
		tool: 'move_post',
		input: request,
		from: fromRows.map((r) => r.id),
		to: to.map((c) => c.connectionId),
		runAt: runAt!.toISOString()
	});
	const lines = [
		`Post ${input.postId}${draft.title ? ` "${draft.title}"` : ''}:`,
		...fromRows.map(
			(r) => `  remove ${viewOf(r.connectionId).key} ${viewOf(r.connectionId).handle ?? ''}`
		),
		...to.map((c) => `  add    ${channelLabel(c)} at ${describeInstant(runAt!, timeZone).display}`)
	];
	if (input.dryRun || !input.confirmToken) {
		const { token, expiresAt } = await issueConfirmation(
			ctx.db,
			userId,
			'move_post',
			payloadHash,
			now
		);
		return {
			status: input.dryRun ? 'preview' : 'confirmation_required',
			committed: false,
			confirmationRequired: true,
			confirmToken: token,
			confirmExpiresAt: expiresAt.toISOString(),
			now: nowView(agent),
			postId: input.postId,
			before,
			after: plannedAfter,
			warnings,
			next: `Nothing moved yet. Confirm the new channels with the operator, then call move_post again with the same arguments and confirmToken "${token}".`,
			summary: [
				`${input.dryRun ? 'DRY RUN' : 'NOT MOVED YET — confirmation required'}.`,
				...lines,
				...warnings.map((w) => `Warning: ${w}`)
			].join('\n')
		};
	}
	return withIdempotency(
		ctx.db,
		userId,
		'move_post',
		input.idempotencyKey,
		request,
		async () => {
			const spent = await consumeConfirmation(
				ctx.db,
				userId,
				'move_post',
				input.confirmToken!,
				payloadHash,
				now
			);
			let cancelled = 0;
			try {
				// Old channels first: a failure part-way leaves the post on fewer
				// channels, never on the old and the new at once.
				for (const row of fromRows) {
					await cancelDelivery(ctx, userId, row.id);
					cancelled++;
				}
				await scheduleDraft(ctx, userId, input.postId, {
					connectionIds: to.map((c) => c.connectionId),
					runAt: runAt!.toISOString()
				});
			} catch (err) {
				if (!cancelled) await spent.release().catch(() => {});
				if (cancelled)
					fail(
						`Moved off ${cancelled} channel(s) but could not schedule the new ones: ${err instanceof Error ? err.message : 'error'}. The post is now only on its remaining channels; fix the problem and add the new channels with move_post (no from).`,
						{
							code: 'move_incomplete',
							cancelledDeliveryIds: fromRows.slice(0, cancelled).map((r) => r.id)
						},
						409
					);
				throw err;
			}
			const fresh = await ownedTargets(agent, eq(publishTargets.draftId, input.postId));
			const after = fresh
				.filter((t) => t.status !== 'cancelled')
				.map((t) => deliveryOut(t, viewOf(t.connectionId), timeZone));
			return {
				status: 'moved',
				committed: true,
				now: nowView(agent),
				postId: input.postId,
				before,
				after,
				warnings,
				next: 'Done. get_post shows the post; reschedule_posts changes its time.',
				summary: [
					'Moved.',
					...lines,
					'Now goes to:',
					...after.map(
						(d) =>
							`  ${d.channel.key} ${d.channel.handle ?? ''} — ${d.status}${d.runAt ? ` at ${d.runAt.display}` : ''} (delivery ${d.deliveryId})`
					)
				].join('\n')
			};
		},
		now
	);
}

export async function cancelPostsOp(
	agent: AgentContext,
	input: { items: DeliverySelector[]; deletePost?: boolean }
) {
	const { ctx, userId, timeZone, now } = agent;
	if (input.deletePost) {
		const problems: string[] = [];
		input.items.forEach((item, i) => {
			if (!item.postId || item.deliveryId || item.channels?.length)
				problems.push(`items[${i}]: deletePost takes whole posts: send only postId.`);
		});
		if (problems.length) fail(problems[0], { code: 'invalid_selection', problems });
		const deleted = [];
		for (const item of input.items) {
			const draft = await loadOwnedDraft(ctx.db, item.postId!, userId);
			if (!draft) fail(`No post "${item.postId}".`, { code: 'not_found' }, 404);
			const targets = await ownedTargets(agent, eq(publishTargets.draftId, item.postId!));
			if (targets.some((t) => t.status === 'published' || t.remotePostId))
				fail(
					`Post "${item.postId}" has published deliveries; cancel the waiting ones instead of deleting it.`,
					{ code: 'published' },
					409
				);
		}
		for (const item of input.items) {
			await deleteDraft(ctx, userId, item.postId!);
			deleted.push(item.postId!);
		}
		return {
			status: 'deleted',
			committed: true,
			now: nowView(agent),
			deleted,
			deliveries: [],
			next: 'Deleted, with their media. This cannot be undone.',
			summary: `Deleted ${deleted.length} post(s): ${deleted.join(', ')}`
		};
	}
	const { dir, picked } = await selectDeliveries(agent, input.items, 'items');
	const { viewOf } = await channelsFor(
		agent,
		picked.flatMap((p) => p.rows),
		dir
	);
	const blocked: string[] = [];
	for (const { item, rows } of picked)
		for (const row of rows) {
			if (row.status === 'cancelled') continue;
			const why = refuseInFlightOrPublished(row, now);
			if (why)
				blocked.push(
					`items[${item}]: ${viewOf(row.connectionId).key} — ${why}; it cannot be cancelled.`
				);
		}
	if (blocked.length) fail(blocked[0], { code: 'not_cancellable', problems: blocked }, 409);
	const out = [];
	for (const { rows } of picked)
		for (const row of rows) {
			const result =
				row.status === 'cancelled' ? { target: row } : await cancelDelivery(ctx, userId, row.id);
			out.push({
				...deliveryOut(result.target, viewOf(row.connectionId), timeZone),
				wasScheduledFor: view(row.scheduledFor, timeZone)
			});
		}
	return {
		status: 'cancelled',
		committed: true,
		now: nowView(agent),
		deliveries: out,
		next: 'Cancelled deliveries stay listed with status cancelled. To post one again, schedule it with schedule_posts (draftId) or move_post.',
		summary: [
			`Cancelled ${out.length} deliver${out.length === 1 ? 'y' : 'ies'}:`,
			...out.map(
				(d) =>
					`${d.channel.key} ${d.channel.handle ?? ''} (was ${d.wasScheduledFor?.display ?? 'unscheduled'}) — delivery ${d.deliveryId}`
			)
		].join('\n')
	};
}

export async function publishNowOp(
	agent: AgentContext,
	input: {
		postId: string;
		channels: ChannelRef[];
		dryRun?: boolean;
		confirmToken?: string;
		idempotencyKey?: string;
	}
) {
	const { ctx, userId, timeZone, now } = agent;
	const request = idempotentRequest(input);
	if (!input.dryRun) {
		const replay = await peekIdempotent(
			ctx.db,
			userId,
			'publish_now',
			input.idempotencyKey,
			request,
			now
		);
		if (replay) return replay;
	}
	const draft = await loadOwnedDraft(ctx.db, input.postId, userId);
	if (!draft)
		fail(`No post "${input.postId}". list_posts shows post ids.`, { code: 'not_found' }, 404);
	const { channels } = await resolveOrFail(
		agent,
		input.channels,
		'channels',
		true,
		`{"postId": "${input.postId}", "channels": ["jobjob.linkedin"], "dryRun": true}`
	);
	const ids = channels.map((c) => c.connectionId);
	const check = await checkDraft(ctx, userId, input.postId, ids);
	if (!check.ok) fail(check.problems[0], { code: 'invalid_posts', problems: check.problems });
	const targets = await ownedTargets(agent, eq(publishTargets.draftId, input.postId));
	const already = channels.filter((c) =>
		targets.some(
			(t) => t.connectionId === c.connectionId && (t.status === 'published' || t.remotePostId)
		)
	);
	const payloadHash = await hashPayload({ tool: 'publish_now', input: request, channels: ids });
	const lines = channels.map(
		(c) =>
			`  ${channelLabel(c)}${already.includes(c) ? ' — already published, will be skipped' : ''}`
	);
	if (input.dryRun || !input.confirmToken) {
		const { token, expiresAt } = await issueConfirmation(
			ctx.db,
			userId,
			'publish_now',
			payloadHash,
			now
		);
		return {
			status: input.dryRun ? 'preview' : 'confirmation_required',
			committed: false,
			confirmationRequired: true,
			confirmToken: token,
			confirmExpiresAt: expiresAt.toISOString(),
			now: nowView(agent),
			postId: input.postId,
			text: draftExcerpt(draft.baseBody, 200),
			channels: channels.map(channelView),
			deliveries: [],
			next: `Nothing was sent. This posts publicly right away: confirm with the operator, then call publish_now again with the same arguments and confirmToken "${token}".`,
			summary: [
				`${input.dryRun ? 'DRY RUN' : 'NOT SENT — confirmation required'}. Would publish post ${input.postId} now to:`,
				...lines
			].join('\n')
		};
	}
	return withIdempotency(
		ctx.db,
		userId,
		'publish_now',
		input.idempotencyKey,
		request,
		async () => {
			const spent = await consumeConfirmation(
				ctx.db,
				userId,
				'publish_now',
				input.confirmToken!,
				payloadHash,
				now
			);
			let published;
			try {
				await refuseMediaProblems(ctx, userId, input.postId, ids);
				published = await publishDraft(ctx, userId, input.postId, { connectionIds: ids });
			} catch (err) {
				await spent.release().catch(() => {});
				throw err;
			}
			const byId = new Map(channels.map((c) => [c.connectionId, c]));
			const deliveries = published.results.map((r) => ({
				deliveryId: r.targetId,
				postId: input.postId,
				channel: channelView(byId.get(r.connectionId)!),
				status: r.status,
				runAt: describeInstant(now, timeZone),
				permalink: r.permalink,
				error: r.error
			}));
			const outcome = overallOutcome(
				deliveries.map((d) => d.status),
				Boolean(published.stopped)
			);
			return {
				status: outcome,
				committed: true,
				now: nowView(agent),
				postId: input.postId,
				channels: channels.map(channelView),
				deliveries,
				...(published.stopped ? { error: published.stoppedError } : {}),
				next:
					outcome === 'failed'
						? 'Nothing was published. Read each delivery error, fix the cause, then call publish_now again for this post.'
						: published.stopped
							? 'Some channels were not reached; they are still due and go out on the next scheduler tick. Do not resend.'
							: outcome === 'partial'
								? 'Some deliveries failed; the rest went out. Fix the failed ones from their errors and publish_now only those channels; do not resend the published ones.'
								: 'Done. Deliveries with status pending go out on the next scheduler tick; do not resend them.',
				summary: [
					`${outcome === 'failed' ? 'FAILED: ' : outcome === 'partial' ? 'PARTIAL: ' : ''}Publish of post ${input.postId}:`,
					...deliveries.map(
						(d) =>
							`  ${d.channel.key} ${d.channel.handle ?? ''} — ${d.status}${d.permalink ? ` ${d.permalink}` : ''}${d.error ? ` — ${d.error}` : ''}`
					)
				].join('\n')
			};
		},
		now
	);
}

/** One word for a batch of deliveries, so an agent reading only the top level
 *  is never told "published" when a channel failed. */
export function overallOutcome(
	statuses: string[],
	stopped: boolean
): 'published' | 'partial' | 'failed' {
	const failed = statuses.filter((s) => s === 'failed').length;
	if (statuses.length && failed === statuses.length) return 'failed';
	if (failed || stopped) return 'partial';
	return 'published';
}

export const DELIVERY_STATUSES = [
	'scheduled',
	'pending',
	'publishing',
	'published',
	'failed',
	'cancelled'
] as const;
export const LIST_STATUSES = [...DELIVERY_STATUSES, 'draft'] as const;
const DEFAULT_LIST_STATUSES = ['scheduled', 'pending', 'publishing', 'failed'];

function parseBound(raw: string, end: boolean, timeZone: string, field: string): Date {
	const day = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
	if (day) {
		const start = zonedLocalToUtc(`${raw.trim()}T00:00`, timeZone);
		if (start.ok) {
			if (!end) return start.utc;
			const [y, m, d] = raw.split('-').map(Number);
			const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
			const after = zonedLocalToUtc(`${next}T00:00`, timeZone);
			if (after.ok) return after.utc;
		}
	}
	const parsed = /(Z|[+-]\d{2}:\d{2})$/i.test(raw) ? new Date(raw) : new Date(NaN);
	if (Number.isNaN(parsed.getTime()))
		fail(
			`${field} must be a date like "2026-11-03" (a whole day in ${timeZone}) or an ISO 8601 time with an offset.`,
			{ code: 'invalid_time' }
		);
	return parsed;
}

function encodeCursor(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/=+$/, '');
}
function decodeCursor<T>(raw: string): T {
	try {
		return JSON.parse(atob(raw)) as T;
	} catch {
		fail('cursor is not one this server returned; drop it to start from the first page.', {
			code: 'invalid_cursor'
		});
	}
}

export interface ListInput {
	brand?: string;
	channel?: ChannelRef;
	status?: Array<(typeof LIST_STATUSES)[number]>;
	from?: string;
	to?: string;
	cursor?: string;
	limit: number;
	response_format: 'concise' | 'detailed';
}

async function variantBodies(agent: AgentContext, draftIds: string[]) {
	const map = new Map<string, VariantRow[]>();
	for (const chunk of chunkIds(draftIds)) {
		const rows = await agent.ctx.db
			.select()
			.from(draftVariants)
			.where(inArray(draftVariants.draftId, chunk));
		for (const row of rows) map.set(row.draftId, [...(map.get(row.draftId) ?? []), row]);
	}
	return map;
}

async function mediaCounts(agent: AgentContext, draftIds: string[]) {
	const map = new Map<string, Array<{ mime: string }>>();
	for (const chunk of chunkIds(draftIds)) {
		const rows = await agent.ctx.db
			.select({ draftId: draftMedia.draftId, mime: draftMedia.mime })
			.from(draftMedia)
			.where(inArray(draftMedia.draftId, chunk));
		for (const row of rows) map.set(row.draftId, [...(map.get(row.draftId) ?? []), row]);
	}
	return map;
}

export async function listPostsOp(agent: AgentContext, input: ListInput) {
	const { ctx, userId, timeZone } = agent;
	const dir = await loadChannels(ctx.db, userId);
	const statuses = input.status?.length ? input.status : DEFAULT_LIST_STATUSES;
	if (statuses.includes('draft') && statuses.length > 1)
		fail(
			'status "draft" lists unscheduled drafts and cannot be mixed with delivery statuses. Ask for ["draft"] on its own.',
			{ code: 'invalid_filter' }
		);
	let channelIds: string[] | null = null;
	if (input.brand) {
		const wanted = input.brand.trim().toLowerCase();
		const brand = dir.brands.find((b) => b.slug === wanted || b.name.toLowerCase() === wanted);
		if (!brand && wanted !== UNBRANDED_SLUG)
			fail(
				`No brand "${input.brand}". Brands: ${dir.brands.map((b) => b.slug).join(', ') || 'none'}.`,
				{ code: 'unknown_brand' }
			);
		channelIds = dir.channels
			.filter((c) => c.brand.slug === (brand?.slug ?? UNBRANDED_SLUG))
			.map((c) => c.connectionId);
	}
	if (input.channel) {
		const resolved = resolveRefs([input.channel], dir, 'channel', false);
		if (resolved.problems.length)
			fail(resolved.problems[0], {
				code: 'channel_unresolved',
				problems: resolved.problems,
				unresolved: resolved.unresolved
			});
		const id = resolved.channels[0].connectionId;
		channelIds = channelIds ? channelIds.filter((c) => c === id) : [id];
	}
	const from = input.from ? parseBound(input.from, false, timeZone, 'from') : null;
	const to = input.to ? parseBound(input.to, true, timeZone, 'to') : null;
	const detailed = input.response_format === 'detailed';
	if (statuses[0] === 'draft') return listDraftsOp(agent, input, dir, channelIds, detailed);

	const when = sql<number>`coalesce(${publishTargets.scheduledFor}, ${publishTargets.updatedAt})`;
	const filters: Array<SQL | undefined> = [
		eq(drafts.userId, userId),
		inArray(publishTargets.status, statuses as string[])
	];
	if (channelIds)
		filters.push(channelIds.length ? inArray(publishTargets.connectionId, channelIds) : sql`0`);
	if (from) filters.push(sql`${when} >= ${from.getTime()}`);
	if (to) filters.push(sql`${when} < ${to.getTime()}`);
	if (input.cursor) {
		const c = decodeCursor<{ w: number; id: string }>(input.cursor);
		filters.push(
			or(sql`${when} > ${c.w}`, and(sql`${when} = ${c.w}`, sql`${publishTargets.id} > ${c.id}`))
		);
	}
	const rows = await ctx.db
		.select({ t: publishTargets, title: drafts.title, baseBody: drafts.baseBody, when })
		.from(publishTargets)
		.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
		.where(and(...filters))
		.orderBy(asc(when), asc(publishTargets.id))
		.limit(input.limit + 1);
	const hasMore = rows.length > input.limit;
	const page = hasMore ? rows.slice(0, input.limit) : rows;
	const { viewOf } = await channelsFor(
		agent,
		page.map((r) => r.t),
		dir
	);
	const draftIds = [...new Set(page.map((r) => r.t.draftId))];
	const variants = await variantBodies(agent, draftIds);
	const media = detailed ? await mediaCounts(agent, draftIds) : new Map();
	const items = page.map((r) => {
		const channel = viewOf(r.t.connectionId);
		const body =
			variants.get(r.t.draftId)?.find((v) => v.platform === channel.platform)?.body ?? r.baseBody;
		const at = describeInstant(Number(r.when), timeZone);
		const base = {
			postId: r.t.draftId,
			deliveryId: r.t.id,
			channel: channel.key,
			brand: channel.brand,
			platform: channel.platform,
			handle: channel.handle,
			status: r.t.status,
			when: {
				utc: at.utc,
				local: at.local,
				weekday: at.weekday,
				scheduled: r.t.scheduledFor !== null
			},
			excerpt: draftExcerpt(body, 80)
		};
		if (!detailed) return base;
		return {
			...base,
			title: r.title,
			text: body,
			media: mediaSummary(media.get(r.t.draftId) ?? [], 0),
			permalink: r.t.remoteUrl,
			error: r.t.errorMessage,
			attempts: r.t.attemptCount,
			channelDetail: channel
		};
	});
	const last = page[page.length - 1];
	const nextCursor = hasMore && last ? encodeCursor({ w: Number(last.when), id: last.t.id }) : null;
	return {
		now: nowView(agent),
		statuses,
		posts: items,
		nextCursor,
		summary: [
			`${items.length} deliver${items.length === 1 ? 'y' : 'ies'} (${statuses.join('/')})${hasMore ? ', more available' : ''}:`,
			...items.map(
				(i) =>
					`${i.when.weekday.slice(0, 3)} ${i.when.local.slice(0, 16).replace('T', ' ')} · ${i.channel || '(disconnected)'} ${i.handle ?? ''} · ${i.status} · "${i.excerpt}" (post ${i.postId}, delivery ${i.deliveryId})`
			),
			hasMore
				? `More: call list_posts again with cursor "${nextCursor}", or narrow with brand, channel, from or to.`
				: ''
		]
			.filter(Boolean)
			.join('\n')
	};
}

async function listDraftsOp(
	agent: AgentContext,
	input: ListInput,
	dir: Directory,
	channelIds: string[] | null,
	detailed: boolean
) {
	const { ctx, userId, timeZone } = agent;
	const filters: Array<SQL | undefined> = [eq(drafts.userId, userId), eq(drafts.status, 'draft')];
	if (input.cursor) {
		const c = decodeCursor<{ u: number; id: string }>(input.cursor);
		filters.push(
			or(
				sql`${drafts.updatedAt} < ${c.u}`,
				and(sql`${drafts.updatedAt} = ${c.u}`, sql`${drafts.id} < ${c.id}`)
			)
		);
	}
	const rows = await ctx.db
		.select()
		.from(drafts)
		.where(and(...filters))
		.orderBy(desc(drafts.updatedAt), desc(drafts.id))
		.limit(input.limit + 1);
	const byId = new Map(dir.channels.map((c) => [c.connectionId, c]));
	const withChannels = rows
		.map((d) => ({
			draft: d,
			channels: parseJson<string[]>(d.selectedConnectionIds, []).flatMap((id) =>
				byId.has(id) ? [byId.get(id)!] : []
			)
		}))
		.filter((d) => !channelIds || d.channels.some((c) => channelIds.includes(c.connectionId)));
	const hasMore = rows.length > input.limit;
	const page = withChannels.slice(0, input.limit);
	const media = await mediaCounts(
		agent,
		page.map((p) => p.draft.id)
	);
	const items = page.map(({ draft, channels }) => ({
		postId: draft.id,
		status: 'draft',
		title: draft.title,
		excerpt: draftExcerpt(draft.baseBody, 80),
		channels: channels.map((c) => c.key),
		media: mediaSummary(media.get(draft.id) ?? [], 0),
		updated: describeInstant(draft.updatedAt, timeZone).local,
		...(detailed ? { text: draft.baseBody } : {})
	}));
	const last = rows[Math.min(rows.length, input.limit) - 1];
	const nextCursor =
		hasMore && last ? encodeCursor({ u: last.updatedAt.getTime(), id: last.id }) : null;
	return {
		now: nowView(agent),
		statuses: ['draft'],
		posts: items,
		nextCursor,
		summary: [
			`${items.length} unscheduled draft(s)${hasMore ? ', more available' : ''}:`,
			...items.map(
				(i) =>
					`${i.postId} · "${i.excerpt}" · ${i.media} · channels: ${i.channels.join(', ') || 'none chosen'}`
			)
		].join('\n')
	};
}

export async function getPostOp(
	agent: AgentContext,
	input: { postId: string; response_format: 'concise' | 'detailed' }
) {
	const { ctx, userId, timeZone } = agent;
	const draft = await loadOwnedDraft(ctx.db, input.postId, userId);
	if (!draft)
		fail(`No post "${input.postId}". list_posts shows post ids.`, { code: 'not_found' }, 404);
	const targets = await ownedTargets(agent, eq(publishTargets.draftId, input.postId));
	const { viewOf } = await channelsFor(agent, targets);
	const deliveries = targets.map((t) => deliveryOut(t, viewOf(t.connectionId), timeZone));
	const detailed = input.response_format === 'detailed';
	const live = targets
		.filter((t) => t.status !== 'cancelled' && t.status !== 'published')
		.map((t) => t.connectionId);
	const check = detailed && live.length ? await checkDraft(ctx, userId, input.postId, live) : null;
	const variants = draft.variants.map((v) => ({
		platform: v.platform,
		text: detailed ? v.body : draftExcerpt(v.body, 120)
	}));
	const media = draft.media.map((m) => ({
		mediaId: m.id,
		mime: m.mime,
		size: m.size,
		segmentIndex: m.segmentIndex,
		altText: m.altText,
		...(detailed ? { width: m.width, height: m.height, meta: m.meta } : {})
	}));
	return {
		now: nowView(agent),
		post: {
			postId: draft.id,
			title: draft.title,
			status: draft.status,
			text: detailed ? draft.baseBody : draftExcerpt(draft.baseBody, 280),
			variants,
			media,
			deliveries,
			...(check ? { checks: { ok: check.ok, problems: check.problems } } : {})
		},
		summary: [
			`Post ${draft.id}${draft.title ? ` "${draft.title}"` : ''} (${draft.status}): "${draftExcerpt(draft.baseBody, 120)}" — ${mediaSummary(draft.media, 0)}`,
			...deliveries.map(
				(d) =>
					`  ${d.channel.key || '(disconnected)'} ${d.channel.handle ?? ''} — ${d.status}${d.runAt ? ` at ${d.runAt.display}` : ''} (delivery ${d.deliveryId})`
			),
			...(check && !check.ok ? check.problems.map((p) => `  Problem: ${p}`) : [])
		].join('\n')
	};
}

export async function validateChannelsOp(
	agent: AgentContext,
	input: { text?: string; draftId?: string; channels: ChannelRef[] }
) {
	const { ctx, userId } = agent;
	const { channels } = await resolveOrFail(
		agent,
		input.channels,
		'channels',
		false,
		'{"text": "Hello", "channels": ["jobjob.linkedin"]}'
	);
	const ids = channels.map((c) => c.connectionId);
	if (input.draftId && input.text === undefined) {
		const check = await checkDraft(ctx, userId, input.draftId, ids);
		const byId = new Map(channels.map((c) => [c.connectionId, c]));
		return {
			ok: check.ok,
			channels: check.accounts.map((a) => ({
				channel: channelView(byId.get(a.connectionId)!),
				ok: a.ok,
				issues: a.issues
			})),
			problems: check.problems
		};
	}
	if (input.text === undefined)
		fail('Send text, or a draftId to check a saved post.', { code: 'invalid_input' });
	const plan: PostPlan = {
		index: 0,
		title: null,
		runAt: { now: true },
		sourceDraftId: input.draftId ?? null,
		baseBody: input.text,
		mediaUrls: [],
		groups: [{ channels, variants: {} }],
		issues: new Map(),
		mediaSummary: '',
		bodies: new Map()
	};
	let mediaRows: MediaRow[] = [];
	if (input.draftId) {
		const draft = await loadOwnedDraft(ctx.db, input.draftId, userId);
		if (!draft) fail(`No draft "${input.draftId}".`, { code: 'not_found' }, 404);
		mediaRows = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, input.draftId));
	}
	await checkPlannedContent(agent, plan, input.text, [], mediaRows);
	const results = channels.map((c) => {
		const issues = plan.issues.get(c.connectionId) ?? [];
		return { channel: channelView(c), ok: issues.length === 0, issues };
	});
	const problems = results.flatMap((r) => r.issues.map((i) => issueLine(r.channel.key, i)));
	return { ok: problems.length === 0, channels: results, problems };
}
