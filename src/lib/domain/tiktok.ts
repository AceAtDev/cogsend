/**
 * TikTok's per-post choices and the rules its Content Sharing Guidelines put
 * on them (https://developers.tiktok.com/doc/content-sharing-guidelines).
 * Shared by the composer, which shows them, and the server, which refuses a
 * post that breaks them: TikTok audits an app on both.
 */
export const TIKTOK_PRIVACY_LEVELS = [
	'PUBLIC_TO_EVERYONE',
	'MUTUAL_FOLLOW_FRIENDS',
	'FOLLOWER_OF_CREATOR',
	'SELF_ONLY'
] as const;

export type TiktokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/** The words TikTok's own app uses for each level. */
const LABELS: Record<TiktokPrivacy, string> = {
	PUBLIC_TO_EVERYONE: 'Everyone',
	MUTUAL_FOLLOW_FRIENDS: 'Friends',
	FOLLOWER_OF_CREATOR: 'Followers',
	SELF_ONLY: 'Only me'
};

export const TIKTOK_MUSIC_USAGE_URL =
	'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
export const TIKTOK_BRANDED_CONTENT_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

export const TIKTOK_PROCESSING_NOTE =
	'TikTok can take a few minutes to process a video before it shows on the profile.';

export function isTiktokPrivacy(value: unknown): value is TiktokPrivacy {
	return typeof value === 'string' && (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value);
}

export function tiktokPrivacyLabel(level: string): string {
	return isTiktokPrivacy(level) ? LABELS[level] : level;
}

/**
 * What the creator chose for one post to one account. `privacy` is null until
 * they pick it: the guidelines allow no default, so nothing here starts with
 * one, and the interaction and disclosure switches all start off.
 */
export interface TiktokPostChoice {
	privacy: TiktokPrivacy | null;
	allowComment: boolean;
	allowDuet: boolean;
	allowStitch: boolean;
	/** "Disclose video content": the post promotes a brand, product or service. */
	disclose: boolean;
	/** Promotes the creator's own business (`brand_organic_toggle`). */
	yourBrand: boolean;
	/** Promotes a third party in exchange for something (`brand_content_toggle`). */
	brandedContent: boolean;
}

export const EMPTY_TIKTOK_CHOICE: Readonly<TiktokPostChoice> = Object.freeze({
	privacy: null,
	allowComment: false,
	allowDuet: false,
	allowStitch: false,
	disclose: false,
	yourBrand: false,
	brandedContent: false
});

/** What creator_info says the account may do, as far as a post's choices go. */
export interface TiktokCreatorRules {
	privacyOptions?: readonly string[];
	commentDisabled?: boolean;
	duetDisabled?: boolean;
	stitchDisabled?: boolean;
	maxVideoSec?: number;
}

const CHOICE_KEYS = [
	'privacy',
	'allowComment',
	'allowDuet',
	'allowStitch',
	'disclose',
	'yourBrand',
	'brandedContent'
] as const;

/**
 * A choice from untrusted input (a request body, a stored draft), or an error.
 * Absent switches are off; a privacy that is absent or null stays unchosen.
 */
export function parseTiktokChoice(
	raw: unknown
): { ok: true; choice: TiktokPostChoice } | { ok: false; error: string } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: 'TikTok options must be an object' };
	}
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!(CHOICE_KEYS as readonly string[]).includes(key)) {
			return { ok: false, error: `Unknown TikTok option "${key}"` };
		}
	}
	if (input.privacy !== undefined && input.privacy !== null && !isTiktokPrivacy(input.privacy)) {
		return {
			ok: false,
			error: `TikTok privacy must be one of ${TIKTOK_PRIVACY_LEVELS.join(', ')}`
		};
	}
	const choice: TiktokPostChoice = { ...EMPTY_TIKTOK_CHOICE };
	if (isTiktokPrivacy(input.privacy)) choice.privacy = input.privacy;
	for (const key of CHOICE_KEYS) {
		if (key === 'privacy' || input[key] === undefined) continue;
		if (typeof input[key] !== 'boolean') {
			return { ok: false, error: `TikTok option "${key}" must be true or false` };
		}
		choice[key] = input[key];
	}
	// Brand choices mean nothing with disclosure off, and keeping them would
	// label a post the creator said promotes nothing.
	if (!choice.disclose) {
		choice.yourBrand = false;
		choice.brandedContent = false;
	}
	return { ok: true, choice };
}

/** A stored choice, or null when there is none worth reading. */
export function readTiktokChoice(raw: unknown): TiktokPostChoice | null {
	const parsed = parseTiktokChoice(raw);
	return parsed.ok ? parsed.choice : null;
}

/**
 * The per-account choices a draft keeps in its TikTok variant's options, keyed
 * by connection id. Anything unreadable is dropped.
 */
export function readTiktokChoices(raw: unknown): Record<string, TiktokPostChoice> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, TiktokPostChoice> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		const choice = readTiktokChoice(value);
		if (choice) out[id] = choice;
	}
	return out;
}

/**
 * The levels the dropdown may offer: exactly creator_info's
 * `privacy_level_options`, in TikTok's order. Empty until creator_info has
 * been read, and then the composer offers nothing to pick.
 */
