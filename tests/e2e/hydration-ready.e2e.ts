import { expect, test } from '@playwright/test';

test('the composer accepts text only once hydration can preserve and autosave it', async ({
	page
}) => {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => (release = resolve));
	await page.route(/\/_app\/immutable\/.*\.js(?:\?|$)/, async (route) => {
		await ready;
		await route.continue();
	});
	try {
		await page.goto('/compose', { waitUntil: 'commit' });
		const input = page.getByRole('textbox', { name: 'Post text', exact: true });
		await expect(input).toBeVisible();
		await expect(input).not.toBeEditable();
		release();
		await expect(input).toBeEditable();
		await input.fill('Hydrated composer regression');
		await expect
			.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 15000 })
			.toBeTruthy();
		const id = new URL(page.url()).searchParams.get('id')!;
		const stored = await page.request.get(`/api/drafts/${id}`).then((res) => res.json());
		expect(stored.draft.baseBody).toBe('Hydrated composer regression');
		await expect(input).toHaveValue('Hydrated composer regression');
	} finally {
		release();
	}
});

test('profile picture controls wait for hydration and the first click opens a focused dialog', async ({
	page
}) => {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => (release = resolve));
	await page.route(/\/_app\/immutable\/.*\.js(?:\?|$)/, async (route) => {
		await ready;
		await route.continue();
	});
	try {
		await page.goto('/settings', { waitUntil: 'commit' });
		const opener = page.getByRole('button', { name: /(?:Add|Edit) profile picture/ });
		await expect(opener).toBeVisible();
		await expect(opener).toBeDisabled();
		release();
		await expect(opener).toBeEnabled();
		await opener.click();
		const dialog = page.getByRole('alertdialog', { name: 'Profile picture' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(opener).toBeFocused();
	} finally {
		release();
	}
});
