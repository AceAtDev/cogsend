import {
	createMcpHandler,
	isJsonContentType,
	isLegacyRequest,
	McpServer,
	ResourceTemplate,
	WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { humanizedCause } from '#lib/domain/human-error.js';
import { PLATFORM_IDS, type PlatformId } from '#lib/domain/platforms.js';
import { operatorZone } from '#lib/domain/zoned-time.js';
import {
	createDraft,
	deleteDraft,
	deleteDraftVariant,
	setDraftVariant,
	updateDraft,
	validatePost,
	type OperationContext
} from '#lib/server/api/operations.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { checkDraft } from '#lib/server/api/draft-checks.js';
import {
	abortVideoUpload,
	attachBase64Image,
	attachLimits,
	attachMediaFromUrl,
	BASE64_MAX_BYTES,
	completeVideoUpload,
	coverBytes,
	createMediaUpload,
	removeMedia,
	removeVideoCover,
	setVideoCover,
	updateMedia
} from '#lib/server/api/media-operations.js';
import {
	cancelPostsOp,
	channelView,
	getPostOp,
	LIST_STATUSES,
	listChannelsOp,
	listPostsOp,
	MAX_BATCH_POSTS,
	movePostOp,
	planDraftTiktok,
	publishNowOp,
	reschedulePostsOp,
	resubmitForReviewOp,
	saveDraftTiktok,
	schedulePostsOp,
	validateChannelsOp,
	type AgentContext
} from '#lib/server/api/agent-operations.js';
import { IDEMPOTENCY_KEY_PATTERN, withIdempotency } from '#lib/server/api/mcp-safety.js';
import { getBrandBriefOp, listSlotsOp } from '#lib/server/api/agent-slots.js';
import { briefMarkdown } from '#lib/domain/brand-brief.js';
import { loadBriefs } from '#lib/server/brand-briefs.js';
import { listBrandRows } from '#lib/server/brands.js';
import { loadChannels } from '#lib/server/brands.js';
import { resolveChannelRef, candidateLines, type ChannelRef } from '#lib/domain/channel-keys.js';
import { loadPlatformRequirements } from '#lib/server/platform-requirements.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { TIKTOK_PRIVACY_LEVELS } from '#lib/domain/tiktok.js';
import { actorOf, recordActivity } from '#lib/server/activity.js';
import { PERFORMANCE_SORTS } from '#lib/domain/metrics.js';
import { getPerformanceOp } from '#lib/server/api/agent-metrics.js';

const id = z.string().min(1).max(128);
const anyPlatform = z.enum(PLATFORM_IDS as [PlatformId, ...PlatformId[]]);
const segmentIndex = z.number().int().min(0).max(100);
const altText = z.string().max(1500).nullable();
const channelRef = z.union([
	z
		.string()
		.min(1)
		.max(200)
		.describe('A channel key from list_channels, such as "jobjob.linkedin", or a connection id.'),
	z
		.object({
			brand: z.string().min(1).max(80).describe('Brand slug or exact brand name.'),
			platform: anyPlatform,
			handle: z.string().min(1).max(200).optional()
		})
		.strict()
]);
const channelRefs = z.array(channelRef).min(1).max(10);
const runAt = z.union([
	z
		.string()
		.min(1)
		.max(64)
		.describe(
			'ISO 8601 with Z or an offset, such as "2026-11-03T09:00:00+01:00". "now" publishes immediately (schedule_posts only, always needs confirmation).'
		),
	z
		.object({
			localTime: z
				.string()
				.min(16)
				.max(19)
				.describe('Wall-clock time without offset, such as "2026-11-03T09:00".'),
			timeZone: z.string().min(1).max(64).describe('IANA zone, such as "Europe/Berlin".')
		})
		.strict()
]);
// schedule_posts and reschedule_posts also take a slot: the account's next
// open posting slot, which the server picks so an agent never invents a time.
const slotRunAt = z.union([
	runAt,
	z
		.object({
			slot: z.literal('next'),
			after: z
				.string()
				.min(10)
				.max(40)
				.optional()
				.describe(
					'Look from here on: a day such as "2026-11-10" (from midnight in the operator’s zone) or an ISO 8601 time with an offset. Default: now.'
				)
		})
		.strict()
		.describe(
			'The next open posting slot of each channel, after the given time. "next_slot" is the same from now.'
		)
]);
const dryRun = z
	.boolean()
	.optional()
	.describe('true: validate and preview only, and return a confirmToken. Nothing is written.');
const confirmToken = z
	.string()
	.min(8)
	.max(100)
	.optional()
	.describe('The confirmToken a dry run of exactly these arguments returned.');
const idempotencyKey = z
	.string()
	.regex(IDEMPOTENCY_KEY_PATTERN)
	.optional()
	.describe(
		'Any unique string (8-128 of A-Z a-z 0-9 _ . : -). Retrying the identical call with the same key returns the first answer instead of writing twice; kept 24 hours.'
	);
// TikTok's guidelines leave every one of these to the creator, with no
// default. The schema keeps them optional so a missing one reaches the
// operation, which refuses it with what to send rather than a bare
// "Invalid input" from the union below.
const tiktokChoice = {
	privacy: z
		.string()
		.max(40)
		.optional()
		.describe(
			`Required unless draft. Who can see the post: one of ${TIKTOK_PRIVACY_LEVELS.join(', ')} that the account offers (get_platform_requirements with the channel lists them). Never assume one.`
		),
	allowComment: z.boolean().optional().describe('Required unless draft. Allow comments.'),
	allowDuet: z.boolean().optional().describe('Required unless draft. Allow Duets.'),
	allowStitch: z.boolean().optional().describe('Required unless draft. Allow Stitches.'),
	disclose: z
		.boolean()
		.optional()
		.describe(
			'Required unless draft. The post promotes a brand, product or service; with true, set yourBrand and/or brandedContent.'
		),
	yourBrand: z.boolean().optional().describe('Promotes the operator’s own business.'),
	brandedContent: z
		.boolean()
		.optional()
		.describe('Paid partnership promoting a third party. Cannot be combined with SELF_ONLY.'),
	draft: z
		.boolean()
		.optional()
		.describe(
			'Send the video to the TikTok inbox as a draft instead of posting it. With true, leave out every other choice: the creator adds the caption, picks who can see it and posts it in the TikTok app. Until TikTok audits the app, Direct Post is Only me, so this is the way to a public post: offer it whenever the operator wants the video seen. The delivery then reports status published with tiktokInbox, meaning it reached the inbox, not that it is live.'
		)
};
const tiktokEntry = z
	.object({
		for: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe('One TikTok channel key of this post; omit to apply to every TikTok channel.'),
		...tiktokChoice
	})
	.strict();
const tiktokOptions = z
	.union([tiktokEntry, z.array(tiktokEntry).min(1).max(10)])
	.optional()
	.describe(
		'Required whenever a TikTok channel is targeted (unless save_draft already stored them): TikTok’s per-post choices, one object for every TikTok channel or a list with `for` per channel: either Direct Post (privacy, allowComment, allowDuet, allowStitch, disclose) or {draft: true}. There is no default; ask the operator. Until TikTok audits the app, Direct Post can only be Only me (SELF_ONLY), and a public post needs draft: true, which the operator finishes in the TikTok app.'
	);
const responseFormat = z
	.enum(['concise', 'detailed'])
	.default('concise')
	.describe('concise (default) for lists and ids; detailed adds full text, media and errors.');
const deliverySelector = {
	deliveryId: id.optional().describe('One delivery (a post on one channel), from list_posts.'),
	postId: id.optional().describe('A whole post: every matching delivery of it.'),
	channels: channelRefs.optional().describe('With postId: only the deliveries on these channels.')
};

const annotations = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	saveDraft: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	attach: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	mediaUpload: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	editMedia: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	schedule: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	reschedule: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	move: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	cancel: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false
	},
	publish: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	}
} as const;

