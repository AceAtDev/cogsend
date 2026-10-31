import { createMcpHandler, isJsonContentType, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { humanizedCause } from '#lib/domain/human-error.js';
import {
	cancelDelivery,
	createDraft,
	deleteDraft,
	deleteDraftVariant,
	duplicateDraft,
	getDraft,
	listConnections,
	listDrafts,
	listQueue,
	publishDraft,
	rescheduleDelivery,
	retryDelivery,
	scheduleDraft,
	setDraftVariant,
	updateDraft,
	validatePost
} from '#lib/server/api/operations.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { checkDraft, refuseMediaProblems } from '#lib/server/api/draft-checks.js';
import {
	abortVideoUpload,
	attachBase64Image,
	attachLimits,
	attachMediaFromUrl,
	BASE64_MAX_BYTES,
	completeVideoUpload,
	coverBytes,
	createMediaUpload,
	listMedia,
	removeMedia,
	removeVideoCover,
	setVideoCover,
	updateMedia
} from '#lib/server/api/media-operations.js';
import { PLATFORM_IDS, type PlatformId } from '#lib/domain/platforms.js';
import { loadPlatformRequirements } from '#lib/server/platform-requirements.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import type { OperationContext } from '#lib/server/api/operations.js';

const id = z.string().min(1).max(128);
const boundedLimit = z.number().int().min(1).max(100).default(50);
const platform = z.enum(['mastodon', 'bluesky', 'linkedin', 'threads', 'instagram', 'tiktok', 'x']);
// Every platform CogSend has a provider for, so a new one is described and
// checked here as soon as it is registered.
const anyPlatform = z.enum(PLATFORM_IDS as [PlatformId, ...PlatformId[]]);
const segmentIndex = z.number().int().min(0).max(100);
const altText = z.string().max(1500).nullable();
const runAt = z.string().min(1).max(64);
const connectionIds = z.array(id).min(1).max(10);
const draftFields = {
	title: z.string().max(200).nullable().optional(),
	baseBody: z.string().max(100_000).optional(),
	selectedConnectionIds: z.array(id).max(10).nullable().optional()
};
const variantOptions = z
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
			.nullable()
			.optional(),
		threadSegments: z.array(z.string().max(100_000)).max(100).optional()
	})
	.strict()
	.optional();

const annotations = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	create: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false
	},
	update: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	delete: {
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
	},
	// Adds to a draft, from a URL anywhere on the web.
	fetch: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	}
} as const;

const dateTime = () =>
	z.preprocess(
		(value) => (value instanceof Date ? value.toISOString() : value),
		z.string().datetime()
	);

const validationCheck = z
	.object({
		ok: z.boolean(),
		length: z.number(),
		max: z.number(),
		message: z.string().optional()
	})
	.passthrough();
const validationIssue = z
	.object({
		field: z.string().optional(),
		message: z.string(),
		code: z.string().optional()
	})
	.passthrough();
const connectionSchema = z
	.object({
		id: z.string(),
		platform: z.string(),
		displayName: z.string().nullable(),
		handle: z.string().nullable(),
		avatarUrl: z.string().nullable(),
		instanceUrl: z.string().nullable(),
		status: z.string(),
		metaJson: z.record(z.string(), z.unknown()),
		createdAt: dateTime()
	})
	.passthrough();
const connectionSummarySchema = z
	.object({
		id: z.string(),
		platform: z.string(),
		handle: z.string().nullable(),
		displayName: z.string().nullable().optional(),
		avatarUrl: z.string().nullable().optional(),
		status: z.string().optional()
	})
	.passthrough();
const variantSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		platform: z.string(),
		body: z.string().nullable(),
		optionsJson: z.record(z.string(), z.unknown()),
		createdAt: dateTime(),
		updatedAt: dateTime()
	})
	.passthrough();
const mediaSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		storageKey: z.string(),
		mime: z.string(),
		size: z.number(),
		width: z.number().nullable(),
		height: z.number().nullable(),
		altText: z.string().nullable(),
		sortOrder: z.number(),
		segmentIndex: z.number(),
		createdAt: dateTime()
	})
	.passthrough();
