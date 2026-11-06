import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import TiktokPostPanel from '#lib/components/TiktokPostPanel.svelte';
import { EMPTY_TIKTOK_CHOICE } from '#lib/domain/tiktok.js';

const props = {
	accounts: [{ id: 'account', handle: '@creator', displayName: 'Creator' }],
	choices: { account: { ...EMPTY_TIKTOK_CHOICE, draft: true, title: 'Protein snacks' } },
	creators: {},
	caption: 'Caption is separate',
	onChange: () => {},
	onRetry: () => {}
};

describe('TikTok photo title form', () => {
	it('shows the stored title for photos while creator settings are loading', () => {
		const body = render(TiktokPostPanel, { props: { ...props, photoPost: true } }).body;
		expect(body).toContain('TikTok photo title for Creator');
		expect(body).toContain('value="Protein snacks"');
		expect(body).toContain('maxlength="90"');
		expect(body.replace(/\s+/g, ' ')).toContain('internal post title is not sent to TikTok');
	});

	it('does not offer a photo title for videos', () => {
		const body = render(TiktokPostPanel, { props }).body;
		expect(body).not.toContain('data-testid="tiktok-title-account"');
	});
});
