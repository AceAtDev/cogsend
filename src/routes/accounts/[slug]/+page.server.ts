import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { UNBRANDED_COLOR, UNBRANDED_SLUG } from '#lib/domain/channel-keys.js';
import { safeTimeZone } from '#lib/domain/calendar.js';
import { EMPTY_RULES } from '#lib/domain/posting-slots.js';
import { loadBriefs } from '#lib/server/brand-briefs.js';
import { loadChannels } from '#lib/server/brands.js';
import { createSlotPlanner, loadPostingRules, serializeRules } from '#lib/server/posting-slots.js';
import { requireUser } from '#lib/server/require.js';

const PREVIEW_SLOTS = 3;

/** One brand's brief and its accounts' posting slots; `unbranded` has slots only. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals.user);
	const timeZone = safeTimeZone(user.timezone);
	const now = new Date();
	const dir = await loadChannels(locals.db, user.id);
	const unbranded = params.slug === UNBRANDED_SLUG;
	const brand = unbranded ? null : dir.brands.find((b) => b.slug === params.slug);
	if (!unbranded && !brand) error(404, 'Not found');
	const channels = dir.channels.filter((c) => c.brand.id === (brand?.id ?? null));
	const ids = channels.map((c) => c.connectionId);
	const [briefs, rules] = await Promise.all([
		brand ? loadBriefs(locals.db, user.id) : Promise.resolve(new Map()),
		loadPostingRules(locals.db, user.id, ids)
	]);
	const planner = await createSlotPlanner(locals.db, user.id, {
		timeZone,
		now,
		connectionIds: ids,
		rules
	});
	const brief = brand ? briefs.get(brand.id) : undefined;
	return {
		timeZone,
		brand: brand
			? { id: brand.id, name: brand.name, slug: brand.slug, color: brand.color }
			: { id: null, name: 'Unbranded', slug: UNBRANDED_SLUG, color: UNBRANDED_COLOR },
		brief: brand
			? {
					sections: brief?.sections ?? {},
					platformNotes: brief?.platformNotes ?? {},
					updatedAt: brief?.updatedAt ?? null
				}
			: null,
		channels: channels.map((c) => ({
			connectionId: c.connectionId,
			key: c.key,
			platform: c.platform,
			platformName: c.platformName,
			handle: c.handle,
			status: c.status,
			rules: serializeRules(rules.get(c.connectionId) ?? EMPTY_RULES),
			nextOpen: planner.hasSlots(c.connectionId)
				? planner.openSlots(
						c.connectionId,
						now.getTime(),
						now.getTime() + 14 * 86_400_000,
						PREVIEW_SLOTS
					)
				: []
		}))
	};
};