const targetSchema = z
	.object({
		id: z.string(),
		draftId: z.string(),
		connectionId: z.string(),
		variantId: z.string().nullable(),
		status: z.string(),
		scheduledFor: dateTime().nullable(),
		remotePostId: z.string().nullable(),
		remoteUrl: z.string().nullable(),
		errorMessage: z.string().nullable(),
		attemptCount: z.number(),
		jobId: z.string().nullable(),
		createdAt: dateTime(),
		updatedAt: dateTime(),
		connection: connectionSummarySchema.optional()
	})
	.passthrough();
const draftSchema = z
	.object({
		id: z.string(),
		userId: z.string(),
		title: z.string().nullable(),
		baseBody: z.string(),
		selectedConnectionIds: z.array(z.string()).nullable(),
		status: z.string(),
		createdAt: dateTime(),
		updatedAt: dateTime(),
		variants: z.array(variantSchema),
		media: z.array(mediaSchema),
		targets: z.array(targetSchema)
	})
	.passthrough();
const queueDraftSchema = z
	.object({
		id: z.string(),
		title: z.string().nullable(),
		baseBody: z.string(),
		status: z.string(),
		media: z.array(mediaSchema)
	})
	.passthrough();
const queueTargetSchema = z
	.object({
		id: z.string(),
		status: z.string(),
		scheduledFor: dateTime().nullable(),
		updatedAt: dateTime(),
		remoteUrl: z.string().nullable(),
		errorMessage: z.string().nullable(),
		draft: queueDraftSchema,
		connection: z
			.object({
				id: z.string(),
				platform: z.string(),
				handle: z.string().nullable(),
				displayName: z.string().nullable(),
				avatarUrl: z.string().nullable(),
				status: z.string()
			})
			.passthrough()
	})
	.passthrough();

const videoRequirementsSchema = z
	.object({
		supported: z.boolean(),
		mimes: z.array(z.string()),
		codecs: z.array(z.string()).nullable(),
		maxBytes: z.number(),
		minBytes: z.number().nullable(),
		minDurationMs: z.number().nullable(),
		maxDurationMs: z.number().nullable(),
		aspectRatio: z.object({ min: z.number(), max: z.number(), label: z.string() }).nullable(),
		maxWidth: z.number().nullable(),
		maxPixels: z.number().nullable(),
		minFps: z.number().nullable(),
		maxFps: z.number().nullable(),
		faststart: z.boolean(),
		cover: z.boolean(),
		perPost: z.number(),
		notes: z.array(z.string())
	})
	.passthrough();
const platformRequirementsSchema = z
	.object({
		platform: z.string(),
		name: z.string(),
		summary: z.string(),
		text: z.object({ maxCharacters: z.number().nullable() }).passthrough(),
		threads: z.object({ supported: z.boolean(), flattened: z.boolean() }).passthrough(),
		media: z
			.object({
				required: z.boolean(),
				mixImagesAndVideo: z.boolean(),
				limitsApplyTo: z.enum(['segment', 'post'])
			})
			.passthrough(),
		images: z
			.object({
				maxPerPost: z.number(),
				maxPerSegment: z.number(),
				mimes: z.array(z.string()),
				maxBytes: z.number(),
				maxBytesByMime: z.record(z.string(), z.number()),
				aspectRatio: z.object({ min: z.number(), max: z.number(), label: z.string() }).nullable()
			})
			.passthrough(),
		video: videoRequirementsSchema,
		altText: z
			.object({ images: z.boolean(), videos: z.boolean(), maxLength: z.number() })
			.passthrough(),
		notes: z.array(z.string())
	})
	.passthrough();
const accountRequirementsSchema = z
	.object({
		connectionId: z.string(),
		platform: z.string(),
		handle: z.string().nullable(),
		displayName: z.string().nullable(),
		status: z.string(),
		text: z.object({ maxCharacters: z.number().nullable() }).passthrough(),
		video: videoRequirementsSchema,
		summary: z.string()
	})
	.passthrough();
const draftIssueSchema = z
	.object({
		kind: z.enum(['media', 'text', 'post', 'account']),
		message: z.string(),
		code: z.string().optional(),
		field: z.string().optional(),
		post: z.number().optional(),
		attached: z.object({ images: z.number(), videos: z.number() }).optional()
	})
	.passthrough();