export function tiktokPrivacyOptions(
	rules: TiktokCreatorRules | null | undefined
): TiktokPrivacy[] {
	const reported = new Set((rules?.privacyOptions ?? []).filter(isTiktokPrivacy));
	return TIKTOK_PRIVACY_LEVELS.filter((level) => reported.has(level));
}

export const TIKTOK_BRANDED_PRIVATE_MESSAGE =
	'Branded content visibility cannot be set to private.';
export const TIKTOK_DISCLOSURE_MISSING_MESSAGE =
	'You need to indicate if your content promotes yourself, a third party, or both.';
export const TIKTOK_PRIVACY_MISSING_MESSAGE = 'Choose who can see this TikTok post';

/** Whether a privacy level may be picked with the disclosure as it stands. */
export function tiktokPrivacyAllowed(level: string, choice: TiktokPostChoice): boolean {
	return !(level === 'SELF_ONLY' && choice.disclose && choice.brandedContent);
}

/** The label TikTok puts on a disclosed post, as the guidelines word the notice. */
export function tiktokDisclosureNotice(choice: TiktokPostChoice): string | null {
	if (!choice.disclose) return null;
	if (choice.brandedContent) return "Your video will be labeled as 'Paid partnership'";
	if (choice.yourBrand) return "Your video will be labeled as 'Promotional content'";
	return null;
}

/** Whether posting also means agreeing to TikTok's Branded Content Policy. */
export function tiktokNeedsBrandedConsent(choice: TiktokPostChoice): boolean {
	return choice.disclose && choice.brandedContent;
}

export function formatSeconds(totalSec: number): string {
	const whole = Math.max(0, Math.round(totalSec));
	const m = Math.floor(whole / 60);
	const s = whole % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** A video longer than creator_info's `max_video_post_duration_sec`, said plainly. */
export function tiktokDurationProblem(
	maxVideoSec: number | undefined,
	durationMs: number | null | undefined
): string | null {
	if (!maxVideoSec || !durationMs) return null;
	// Half a second of slack: a container's duration rounds differently from
	// TikTok's own reading of it.
	if (durationMs <= maxVideoSec * 1000 + 500) return null;
	return `TikTok lets this account post videos up to ${formatSeconds(maxVideoSec)}, and this one is ${formatSeconds(durationMs / 1000)}`;
}

/**
 * The first thing that stops this choice from being posted, or null. With
 * `rules` (creator_info), the privacy must be one TikTok offers the account;
 * without them only the guideline rules apply, and publish checks the rest
 * against a fresh creator_info.
 */
export function tiktokChoiceProblem(
	choice: TiktokPostChoice | null | undefined,
	rules?: TiktokCreatorRules | null,
	durationMs?: number | null
): string | null {
	if (!choice?.privacy) return TIKTOK_PRIVACY_MISSING_MESSAGE;
	if (choice.disclose && !choice.yourBrand && !choice.brandedContent) {
		return TIKTOK_DISCLOSURE_MISSING_MESSAGE;
	}
	if (!tiktokPrivacyAllowed(choice.privacy, choice)) return TIKTOK_BRANDED_PRIVATE_MESSAGE;
	if (rules?.privacyOptions?.length && !rules.privacyOptions.includes(choice.privacy)) {
		return `TikTok does not offer “${tiktokPrivacyLabel(choice.privacy)}” for this account now — choose another`;
	}
	return tiktokDurationProblem(rules?.maxVideoSec, durationMs);
}

/**
 * `post_info` for Direct Post. An interaction the creator turned off in the
 * TikTok app stays off whatever was ticked here.
 */
export function tiktokPostInfo(
	choice: TiktokPostChoice & { privacy: TiktokPrivacy },
	rules: TiktokCreatorRules | null | undefined,
	title: string
): Record<string, unknown> {
	return {
		privacy_level: choice.privacy,
		disable_comment: !choice.allowComment || rules?.commentDisabled === true,
		disable_duet: !choice.allowDuet || rules?.duetDisabled === true,
		disable_stitch: !choice.allowStitch || rules?.stitchDisabled === true,
		brand_content_toggle: choice.disclose && choice.brandedContent,
		brand_organic_toggle: choice.disclose && choice.yourBrand,
		...(title ? { title } : {})
	};
}

/** creator_info as the composer receives it (GET /api/connections/:id/creator-info). */
export interface TiktokCreatorView extends TiktokCreatorRules {
	nickname: string | null;
	username: string | null;
	avatarUrl: string | null;
	privacyOptions: string[];
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
}

export type TiktokCreatorState =
	| { status: 'loading' }
	| { status: 'ready'; creator: TiktokCreatorView }
	| { status: 'cannot_post'; reason: string }
	| { status: 'error'; message: string };

/**
 * What stops a post to this account from the composer right now, or null.
 * Nothing goes out before creator_info has been read: the choices are only
 * meaningful against what it reported.
 */
export function tiktokAccountProblem(
	state: TiktokCreatorState | undefined,
	choice: TiktokPostChoice | undefined,
	durationMs: number | null | undefined
): string | null {
	if (!state || state.status === 'loading') return 'Reading the TikTok account’s settings…';
	if (state.status === 'cannot_post') return `${state.reason}. Try again later.`;
	if (state.status === 'error') return state.message;
	return tiktokChoiceProblem(choice ?? EMPTY_TIKTOK_CHOICE, state.creator, durationMs);
}
