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
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#ccfaf1"/><circle cx="540" cy="550" r="300" fill="#059669"/><text x="540" y="1050" text-anchor="middle" font-size="75">4:5 original image</text></svg>'
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

test('all seven providers open from Review in mobile and desktop modes', async ({ page }) => {
	test.setTimeout(120000);
	await page.goto('/review');
	for (const platform of platforms) {
		await page.getByRole('button', { name: new RegExp(`Preview .*${prefix}${platform}`) }).click();
		const viewer = page.locator('dialog[open]');
		await expect(viewer).toBeVisible();
		await expect(viewer).toContainText(`${prefix}${platform}`);
		await expect(viewer).not.toContainText('Internal label never public');
		if (platform === 'tiktok') {
			await expect(viewer).toContainText('Actual photo title');
			await expect(viewer.getByRole('button', { name: 'Next media' })).toBeInViewport();
			await expect(viewer.getByText('Actual photo title', { exact: true })).toBeInViewport();
		}
		await viewer.screenshot({ path: `../deliverables/post-viewer/${platform}-mobile.png` });
		await viewer.getByRole('button', { name: 'Desktop', exact: true }).click();
		await expect(viewer).toBeVisible();
		if (platform === 'tiktok') {
			await expect
				.poll(async () => (await viewer.getByAltText('tiktok slide 1').boundingBox())?.width ?? 0)
				.toBeGreaterThan(100);
		}
		await viewer.screenshot({ path: `../deliverables/post-viewer/${platform}-desktop.png` });
		await viewer.getByRole('button', { name: 'Mobile', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect(viewer).not.toBeVisible();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	for (const platform of platforms) {
		await page.getByRole('button', { name: new RegExp(`Preview .*${prefix}${platform}`) }).click();
		const viewer = page.locator('dialog[open]');
		await expect(viewer).toBeVisible();
		await expect
			.poll(async () => (await viewer.boundingBox())?.width ?? 9999)
			.toBeLessThanOrEqual(390);
		await viewer.getByRole('button', { name: 'Desktop', exact: true }).click();
		await expect
			.poll(async () => (await viewer.boundingBox())?.width ?? 9999)
			.toBeLessThanOrEqual(390);
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
	await viewer.getByRole('button', { name: 'Show more', exact: true }).click();
	await expect(viewer.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
	for (let i = 0; i < 5; i++) await viewer.getByRole('button', { name: /next/i }).click();
	await expect(viewer.getByAltText('tiktok slide 6')).toBeVisible();
	await page.keyboard.press('ArrowLeft');
	await expect(viewer.getByAltText('tiktok slide 5')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(thumb).toBeFocused();
});

test('Calendar uses same viewer and Escape leaves the detail drawer open', async ({ page }) => {
	await page.goto('/calendar');
	const detail = page.getByTestId('calendar-detail');
	await clickUntilVisible(
		page,
		page.locator(`[data-cal-item="${ids.get('tiktok')!.target}"]`).first(),
		detail
	);
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
	await viewer.getByRole('combobox').selectOption('1');
	await expect(viewer).toContainText('Second thread post');
	await expect(viewer.getByAltText('x slide 6')).toBeVisible();
});
