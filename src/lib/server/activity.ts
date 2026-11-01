import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import { newId, type AppDb } from './db/client';
import { activityLog } from './db/schema';

export type ActorType = 'session' | 'api_key' | 'api_token' | 'system';

export type Actor = { type: ActorType; id: string | null; label: string };

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'Scheduler' };

/** What a request authenticated as, in the words the Activity page uses. */
export function actorOf(locals: {
	authCredential?: 'session' | 'personal_api_key' | 'api_token' | null;
	apiKey?: { id: string; prefix: string } | null;
}): Actor {
	switch (locals.authCredential) {
		case 'personal_api_key':
			return {
				type: 'api_key',
				id: locals.apiKey?.id ?? null,
				label: locals.apiKey ? `API key ${locals.apiKey.prefix}…` : 'API key'
			};
		case 'api_token':
			return { type: 'api_token', id: null, label: 'API_TOKEN' };
		default:
			return { type: 'session', id: null, label: 'You (signed in)' };
	}
}

export type ActivityEntry = {
	action: string;
	summary: string;
	targetType?: string | null;
	targetId?: string | null;
	before?: string | null;
	after?: string | null;
};

/** Long enough for a post excerpt and a channel list, short enough to page through. */
const SUMMARY_MAX = 500;

function clip(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value.length > SUMMARY_MAX ? `${value.slice(0, SUMMARY_MAX - 1)}…` : value;
}

/**
 * Best effort: a log row is never worth failing the write it describes, so a
 * failure is logged and swallowed. Several entries go in one statement.
 */
export async function recordActivity(
	db: AppDb,
	userId: string,
	actor: Actor,
	entries: ActivityEntry | ActivityEntry[],
	at: Date = new Date()
): Promise<void> {
	const list = Array.isArray(entries) ? entries : [entries];
	if (!list.length) return;
	try {
		// 12 bound parameters a row; D1 caps a statement at 100.
		for (let i = 0; i < list.length; i += 8) {
			await db.insert(activityLog).values(
				list.slice(i, i + 8).map((e) => ({
					id: newId(),
					userId,
					actorType: actor.type,
					actorId: actor.id,
					actorLabel: actor.label,
					action: e.action,
					targetType: e.targetType ?? null,
					targetId: e.targetId ?? null,
					summary: clip(e.summary) ?? e.action,
					beforeSummary: clip(e.before),
					afterSummary: clip(e.after),
					createdAt: at
				}))
			);
		}
	} catch (err) {
		console.error('[activity] could not record', list[0]?.action, err);
	}
}

export const ACTIVITY_PAGE = 50;
export const ACTIVITY_MAX_PAGE = 200;

export type ActivityFilter = {
	actorType?: ActorType | null;
	/** An action, or a family of them by prefix: `review` matches `review.approve`. */
	action?: string | null;
	targetId?: string | null;
	/** The `next` cursor of the previous page. */
	cursor?: string | null;
	limit?: number;
};

function decodeCursor(raw: string | null | undefined): { at: number; id: string } | null {
	if (!raw) return null;
	const [at, id] = raw.split('.', 2);
	const n = Number(at);
	return Number.isFinite(n) && id ? { at: n, id } : null;
}

export async function listActivity(db: AppDb, userId: string, filter: ActivityFilter = {}) {
	const limit = Math.min(ACTIVITY_MAX_PAGE, Math.max(1, Math.floor(filter.limit ?? ACTIVITY_PAGE)));
	const where: Array<SQL | undefined> = [eq(activityLog.userId, userId)];
	if (filter.actorType) where.push(eq(activityLog.actorType, filter.actorType));
	if (filter.targetId) where.push(eq(activityLog.targetId, filter.targetId));
	const action = filter.action?.trim();
	if (action && /^[a-z_.]{1,64}$/.test(action)) {
		where.push(
			action.includes('.')
				? eq(activityLog.action, action)
				: or(eq(activityLog.action, action), like(activityLog.action, `${action}.%`))
		);
	}
	const cursor = decodeCursor(filter.cursor);
	if (cursor) {
		const at = new Date(cursor.at);
		where.push(
			or(
				lt(activityLog.createdAt, at),
				and(eq(activityLog.createdAt, at), lt(activityLog.id, cursor.id))
			)
		);
	}
	const rows = await db
		.select()
		.from(activityLog)
		.where(and(...where))
		.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		entries: page.map((r) => ({
			id: r.id,
			at: r.createdAt.getTime(),
			actor: { type: r.actorType, id: r.actorId, label: r.actorLabel },
			action: r.action,
			targetType: r.targetType,
			targetId: r.targetId,
			summary: r.summary,
			before: r.beforeSummary,
			after: r.afterSummary
		})),
		next: rows.length > limit && last ? `${last.createdAt.getTime()}.${last.id}` : null
	};
}

