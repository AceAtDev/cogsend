import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { clickUntilVisible, d1, E2E_AUTH_STATE, fillUntilKept } from './e2e-env';

test.use({ storageState: E2E_AUTH_STATE });

let brand: string;
let slug: string;
let draft: string;
let connections: string[];
let targets: string[];

test.beforeEach(async ({ page }) => {
	brand = randomUUID();
	slug = `ui-regression-${brand}`;
	draft = randomUUID();
	connections = Array.from({ length: 11 }, () => randomUUID());
	targets = connections.map(() => randomUUID());
	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const now = Date.now();
	const sql = [
		`INSERT INTO brands (id,user_id,name,slug,color,created_at,updated_at) VALUES ('${brand}','${me.user.id}','${slug}','${slug}','#059669',${now},${now})`,
		`INSERT INTO drafts (id,user_id,title,base_body,status,created_at,updated_at) VALUES ('${draft}','${me.user.id}','UI fixture','${slug} rejected post','draft',${now},${now})`
	];
	connections.forEach((id, i) => {
		sql.push(
			`INSERT INTO connections (id,user_id,brand_id,platform,handle,display_name,credentials_encrypted,meta_json,status,created_at,updated_at) VALUES ('${id}','${me.user.id}','${brand}','mastodon','slot-account-${i}','Slot account ${i}','enc','{}','active',${now + i},${now + i})`
		);
		sql.push(
			`INSERT INTO publish_targets (id,draft_id,connection_id,status,scheduled_for,created_at,updated_at) VALUES ('${targets[i]}','${draft}','${id}','rejected',${now + 3600000},${now},${now})`
		);
	});
	d1(sql.join('; '));
});

test.afterEach(() => {
	d1(
		`DELETE FROM publish_targets WHERE draft_id='${draft}'; DELETE FROM drafts WHERE id='${draft}'; DELETE FROM posting_schedules WHERE connection_id IN (${connections.map((id) => `'${id}'`).join(',')}); DELETE FROM connections WHERE brand_id='${brand}'; DELETE FROM brands WHERE id='${brand}'`
	);
});

test('saving A preserves B unsaved slots, limits and pending time across invalidation', async ({
	page
}) => {
	await page.goto(`/accounts/${slug}`);
	const a = page
		.locator('form')
		.filter({ has: page.getByRole('heading', { name: /slot-account-0\b/ }) });
	const b = page
		.locator('form')
		.filter({ has: page.getByRole('heading', { name: /slot-account-1\b/ }) });
	await fillUntilKept(a.getByLabel('New time on Monday', { exact: true }), '09:00');
	await a.getByRole('button', { name: 'Add time on Monday', exact: true }).click();
	await fillUntilKept(b.getByLabel('New time on Monday', { exact: true }), '11:00');
	await b.getByRole('button', { name: 'Add time on Monday', exact: true }).click();
	await b.getByLabel('Max posts a day').fill('3');
	await b.getByLabel('Minutes between posts').fill('45');
	await b.getByLabel('New time on Tuesday', { exact: true }).fill('12:00');
	await a.getByRole('button', { name: 'Save slots', exact: true }).click();
	// The description is server data, so this waits for invalidateAll, not just the toast.
	await expect(a.locator('p').first()).toContainText('09:00');
	await expect(a.getByRole('button', { name: 'Save slots', exact: true })).toBeEnabled();
	const saved = await page.request
		.get(`/api/connections/${connections[0]}/slots`)
		.then((r) => r.json());
	expect(JSON.stringify(saved)).toContain('09:00');
	await expect(
		b.getByRole('button', { name: 'Remove 11:00 on Monday', exact: true })
	).toBeVisible();
	await expect(b.getByLabel('Max posts a day')).toHaveValue('3');
	await expect(b.getByLabel('Minutes between posts')).toHaveValue('45');
	await expect(b.getByLabel('New time on Tuesday', { exact: true })).toHaveValue('12:00');
	await page.reload();
	await expect(b.getByRole('button', { name: 'Remove 11:00 on Monday', exact: true })).toHaveCount(
		0
	);
});

test('Cancel it cancels all eleven grouped deliveries using bounded requests', async ({ page }) => {
	const batches: string[][] = [];
	await page.route('**/api/targets/bulk', async (route) => {
		batches.push(route.request().postDataJSON().ids);
		await route.continue();
	});
	await page.goto('/review');
	const card = page.getByTestId('review-rejected').filter({ hasText: `${slug} rejected post` });
	await clickUntilVisible(page, page.getByRole('button', { name: /Show.*rejected/ }), card);
	await card.getByRole('button', { name: 'Cancel it', exact: true }).click();
	await expect(page.getByText('Cancelled 11 deliveries', { exact: true })).toBeVisible();
	await expect(card).toHaveCount(0);
	expect(batches.map((batch) => batch.length)).toEqual([10, 1]);
	expect(batches.flat().sort()).toEqual([...targets].sort());
});

test('Cancel it reports partial HTTP-200 failures instead of unqualified success', async ({
	page
}) => {
	const batches: string[][] = [];
	await page.route('**/api/targets/bulk', async (route) => {
		const ids: string[] = route.request().postDataJSON().ids;
		batches.push(ids);
		const results = ids.map((id) => ({
			id,
			ok: id !== targets[0],
			...(id === targets[0] ? { error: 'Already published' } : { status: 'cancelled' })
		}));
		await route.fulfill({ json: { results, failed: results.filter((r) => !r.ok) } });
	});
	await page.goto('/review');
	const card = page.getByTestId('review-rejected').filter({ hasText: `${slug} rejected post` });
	await clickUntilVisible(page, page.getByRole('button', { name: /Show.*rejected/ }), card);
	await card.getByRole('button', { name: 'Cancel it', exact: true }).click();
	await expect(
		page.getByText('Cancelled 10; 1 not cancelled: Already published', { exact: true })
	).toBeVisible();
	await expect(page.getByText('Cancelled 11 deliveries', { exact: true })).toHaveCount(0);
	expect(batches.flat().sort()).toEqual([...targets].sort());
});
