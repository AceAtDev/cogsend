import { describe, expect, it } from 'vitest';
import {
	briefFromStored,
	briefMarkdown,
	briefSummary,
	isBriefEmpty,
	MAX_BRIEF_SECTION,
	parseBrief
} from '#lib/domain/brand-brief.js';

describe('parseBrief', () => {
	it('trims, normalises line endings and drops empty sections and notes', () => {
		const parsed = parseBrief({
			sections: { voice: '  Warm,\r\nplain.  ', audience: '   ', ctas: null },
			platformNotes: { linkedin: 'No emoji.', x: '' }
		});
		expect(parsed).toEqual({
			ok: true,
			brief: { sections: { voice: 'Warm,\nplain.' }, platformNotes: { linkedin: 'No emoji.' } }
		});
	});

	it.each([
		[{ sections: { tone: 'x' } }, /not a section/],
		[{ platformNotes: { facebook: 'x' } }, /not a platform/],
		[{ sections: { voice: 5 } }, /must be text/],
		[{ sections: { voice: 'x'.repeat(MAX_BRIEF_SECTION + 1) } }, /characters or fewer/],
		[{ voice: 'x' }, /Unknown field/],
		['brief', /Send an object/]
	])('refuses %j', (input, message) => {
		const parsed = parseBrief(input);
		expect(parsed.ok).toBe(false);
		expect(!parsed.ok && parsed.error).toMatch(message);
	});

	it('reads a damaged stored row as an empty brief', () => {
		expect(isBriefEmpty(briefFromStored('{oops', '[]'))).toBe(true);
	});
});

describe('briefMarkdown and briefSummary', () => {
	const brief = {
		sections: {
			voice: 'Friendly and direct.',
			dont: 'No salary promises.',
			links: 'https://jobjob.example'
		},
		platformNotes: { tiktok: 'Hook in the first second.', linkedin: 'Three hashtags at most.' }
	};

	it('renders sections in their fixed order and platform notes in platform order', () => {
		expect(briefMarkdown('JobJob', brief)).toBe(
			[
				'# JobJob brief',
				'',
				'## Voice and tone',
				'',
				'Friendly and direct.',
				'',
				"## Don't",
				'',
				'No salary promises.',
				'',
				'## Links',
				'',
				'https://jobjob.example',
				'',
				'## Platform notes',
				'',
				'### TikTok',
				'',
				'Hook in the first second.',
				'',
				'### LinkedIn',
				'',
				'Three hashtags at most.'
			].join('\n')
		);
		expect(briefMarkdown('Empty', { sections: {}, platformNotes: {} })).toContain(
			'(No brief written yet.)'
		);
	});

	it('summarises which parts exist with the start of the voice', () => {
		expect(briefSummary(brief)).toEqual({
			hasBrief: true,
			sections: ['voice', 'dont', 'links'],
			platformNotes: ['tiktok', 'linkedin'],
			excerpt: 'Friendly and direct.'
		});
		const long = briefSummary({ sections: { audience: 'a '.repeat(200) }, platformNotes: {} });
		expect(long.excerpt.length).toBe(160);
		expect(long.excerpt.endsWith('…')).toBe(true);
	});
});
