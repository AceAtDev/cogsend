/**
 * Stands in for workerd's `cloudflare:sockets` in the unit tests (vite.config.ts
 * aliases the module here). Nothing may open a real connection from a test: a
 * route that sends mail reaches this `connect`, which refuses unless a test
 * handed it a fake server with useFakeConnect().
 */
type Connect = (...args: never[]) => unknown;

let fake: Connect | null = null;

export function useFakeConnect(next: Connect | null): void {
	fake = next;
}

export function connect(...args: never[]): unknown {
	if (!fake) throw new Error('cloudflare:sockets is not available in tests; pass a fake connect');
	return fake(...args);
}
