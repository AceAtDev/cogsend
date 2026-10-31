import { isPlatformId, platformName, platformRank } from './platforms';

/**
 * Channel keys: the human name an agent (or a person) uses for one connected
 * account, `<brand-slug>.<platform>`, e.g. `jobjob.linkedin`.
 *
 * - A brand with two accounts on one platform cannot use the short key for
 *   either: both get `<brand>.<platform>.<handle-slug>`, and the short key
 *   resolves to neither, so a saved `jobjob.instagram` fails loudly instead of
 *   silently picking one when a second account is added.
 * - The long form is always accepted, even when the short one is unique.
 * - Accounts with no brand live under the reserved slug `unbranded`.
 *
 * Keys are computed from the current accounts, never stored, so they cannot
 * drift from the data. Matching is exact (case-insensitive); nothing here
 * guesses.
 */

export const UNBRANDED_SLUG = 'unbranded';
export const MAX_BRAND_NAME = 60;
export const MAX_BRAND_SLUG = 32;

/** Distinct enough on the stone UI to tell brands apart at a glance. */
export const BRAND_COLORS = [
	'#2563eb',
	'#db2777',
	'#16a34a',
	'#ea580c',
	'#7c3aed',
	'#0891b2',
	'#ca8a04',
	'#dc2626'
] as const;

export const UNBRANDED_COLOR = '#78716c';

export function isBrandColor(value: unknown): value is string {
	return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/** Lowercase ASCII letters, digits and single dashes. */
export function slugify(value: string, max = MAX_BRAND_SLUG): string {
	return value
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/g, '');
}

export function isBrandSlug(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_BRAND_SLUG &&
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
		value !== UNBRANDED_SLUG
	);
}

/** `@Pat.Example` and `pat@mastodon.social` both become safe key segments. */
export function handleSlug(handle: string | null | undefined, id: string): string {
	const slug = slugify((handle ?? '').replace(/^@+/, ''), 64);
	return (
		slug ||
		id
			.replace(/[^a-z0-9]/gi, '')
			.slice(0, 8)
			.toLowerCase() ||
		'account'
	);
}

export interface BrandRef {
	id: string;
	name: string;
	slug: string;
	color: string;
}

export interface ChannelSource {
	id: string;
	platform: string;
	handle: string | null;
	displayName: string | null;
	status: string;
	brandId: string | null;
	createdAt?: Date | number | string | null;
}

export interface Channel {
	connectionId: string;
	/** The shortest key that names only this account. */
	key: string;
	/** Every key that resolves to this account, `key` first. */
	keys: string[];
	platform: string;
	platformName: string;
	handle: string | null;
	displayName: string | null;
	status: string;
	brand: { id: string | null; name: string; slug: string; color: string };
}

function createdMs(value: ChannelSource['createdAt']): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	if (typeof value === 'string') return Date.parse(value) || 0;
	return 0;
}

/**
 * Keys for every account given. Disconnected tombstones should be left out by
 * the caller: they cannot be posted to, and counting them would turn a unique
 * short key ambiguous for no visible reason.
 */
export function assignChannelKeys(brands: BrandRef[], sources: ChannelSource[]): Channel[] {
	const brandById = new Map(brands.map((brand) => [brand.id, brand]));
	const ordered = [...sources].sort(
		(a, b) => createdMs(a.createdAt) - createdMs(b.createdAt) || a.id.localeCompare(b.id)
	);
	const groups = new Map<string, ChannelSource[]>();
	for (const source of ordered) {
		const brand = source.brandId ? brandById.get(source.brandId) : undefined;
		const group = `${brand?.slug ?? UNBRANDED_SLUG}.${source.platform}`;
		groups.set(group, [...(groups.get(group) ?? []), source]);
	}
	const out: Channel[] = [];
	for (const [base, members] of groups) {
		const used = new Set<string>();
		for (const source of members) {
			let segment = handleSlug(source.handle, source.id);
			// Two accounts whose handles slug the same (`pat.dev` and `pat-dev`):
			// the id suffix keeps both addressable and stays stable per account.
			if (used.has(segment)) segment = `${segment}-${source.id.slice(0, 6).toLowerCase()}`;
			used.add(segment);
			const long = `${base}.${segment}`;
			const brand = source.brandId ? brandById.get(source.brandId) : undefined;
			out.push({
				connectionId: source.id,
				key: members.length === 1 ? base : long,
				keys: members.length === 1 ? [base, long] : [long],
				platform: source.platform,
				platformName: isPlatformId(source.platform)
					? platformName(source.platform)
					: source.platform,
				handle: source.handle,
				displayName: source.displayName,
				status: source.status,
				brand: brand
					? { id: brand.id, name: brand.name, slug: brand.slug, color: brand.color }
					: { id: null, name: 'Unbranded', slug: UNBRANDED_SLUG, color: UNBRANDED_COLOR }
			});
		}
	}
	return out.sort(
		(a, b) =>
			a.brand.slug.localeCompare(b.brand.slug) ||
			platformRank(a.platform) - platformRank(b.platform) ||
			a.key.localeCompare(b.key)
	);
}