const loose = (shape: Record<string, z.ZodType>) => z.object(shape).passthrough();
const instant = loose({
	utc: z.string(),
	local: z.string(),
	weekday: z.string(),
	timeZone: z.string(),
	display: z.string()
});
const channelOut = loose({
	key: z.string(),
	brand: z.string(),
	platform: z.string(),
	handle: z.string().nullable(),
	status: z.string()
});
const deliveryOut = loose({
	deliveryId: z.string(),
	postId: z.string(),
	channel: channelOut,
	status: z.string()
});
const writeOut = (shape: Record<string, z.ZodType>) =>
	loose({ status: z.string(), next: z.string(), summary: z.string(), ...shape });

type ToolSpec = {
	scope: 'read' | 'write';
	title: string;
	annotation: (typeof annotations)[keyof typeof annotations];
	description: string;
	outputSchema: z.ZodType;
	/** A valid call, quoted back in every error so the agent can correct itself. */
	example: Record<string, unknown>;
	examples?: Array<Record<string, unknown>>;
};

type Operation<T extends z.ZodType> = (
	input: z.infer<T>,
	agent: AgentContext
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function errorResult(error: unknown, spec: ToolSpec) {
	const rawStatus = Number((error as { status?: unknown })?.status ?? 500);
	let status: number;
	if (rawStatus >= 400 && rawStatus < 600) status = rawStatus;
	else if (rawStatus < 500) status = 400;
	else status = 500;
	const message = error instanceof Error ? error.message : 'Server error';
	let safeMessage = message;
	if (status === 401 && (!message || message === 'Server error')) safeMessage = 'Unauthorized';
	else if (status >= 500)
		safeMessage = humanizedCause(message) ?? 'Something went wrong on the server';
	if (status === 403 && message === 'Insufficient scope')
		safeMessage =
			spec.scope === 'write'
				? 'This API key is read-only; this tool needs a Read + write key.'
				: 'This API key has no read access.';
	const details =
		error instanceof ApiOperationError && status < 500 && status !== 401
			? error.details
			: undefined;
	if (status >= 500) console.error('[mcp] tool failed', error);
	const problems = Array.isArray(details?.problems) ? (details.problems as string[]) : [];
	const example = (details?.example as string | undefined) ?? JSON.stringify(spec.example);
	const lines = [problems.length > 1 ? problems.join('\n') : safeMessage];
	if (status < 500 && status !== 401 && status !== 403)
		lines.push(`Example of a valid call: ${example}`);
	return {
		isError: true,
		content: [{ type: 'text' as const, text: lines.join('\n') }],
		structuredContent: { error: safeMessage, status, ...(details ?? {}), example }
	};
}

function registerForEvent<T extends z.ZodType>(
	server: McpServer,
	event: RequestEvent,
	name: string,
	spec: ToolSpec,
	inputSchema: T,
	operation: Operation<T>
) {
	server.registerTool(
		name,
		{
			title: spec.title,
			description: spec.description,
			inputSchema,
			outputSchema: spec.outputSchema,
			annotations: { title: spec.title, ...spec.annotation },
			_meta: { 'cogsend/inputExamples': spec.examples ?? [spec.example] }
		} as never,
		(async (input: z.infer<T>) => {
			try {
				const user = requireUser(event.locals.user);
				requireScope(event.locals, spec.scope);
				// Publishing hands its provider calls to locals.waitUntil, as the
				// REST routes do, so a client that disconnects cannot cut them off.
				const agent: AgentContext = {
					ctx: event.locals,
					userId: user.id,
					timeZone: operatorZone(user.timezone),
					now: new Date()
				};
				const result = await operation(input, agent);
				const summary = typeof result.summary === 'string' ? result.summary : `${name}: done`;
				if (spec.scope === 'write') await logToolCall(event, user.id, name, input, result, summary);
				return {
					content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(result)}` }],
					structuredContent: result
				};
			} catch (error) {
				return errorResult(error, spec);
			}
		}) as never
	);
}

/**
 * One activity row per write that changed something: previews, confirmation
 * requests and idempotent replays change nothing, so they leave none.
 */
async function logToolCall(
	event: RequestEvent,
	userId: string,
	name: string,
	input: unknown,
	result: Record<string, unknown>,
	summary: string
) {
	if (result.committed === false || result.idempotentReplay === true) return;
	const args = (input ?? {}) as Record<string, unknown>;
	const postId =
		(typeof result.postId === 'string' && result.postId) ||
		(typeof args.postId === 'string' && args.postId) ||
		(typeof args.draftId === 'string' && args.draftId) ||
		null;
	await recordActivity(event.locals.db, userId, actorOf(event.locals), {
		action: `mcp.${name}`,
		targetType: postId ? 'post' : null,
		targetId: postId,
		summary: `${name}: ${summary.split('\n').slice(0, 3).join(' · ')}`
	});
}

function canMakeJpegCopies(ctx: OperationContext): boolean {
	return Boolean((ctx.bindings as { IMAGES?: unknown } | undefined)?.IMAGES);
}

/** For tools that take channel refs but only need the ids. */
async function resolveIds(agent: AgentContext, refs: ChannelRef[] | undefined, field: string) {
	if (!refs?.length) return { ids: undefined, channels: [] };
	const dir = await loadChannels(agent.ctx.db, agent.userId);
	const problems: string[] = [];
	const channels = [];
	for (const [i, ref] of refs.entries()) {
		const result = resolveChannelRef(ref, dir.channels, dir.brands, { requireActive: false });
		if (result.ok) channels.push(result.channel);
		else
			problems.push(
				`${field}[${i}]: ${result.message} Valid channels: ${candidateLines(result.candidates).join('; ') || 'none'}.`
			);
	}
	if (problems.length)
		throw new ApiOperationError(problems[0], 400, { code: 'channel_unresolved', problems });
	return { ids: channels.map((c) => c.connectionId), channels };
}

function mediaOut(media: Record<string, unknown>) {
	return {
		mediaId: media.id,
		mime: media.mime,
		size: media.size,
		segmentIndex: media.segmentIndex,
		altText: media.altText,
		width: media.width,
		height: media.height,
		meta: media.meta ?? null
	};
}

const uploadClaimInput = z
	.object({
		key: z.string().min(1).max(128),
		uploadId: z.string().min(1).max(1024),
		size: z.number().int().min(1),
		segmentIndex,
		token: z.string().min(1).max(128)
	})
	.passthrough();
// Twice the encoded size, so a file just over the cap gets the operation's own
// message (which names the other ways in) rather than a bare schema error.
const base64Length = (bytes: number) => Math.ceil((bytes * 2) / 3) * 4;

const TIME_EXAMPLE = '2026-11-03T09:00:00+01:00';

function createServer(event: RequestEvent) {
	const server = new McpServer({ name: 'cogsend', version: '2.0.0' });
	const register = <T extends z.ZodType>(
		name: string,
		spec: ToolSpec,
		inputSchema: T,
		operation: Operation<T>
	) => registerForEvent(server, event, name, spec, inputSchema, operation);

	register(
		'list_channels',
		{
			scope: 'read',
			title: 'List brands and channels',
			annotation: annotations.read,
			description:
				'Call this first. Lists every brand with its connected channels (channel key such as "jobjob.linkedin", platform, @handle, display name, status, brand colour), each brand’s brief at a glance (which sections exist; get_brand_brief reads it), each channel’s posting slots and limits with its next open slot, the server time now in UTC and in the operator’s time zone, and a one-line requirements summary per platform in use. Every other tool targets channels by these exact keys; work out relative dates ("next Tuesday 9am") from the `now` returned here. A bare platform name is never a valid target when two brands post there. Do not use it to read posts: list_posts does that.',
			outputSchema: loose({
				now: instant,
				timeZone: z.string(),
				brands: z.array(
					loose({
						name: z.string(),
						slug: z.string(),
						color: z.string(),
						channels: z.array(channelOut)
					})
				),
				platforms: z.array(loose({ platform: z.string(), name: z.string(), summary: z.string() })),
				summary: z.string()
			}),
			example: {}
		},
		z.object({}).strict(),
		(_input, agent) => listChannelsOp(agent)
	);

	register(
		'get_brand_brief',
		{
			scope: 'read',
			title: 'Read a brand’s brief',
			annotation: annotations.read,
			description:
				'Reads the brief the operator wrote for a brand: voice and tone, audience, do and don’t, links, hashtags, calls to action, and notes per platform, as sections and as one markdown document, with each channel’s posting slots and limits. Read it before drafting anything for a brand and follow it in every post; when a brand has no brief, ask the operator rather than guessing a voice. Name the brand by slug or name, or a channel key to get that channel’s brand with its platform note picked out; with neither it returns every brand. Unbranded channels have no brief. It never changes anything: the operator edits briefs in Accounts.',
			outputSchema: loose({
				timeZone: z.string(),
				brands: z.array(
					loose({
						name: z.string(),
						slug: z.string(),
						hasBrief: z.boolean(),
						markdown: z.string(),
						brief: loose({ sections: z.record(z.string(), z.string()) })
					})
				),
				summary: z.string()
			}),
			example: { brand: 'jobjob' },
			examples: [{ brand: 'jobjob' }, { channel: 'jobjob.linkedin' }, {}]
		},
		z
			.object({
				brand: z.string().min(1).max(80).optional().describe('Brand slug or exact name.'),
				channel: channelRef
					.optional()
					.describe('A channel key: returns its brand’s brief and that platform’s note.')
			})
			.strict(),
		(input, agent) => getBrandBriefOp(agent, input)
	);

	register(
		'list_slots',
		{
			scope: 'read',
			title: 'List open posting slots',
			annotation: annotations.read,
			description:
				'Lists the open posting slots of channels between from and to (default the next 7 days, at most 60), in the operator’s time zone with UTC, plus each channel’s weekly slots and limits (max posts a day, minimum minutes between posts). A slot is open when no post on that channel is within 15 minutes of it (or within its minimum gap) and its day is not full; posts held for review count too. Use it to plan a week of posts, or pass runAt "next_slot" to schedule_posts and let the server pick. Without channels it covers every active channel, or one brand’s with brand. It does not list posts: list_posts does that.',
			outputSchema: loose({
				now: instant,
				timeZone: z.string(),
				channels: z.array(
					loose({
						channel: loose({ key: z.string() }),
						openSlots: z.array(instant),
						nextOpenSlot: instant.nullable()
					})
				),
				summary: z.string()
			}),
			example: { channels: ['jobjob.linkedin'], from: '2026-11-09', to: '2026-11-15' },
			examples: [
				{ channels: ['jobjob.linkedin'], from: '2026-11-09', to: '2026-11-15' },
				{ brand: 'jobjob', limit: 3 },
				{}
			]
		},
		z
			.object({
				channels: channelRefs.optional(),
				brand: z.string().min(1).max(80).optional().describe('Brand slug or name.'),
				from: z
					.string()
					.min(10)
					.max(40)
					.optional()
					.describe('A day ("2026-11-09") or an ISO time with offset; default now.'),
				to: z
					.string()
					.min(10)
					.max(40)
					.optional()
					.describe('A day (through its end) or an ISO time with offset; default from + 7 days.'),
				limit: z.number().int().min(1).max(50).default(10).describe('Open slots per channel.')
			})
			.strict(),
		(input, agent) => listSlotsOp(agent, input)
	);

	register(
		'list_posts',
		{
			scope: 'read',
			title: 'List planned and past posts',
			annotation: annotations.read,
			description:
				'Lists deliveries (one post on one channel) in time order, with post id, delivery id, channel key, brand, @handle, status and local and UTC time. By default it shows what is still to come or needs attention (awaiting_review, rejected, scheduled, pending, publishing, failed); a delivery held for review or rejected carries review.state and the reviewer’s review.note, so read the rejections here before revising and calling resubmit_for_review; filter by brand, channel, status and a from/to range (a day such as "2026-11-03" means that whole day in the operator’s zone). Use status ["draft"] alone to list unscheduled drafts instead. Results are paged: pass nextCursor back as cursor. Use get_post for one post’s full text, media and checks.',
			outputSchema: loose({
				now: instant,
				statuses: z.array(z.string()),
				posts: z.array(loose({ postId: z.string(), status: z.string() })),
				nextCursor: z.string().nullable(),
				summary: z.string()
			}),
			example: { brand: 'jobjob', from: '2026-11-03', to: '2026-11-09' }
		},
		z
			.object({
				brand: z.string().min(1).max(80).optional().describe('Brand slug or name.'),
				channel: channelRef.optional(),
				status: z.array(z.enum(LIST_STATUSES)).min(1).max(9).optional(),
				from: z.string().min(10).max(40).optional(),
				to: z.string().min(10).max(40).optional(),
				cursor: z.string().min(1).max(500).optional(),
				limit: z.number().int().min(1).max(50).default(20),
				response_format: responseFormat
			})
			.strict(),
		(input, agent) => listPostsOp(agent, input)
	);

	register(
		'get_post',
		{
			scope: 'read',
			title: 'Get one post',
			annotation: annotations.read,
			description:
				'One post by postId: its text, per-platform variants, media (with mediaId for edit_media) and every delivery with channel key, @handle, status and local and UTC time; a published delivery also carries its latest metrics (counts, when read, or why there are none). With response_format "detailed" it also returns full text and checks the post against every channel it still goes to, listing what a platform would refuse. Each delivery held for review or rejected carries review (state waiting, overdue or rejected, the reviewer’s note, when it was reviewed). Use list_posts to find post ids; use this before move_post or publish_now to see what will go out.',
			outputSchema: loose({
				now: instant,
				post: loose({
					postId: z.string(),
					status: z.string(),
					deliveries: z.array(deliveryOut)
				}),
				summary: z.string()
			}),
			example: { postId: 'POST_ID', response_format: 'detailed' }
		},
		z.object({ postId: id, response_format: responseFormat }).strict(),
		(input, agent) => getPostOp(agent, input)
	);

	register(
		'get_performance',
		{
			scope: 'read',
			title: 'How published posts performed',
			annotation: annotations.read,
			description:
				'How published posts performed over a range of publish dates (default: the last 30 days): totals per brand and per channel, and the top deliveries by the chosen count, each with its channel key, publish time, counts and text excerpt. Use it to learn which posts, channels and formats work before drafting new ones. Counts come from snapshots about 1h, 24h and 7d after publishing, so a post from the last hour may have none yet. Bluesky, Mastodon, TikTok and LinkedIn company pages report counts; Instagram, Threads and X are not collected yet. Use get_post for one post’s latest counts.',
			outputSchema: loose({
				now: instant,
				range: loose({ from: instant, to: instant }),
				sort: z.string(),
				totals: z.record(z.string(), z.unknown()),
				brands: z.array(loose({ brand: z.string(), posts: z.number() })),
				channels: z.array(loose({ channel: z.string(), platform: z.string(), posts: z.number() })),
				top: z.array(loose({ postId: z.string(), channel: z.string(), engagement: z.number() })),
				summary: z.string()
			}),
			example: { brand: 'jobjob', from: '2026-10-01', to: '2026-10-31', sort: 'engagement' },
			examples: [
				{ brand: 'jobjob', from: '2026-10-01', to: '2026-10-31', sort: 'engagement' },
				{ channels: ['465cal.tiktok'], sort: 'views', limit: 5 },
				{ from: '2026-10-24T00:00:00+02:00', sort: 'recent', response_format: 'detailed' }
			]
		},
		z
			.object({
				brand: z.string().min(1).max(80).optional().describe('Brand slug or name.'),
				channels: channelRefs.optional().describe('Only these channels.'),
				from: z
					.string()
					.min(10)
					.max(40)
					.optional()
					.describe(
						'Published at or after: a day such as "2026-10-01" (start of that day in the operator’s zone) or ISO 8601 with an offset. Default: 30 days before `to`.'
					),
				to: z
					.string()
					.min(10)
					.max(40)
					.optional()
					.describe(
						'Published before: a day (the whole day is included) or ISO 8601. Default: now.'
					),
				sort: z
					.enum(PERFORMANCE_SORTS)
					.default('engagement')
					.describe(
						'Order of the top list. engagement = likes + comments + shares + quotes; views (TikTok) and impressions (LinkedIn) list only posts that report them; recent = newest first.'
					),
				limit: z.number().int().min(1).max(50).default(10).describe('How many top posts.'),
				response_format: responseFormat
			})
			.strict(),
		(input, agent) => getPerformanceOp(agent, input)
	);

	register(
		'get_platform_requirements',
		{
			scope: 'read',
			title: 'Platform requirements',
			annotation: annotations.read,
			description:
				'What each platform takes before you build a post: text limit, whether media is required, image count, types and sizes, whether images and video can mix, video container, codecs, size, duration, aspect, resolution and frame rate, covers, threads and alt text, with a one-line summary each. Give channels to add what each account changes (a Mastodon instance’s limits, an X plan). Also lists the ways to attach a file and their size caps. list_channels already carries the one-line summaries; use this for the details.',
			outputSchema: loose({
				platforms: z.array(loose({ platform: z.string(), summary: z.string() })),
				accounts: z.array(loose({ connectionId: z.string(), summary: z.string() })),
				store: z.record(z.string(), z.unknown()),
				attach: z.record(z.string(), z.unknown()),
				summary: z.string()
			}),
			example: { channels: ['465cal.tiktok'] }
		},
		z
			.object({
				platforms: z.array(anyPlatform).max(20).optional(),
				channels: channelRefs.optional()
			})
			.strict(),
		async (input, agent) => {
			const { ids, channels } = await resolveIds(agent, input.channels, 'channels');
			const loaded = await loadPlatformRequirements(agent.ctx.db, agent.userId, {
				platforms: input.platforms,
				connectionIds: ids,
				canMakeJpegCopies: canMakeJpegCopies(agent.ctx)
			});
			const keyOf = new Map(channels.map((c) => [c.connectionId, c.key]));
			const accounts = loaded.accounts.map((a) => ({ ...a, channel: keyOf.get(a.connectionId) }));
			return {
				...loaded,
				accounts,
				attach: attachLimits(agent.ctx),
				summary: [...loaded.platforms, ...accounts]
					.map((p) => ('channel' in p && p.channel ? `${p.channel}: ${p.summary}` : p.summary))
					.join('\n')
			};
		}
	);

	register(
		'validate_post',
		{
			scope: 'read',
			title: 'Check a post',
			annotation: annotations.read,
			description:
				'Checks text, or a saved draft (draftId), against each channel it would go to, the same way publishing will, and returns every problem per channel with what to fix. Without channels it checks text against every platform’s length rules. Each problem names the channel and what to change, such as an image count or a missing video. schedule_posts runs the same checks itself, so use this while drafting, not as a required step before scheduling.',
			outputSchema: loose({ ok: z.boolean(), summary: z.string() }),
			example: { text: 'Hello from JobJob', channels: ['jobjob.linkedin', 'jobjob.instagram'] }
		},
		z
			.object({
				text: z.string().max(200_000).optional(),
				draftId: id.optional(),
				channels: channelRefs.optional(),
				platform: anyPlatform.optional()
			})
			.strict(),
		async (input, agent) => {
			if (input.channels?.length) {
				const result = await validateChannelsOp(agent, {
					text: input.text,
					draftId: input.draftId,
					channels: input.channels
				});
				return {
					...result,
					summary: result.ok
						? `Fits every channel checked: ${result.channels.map((c) => c.channel.key).join(', ')}.`
						: `Problems:\n${result.problems.join('\n')}`
				};
			}
			if (input.draftId) {
				const check = await checkDraft(agent.ctx, agent.userId, input.draftId);
				return {
					...check,
					summary: check.ok
						? 'The draft fits every account checked.'
						: `Problems:\n${check.problems.join('\n')}`
				};
			}
			if (input.text === undefined)
				throw new ApiOperationError('Send text, a draftId, or both with channels.', 400);
			const result = validatePost({ text: input.text, platform: input.platform });
			return {
				ok: result.issues.length === 0,
				...result,
				summary: `${result.graphemes} graphemes; ${result.issues.length} issue(s)${input.platform ? ` for ${input.platform}` : ''}.`
			};
		}
	);

	register(
		'schedule_posts',
		{
			scope: 'write',
			title: 'Create and schedule posts',
			annotation: annotations.schedule,
			description: `Creates and schedules up to ${MAX_BATCH_POSTS} posts in one call: each with text, optional per-channel or per-platform variants, optional media (public URLs, or a draftId whose text and media you prepared with save_draft/attach_media), target channel keys and runAt (a time, or "next_slot" for each channel’s next open posting slot, which respects the channel’s max posts a day and minimum gap; a time that breaks those limits is refused with the next allowed one). Every post is validated against each channel’s platform rules before anything is written; one bad post refuses the whole batch with every problem listed. Safety: a call that targets more than one channel or brand, or uses runAt "now", returns a preview and a confirmToken instead of writing; show the preview to the operator, then repeat the identical call with confirmToken. Send dryRun: true to preview a single-channel call too, and an idempotencyKey so a retry never schedules twice. A TikTok channel also needs posts[].tiktok, which TikTok allows no default for (ask the operator): either Direct Post (privacy from what the account offers, comments, Duet, Stitch and disclosure; only Only me until TikTok audits the app) or {draft: true}, which sends the video to the TikTok inbox for the operator to post publicly from the app. Review: on a brand that requires it (list_channels says which), committed deliveries come back as status awaiting_review: they keep their time (a next_slot time too, which stays reserved) but nothing goes out until the operator approves them in the Review inbox, so never resend them. Do not use it to change an existing delivery: reschedule_posts changes a time, move_post a channel.`,
			outputSchema: writeOut({
				committed: z.boolean(),
				now: instant,
				posts: z.array(loose({ index: z.number() })),
				warnings: z.array(z.string())
			}),
			example: {
				posts: [
					{
						channels: ['jobjob.linkedin', 'jobjob.instagram'],
						text: 'We are hiring!',
						media: [{ url: 'https://example.com/hiring.jpg', altText: 'Team photo' }],
						runAt: TIME_EXAMPLE
					}
				],
				dryRun: true
			},
			examples: [
				{
					posts: [
						{
							channels: ['jobjob.linkedin'],
							text: 'New roles are open.',
							runAt: { localTime: '2026-11-03T09:00', timeZone: 'Europe/Berlin' }
						}
					],
					idempotencyKey: 'jobjob-2026-11-03-roles'
				},
				{
					posts: [
						{ channels: ['jobjob.linkedin'], text: 'Tip of the week', runAt: 'next_slot' },
						{
							channels: ['jobjob.linkedin'],
							text: 'Second tip',
							runAt: { slot: 'next', after: '2026-11-10' }
						}
					],
					dryRun: true
				},
				{
					posts: [
						{
							channels: ['465cal.tiktok', '465cal.instagram'],
							draftId: 'DRAFT_WITH_VIDEO',
							variants: [{ for: '465cal.instagram', text: 'Link in bio' }],
							runAt: TIME_EXAMPLE,
							tiktok: {
								privacy: 'PUBLIC_TO_EVERYONE',
								allowComment: true,
								allowDuet: false,
								allowStitch: false,
								disclose: false
							}
						}
					],
					dryRun: true
				},
				{
					posts: [
						{
							channels: [{ brand: 'jobjob', platform: 'instagram' }],
							text: 'Morning post',
							runAt: TIME_EXAMPLE
						},
						{
							channels: [{ brand: '465cal', platform: 'instagram' }],
							text: 'Evening post',
							runAt: '2026-11-03T18:00:00+01:00'
						}
					],
					confirmToken: 'cfm_… from the dry run'
				}
			]
		},
		z
			.object({
				posts: z
					.array(
						z
							.object({
								channels: channelRefs,
								text: z.string().max(100_000).optional(),
								title: z.string().max(200).optional(),
								variants: z
									.array(
										z
											.object({
												for: z
													.string()
													.min(1)
													.max(200)
													.describe('A channel key of this post, or a platform name.'),
												text: z.string().max(100_000)
											})
											.strict()
									)
									.max(20)
									.optional(),
								media: z
									.array(
										z
											.object({
												url: z.string().url().max(2048),
												altText: z.string().max(1500).optional()
											})
											.strict()
									)
									.max(4)
									.optional(),
								draftId: id.optional(),
								runAt: slotRunAt,
								tiktok: tiktokOptions
							})
							.strict()
					)
					.min(1)
					.max(MAX_BATCH_POSTS),
				dryRun,
				confirmToken,
				idempotencyKey
			})
			.strict(),
		(input, agent) => schedulePostsOp(agent, input)
	);

	register(
		'reschedule_posts',
		{
			scope: 'write',
			title: 'Change post times',
			annotation: annotations.reschedule,
			description:
				'Moves scheduled deliveries to a new time, leaving their channels and content alone. Each item names one delivery (deliveryId) or a whole post (postId, optionally narrowed to some channels) and the new runAt, or "next_slot" for each channel’s next open posting slot; up to 20 items, all checked against the channels’ posting limits before any is changed. Repeating the same call is safe. Failed deliveries are rescheduled too; published, publishing, cancelled and rejected ones are refused. A delivery held for review stays held at its new time. Use move_post to change channels and publish_now to send immediately.',
			outputSchema: writeOut({
				committed: z.boolean(),
				deliveries: z.array(loose({ deliveryId: z.string(), channel: channelOut })),
				warnings: z.array(z.string())
			}),
			example: { items: [{ postId: 'POST_ID', runAt: TIME_EXAMPLE }] },
			examples: [
				{ items: [{ postId: 'POST_ID', runAt: TIME_EXAMPLE }] },
				{ items: [{ deliveryId: 'DELIVERY_ID', runAt: 'next_slot' }], dryRun: true }
			]
		},
		z
			.object({
				items: z
					.array(z.object({ ...deliverySelector, runAt: slotRunAt }).strict())
					.min(1)
					.max(20),
				dryRun
			})
			.strict(),
		(input, agent) => reschedulePostsOp(agent, input)
	);

	register(
		'move_post',
		{
			scope: 'write',
			title: 'Change a post’s channels',
			annotation: annotations.move,
			description:
				'Moves a post from some channels to others (from → to), or adds channels when from is omitted, keeping its content and, unless runAt is given, its scheduled time. The post is checked against every new channel first. Like a new post, it always needs confirmation: the first call returns before/after and a confirmToken, and the identical call with that token applies it; the old deliveries are cancelled before the new ones are scheduled, so a failure never leaves it on both. Moving to a TikTok channel needs tiktok, as in schedule_posts. Use reschedule_posts for a time-only change and cancel_posts to drop a channel without adding one.',
			outputSchema: writeOut({
				committed: z.boolean(),
				postId: z.string(),
				before: z.array(deliveryOut),
				after: z.array(loose({ channel: channelOut, status: z.string() }))
			}),
			example: {
				postId: 'POST_ID',
				from: ['jobjob.instagram'],
				to: ['465cal.instagram'],
				dryRun: true
			}
		},
		z
			.object({
				postId: id,
				from: channelRefs.optional(),
				to: channelRefs,
				runAt: runAt.optional(),
				tiktok: tiktokOptions,
				dryRun,
				confirmToken,
				idempotencyKey
			})
			.strict(),
		(input, agent) => movePostOp(agent, input)
	);

	register(
		'cancel_posts',
		{
			scope: 'write',
			title: 'Cancel deliveries',
			annotation: annotations.cancel,
			description:
				'Cancels deliveries that have not gone out yet, by deliveryId or by postId (optionally narrowed to some channels); up to 20 items, all checked first, and already-cancelled ones are left as they are. Published or publishing deliveries cannot be cancelled. With deletePost: true and only postIds, it deletes the posts and their media instead, which cannot be undone and is refused once anything was published. Use reschedule_posts to postpone rather than cancel.',
			outputSchema: writeOut({
				committed: z.boolean(),
				deliveries: z.array(loose({ deliveryId: z.string() }))
			}),
			example: { items: [{ postId: 'POST_ID', channels: ['jobjob.linkedin'] }] }
		},
		z
			.object({
				items: z.array(z.object(deliverySelector).strict()).min(1).max(20),
				deletePost: z.boolean().optional()
			})
			.strict(),
		(input, agent) => cancelPostsOp(agent, input)
	);

	register(
		'resubmit_for_review',
		{
			scope: 'write',
			title: 'Resubmit a rejected post for review',
			annotation: annotations.reschedule,
			description:
				'Sends deliveries the operator rejected back to the Review inbox, after you revised the post as their note asked (read it with list_posts or get_post; change text with save_draft and media with edit_media or attach_media). Each item names a delivery (deliveryId) or a whole post (postId, optionally narrowed to some channels); runAt gives them a new time, and is required when the old one has passed. Deliveries already waiting for review are left as they are, so repeating the call is safe. Nothing is published by this: the operator still approves.',
			outputSchema: writeOut({
				committed: z.boolean(),
				deliveries: z.array(deliveryOut)
			}),
			example: { items: [{ postId: 'POST_ID' }], runAt: TIME_EXAMPLE }
		},
		z
			.object({
				items: z.array(z.object(deliverySelector).strict()).min(1).max(20),
				runAt: runAt.optional()
			})
			.strict(),
		(input, agent) => resubmitForReviewOp(agent, input)
	);

	register(
		'publish_now',
		{
			scope: 'write',
			title: 'Publish a post now',
			annotation: annotations.publish,
			description:
				'Publishes an existing post to the given channels immediately, publicly, and retries a failed delivery the same way. Always two steps: the first call checks the post against each channel and returns what would go out with a confirmToken; the identical call with that token publishes. Channels the post already published to are skipped. A TikTok channel needs tiktok (privacy, comments, Duet, Stitch, disclosure, or {draft: true} to send it to the TikTok inbox, the way to a public post until TikTok audits the app) unless save_draft stored them; there is no default. On a brand that requires review nothing is sent: the deliveries come back awaiting_review and go out on the next tick once the operator approves them. To create and publish new content in one go, use schedule_posts with runAt "now"; to post later, use schedule_posts or reschedule_posts.',
			outputSchema: writeOut({
				committed: z.boolean(),
				postId: z.string(),
				deliveries: z.array(loose({ channel: channelOut, status: z.string() }))
			}),
			example: { postId: 'POST_ID', channels: ['jobjob.linkedin'], dryRun: true }
		},
		z
			.object({
				postId: id,
				channels: channelRefs,
				tiktok: tiktokOptions,
				dryRun,
				confirmToken,
				idempotencyKey
			})
			.strict(),
		(input, agent) => publishNowOp(agent, input)
	);

	register(
		'save_draft',
		{
			scope: 'write',
			title: 'Create or edit a draft',
			annotation: annotations.saveDraft,
			description:
				'Creates a draft (no draftId) or edits one: title, text, per-platform variants with options (visibility, spoiler text, poll, explicit thread segments) and the channels it is meant for. A draft is never sent by itself; schedule it with schedule_posts (posts[].draftId) or publish_now. Use it for content that needs media or variant options, then attach media with attach_media. Editing replaces the fields you send; a variant with remove: true is deleted. tiktok stores TikTok’s per-post choices for the draft’s TikTok channels, which schedule_posts and publish_now then use.',
			outputSchema: writeOut({ postId: z.string() }),
			example: {
				text: 'Launch week starts Monday',
				channels: ['465cal.tiktok'],
				variants: [{ platform: 'tiktok', text: 'Launch week 🚀' }]
			}
		},
		z
			.object({
				draftId: id.optional(),
				title: z.string().max(200).nullable().optional(),
				text: z.string().max(100_000).optional(),
				channels: z.array(channelRef).max(10).optional(),
				variants: z
					.array(
						z
							.object({
								platform: anyPlatform,
								text: z.string().max(100_000).nullable().optional(),
								options: z
									.object({
										visibility: z.enum(['public', 'unlisted', 'private', 'direct']).optional(),
										spoilerText: z.string().max(100_000).optional(),
										langs: z.array(z.string().max(100)).max(100).optional(),
										poll: z
											.object({
												options: z.array(z.string().max(50)).min(2).max(4),
												expiresIn: z.number().int().min(300).max(604_800),
												multiple: z.boolean().optional(),
												hideTotals: z.boolean().optional()
											})
											.strict()
											.nullable()
											.optional(),
										threadSegments: z.array(z.string().max(100_000)).max(100).optional()
									})
									.strict()
									.optional(),
								remove: z.boolean().optional()
							})
							.strict()
					)
					.max(7)
					.optional(),
				tiktok: tiktokOptions,
				idempotencyKey
			})
			.strict(),
		async (input, agent) => {
			const { ctx, userId } = agent;
			const run = async () => {
				const { ids, channels } = await resolveIds(agent, input.channels, 'channels');
				const tiktok = await planDraftTiktok(agent, input.draftId, input.channels, input.tiktok);
				let draftId = input.draftId;
				const created = !draftId;
				if (draftId) {
					await updateDraft(ctx, userId, draftId, {
						...(input.title !== undefined ? { title: input.title } : {}),
						...(input.text !== undefined ? { baseBody: input.text } : {}),
						...(ids ? { selectedConnectionIds: ids } : {})
					});
				} else {
					draftId = String(
						(
							await createDraft(ctx, userId, {
								title: input.title ?? null,
								baseBody: input.text ?? '',
								...(ids ? { selectedConnectionIds: ids } : {})
							})
						).draft.id
					);
				}
				for (const variant of input.variants ?? []) {
					if (variant.remove) await deleteDraftVariant(ctx, userId, draftId, variant.platform);
					else
						await setDraftVariant(ctx, userId, draftId, {
							platform: variant.platform,
							...(variant.text !== undefined ? { body: variant.text } : {}),
							...(variant.options ? { options: variant.options } : {})
						});
				}
				// A TikTok variant sent with options replaces them whole, choices included.
				const rewroteTiktok = input.variants?.some((v) => v.platform === 'tiktok');
				if (Object.keys(tiktok.choices).length && (input.tiktok !== undefined || rewroteTiktok))
					await saveDraftTiktok(agent, draftId, tiktok.choices);
				const missing = tiktok.missing.map((m) => m.channel);
				return {
					status: created ? 'created' : 'saved',
					postId: draftId,
					channels: channels.map(channelView),
					...(missing.length ? { tiktokMissing: tiktok.missing } : {}),
					next: `Not scheduled. Attach media with attach_media, then schedule with schedule_posts using posts[].draftId.${missing.length ? ` ${missing.join(', ')} still need TikTok's per-post choices: ask the operator and send them as tiktok here or in schedule_posts; scheduling refuses TikTok without them.` : ''}`,
					summary: `${created ? 'Created' : 'Saved'} draft ${draftId}${channels.length ? ` for ${channels.map((c) => c.key).join(', ')}` : ''}.${missing.length ? ` TikTok choices still missing for ${missing.join(', ')}.` : ''}`
				};
			};
			return withIdempotency(
				ctx.db,
				userId,
				'save_draft',
				input.idempotencyKey,
				{ ...input, idempotencyKey: undefined },
				run,
				agent.now
			);
		}
	);

	register(
		'attach_media',
		{
			scope: 'write',
			title: 'Attach an image or video',
			annotation: annotations.attach,
			description: `Attaches one file to a draft: a public http(s) URL (image up to 16 MB or MP4 video, type read from the file) or a small image inline as base64 (at most ${BASE64_MAX_BYTES / 1_000_000} MB). Without draftId it creates a new empty draft and returns its postId, so you can add text with save_draft and schedule it with schedule_posts (posts[].draftId). A video too large for one request is refused with useUploadSession: send it with media_upload. Simple URL media can also go straight into schedule_posts (posts[].media).`,
			outputSchema: writeOut({ postId: z.string(), media: loose({ mediaId: z.string() }) }),
			example: { url: 'https://example.com/clip.mp4', altText: 'Product demo' }
		},
		z
			.object({
				draftId: id.optional(),
				url: z.string().url().max(2048).optional(),
				base64: z.string().min(1).max(base64Length(BASE64_MAX_BYTES)).optional(),
				segmentIndex: segmentIndex.optional(),
				altText: altText.optional()
			})
			.strict(),
		async (input, agent) => {
			const { ctx, userId } = agent;
			if ((input.url === undefined) === (input.base64 === undefined))
				throw new ApiOperationError('Send exactly one of url or base64.', 400);
			const created = !input.draftId;
			const draftId = input.draftId ?? String((await createDraft(ctx, userId, {})).draft.id);
			try {
				const result = input.url
					? await attachMediaFromUrl(ctx, userId, draftId, {
							url: input.url,
							segmentIndex: input.segmentIndex,
							altText: input.altText
						})
					: await attachBase64Image(ctx, userId, draftId, {
							data: input.base64!,
							segmentIndex: input.segmentIndex,
							altText: input.altText
						});
				const media = mediaOut(result.media as unknown as Record<string, unknown>);
				return {
					status: 'attached',
					postId: draftId,
					createdDraft: created,
					media,
					next: `Media is on draft ${draftId}. Schedule it with schedule_posts: {"posts": [{"draftId": "${draftId}", "text": "…", "channels": [...], "runAt": "…"}]}.`,
					summary: `Attached ${String(media.mime)} (${String(media.mediaId)}) to segment ${String(media.segmentIndex)} of draft ${draftId}${created ? ' (new draft)' : ''}.`
				};
			} catch (err) {
				if (created) await deleteDraft(ctx, userId, draftId).catch(() => {});
				throw err;
			}
		}
	);

	register(
		'media_upload',
		{
			scope: 'write',
			title: 'Upload a large video',
			annotation: annotations.mediaUpload,
			description:
				'Uploads an MP4 of up to 300 MB that you send yourself over HTTP with your API key, in three actions. Action "start" (size, optional draftId; creates a draft when omitted) returns the URL, byte range and headers of every part; PUT each part and keep each answer’s etag. Action "complete" (draftId, upload, and parts with every etag in order) checks the video and attaches it. Action "abort" (draftId, upload) gives an upload up. Use attach_media for anything one request can fetch.',
			outputSchema: writeOut({ postId: z.string() }),
			example: { action: 'start', size: 52_428_800 }
		},
		z
			.object({
				action: z.enum(['start', 'complete', 'abort']),
				draftId: id.optional(),
				size: z.number().int().min(1).optional(),
				segmentIndex: segmentIndex.optional(),
				upload: uploadClaimInput.optional(),
				parts: z
					.array(
						z
							.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(256) })
							.strict()
					)
					.min(1)
					.max(100)
					.optional(),
				altText: altText.optional()
			})
			.strict(),
		async (input, agent) => {
			const { ctx, userId } = agent;
			if (input.action === 'start') {
				if (!input.size) throw new ApiOperationError('start needs size (bytes).', 400);
				const created = !input.draftId;
				const draftId = input.draftId ?? String((await createDraft(ctx, userId, {})).draft.id);
				try {
					const result = await createMediaUpload(
						ctx,
						userId,
						draftId,
						{ size: input.size, segmentIndex: input.segmentIndex },
						ctx.env.APP_URL
					);
					return {
						status: 'started',
						postId: draftId,
						createdDraft: created,
						...result,
						next: `PUT each of the ${result.parts.length} part(s) to its url with your API key, keep each etag, then call media_upload with action "complete", draftId "${draftId}", this upload object and the parts.`,
						summary: `Upload started on draft ${draftId}: ${result.parts.length} part(s) of up to ${result.upload.partSize} bytes.`
					};
				} catch (err) {
					if (created) await deleteDraft(ctx, userId, draftId).catch(() => {});
					throw err;
				}
			}
			if (!input.draftId || !input.upload)
				throw new ApiOperationError(`${input.action} needs draftId and upload.`, 400);
			if (input.action === 'abort') {
				await abortVideoUpload(ctx, userId, input.draftId, input.upload);
				return {
					status: 'aborted',
					postId: input.draftId,
					next: 'Nothing was attached.',
					summary: 'Upload abandoned.'
				};
			}
			if (!input.parts) throw new ApiOperationError('complete needs parts.', 400);
			const result = await completeVideoUpload(ctx, userId, input.draftId, {
				...input.upload,
				parts: input.parts,
				altText: input.altText
			});
			const media = mediaOut(result.media as unknown as Record<string, unknown>);
			return {
				status: 'attached',
				postId: input.draftId,
				media,
				next: 'Schedule the draft with schedule_posts (posts[].draftId).',
				summary: `Video ${String(media.mediaId)} attached to draft ${input.draftId}.`
			};
		}
	);

	register(
		'edit_media',
		{
			scope: 'write',
			title: 'Edit or remove an attachment',
			annotation: annotations.editMedia,
			description:
				'Changes one attachment of a draft (mediaId from get_post). action "update" sets alt text or moves it to another segment; "remove" deletes it and its file; "set_cover" sets a video’s cover from a JPEG of at most 8 MB (coverUrl or coverBase64); "remove_cover" lets each platform pick its own frame. Covers are used only where get_platform_requirements says video.cover. A published post cannot be edited.',
			outputSchema: writeOut({ postId: z.string() }),
			example: { draftId: 'POST_ID', mediaId: 'MEDIA_ID', action: 'update', altText: 'Our team' }
		},
		z
			.object({
				draftId: id,
				mediaId: id,
				action: z.enum(['update', 'remove', 'set_cover', 'remove_cover']),
				altText: altText.optional(),
				segmentIndex: segmentIndex.optional(),
				coverUrl: z.string().url().max(2048).optional(),
				coverBase64: z.string().min(1).max(base64Length(8_000_000)).optional(),
				atMs: z.number().int().min(0).optional()
			})
			.strict(),
		async (input, agent) => {
			const { ctx, userId } = agent;
			const done = (status: string, media: Record<string, unknown> | null, summary: string) => ({
				status,
				postId: input.draftId,
				media: media ? mediaOut(media) : null,
				next: 'get_post shows the draft’s media.',
				summary
			});
			switch (input.action) {
				case 'update': {
					const result = await updateMedia(ctx, userId, input.draftId, async () => ({
						mediaId: input.mediaId,
						altText: input.altText,
						segmentIndex: input.segmentIndex
					}));
					return done(
						'updated',
						result.media as unknown as Record<string, unknown>,
						`Updated ${input.mediaId}.`
					);
				}
				case 'remove':
					await removeMedia(ctx, userId, input.draftId, input.mediaId);
					return done('removed', null, `Removed ${input.mediaId}.`);
				case 'set_cover': {
					if ((input.coverBase64 === undefined) === (input.coverUrl === undefined))
						throw new ApiOperationError(
							'set_cover needs exactly one of coverUrl or coverBase64.',
							400
						);
					const result = await setVideoCover(ctx, userId, input.draftId, {
						mediaId: input.mediaId,
						read: () => coverBytes(ctx, { data: input.coverBase64, url: input.coverUrl }),
						atMs: input.atMs
					});
					return done(
						'cover_set',
						result.media as unknown as Record<string, unknown>,
						`Cover set on ${input.mediaId}.`
					);
				}
				case 'remove_cover': {
					const result = await removeVideoCover(ctx, userId, input.draftId, input.mediaId);
					return done(
						'cover_removed',
						result.media as unknown as Record<string, unknown>,
						`Cover removed from ${input.mediaId}.`
					);
				}
			}
		}
	);

	// The same requirements as a resource, for clients that load context
	// before choosing a tool. Accounts need arguments, so they stay in the tool.
	server.registerResource(
		'platform-requirements',
		REQUIREMENTS_URI,
		{
			title: 'Platform requirements',
			description:
				'What each platform takes in text, images and video, and the ways to attach a file (get_platform_requirements without arguments).',
			mimeType: 'application/json'
		},
		async (uri) => {
			const user = requireUser(event.locals.user);
			requireScope(event.locals, 'read');
			const ctx: OperationContext = event.locals;
			const { platforms, store } = await loadPlatformRequirements(ctx.db, user.id, {
				canMakeJpegCopies: canMakeJpegCopies(ctx)
			});
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'application/json',
						text: JSON.stringify({ platforms, store, attach: attachLimits(ctx) })
					}
				]
			};
		}
	);
	server.registerResource(
		'brand-brief',
		new ResourceTemplate('cogsend://brands/{slug}/brief', {
			list: async () => {
				const user = requireUser(event.locals.user);
				requireScope(event.locals, 'read');
				const rows = await listBrandRows(event.locals.db, user.id);
				return {
					resources: rows.map((b) => ({
						uri: `cogsend://brands/${b.slug}/brief`,
						name: `${b.name} brief`,
						mimeType: 'text/markdown'
					}))
				};
			}
		}),
		{
			title: 'Brand brief',
			description:
				'A brand’s brief as markdown: voice, audience, do and don’t, links, hashtags, calls to action and platform notes (get_brand_brief with the brand).',
			mimeType: 'text/markdown'
		},
		async (uri, variables) => {
			const user = requireUser(event.locals.user);
			requireScope(event.locals, 'read');
			const slug = String(variables.slug ?? '').toLowerCase();
			const rows = await listBrandRows(event.locals.db, user.id);
			const brand = rows.find((b) => b.slug === slug);
			if (!brand) throw new ApiOperationError(`No brand "${slug}"`, 404);
			const brief = (await loadBriefs(event.locals.db, user.id)).get(brand.id);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: 'text/markdown',
						text: briefMarkdown(brand.name, brief ?? { sections: {}, platformNotes: {} })
					}
				]
			};
		}
	);
	return server;
}

