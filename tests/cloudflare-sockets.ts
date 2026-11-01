/**
 * Stands in for workerd's `cloudflare:sockets` in the unit tests (vite.config.ts
 * aliases the module here). Nothing may open a real connection from a test:
 * the SMTP code takes its `connect` as a parameter and tests pass a fake one.
 */
export function connect(): never {
	throw new Error('cloudflare:sockets is not available in tests; pass a fake connect');
}