const draftCheckSchema = z
	.object({
		draftId: z.string(),
		ok: z.boolean(),
		accounts: z.array(
			z
				.object({
					connectionId: z.string(),
					platform: z.string(),
					handle: z.string().nullable(),
					label: z.string(),
					ok: z.boolean(),
					issues: z.array(draftIssueSchema)
				})
				.passthrough()
		),
		problems: z.array(z.string())
	})
	.passthrough();
const attachedMediaSchema = z
	.object({ media: mediaSchema, sourceUrl: z.string().optional() })
	.passthrough();
const uploadClaimSchema = z
	.object({
		draftId: z.string(),
		key: z.string(),
		uploadId: z.string(),
		size: z.number(),
		segmentIndex: z.number(),
		token: z.string(),
		partSize: z.number(),
		parts: z.number()
	})
	.passthrough();

const mcpOutputSchemas = {
	list_connections: z
		.object({
			connections: z.array(connectionSchema),
			configured: z
				.object({
					linkedin: z.boolean(),
					threads: z.boolean(),
					instagram: z.boolean(),
					tiktok: z.boolean(),
					x: z.boolean()
				})
				.passthrough(),
			appUrl: z.string()
		})
		.passthrough(),
	list_drafts: z.object({ drafts: z.array(draftSchema), hasMore: z.boolean() }).passthrough(),
	get_draft: z.object({ draft: draftSchema }).passthrough(),
	create_draft: z.object({ draft: draftSchema }).passthrough(),
	update_draft: z.object({ ok: z.literal(true) }).passthrough(),
	duplicate_draft: z.object({ draft: draftSchema }).passthrough(),
	delete_draft: z.object({ ok: z.literal(true) }).passthrough(),
	set_draft_variant: z.object({ variant: variantSchema }).passthrough(),
	delete_draft_variant: z.object({ ok: z.literal(true) }).passthrough(),
	validate_post: z
		.object({
			graphemes: z.number(),
			mastodonLength: z.number(),
			bluesky: validationCheck,
			mastodon: validationCheck,
			linkedin: validationCheck,
			threads: validationCheck,
			instagram: validationCheck,
			tiktok: validationCheck,
			x: validationCheck,
			issues: z.array(validationIssue),
			draft: draftCheckSchema.optional()
		})
		.passthrough(),
	publish_draft: z
		.object({
			results: z.array(
				z
					.object({
						targetId: z.string(),
						connectionId: z.string(),
						platform: z.string(),
						handle: z.string().nullable(),
						displayName: z.string().nullable(),
						status: z.string(),
						permalink: z.string().nullable(),
						error: z.string().nullable(),
						skipped: z.boolean(),
						inFlight: z.boolean().optional()
					})
					.passthrough()
			),
			stopped: z.boolean().optional(),
			stoppedError: z.string().optional(),
			draft: draftSchema.nullable()
		})
		.passthrough(),
	schedule_draft: z
		.object({ targets: z.array(targetSchema), scheduledFor: dateTime() })
		.passthrough(),
	list_queue: z.object({ targets: z.array(queueTargetSchema), hasMore: z.boolean() }).passthrough(),
	cancel_delivery: z.object({ target: targetSchema }).passthrough(),
	retry_delivery: z
		.object({
			status: z.string(),
			remotePostId: z.string().optional(),
			error: z.string().optional(),
			skipped: z.boolean().optional()
		})
		.passthrough(),
	reschedule_delivery: z.object({ ok: z.literal(true), scheduledFor: dateTime() }).passthrough(),
	get_platform_requirements: z
		.object({
			platforms: z.array(platformRequirementsSchema),
			accounts: z.array(accountRequirementsSchema),
			store: z.record(z.string(), z.unknown()),
			attach: z.record(z.string(), z.unknown())
		})
		.passthrough(),
	list_media: z.object({ media: z.array(mediaSchema) }).passthrough(),
	attach_media_from_url: attachedMediaSchema,
	attach_media_base64: attachedMediaSchema,
	create_media_upload: z
		.object({
			upload: uploadClaimSchema,
			parts: z.array(
				z
					.object({
						partNumber: z.number(),
						offset: z.number(),
						length: z.number(),
						url: z.string()
					})
					.passthrough()
			),
			request: z.record(z.string(), z.unknown()),
			complete: z.record(z.string(), z.unknown()),
			abort: z.record(z.string(), z.unknown())
		})
		.passthrough(),
	complete_media_upload: attachedMediaSchema,
	abort_media_upload: z.object({ ok: z.literal(true) }).passthrough(),
	update_media: attachedMediaSchema,
	remove_media: z.object({ ok: z.literal(true) }).passthrough(),
	set_video_cover: attachedMediaSchema,
	remove_video_cover: attachedMediaSchema
} as const;