/** How long the log keeps a row; the janitor clears older ones hourly. */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60_000;

export async function purgeOldActivity(db: AppDb, now: Date = new Date()) {
	await db
		.delete(activityLog)
		.where(lt(activityLog.createdAt, new Date(now.getTime() - ACTIVITY_RETENTION_MS)));
}

/**
 * Writes the app routes record on their own, with what changed, or that are
 * not worth a row: sign-in and its steps, the scheduler's endpoints, MCP (one
 * row per tool call instead), checks that change nothing, and upload parts.
 */
const SKIPPED_ROUTES = [
	/^\w+ \/api\/auth\//,
	/^\w+ \/api\/internal\//,
	/^\w+ \/api\/mcp$/,
	/^\w+ \/api\/validate$/,
	/^\w+ \/api\/link-preview$/,
	/^\w+ \/api\/review\//,
	/^PATCH \/api\/brands\/\[id\]$/,
	/^\w+ \/api\/drafts\/\[id\]\/media\/uploads\/part$/
];

/**
 * The composer saves as the operator types, so its own saves would bury
 * everything else; an agent's edits are what the log is for.
 */
const SESSION_AUTOSAVE_ROUTES = [/^\/api\/drafts\/\[id\]$/, /^\/api\/drafts\/\[id\]\/variants$/];

const ACTION_NAMES: Array<[RegExp, string, string]> = [
	[/^POST \/api\/drafts$/, 'post.create', 'Created a post'],
	[/^PATCH \/api\/drafts\/\[id\]$/, 'post.edit', 'Edited a post'],
	[/^DELETE \/api\/drafts\/\[id\]$/, 'post.delete', 'Deleted a post'],
	[/^POST \/api\/drafts\/\[id\]\/duplicate$/, 'post.duplicate', 'Duplicated a post'],
	[/^POST \/api\/drafts\/\[id\]\/schedule$/, 'post.schedule', 'Scheduled a post'],
	[/^POST \/api\/drafts\/\[id\]\/publish$/, 'post.publish', 'Published a post now'],
	[/^\w+ \/api\/drafts\/\[id\]\/variants$/, 'post.edit', 'Edited a platform version'],
	[/^\w+ \/api\/drafts\/\[id\]\/media/, 'post.media', 'Changed a post’s media'],
	[/^\w+ \/api\/drafts\/\[id\]\/share$/, 'post.share', 'Changed a preview link'],
	[/^POST \/api\/targets\/\[id\]\/cancel$/, 'delivery.cancel', 'Cancelled a delivery'],
	[/^POST \/api\/targets\/\[id\]\/retry$/, 'delivery.retry', 'Retried a delivery'],
	[/^POST \/api\/targets\/\[id\]\/reschedule$/, 'delivery.reschedule', 'Rescheduled a delivery'],
	[/^POST \/api\/targets\/bulk$/, 'delivery.bulk', 'Changed several deliveries'],
	[/^POST \/api\/brands$/, 'brand.create', 'Created a brand'],
	[/^DELETE \/api\/brands\/\[id\]$/, 'brand.delete', 'Deleted a brand'],
	[/^\w+ \/api\/connections/, 'account.change', 'Changed a connected account'],
	[/^\w+ \/api\/key$/, 'api_key.change', 'Changed the API key'],
	[/^\w+ \/api\/settings/, 'settings.change', 'Changed settings'],
	[/^\w+ \/api\/account$/, 'account.settings', 'Changed account settings']
];

/** The row a successful REST write leaves, or null when it leaves none. */
export function restActivity(input: {
	method: string;
	routeId: string | null;
	params: Record<string, string>;
	path: string;
	status: number;
	authCredential: 'session' | 'personal_api_key' | 'api_token' | null;
}): ActivityEntry | null {
	const method = input.method.toUpperCase();
	if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
	if (input.status < 200 || input.status >= 400) return null;
	const route = input.routeId;
	if (!route || !route.startsWith('/api/')) return null;
	const key = `${method} ${route}`;
	if (SKIPPED_ROUTES.some((re) => re.test(key))) return null;
	if (input.authCredential === 'session' && SESSION_AUTOSAVE_ROUTES.some((re) => re.test(route)))
		return null;
	const named = ACTION_NAMES.find(([re]) => re.test(key));
	const targetId = input.params.id ?? input.params.platform ?? null;
	return {
		action: named?.[1] ?? 'api.write',
		summary: `${named?.[2] ?? 'Changed something'} (${method} ${input.path})`,
		targetType: route.startsWith('/api/drafts')
			? 'post'
			: route.startsWith('/api/targets/[id]')
				? 'delivery'
				: route.startsWith('/api/brands/[id]')
					? 'brand'
					: route.startsWith('/api/connections/[id]')
						? 'account'
						: null,
		targetId
	};
}
