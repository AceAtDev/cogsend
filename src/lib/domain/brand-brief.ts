import { isPlatformId, PLATFORM_ORDER, platformName, type PlatformId } from './platforms';

/**
 * A brand's brief: the rules every post for it follows, written by the
 * operator as markdown sections, plus notes for single platforms. Agents read
 * it before drafting (MCP `get_brand_brief`), so every call starts from the
 * same voice, audience and links instead of whatever the last prompt said.
 */

export const BRIEF_SECTIONS = [
	{
		key: 'voice',
		label: 'Voice and tone',
		hint: 'How the brand sounds: formal or casual, words it uses and avoids.'
	},
	{ key: 'audience', label: 'Audience', hint: 'Who the posts are for and what they care about.' },
	{ key: 'do', label: 'Do', hint: 'Things every post should do.' },
	{ key: 'dont', label: "Don't", hint: 'Things no post may do: topics, claims, words.' },
	{ key: 'links', label: 'Links', hint: 'URLs to use, with what each is for.' },
	{ key: 'hashtags', label: 'Hashtags', hint: 'Hashtags to use, and how many.' },
	{ key: 'ctas', label: 'Calls to action', hint: 'What a post should ask the reader to do.' }
] as const;

export type BriefSectionKey = (typeof BRIEF_SECTIONS)[number]['key'];
export const BRIEF_SECTION_KEYS = BRIEF_SECTIONS.map((s) => s.key) as BriefSectionKey[];

export const MAX_BRIEF_SECTION = 4000;
export const MAX_PLATFORM_NOTE = 2000;

export interface BrandBrief {
	sections: Partial<Record<BriefSectionKey, string>>;
	platformNotes: Partial<Record<PlatformId, string>>;
}

export const EMPTY_BRIEF: BrandBrief = { sections: {}, platformNotes: {} };

export type BriefResult = { ok: true; brief: BrandBrief } | { ok: false; error: string };

function cleanText(raw: unknown, field: string, max: number): { value?: string; error?: string } {
	if (raw === null || raw === undefined) return {};
	if (typeof raw !== 'string') return { error: `${field} must be text` };
	// Normalised line endings keep the stored text what the textarea showed.
	const value = raw.replace(/\r\n?/g, '\n').trim();
	if (value.length > max) return { error: `${field} must be ${max} characters or fewer` };
	return value ? { value } : {};
}

/** `{ sections: { voice, … }, platformNotes: { linkedin, … } }`; the whole brief is replaced. */
export function parseBrief(raw: unknown): BriefResult {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return { ok: false, error: 'Send an object with sections and platformNotes' };
	const body = raw as Record<string, unknown>;
	for (const key of Object.keys(body))
		if (key !== 'sections' && key !== 'platformNotes')
			return { ok: false, error: `Unknown field "${key}"` };
	const brief: BrandBrief = { sections: {}, platformNotes: {} };
	const sections = body.sections ?? {};
	if (!sections || typeof sections !== 'object' || Array.isArray(sections))
		return { ok: false, error: 'sections must be an object' };
	for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
		if (!(BRIEF_SECTION_KEYS as string[]).includes(key))
			return {
				ok: false,
				error: `"${key}" is not a section; use ${BRIEF_SECTION_KEYS.join(', ')}`
			};
		const cleaned = cleanText(value, `sections.${key}`, MAX_BRIEF_SECTION);
		if (cleaned.error) return { ok: false, error: cleaned.error };
		if (cleaned.value) brief.sections[key as BriefSectionKey] = cleaned.value;
	}
	const notes = body.platformNotes ?? {};
	if (!notes || typeof notes !== 'object' || Array.isArray(notes))
		return { ok: false, error: 'platformNotes must be an object keyed by platform' };
	for (const [key, value] of Object.entries(notes as Record<string, unknown>)) {
		if (!isPlatformId(key))
			return { ok: false, error: `"${key}" is not a platform; use ${PLATFORM_ORDER.join(', ')}` };
		const cleaned = cleanText(value, `platformNotes.${key}`, MAX_PLATFORM_NOTE);
		if (cleaned.error) return { ok: false, error: cleaned.error };
		if (cleaned.value) brief.platformNotes[key] = cleaned.value;
	}
	return { ok: true, brief };
}

export function briefFromStored(sectionsJson: string, notesJson: string): BrandBrief {
	const read = (raw: string) => {
		try {
			return JSON.parse(raw || '{}');
		} catch {
			return {};
		}
	};
	const parsed = parseBrief({ sections: read(sectionsJson), platformNotes: read(notesJson) });
	return parsed.ok ? parsed.brief : EMPTY_BRIEF;
}

export function isBriefEmpty(brief: BrandBrief): boolean {
	return !Object.keys(brief.sections).length && !Object.keys(brief.platformNotes).length;
}

/** The brief as one markdown document, sections in their fixed order. */
export function briefMarkdown(brandName: string, brief: BrandBrief, only?: PlatformId[]): string {
	const lines = [`# ${brandName} brief`];
	for (const { key, label } of BRIEF_SECTIONS) {
		const text = brief.sections[key];
		if (text) lines.push('', `## ${label}`, '', text);
	}
	const platforms = PLATFORM_ORDER.filter(
		(p) => brief.platformNotes[p] && (!only || only.includes(p))
	);
	if (platforms.length) {
		lines.push('', '## Platform notes');
		for (const p of platforms)
			lines.push('', `### ${platformName(p)}`, '', brief.platformNotes[p]!);
	}
	if (lines.length === 1) lines.push('', '(No brief written yet.)');
	return lines.join('\n');
}

/** A line or two for list views: which sections exist, and the start of the voice. */
export function briefSummary(brief: BrandBrief) {
	const sections = BRIEF_SECTION_KEYS.filter((k) => brief.sections[k]);
	const platforms = PLATFORM_ORDER.filter((p) => brief.platformNotes[p]);
	const lead = brief.sections.voice ?? (sections.length ? brief.sections[sections[0]]! : '');
	const flat = lead.replace(/\s+/g, ' ').trim();
	return {
		hasBrief: sections.length > 0 || platforms.length > 0,
		sections,
		platformNotes: platforms,
		excerpt: flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
	};
}