type ToolSpec = {
	scope: 'read' | 'write';
	annotation: (typeof annotations)[keyof typeof annotations];
	description: string;
	outputSchema: z.ZodType;
};

function concise(name: string, result: Record<string, unknown>): string {
	const draft = result.draft as { id?: string; title?: string | null } | undefined;
	switch (name) {
		case 'list_drafts':
			return `${Array.isArray(result.drafts) ? result.drafts.length : 0} drafts${result.hasMore ? ' (more available)' : ''}`;
		case 'list_connections':
			return `${Array.isArray(result.connections) ? result.connections.length : 0} connections`;
		case 'list_queue':
			return `${Array.isArray(result.targets) ? result.targets.length : 0} delivery targets${result.hasMore ? ' (more available)' : ''}`;
		case 'validate_post': {
			const summary = `Validated ${String(result.graphemes ?? 0)} graphemes; ${Array.isArray(result.issues) ? result.issues.length : 0} platform-specific issues`;
			const draft = result.draft as { ok?: boolean; problems?: string[] } | undefined;
			if (!draft) return summary;
			if (draft.ok) return `${summary}. The draft fits every account checked.`;
			return `${summary}. The draft has problems:\n${(draft.problems ?? []).join('\n')}`;
		}
		case 'publish_draft': {
			const results = Array.isArray(result.results) ? result.results : [];
			const succeeded = results.filter(
				(item) => (item as { status?: string }).status === 'published'
			).length;
			return `Published ${succeeded} of ${results.length} targets${result.stopped ? '; stopped early' : ''}`;
		}
		case 'schedule_draft':
			return `Scheduled ${Array.isArray(result.targets) ? result.targets.length : 0} delivery targets for ${String(result.scheduledFor ?? 'the requested time')}`;
		case 'cancel_delivery': {
			const target = result.target as { status?: string } | undefined;
			return `cancel_delivery: ${target?.status ?? 'done'}`;
		}
		case 'retry_delivery':
			return `retry_delivery: ${String(result.status ?? 'started')}${result.skipped ? ' (already published)' : ''}`;
		case 'reschedule_delivery':
			return `reschedule_delivery: scheduled for ${String(result.scheduledFor ?? 'the requested time')}`;
		case 'get_draft':
		case 'create_draft':
		case 'duplicate_draft':
			return `${name}: ${draft?.title || 'Draft'} (${draft?.id ?? 'saved'})`;
		case 'set_draft_variant':
			return 'set_draft_variant: variant saved';
		case 'get_platform_requirements': {
			const platforms = Array.isArray(result.platforms) ? result.platforms : [];
			const accounts = Array.isArray(result.accounts) ? result.accounts : [];
			return [...platforms, ...accounts]
				.map((p) => (p as { summary?: string }).summary ?? '')
				.join('\n');
		}
		case 'list_media':
			return `${Array.isArray(result.media) ? result.media.length : 0} attachments`;
		case 'attach_media_from_url':
		case 'attach_media_base64':
		case 'complete_media_upload':
		case 'update_media':
		case 'set_video_cover':
		case 'remove_video_cover': {
			const media = result.media as
				{ id?: string; mime?: string; segmentIndex?: number } | undefined;
			return `${name}: ${media?.mime ?? 'media'} ${media?.id ?? ''} on segment ${media?.segmentIndex ?? 0}`;
		}
		case 'create_media_upload': {
			const upload = result.upload as { parts?: number; partSize?: number } | undefined;
			return `create_media_upload: PUT ${upload?.parts ?? 0} part(s) of up to ${upload?.partSize ?? 0} bytes to the listed URLs with your API key, then call complete_media_upload with every etag`;
		}
		default:
			return `${name}: ${result.ok === true ? 'done' : 'completed'}`;
	}
}