/** A string key or connection id, or `{ brand, platform, handle? }`. */
export type ChannelRef = string | { brand: string; platform: string; handle?: string };

export type ResolveFailure = {
	ok: false;
	ref: string;
	reason: 'unknown' | 'ambiguous' | 'inactive';
	message: string;
	candidates: Channel[];
};
export type ResolveResult = { ok: true; channel: Channel } | ResolveFailure;

export function describeRef(ref: ChannelRef): string {
	if (typeof ref === 'string') return ref;
	return `{brand: ${ref.brand}, platform: ${ref.platform}${ref.handle ? `, handle: ${ref.handle}` : ''}}`;
}

function refToKey(ref: ChannelRef, brands: BrandRef[]): string {
	if (typeof ref === 'string') return ref.trim().toLowerCase();
	const wanted = ref.brand.trim().toLowerCase();
	// The brand may be named by slug or by its exact name ("465Cal").
	const brand =
		brands.find((b) => b.slug === wanted) ?? brands.find((b) => b.name.toLowerCase() === wanted);
	const slug = brand?.slug ?? (wanted === UNBRANDED_SLUG ? UNBRANDED_SLUG : wanted);
	const platform = ref.platform.trim().toLowerCase();
	return `${slug}.${platform}`;
}

const bareHandle = (handle: string | null | undefined) =>
	(handle ?? '').trim().replace(/^@+/, '').toLowerCase();

/**
 * Resolve one reference to exactly one account. Unknown, ambiguous and
 * not-postable references fail with the accounts that would have been valid,
 * so the caller can say what to send instead.
 */
export function resolveChannelRef(
	ref: ChannelRef,
	channels: Channel[],
	brands: BrandRef[],
	{ requireActive = true }: { requireActive?: boolean } = {}
): ResolveResult {
	const label = describeRef(ref);
	const byId = typeof ref === 'string' ? channels.find((c) => c.connectionId === ref.trim()) : null;
	const key = refToKey(ref, brands);
	let match =
		byId ??
		(typeof ref === 'string' || !ref.handle
			? channels.find((c) => c.keys.includes(key))
			: undefined);
	if (typeof ref !== 'string' && ref.handle) {
		// The handle itself, not its slug: `pat.dev` and `pat-dev` slug alike,
		// and picking the first of the two would post as the wrong account.
		const pool = channels.filter((c) => `${c.brand.slug}.${c.platform}` === key);
		const exact = pool.filter((c) => bareHandle(c.handle) === bareHandle(ref.handle));
		if (exact.length === 1) match = exact[0];
		else
			return {
				ok: false,
				ref: label,
				reason: exact.length > 1 ? 'ambiguous' : 'unknown',
				message:
					exact.length > 1
						? `"${label}" matches ${exact.length} accounts with that handle; use a channel key.`
						: `No ${key} channel has the handle ${displayAt(ref.handle)}.`,
				candidates: pool.length ? pool : channels
			};
	}
	if (match) {
		if (requireActive && match.status !== 'active') {
			return {
				ok: false,
				ref: label,
				reason: 'inactive',
				message: `${match.key} (${match.platformName} ${displayAt(match.handle)}) is ${match.status} and cannot be posted to until it is reconnected in Accounts.`,
				candidates: channels.filter((c) => c.status === 'active' && c.platform === match.platform)
			};
		}
		return { ok: true, channel: match };
	}
	const [brandPart, platformPart] = key.split('.');
	const under = channels.filter((c) => c.key.startsWith(`${key}.`));
	if (under.length > 1 || (under.length === 1 && !under[0].keys.includes(key))) {
		return {
			ok: false,
			ref: label,
			reason: 'ambiguous',
			message: `"${label}" matches ${under.length} accounts; name one of them exactly.`,
			candidates: under
		};
	}
	// A bare platform ("instagram") or a brand alone: say which ones exist.
	const samePlatform = channels.filter(
		(c) => c.platform === brandPart || c.platform === platformPart
	);
	const sameBrand = channels.filter((c) => c.brand.slug === brandPart);
	const candidates = samePlatform.length ? samePlatform : sameBrand.length ? sameBrand : channels;
	const ambiguous = !platformPart && samePlatform.length > 1;
	return {
		ok: false,
		ref: label,
		reason: ambiguous ? 'ambiguous' : 'unknown',
		message: ambiguous
			? `"${label}" is a platform, not a channel: ${samePlatform.length} accounts post there. Name the brand too.`
			: `No channel is called "${label}".`,
		candidates
	};
}

export function displayAt(handle: string | null): string {
	if (!handle) return '(no handle)';
	return handle.startsWith('@') ? handle : `@${handle}`;
}

/** One line per candidate, for error text an agent can copy from. */
export function candidateLines(candidates: Channel[]): string[] {
	return candidates.map(
		(c) =>
			`${c.key} — ${c.brand.name}, ${c.platformName} ${displayAt(c.handle)}${c.status === 'active' ? '' : ` (${c.status})`}`
	);
}
