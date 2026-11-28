import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { clickUntilVisible, d1 } from './e2e-env';

const platforms = ['tiktok', 'instagram', 'x', 'threads', 'linkedin', 'mastodon', 'bluesky'];
const prefix = 'viewer-fixture-';
const ids = new Map<string, { draft: string; target: string; connection: string }>();

test.beforeEach(async ({ page }) => {
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const now = Date.now();
	const sql: string[] = [];
	for (const platform of platforms) {
		const draft = randomUUID(),
			target = randomUUID(),
			connection = randomUUID();
		ids.set(platform, { draft, target, connection });
		sql.push(
			`INSERT INTO connections (id,user_id,platform,handle,display_name,credentials_encrypted,meta_json,status,created_at,updated_at) VALUES ('${connection}','${me.user.id}','${platform}','${prefix}${platform}','Viewer ${platform}','enc','{}','active',${now},${now})`
		);
		sql.push(
			`INSERT INTO drafts (id,user_id,title,base_body,status,created_at,updated_at) VALUES ('${draft}','${me.user.id}','Internal label never public','${prefix}${platform} caption ${'long caption '.repeat(45)}','scheduled',${now},${now})`
		);
		sql.push(
			`INSERT INTO publish_targets (id,draft_id,connection_id,status,scheduled_for,created_at,updated_at) VALUES ('${target}','${draft}','${connection}','awaiting_review',${now + 3600000},${now},${now})`
		);
		if (platform === 'tiktok') {
			const options = JSON.stringify({
				tiktok: { [connection]: { draft: true, title: 'Actual photo title' } }
			}).replace(/"/g, '\\"');
			sql.push(
				`INSERT INTO draft_variants (id,draft_id,platform,body,options_json,created_at,updated_at) VALUES ('${randomUUID()}','${draft}','tiktok',NULL,'${options}',${now},${now})`
			);
		}
		for (let i = 0; i < 6; i++)
			sql.push(
				`INSERT INTO draft_media (id,draft_id,storage_key,mime,size,width,height,alt_text,sort_order,segment_index,created_at) VALUES ('${randomUUID()}','${draft}','${prefix}${platform}-${i}.png','image/png',123,1080,1350,'${platform} slide ${i + 1}',${i},0,${now})`
			);
	}
	d1(sql.join('; '));
	await page.route(`**/api/media/${prefix}*`, (route) =>
		route.fulfill({
			contentType: 'image/svg+xml',
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#f5f1e8"/><g font-family="Georgia,serif" text-anchor="middle" fill="#1c1917"><text x="540" y="130" font-size="64" font-weight="bold">30g Protein</text><text x="270" y="260" font-size="52">Cod</text><text x="810" y="260" font-size="52">Tofu</text><text x="270" y="305" font-size="28" fill="#57534e">baked</text><text x="810" y="305" font-size="28" fill="#57534e">firm, calcium-set</text><path d="M540 220v960" stroke="#78716c"/><ellipse cx="270" cy="640" rx="180" ry="130" fill="#e2b76c"/><path d="M660 530h300v240H660z" fill="#e9dcb7"/><text x="270" y="1000" font-size="30">cut</text><text x="810" y="1000" font-size="30">bulk</text><text x="270" y="1120" font-size="62" font-weight="bold">132g</text><text x="810" y="1120" font-size="62" font-weight="bold">173g</text><text x="270" y="1170" font-size="30">138 kcal</text><text x="810" y="1170" font-size="30">250 kcal</text><text x="540" y="1280" font-size="26" fill="#57534e">Readable nutrition artwork · layout test fixture</text></g></svg>'
		})
	);
});

test.afterEach(() => {
	const drafts = [...ids.values()].map((v) => `'${v.draft}'`).join(',');
	const connections = [...ids.values()].map((v) => `'${v.connection}'`).join(',');
	if (drafts)
		d1(
			`DELETE FROM publish_targets WHERE draft_id IN (${drafts}); DELETE FROM draft_media WHERE draft_id IN (${drafts}); DELETE FROM draft_variants WHERE draft_id IN (${drafts}); DELETE FROM drafts WHERE id IN (${drafts}); DELETE FROM connections WHERE id IN (${connections})`
		);
	ids.clear();
});

const SCALE_KEY = 'cogsend.preview.pxPerCm';

test('all seven providers open from Review in phone, desktop and file views', async ({ page }) => {
	test.setTimeout(120000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto('/review');
	for (const platform of platforms) {
		await page.getByRole('button', { name: new RegExp(`Preview .*${prefix}${platform}`) }).click();
		const viewer = page.locator('dialog[open]');
		await expect(viewer).toBeVisible();
		await expect(viewer).toContainText(`${prefix}${platform}`);
		await expect(viewer).not.toContainText('Internal label never public');
		await expect(viewer.getByRole('button', { name: 'Phone', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(viewer.locator('.device .screen')).toBeVisible();
		if (platform === 'tiktok')
			await expect(viewer.getByText('Actual photo title', { exact: true }).first()).toBeVisible();
		await viewer.screenshot({ path: `../deliverables/post-viewer/${platform}-phone.png` });
		await viewer.getByRole('button', { name: 'Desktop', exact: true }).click();
		await expect(viewer.locator('.desktop')).toBeVisible();
		await viewer.screenshot({ path: `../deliverables/post-viewer/${platform}-desktop.png` });
		await viewer.getByRole('button', { name: 'File', exact: true }).click();
		await expect(viewer.getByRole('region', { name: 'Original file' })).toBeVisible();
		await expect(viewer).toContainText('1080 × 1350 px');
		await page.keyboard.press('Escape');
		await expect(viewer).not.toBeVisible();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	for (const platform of platforms) {
		await page.getByRole('button', { name: new RegExp(`Preview .*${prefix}${platform}`) }).click();
		const viewer = page.locator('dialog[open]');
		await expect(viewer).toBeVisible();
		if (platform === 'tiktok')
			await viewer.screenshot({ path: '../deliverables/post-viewer/tiktok-phone-mobile.png' });
		for (const view of ['Phone', 'Desktop', 'File']) {
			await viewer.getByRole('button', { name: view, exact: true }).click();
			await expect
				.poll(async () => (await viewer.boundingBox())?.width ?? 9999)
				.toBeLessThanOrEqual(390);
		}
		await page.keyboard.press('Escape');
	}
});

test('a calibrated phone renders at physical size and reports the media in cm', async ({
	page
}) => {
	await page.setViewportSize({ width: 1600, height: 1100 });
	await page.addInitScript((key) => localStorage.setItem(key, '50'), SCALE_KEY);
	await page.goto('/review');
	const viewer = page.locator('dialog[open]');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: new RegExp(`Preview .*${prefix}tiktok`) }),
		viewer
	);
	// iPhone 15: 1179 px at 460 ppi is 6.51 cm wide, so 325.5 px at 50 px per cm.
	await expect
		.poll(async () => (await viewer.locator('.device .screen').boundingBox())?.width ?? 0)
		.toBeCloseTo(325.5, 0);
	// A 4:5 photo letterboxed across a 6.51 cm screen is 6.5 × 8.1 cm.
	await expect(viewer.getByRole('region', { name: 'Size on screen' })).toContainText(
		'6.5 × 8.1 cm'
	);
	await expect(viewer).toContainText('True size on this screen');
	await viewer.screenshot({ path: '../deliverables/post-viewer/tiktok-true-size.png' });
	const overlays = viewer.getByRole('switch', { name: /App buttons and caption/ });
	await expect(overlays).toBeChecked();
	await expect(viewer.locator('.sim-rail')).toBeVisible();
	await overlays.uncheck();
	await expect(viewer.locator('.sim-rail')).toHaveCount(0);
	await overlays.check();
	await viewer.locator('.sim-more').click();
	await expect(viewer.locator('.sim-more')).toHaveText('less');
	await viewer.getByRole('combobox', { name: 'Phone' }).selectOption('iphone-6-9');
	// 1320 px at 460 ppi is 7.29 cm.
	await expect
		.poll(async () => (await viewer.locator('.device .screen').boundingBox())?.width ?? 0)
		.toBeCloseTo(364.5, 0);
});

test('calibrating against a card is saved for this screen', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.addInitScript((key) => localStorage.removeItem(key), SCALE_KEY);
	await page.goto('/review');
	const viewer = page.locator('dialog[open]');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: new RegExp(`Preview .*${prefix}tiktok`) }),
		viewer
	);
	await expect(viewer).toContainText('Approximate until you calibrate');
	await viewer.getByRole('button', { name: 'Calibrate screen' }).click();
	await viewer.getByRole('slider', { name: 'Card outline size' }).fill('44');
	// ID-1 cards are 8.56 cm wide.
	await expect
		.poll(async () => (await viewer.locator('.card-outline').boundingBox())?.width ?? 0)
		.toBeCloseTo(8.56 * 44, 0);
	await viewer.screenshot({ path: '../deliverables/post-viewer/calibrate.png' });
	await page.keyboard.press('Escape');
	await expect(viewer).toBeVisible();
	await viewer.getByRole('button', { name: 'Calibrate screen' }).click();
	await viewer.getByRole('slider', { name: 'Card outline size' }).fill('44');
	await viewer.getByRole('button', { name: 'Save' }).click();
	await expect(viewer).toContainText('True size on this screen');
	expect(await page.evaluate((key) => localStorage.getItem(key), SCALE_KEY)).toBe('44');
});