function registerForEvent<T extends z.ZodType>(
	server: McpServer,
	event: RequestEvent,
	name: string,
	spec: ToolSpec,
	inputSchema: T,
	operation: (
		input: z.infer<T>,
		ctx: OperationContext,
		userId: string
	) => Promise<Record<string, unknown>> | Record<string, unknown>
) {
	server.registerTool(
		name,
		{
			description: spec.description,
			inputSchema,
			outputSchema: spec.outputSchema,
			annotations: spec.annotation
		} as never,
		(async (input: z.infer<T>) => {
			try {
				const user = requireUser(event.locals.user);
				requireScope(event.locals, spec.scope);
				// Publish and retry hand their provider calls to locals.waitUntil, as
				// the REST routes do, so a client that disconnects mid-call cannot cut
				// them off.
				const ctx: OperationContext = event.locals;
				const result = await operation(input as z.infer<T>, ctx, user.id);
				return {
					content: [{ type: 'text' as const, text: concise(name, result) }],
					structuredContent: result
				};
			} catch (error) {
				const rawStatus = Number((error as { status?: unknown })?.status ?? 500);
				let status: number;
				if (rawStatus >= 400 && rawStatus < 600) status = rawStatus;
				else if (rawStatus < 500) status = 400;
				else status = 500;
				const message = error instanceof Error ? error.message : 'Server error';
				let safeMessage = message;
				if (status === 401 && (!message || message === 'Server error'))
					safeMessage = 'Unauthorized';
				else if (status >= 500)
					safeMessage = humanizedCause(message) ?? 'Something went wrong on the server';
				const details =
					error instanceof ApiOperationError && status < 500 && status !== 401
						? error.details
						: undefined;
				const safe = { error: safeMessage, status, ...(details ?? {}) };
				if (status >= 500) console.error('[mcp] tool failed', error);
				// Every problem, one a line, so an agent can fix them all in one pass.
				const problems = Array.isArray(details?.problems) ? (details.problems as string[]) : [];
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: problems.length > 1 ? problems.join('\n') : safeMessage
						}
					],
					structuredContent: safe
				};
			}
		}) as never
	);
}

