/**
 * Who may see a TikTok post (`post_info.privacy_level`). TikTok's Content
 * Sharing Guidelines leave the choice to the creator, so CogSend never picks a
 * wider audience on its own: an account nobody has set posts as Only me.
 */
export const TIKTOK_PRIVACY_LEVELS = [
	'SELF_ONLY',
	'MUTUAL_FOLLOW_FRIENDS',
	'FOLLOWER_OF_CREATOR',
	'PUBLIC_TO_EVERYONE'
] as const;

export type TiktokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export const TIKTOK_DEFAULT_PRIVACY: TiktokPrivacy = 'SELF_ONLY';

/** The words TikTok's own app uses for each level. */
const LABELS: Record<TiktokPrivacy, string> = {
	SELF_ONLY: 'Only me',
	MUTUAL_FOLLOW_FRIENDS: 'Friends',
	FOLLOWER_OF_CREATOR: 'Followers',
	PUBLIC_TO_EVERYONE: 'Everyone'
};

export function isTiktokPrivacy(value: unknown): value is TiktokPrivacy {
	return typeof value === 'string' && (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value);
}

export function tiktokPrivacyLabel(level: string): string {
	return isTiktokPrivacy(level) ? LABELS[level] : level;
}

export interface TiktokSettingsMeta {
	tiktokPrivacy?: unknown;
	tiktokPrivacyOptions?: unknown;
}

/** The level a post goes out with. */
export function tiktokPrivacyOf(meta: TiktokSettingsMeta | null | undefined): TiktokPrivacy {
	return isTiktokPrivacy(meta?.tiktokPrivacy) ? meta.tiktokPrivacy : TIKTOK_DEFAULT_PRIVACY;
}

/**
 * The levels the account can choose from: what creator_info last reported
 * (a private account has no Everyone, a public one no Followers), or every
 * level when it has not been read yet. Publish checks again either way.
 */
export function tiktokPrivacyChoices(meta: TiktokSettingsMeta | null | undefined): TiktokPrivacy[] {
	const reported = Array.isArray(meta?.tiktokPrivacyOptions)
		? meta.tiktokPrivacyOptions.filter(isTiktokPrivacy)
		: [];
	const known = new Set<TiktokPrivacy>(reported.length ? reported : TIKTOK_PRIVACY_LEVELS);
	return TIKTOK_PRIVACY_LEVELS.filter((level) => known.has(level));
}