test('file view shows the original at 100% and can be panned', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/review');
	const viewer = page.locator('dialog[open]');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: new RegExp(`Preview .*${prefix}tiktok`) }),
		viewer
	);
	await viewer.getByRole('button', { name: 'File', exact: true }).click();
	const image = viewer.getByAltText('tiktok slide 1');
	await expect.poll(async () => (await image.boundingBox())?.width ?? 9999).toBeLessThan(1080);
	await viewer.getByRole('button', { name: '100%', exact: true }).click();
	await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBe(1080);
	const region = viewer.getByRole('region', { name: 'Original file' });
	await region.focus();
	await page.keyboard.press('ArrowRight');
	await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
	await expect(image).toBeVisible();
	await viewer.getByRole('button', { name: 'Fit', exact: true }).click();
	await expect.poll(async () => (await image.boundingBox())?.width ?? 9999).toBeLessThan(1080);
	expect(
		await viewer.locator('.copy-text').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
	).toBeGreaterThanOrEqual(16);
});

test('mobile controls remain thumb-sized and the caption is reachable at 320 and 390px', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/review');
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		const viewer = page.locator('dialog[open]');
		await clickUntilVisible(
			page,
			page.getByRole('button', { name: new RegExp(`Preview .*${prefix}tiktok`) }),
			viewer
		);
		const body = viewer.locator('.viewer-body');
		expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		// Buttons inside the simulated phone are drawn at the phone's real size on purpose.
		for (const button of await viewer.locator('button:not(.screen button)').all()) {
			if (!(await button.isVisible())) continue;
			const box = await button.boundingBox();
			expect(box!.width).toBeGreaterThanOrEqual(48);
			expect(box!.height).toBeGreaterThanOrEqual(48);
		}
		await viewer.locator('.copy-title').scrollIntoViewIfNeeded();
		await expect(viewer.locator('.copy-title')).toHaveText('Actual photo title');
		await expect(viewer.locator('.copy-title')).toBeInViewport();
		await page.keyboard.press('Escape');
	}
});