function createServer(event: RequestEvent) {
	const server = new McpServer({ name: 'cogsend', version: '1.0.0' });
	const register = <T extends z.ZodType>(
		server: McpServer,
		name: string,
		spec: ToolSpec,
		inputSchema: T,
		operation: (
			input: z.infer<T>,
			ctx: OperationContext,
			userId: string
		) => Promise<Record<string, unknown>> | Record<string, unknown>
	) => registerForEvent(server, event, name, spec, inputSchema, operation);
	const read = annotations.read;
	const write = annotations.update;
	register(
		server,
		'list_connections',
		{
			scope: 'read',
			annotation: read,
			description: 'List connected social accounts and provider configuration.',
			outputSchema: mcpOutputSchemas.list_connections
		},
		z.object({}).strict(),
		(_input, ctx, uid) => listConnections(ctx, uid)
	);
	register(
		server,
		'list_drafts',
		{
			scope: 'read',
			annotation: read,
			description: 'List drafts, newest updated first.',
			outputSchema: mcpOutputSchemas.list_drafts
		},
		z.object({ limit: boundedLimit }).strict(),
		(input, ctx, uid) => listDrafts(ctx, uid, input.limit)
	);
	register(
		server,
		'get_draft',
		{
			scope: 'read',
			annotation: read,
			description: 'Get one draft and its variants, media, and delivery targets.',
			outputSchema: mcpOutputSchemas.get_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => getDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'create_draft',
		{
			scope: 'write',
			annotation: annotations.create,
			description: 'Create a draft.',
			outputSchema: mcpOutputSchemas.create_draft
		},
		z.object(draftFields).strict(),
		(input, ctx, uid) => createDraft(ctx, uid, input)
	);
	register(
		server,
		'update_draft',
		{
			scope: 'write',
			annotation: write,
			description: 'Update a draft.',
			outputSchema: mcpOutputSchemas.update_draft
		},
		z.object({ draftId: id, ...draftFields }).strict(),
		(input, ctx, uid) => {
			const { draftId, ...patch } = input;
			return updateDraft(ctx, uid, draftId, patch);
		}
	);
	register(
		server,
		'duplicate_draft',
		{
			scope: 'write',
			annotation: annotations.create,
			description: 'Duplicate a draft and its supported media and variants.',
			outputSchema: mcpOutputSchemas.duplicate_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => duplicateDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'delete_draft',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Delete a draft.',
			outputSchema: mcpOutputSchemas.delete_draft
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => deleteDraft(ctx, uid, input.draftId)
	);
	register(
		server,
		'set_draft_variant',
		{
			scope: 'write',
			annotation: write,
			description: 'Create or update a platform-specific draft variant.',
			outputSchema: mcpOutputSchemas.set_draft_variant
		},
		z
			.object({
				draftId: id,
				platform,
				body: z.string().max(100_000).nullable().optional(),
				options: variantOptions
			})
			.strict(),
		(input, ctx, uid) => setDraftVariant(ctx, uid, input.draftId, input)
	);
	register(
		server,
		'delete_draft_variant',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Delete a platform-specific draft variant.',
			outputSchema: mcpOutputSchemas.delete_draft_variant
		},
		z.object({ draftId: id, platform }).strict(),
		(input, ctx, uid) => deleteDraftVariant(ctx, uid, input.draftId, input.platform)
	);
	register(
		server,
		'validate_post',
		{
			scope: 'read',
			annotation: read,
			description:
				'Validate post text against supported platform limits. With draftId, also check the whole draft (text, media, threads) for each account it would go to, as publishing will, and return every problem per account with what to fix.',
			outputSchema: mcpOutputSchemas.validate_post
		},
		z
			.object({
				text: z.string().max(200_000).optional(),
				platform: platform.optional(),
				maxCharacters: z.number().int().min(1).max(100_000).optional(),
				draftId: id.optional(),
				connectionIds: connectionIds.optional()
			})
			.strict(),
		async (input, ctx, uid) => {
			if (!input.draftId) {
				if (input.text === undefined) throw new ApiOperationError('text or draftId required');
				if (input.connectionIds) throw new ApiOperationError('connectionIds needs a draftId');
				return validatePost(input);
			}
			const draft = await checkDraft(ctx, uid, input.draftId, input.connectionIds);
			const text = input.text ?? (await getDraft(ctx, uid, input.draftId)).draft.baseBody;
			return { ...validatePost({ ...input, text }), draft };
		}
	);
	register(
		server,
		'publish_draft',
		{
			scope: 'write',
			annotation: annotations.publish,
			description:
				'Publish a draft to selected connected accounts. Refused before anything is sent when a platform would refuse the media, with every problem listed per account.',
			outputSchema: mcpOutputSchemas.publish_draft
		},
		z.object({ draftId: id, connectionIds }).strict(),
		async (input, ctx, uid) => {
			await refuseMediaProblems(ctx, uid, input.draftId, input.connectionIds);
			return publishDraft(ctx, uid, input.draftId, { connectionIds: input.connectionIds });
		}
	);
	register(
		server,
		'schedule_draft',
		{
			scope: 'write',
			annotation: write,
			description:
				'Schedule a draft for selected connected accounts. Refused before anything is scheduled when a platform would refuse the media, with every problem listed per account.',
			outputSchema: mcpOutputSchemas.schedule_draft
		},
		z.object({ draftId: id, connectionIds, runAt }).strict(),
		async (input, ctx, uid) => {
			await refuseMediaProblems(ctx, uid, input.draftId, input.connectionIds);
			return scheduleDraft(ctx, uid, input.draftId, input);
		}
	);
	register(
		server,
		'list_queue',
		{
			scope: 'read',
			annotation: read,
			description: 'List scheduled and recent delivery targets.',
			outputSchema: mcpOutputSchemas.list_queue
		},
		z.object({ limit: boundedLimit }).strict(),
		(input, ctx, uid) => listQueue(ctx, uid, input.limit)
	);
	register(
		server,
		'cancel_delivery',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Cancel a pending delivery.',
			outputSchema: mcpOutputSchemas.cancel_delivery
		},
		z.object({ targetId: id }).strict(),
		(input, ctx, uid) => cancelDelivery(ctx, uid, input.targetId)
	);
	register(
		server,
		'retry_delivery',
		{
			scope: 'write',
			annotation: annotations.publish,
			description: 'Retry a delivery now.',
			outputSchema: mcpOutputSchemas.retry_delivery
		},
		z.object({ targetId: id }).strict(),
		(input, ctx, uid) => retryDelivery(ctx, uid, input.targetId)
	);
	register(
		server,
		'reschedule_delivery',
		{
			scope: 'write',
			annotation: write,
			description: 'Change a delivery scheduled time.',
			outputSchema: mcpOutputSchemas.reschedule_delivery
		},
		z.object({ targetId: id, runAt }).strict(),
		(input, ctx, uid) => rescheduleDelivery(ctx, uid, input.targetId, { runAt: input.runAt })
	);
	registerMediaTools(server, register);
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
	return server;
}

