const PREFIX = 'tiktok-developers-site-verification=';
const FILE = /^tiktok([A-Za-z0-9]{8,128})\.txt$/;
const TOKEN = /^[A-Za-z0-9]{8,128}$/;

/**
 * The tokens in TIKTOK_SITE_VERIFICATION. TikTok's URL-prefix verification
 * hands out a file named `tiktok<token>.txt` holding
 * `tiktok-developers-site-verification=<token>`; any of the three (file name,
 * contents, bare token) is accepted, several separated by spaces or commas.
 */
export function tiktokVerificationTokens(raw: string | null | undefined): string[] {
	const tokens = new Set<string>();
	for (const part of (raw ?? '').split(/[\s,]+/)) {
		const value = part.trim();
		if (!value) continue;
		const token =
			FILE.exec(value)?.[1] ?? (value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value);
		if (TOKEN.test(token)) tokens.add(token);
	}
	return [...tokens];
}

export function isTiktokVerificationFile(name: string): boolean {
	return FILE.test(name);
}

/** The file's body for `name`, or null when it is not one of the configured tokens. */
export function tiktokVerificationBody(
	raw: string | null | undefined,
	name: string
): string | null {
	const token = FILE.exec(name)?.[1];
	if (!token || !tiktokVerificationTokens(raw).includes(token)) return null;
	return `${PREFIX}${token}`;
}
