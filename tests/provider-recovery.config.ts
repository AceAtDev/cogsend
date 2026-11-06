import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Provider tests need neither Svelte nor the operator's local environment files.
export default defineConfig({
	envDir: false,
	resolve: {
		alias: {
			'#lib': path('../src/lib'),
			'cloudflare:workers': path('./cloudflare-workers.ts'),
			'cloudflare:sockets': path('./cloudflare-sockets.ts')
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./tests/setup-env.ts'],
		expect: { requireAssertions: true }
	}
});