const REQUIREMENTS_URI = 'cogsend://platform-requirements';

const eventByRequest = new WeakMap<Request, RequestEvent>();
const handler = createMcpHandler(
	({ requestInfo }) => {
		if (!requestInfo) throw new Error('Missing MCP request information');
		const event = eventByRequest.get(requestInfo);
		if (!event) throw new Error('Missing authenticated MCP request context');
		return createServer(event);
	},
	{
		// 2025-era traffic is routed to serveLegacy in POST, which answers JSON.
		legacy: 'reject',
		responseMode: 'json'
	}
);

/**
 * Clients still on the 2025 protocol (no per-request envelope; most hosted
 * agents today) get a fresh stateless server per request. JSON responses, not
 * SSE, as on the modern path.
 */
async function serveLegacy(event: RequestEvent, parsedBody: unknown): Promise<Response> {
	const server = createServer(event);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	try {
		await server.connect(transport);
		return await transport.handleRequest(event.request, { parsedBody });
	} finally {
		void server.close();
	}
}

export const POST: RequestHandler = async (event) => {
	const parsedBody = isJsonContentType(event.request.headers.get('content-type'))
		? await event.request.json().catch(() => undefined)
		: undefined;
	if (
		parsedBody &&
		typeof parsedBody === 'object' &&
		'method' in parsedBody &&
		parsedBody.method === 'subscriptions/listen'
	) {
		const requestId = 'id' in parsedBody ? parsedBody.id : undefined;
		if (requestId === undefined) return new Response(null, { status: 202 });
		const safeId =
			typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
		return Response.json({
			jsonrpc: '2.0',
			id: safeId,
			error: { code: -32601, message: 'Method not found' }
		});
	}
	if (await isLegacyRequest(event.request, parsedBody)) return serveLegacy(event, parsedBody);
	eventByRequest.set(event.request, event);
	try {
		return await handler.fetch(event.request, { parsedBody });
	} finally {
		eventByRequest.delete(event.request);
	}
};

export const GET: RequestHandler = async () =>
	new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
export const DELETE: RequestHandler = async () =>
	new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
