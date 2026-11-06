// Local visual QA only. First materialize fixtures with:
// COGSEND_WRITE_EMAIL_PREVIEW=1 npm test -- tests/daily-digest-render.test.ts
// Then run from this checkout: node scripts/preview-digest.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
	mkdirSync('../deliverables/daily-digest', { recursive: true });
	for (const [kind, device, width] of [
		['quiet', 'mobile', 390],
		['quiet', 'desktop', 800],
		['busy', 'mobile', 390]
	]) {
		const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
		await page.route('https://cogsend.example/email-fixture-*.png', async (route) => {
			const cheese = route.request().url().includes('-1.');
			await route.fulfill({
				contentType: 'image/svg+xml',
				body: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="12" fill="#f5f0e7"/>${cheese ? '<path d="M20 78L90 42v50H20z" fill="#f0bd42"/><circle cx="68" cy="72" r="7" fill="#dba928"/>' : '<ellipse cx="60" cy="65" rx="42" ry="30" fill="white"/><circle cx="60" cy="65" r="18" fill="#efb32e"/>'}</svg>`
			});
		});
		await page.setContent(readFileSync(`.wrangler/digest-preview/${kind}.html`, 'utf8'), {
			waitUntil: 'networkidle'
		});
		if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
			throw new Error(`${kind} ${device}: horizontal overflow`);
		await page.screenshot({
			path: `../deliverables/daily-digest/${kind}-${device}.png`,
			fullPage: true
		});
		console.log(`${kind}-${device}: ${width}px, no horizontal overflow`);
		await page.setViewportSize({ width: 320, height: 844 });
		await page.setContent(
			readFileSync(`.wrangler/digest-preview/${kind}.html`, 'utf8').replaceAll(
				'@465cal',
				`@${'longhandle'.repeat(20)}`
			),
			{ waitUntil: 'networkidle' }
		);
		if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
			throw new Error(`${kind}: long handle overflows at 320px`);
		console.log(`${kind}: 320px long-handle stress check passed`);
		await page.close();
	}
} finally {
	await browser.close();
}