test('thumbnail opens carousel, reaches hidden slides, restores focus on close', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let release!: () => void;
	const ready = new Promise<void>((resolve) => (release = resolve));
	await page.route(/\/_app\/immutable\/.*\.js(?:\?|$)/, async (route) => {
		await ready;
		await route.continue();
	});
	await page.goto('/review', { waitUntil: 'commit' });
	const card = page.locator(`#post-${ids.get('tiktok')!.draft}`);
	const thumb = card.getByRole('button', { name: /Open post preview,/i }).first();
	try {
		await expect(thumb).toBeVisible();
		await expect(thumb).toBeDisabled();
	} finally {
		release();
	}
	await expect(thumb).toBeEnabled();
	await thumb.click();
	const viewer = page.locator('dialog[open]');
	await expect(viewer).toBeVisible();
	await expect(viewer.locator('.device .screen')).toBeVisible();
	for (let i = 0; i < 5; i++) await viewer.getByRole('button', { name: 'Next media' }).click();
	await expect(viewer.getByAltText('tiktok slide 6')).toBeVisible();
	await page.keyboard.press('ArrowLeft');
	await expect(viewer.getByAltText('tiktok slide 5')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(thumb).toBeFocused();
});

test('Calendar uses same viewer and Escape leaves the detail drawer open', async ({ page }) => {
	await page.goto('/calendar');
	const detail = page.getByTestId('calendar-detail');
	// A click on a post opens its preview; Details there opens the drawer.
	await clickUntilVisible(
		page,
		page.locator(`[data-cal-item="${ids.get('tiktok')!.target}"]`).first(),
		page.getByTestId('calendar-preview')
	);
	await page.getByTestId('preview-details').click();
	await expect(detail).toBeVisible();
	await detail
		.getByRole('button', { name: /Open post preview,/i })
		.first()
		.click();
	await expect(page.locator('dialog[open]')).toContainText('Actual photo title');
	await page.keyboard.press('Escape');
	await expect(page.locator('dialog[open]')).toHaveCount(0);
	await expect(detail).toBeVisible();
});

