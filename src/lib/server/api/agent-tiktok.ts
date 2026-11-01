import { resolveChannelRef, type BrandRef, type Channel } from '#lib/domain/channel-keys.js';
import {
	parseTiktokChoice,
	readTiktokChoices,
	tiktokChoiceProblem,
	tiktokDisclosureNotice,
	tiktokNeedsBrandedConsent,
	tiktokPrivacyLabel,
	tiktokPrivacyOptions,
	TIKTOK_BRANDED_CONTENT_URL,
	TIKTOK_MUSIC_USAGE_URL,
	TIKTOK_PRIVACY_LEVELS,
	TIKTOK_PRIVACY_MISSING_MESSAGE,
	type TiktokCreatorRules,
	type TiktokPostChoice
} from '#lib/domain/tiktok.js';
import { parseJson } from '#lib/server/db/client.js';

/**
 * TikTok's per-post choices as an agent sends them. TikTok's guidelines allow
 * no default for any of them, so the MCP tools refuse a TikTok delivery until
 * every one was said out loud, either in the call or saved on the draft by
 * save_draft or the composer, and check them with the same rules REST and the
 * composer use.
 */
export interface TiktokOptionInput {
	/** A TikTok channel key of the post, or "tiktok" (the default) for all of them. */
	for?: string;
	privacy?: string | null;
	allowComment?: boolean;
	allowDuet?: boolean;
	allowStitch?: boolean;
	disclose?: boolean;
	yourBrand?: boolean;
	brandedContent?: boolean;
}

export type TiktokOptionsInput = TiktokOptionInput | TiktokOptionInput[];

/** Switches an agent must state itself: a missing one would be CogSend choosing. */
const EXPLICIT = ['allowComment', 'allowDuet', 'allowStitch', 'disclose'] as const;

type Directory = { brands: BrandRef[]; channels: Channel[] };

export interface TiktokPlan {
	/** connection id -> the choice that goes out with it. */
	choices: Record<string, TiktokPostChoice>;
	problems: string[];
	/** TikTok channels with nothing chosen yet, for the agent to ask about. */
	missing: Array<{ channel: string; privacyOptions: string[] }>;
}

export function creatorRulesFromMeta(metaJson: string | null | undefined): TiktokCreatorRules {
	const meta = parseJson<{
		tiktokPrivacyOptions?: string[];
		tiktokMaxVideoSec?: number;
		tiktokCommentDisabled?: boolean;
		tiktokDuetDisabled?: boolean;
		tiktokStitchDisabled?: boolean;
	}>(metaJson, {});
	return {
		privacyOptions: meta.tiktokPrivacyOptions,
		maxVideoSec: meta.tiktokMaxVideoSec,
		commentDisabled: meta.tiktokCommentDisabled,
		duetDisabled: meta.tiktokDuetDisabled,
		stitchDisabled: meta.tiktokStitchDisabled
	};
}

/** The choices a draft already carries, keyed by connection id. */
export function storedTiktokChoices(
	variants: Array<{ platform: string; optionsJson: string | null }>
): Record<string, TiktokPostChoice> {
	const variant = variants.find((v) => v.platform === 'tiktok');
	return readTiktokChoices(parseJson<{ tiktok?: unknown }>(variant?.optionsJson, {}).tiktok);
}

/** The longest video on a draft, as the duration check reads it. */
export function videoDurationMs(
	media: Array<{ mime: string; metaJson: string | null }>
): number | null {
	for (const row of media) {
		if (!row.mime.toLowerCase().startsWith('video/')) continue;
		const ms = parseJson<{ durationMs?: unknown }>(row.metaJson, {}).durationMs;
		if (typeof ms === 'number' && ms > 0) return ms;
	}
	return null;
}

function levelsFor(rules: TiktokCreatorRules): string[] {
	return tiktokPrivacyOptions(rules);
}

function exampleFor(levels: string[]): string {
	const privacy = levels.length ? levels.join(' | ') : TIKTOK_PRIVACY_LEVELS.join(' | ');
	return `{"privacy": "${privacy}", "allowComment": true|false, "allowDuet": true|false, "allowStitch": true|false, "disclose": false}`;
}

/**
 * The choice each TikTok channel of a post goes out with, or every reason it
 * cannot. `stored` are the choices already on the draft; a call's own choices
 * replace them. With `requireAll` false (saving a draft), a channel with no
 * choice is listed in `missing` rather than refused.
 */