const REQUIREMENTS_URI = 'cogsend://platform-requirements';

type Register = <T extends z.ZodType>(
	server: McpServer,
	name: string,
	spec: ToolSpec,
	inputSchema: T,
	operation: (
		input: z.infer<T>,
		ctx: OperationContext,
		userId: string
	) => Promise<Record<string, unknown>> | Record<string, unknown>
) => void;

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

function canMakeJpegCopies(ctx: OperationContext): boolean {
	return Boolean((ctx.bindings as { IMAGES?: unknown } | undefined)?.IMAGES);
}

function registerMediaTools(server: McpServer, register: Register) {
	const read = annotations.read;
	register(
		server,
		'get_platform_requirements',
		{
			scope: 'read',
			annotation: read,
			description:
				'What each platform takes before you build a post: text limit, whether media is required, how many images and of which types and sizes, whether images and video can mix, video container, codecs, size, duration, aspect, resolution and frame-rate limits, covers, threads and alt text, with a one-line summary each. Give connectionIds to add what each account changes (a Mastodon instance’s limits, an X plan). Also lists the ways to attach a file and their size caps.',
			outputSchema: mcpOutputSchemas.get_platform_requirements
		},
		z
			.object({
				platforms: z.array(anyPlatform).max(20).optional(),
				connectionIds: connectionIds.optional()
			})
			.strict(),
		async (input, ctx, uid) => ({
			...(await loadPlatformRequirements(ctx.db, uid, {
				platforms: input.platforms,
				connectionIds: input.connectionIds,
				canMakeJpegCopies: canMakeJpegCopies(ctx)
			})),
			attach: attachLimits(ctx)
		})
	);
	register(
		server,
		'list_media',
		{
			scope: 'read',
			annotation: read,
			description: 'List a draft’s attachments in order, by segment.',
			outputSchema: mcpOutputSchemas.list_media
		},
		z.object({ draftId: id }).strict(),
		(input, ctx, uid) => listMedia(ctx, uid, input.draftId)
	);
	register(
		server,
		'attach_media_from_url',
		{
			scope: 'write',
			annotation: annotations.fetch,
			description:
				'Fetch a public http(s) image (PNG, JPEG, WebP, GIF, up to 16 MB) or MP4 video and attach it to one segment of a draft. The type is read from the file itself. A video too large for one request is refused with useUploadSession: use create_media_upload for it.',
			outputSchema: mcpOutputSchemas.attach_media_from_url
		},
		z
			.object({
				draftId: id,
				url: z.string().url().max(2048),
				segmentIndex: segmentIndex.optional(),
				altText: altText.optional()
			})
			.strict(),
		(input, ctx, uid) => attachMediaFromUrl(ctx, uid, input.draftId, input)
	);
	register(
		server,
		'attach_media_base64',
		{
			scope: 'write',
			annotation: annotations.create,
			description: `Attach a small image (PNG, JPEG, WebP or GIF, at most ${BASE64_MAX_BYTES / 1_000_000} MB decoded) sent inline as base64. Larger files and videos go by URL or create_media_upload.`,
			outputSchema: mcpOutputSchemas.attach_media_base64
		},
		z
			.object({
				draftId: id,
				data: z.string().min(1).max(base64Length(BASE64_MAX_BYTES)),
				segmentIndex: segmentIndex.optional(),
				altText: altText.optional()
			})
			.strict(),
		(input, ctx, uid) => attachBase64Image(ctx, uid, input.draftId, input)
	);
	register(
		server,
		'create_media_upload',
		{
			scope: 'write',
			annotation: annotations.create,
			description:
				'Start an upload of a large MP4 (up to 300 MB) that you send yourself over HTTP with your API key: returns the URL, byte range and headers for every part. PUT each part, keep each answer’s etag, then call complete_media_upload.',
			outputSchema: mcpOutputSchemas.create_media_upload
		},
		z
			.object({
				draftId: id,
				size: z.number().int().min(1),
				mime: z.literal('video/mp4').optional(),
				segmentIndex: segmentIndex.optional()
			})
			.strict(),
		(input, ctx, uid) => createMediaUpload(ctx, uid, input.draftId, input, ctx.env.APP_URL)
	);
	register(
		server,
		'complete_media_upload',
		{
			scope: 'write',
			annotation: annotations.create,
			description:
				'Finish an upload from create_media_upload: pass its upload object and every part’s etag in order. The video is checked and attached.',
			outputSchema: mcpOutputSchemas.complete_media_upload
		},
		z
			.object({
				draftId: id,
				upload: uploadClaimInput,
				parts: z
					.array(
						z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(256) })
					)
					.min(1)
					.max(100),
				altText: altText.optional()
			})
			.strict(),
		(input, ctx, uid) =>
			completeVideoUpload(ctx, uid, input.draftId, {
				...input.upload,
				parts: input.parts,
				altText: input.altText
			})
	);
	register(
		server,
		'abort_media_upload',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Abandon an upload from create_media_upload.',
			outputSchema: mcpOutputSchemas.abort_media_upload
		},
		z.object({ draftId: id, upload: uploadClaimInput }).strict(),
		(input, ctx, uid) => abortVideoUpload(ctx, uid, input.draftId, input.upload)
	);
	register(
		server,
		'update_media',
		{
			scope: 'write',
			annotation: annotations.update,
			description: 'Change an attachment’s alt text, or move it to another segment.',
			outputSchema: mcpOutputSchemas.update_media
		},
		z
			.object({
				draftId: id,
				mediaId: id,
				altText: altText.optional(),
				segmentIndex: segmentIndex.optional()
			})
			.strict(),
		(input, ctx, uid) => updateMedia(ctx, uid, input.draftId, async () => input)
	);
	register(
		server,
		'remove_media',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Remove an attachment from a draft and delete its file.',
			outputSchema: mcpOutputSchemas.remove_media
		},
		z.object({ draftId: id, mediaId: id }).strict(),
		(input, ctx, uid) => removeMedia(ctx, uid, input.draftId, input.mediaId)
	);
	register(
		server,
		'set_video_cover',
		{
			scope: 'write',
			annotation: annotations.update,
			description:
				'Set a video’s cover from a JPEG of at most 8 MB, inline as base64 (data) or from a public URL (url). Only platforms whose requirements say video.cover use it.',
			outputSchema: mcpOutputSchemas.set_video_cover
		},
		z
			.object({
				draftId: id,
				mediaId: id,
				data: z.string().min(1).max(base64Length(8_000_000)).optional(),
				url: z.string().url().max(2048).optional(),
				atMs: z.number().int().min(0).optional()
			})
			.strict(),
		(input, ctx, uid) => {
			if ((input.data === undefined) === (input.url === undefined)) {
				throw new ApiOperationError('Send exactly one of data or url');
			}
			return setVideoCover(ctx, uid, input.draftId, {
				mediaId: input.mediaId,
				read: () => coverBytes(ctx, input),
				atMs: input.atMs
			});
		}
	);
	register(
		server,
		'remove_video_cover',
		{
			scope: 'write',
			annotation: annotations.delete,
			description: 'Remove a video’s cover, so each platform picks its own frame.',
			outputSchema: mcpOutputSchemas.remove_video_cover
		},
		z.object({ draftId: id, mediaId: id }).strict(),
		(input, ctx, uid) => removeVideoCover(ctx, uid, input.draftId, input.mediaId)
	);
}

const eventByRequest = new WeakMap<Request, RequestEvent>();
const handler = createMcpHandler(
	({ requestInfo }) => {
		if (!requestInfo) throw new Error('Missing MCP request information');
		const event = eventByRequest.get(requestInfo);
		if (!event) throw new Error('Missing authenticated MCP request context');
		return createServer(event);
	},
	{
		legacy: 'reject',
		responseMode: 'json'
	}
);

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
