import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderBlocks } from '../src/lib/server/notify/render';
import { dailyDigestFixture } from './fixtures/daily-digest';

const base = {
	intro: 'Friday 6 November (America/Toronto)',
	footer: 'Sent by CogSend.',
	appUrl: 'https://cogsend.example',
	compact: true
};

describe('compact daily digest', () => {
	it('uses thumbnail cards and short actions rather than caption bullet lists', () => {
		const mail = renderBlocks({ ...base, blocks: dailyDigestFixture() });
		expect(mail.html).toContain('width="48" height="48"');
		expect(mail.html).toContain('Open draft');
		expect(mail.html).not.toContain('<ul');
		expect(mail.html).not.toContain('Needs attention');
		expect(mail.text).toContain('2 TikTok drafts · 0 failed');
		expect(mail.text).not.toContain('0 likes');
		expect(mail.html).toContain('Open calendar');
		expect(mail.text.length).toBeLessThan(1100);
	});

	it('bounds rows across brands and abbreviates captions without relying on CSS clipping', () => {
		const rows = Array.from({ length: 10 }, (_, i) => ({
			title: `Account ${i}`,
			text: 'Long caption '.repeat(100)
		}));
		const mail = renderBlocks({
			...base,
			blocks: [
				{
					id: 'planned',
					heading: 'Today',
					summary: '10 scheduled',
					groups: [
						{ label: 'A', lines: rows.slice(0, 2) },
						{ label: 'B', lines: rows.slice(2) }
					],
					href: 'https://cogsend.example/calendar',
					action: 'View all 10'
				}
			]
		});
		expect(mail.html.match(/role="presentation"/g)).toHaveLength(3);
		expect(mail.html).not.toContain('Account 3');
		expect(mail.text).not.toContain('Long caption '.repeat(7));
		expect(mail.html).toContain('View all 10');
	});

	it('escapes content and rejects unsafe links and thumbnail URLs', () => {
		const mail = renderBlocks({
			...base,
			blocks: [
				{
					id: 'x',
					heading: '<script>',
					href: 'javascript:alert(1)',
					groups: [
						{
							lines: [
								{
									title: '<b>Account</b>',
									text: '<img onerror=alert(1)>',
									image: 'javascript:alert(1)',
									href: 'data:text/html,bad'
								}
							]
						}
					]
				}
			]
		});
		expect(mail.html).toContain('&lt;script&gt;');
		expect(mail.html).not.toContain('javascript:');
		expect(mail.html).not.toContain('data:text');
		expect(mail.html).not.toContain('<img onerror');
	});

	it('does not change on-post alerts', () => {
		const mail = renderBlocks({ ...base, compact: false, blocks: [dailyDigestFixture()[1]] });
		expect(mail.html).toContain('width="64" height="64"');
		expect(mail.html).not.toContain('Daily brief');
	});

	it('can materialize quiet and busy HTML for local visual QA, never sends mail', () => {
		for (const busy of [false, true]) {
			const mail = renderBlocks({ ...base, blocks: dailyDigestFixture(busy) });
			expect(mail.html).toContain('Daily brief');
			if (process.env.COGSEND_WRITE_EMAIL_PREVIEW === '1') {
				mkdirSync('.wrangler/digest-preview', { recursive: true });
				writeFileSync(
					`.wrangler/digest-preview/${busy ? 'busy' : 'quiet'}.html`,
					`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Daily brief layout fixture</title></head><body style="margin:0;background:#fff">${mail.html}</body></html>`
				);
			}
		}
	});
});