test('video opens with native controls and can actually play', async ({ page }) => {
	for (const platform of ['tiktok', 'instagram']) {
		const draft = ids.get(platform)!.draft;
		d1(
			`DELETE FROM draft_media WHERE draft_id='${draft}'; INSERT INTO draft_media (id,draft_id,storage_key,mime,size,width,height,alt_text,sort_order,segment_index,created_at) VALUES ('${randomUUID()}','${draft}','viewer-test-video.mp4','video/mp4',3000,360,640,'Portrait test video',0,0,${Date.now()})`
		);
	}
	await page.route('**/api/media/viewer-test-video.mp4', (route) =>
		route.fulfill({
			contentType: 'video/mp4',
			body: readFileSync('tests/e2e/fixtures/viewer-video.mp4')
		})
	);
	await page.goto('/review');
	for (const platform of ['tiktok', 'instagram']) {
		await page
			.locator(`#post-${ids.get(platform)!.draft}`)
			.getByRole('button', { name: 'Play Portrait test video' })
			.click();
		const video = page.locator('dialog[open] video');
		await expect(video).toBeVisible();
		if (platform === 'instagram') await expect(page.locator('dialog[open]')).toContainText('Reels');
		await expect(video).toHaveAttribute('controls', '');
		await video.evaluate((el: HTMLVideoElement) => el.play());
		await expect
			.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
			.toBeGreaterThan(0);
		await page.keyboard.press('Escape');
		await expect(page.locator('dialog[open]')).toHaveCount(0);
	}
});

test('thread post switching keeps each segment media separate', async ({ page }) => {
	const draft = ids.get('x')!.draft;
	const opts = JSON.stringify({
		threadSegments: ['First thread post', 'Second thread post']
	}).replace(/"/g, '\\"');
	d1(
		`INSERT INTO draft_variants (id,draft_id,platform,body,options_json,created_at,updated_at) VALUES ('${randomUUID()}','${draft}','x',NULL,'${opts}',${Date.now()},${Date.now()}); UPDATE draft_media SET segment_index=1 WHERE draft_id='${draft}' AND sort_order=5`
	);
	await page.goto('/review');
	const viewer = page.locator('dialog[open]');
	await clickUntilVisible(
		page,
		page.getByRole('button', { name: new RegExp(`Preview X.*${prefix}x`) }),
		viewer
	);
	await expect(viewer).toContainText('First thread post');
	await expect(viewer.getByAltText('x slide 6')).toHaveCount(0);
	await viewer.getByRole('combobox', { name: 'Thread post', exact: true }).selectOption('1');
	await expect(viewer).toContainText('Second thread post');
	await expect(viewer.getByAltText('x slide 6')).toBeVisible();
});
