import { readStoredAppName } from './app-settings';

/** True for the usual spellings of "on"; an unset or "0"/"false" value is off. */
export function envFlag(value: string | undefined): boolean {
	const v = (value ?? '').trim().toLowerCase();
	return v !== '' && !['0', 'false', 'no', 'off'].includes(v);
}

export function publicHomepageEnabled(env: { PUBLIC_HOMEPAGE?: string }): boolean {
	return envFlag(env.PUBLIC_HOMEPAGE);
}

/** A plausible address, or null: it is printed on a public page as a mailto link. */
function contactEmail(raw: string | undefined): string | null {
	const value = raw?.trim();
	return value && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value) ? value : null;
}

/** What the public pages say about the instance: its name, address and contact. */
export async function instanceFacts(locals: App.Locals) {
	const appUrl = locals.env.APP_URL.replace(/\/$/, '');
	let host = '';
	try {
		host = new URL(appUrl).host;
	} catch {
		/* no known origin yet: the pages leave the address out */
	}
	return {
		appName: (await readStoredAppName(locals.db)) ?? locals.env.APP_NAME,
		appUrl,
		host,
		contactEmail: contactEmail(locals.env.LEGAL_CONTACT_EMAIL)
	};
}