export function planTiktokChoices(opts: {
	field: string;
	input: TiktokOptionsInput | undefined;
	channels: Channel[];
	dir: Directory;
	stored: Record<string, TiktokPostChoice>;
	rulesOf: (connectionId: string) => TiktokCreatorRules;
	durationMs?: number | null;
	requireAll?: boolean;
}): TiktokPlan {
	const { field, channels, dir, stored, rulesOf, durationMs } = opts;
	const requireAll = opts.requireAll ?? true;
	const out: TiktokPlan = { choices: {}, problems: [], missing: [] };
	const tiktoks = channels.filter((c) => c.platform === 'tiktok');
	const entries =
		opts.input === undefined ? [] : Array.isArray(opts.input) ? opts.input : [opts.input];
	if (entries.length && !tiktoks.length) {
		out.problems.push(
			`${field}: TikTok options were sent, but none of this post's channels is on TikTok. Remove ${field}.`
		);
		return out;
	}
	const general = new Map<string, TiktokPostChoice>();
	const specific = new Map<string, TiktokPostChoice>();
	for (const [i, entry] of entries.entries()) {
		const where = Array.isArray(opts.input) ? `${field}[${i}]` : field;
		const { for: target, ...raw } = entry;
		let targets = tiktoks;
		let bucket = general;
		if (target !== undefined && target.trim().toLowerCase() !== 'tiktok') {
			const match = resolveChannelRef(target, dir.channels, dir.brands, { requireActive: false });
			const hit = match.ok
				? tiktoks.find((c) => c.connectionId === match.channel.connectionId)
				: undefined;
			if (!hit) {
				out.problems.push(
					`${where}.for: "${target}" is not one of this post's TikTok channels (${tiktoks.map((c) => c.key).join(', ')}).`
				);
				continue;
			}
			targets = [hit];
			bucket = specific;
		}
		const unsaid = EXPLICIT.filter((key) => typeof raw[key] !== 'boolean');
		if (unsaid.length) {
			out.problems.push(
				`${where}: say ${unsaid.map((k) => `"${k}"`).join(', ')} explicitly as true or false; TikTok allows no default. Ask the operator, then send ${exampleFor(levelsFor(rulesOf(targets[0].connectionId)))}.`
			);
			continue;
		}
		const parsed = parseTiktokChoice(raw);
		if (!parsed.ok) {
			out.problems.push(`${where}: ${parsed.error}.`);
			continue;
		}
		for (const channel of targets) {
			if (bucket.has(channel.connectionId)) {
				out.problems.push(
					`${where}: ${channel.key} already has TikTok options in ${field}; give each channel one set.`
				);
				continue;
			}
			bucket.set(channel.connectionId, parsed.choice);
		}
	}
	for (const channel of tiktoks) {
		const rules = rulesOf(channel.connectionId);
		const levels = levelsFor(rules);
		const choice =
			specific.get(channel.connectionId) ??
			general.get(channel.connectionId) ??
			stored[channel.connectionId];
		if (!choice?.privacy) {
			out.missing.push({ channel: channel.key, privacyOptions: levels });
			if (!requireAll) continue;
			out.problems.push(
				`${field} for ${channel.key}: ${TIKTOK_PRIVACY_MISSING_MESSAGE}; TikTok allows no default. Send privacy (${levels.length ? `this account offers ${levels.join(', ')}` : 'get_platform_requirements with this channel lists what the account offers'}) and whether comments, Duet and Stitch are allowed and whether the post promotes a brand. Ask the operator, then send ${field}: ${exampleFor(levels)}.`
			);
			continue;
		}
		const problem = tiktokChoiceProblem(choice, rules, durationMs);
		if (problem) {
			out.problems.push(
				`${field} for ${channel.key}: ${problem}${levels.length && rules.privacyOptions?.length && !rules.privacyOptions.includes(choice.privacy) ? ` (this account offers ${levels.join(', ')})` : ''}.`
			);
			continue;
		}
		out.choices[channel.connectionId] = choice;
	}
	return out;
}

/** One line per choice for a preview, in the words TikTok's own app uses. */
export function describeTiktokChoice(choice: TiktokPostChoice): string {
	const on = (v: boolean) => (v ? 'on' : 'off');
	const parts = [
		`who can see it: ${choice.privacy ? tiktokPrivacyLabel(choice.privacy) : 'not chosen'}`,
		`comments ${on(choice.allowComment)}, Duet ${on(choice.allowDuet)}, Stitch ${on(choice.allowStitch)}`,
		tiktokDisclosureNotice(choice) ?? 'not promotional'
	];
	return parts.join('; ');
}

/** What the operator agrees to by posting, which the guidelines want shown before it. */
export function tiktokConsentLine(choices: TiktokPostChoice[]): string | null {
	if (!choices.length) return null;
	const branded = choices.some(tiktokNeedsBrandedConsent);
	return branded
		? `By posting to TikTok, the operator agrees to TikTok's Branded Content Policy (${TIKTOK_BRANDED_CONTENT_URL}) and Music Usage Confirmation (${TIKTOK_MUSIC_USAGE_URL}).`
		: `By posting to TikTok, the operator agrees to TikTok's Music Usage Confirmation (${TIKTOK_MUSIC_USAGE_URL}).`;
}
