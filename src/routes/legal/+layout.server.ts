import type { LayoutServerLoad } from './$types';
import { instanceFacts } from '#lib/server/legal.js';

// Public (isPublicPath): the terms and privacy policy platform app reviews read.
export const load: LayoutServerLoad = async ({ locals }) => ({
	facts: await instanceFacts(locals)
});
