import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { SubrequestBudget } from '#lib/server/budget.js';
import { pingHeartbeat, runSchedulerTick } from '#lib/server/scheduler.js';

describe('heartbeat ping', () => {
	let db: AppDb;
	let close: () => void;
	beforeAll(async () => {
		({ db, close } = await createTestDb());
	});
	afterAll(() => close());

	it('pings HEARTBEAT_URL with the hourly janitors, not every tick', async () => {
		const hits: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			hits.push(String(input));
			return new Response('OK');
		}) as typeof fetch;
		const env = { ...TEST_ENV, HEARTBEAT_URL: 'https://hc-ping.com/abc' };
		await runSchedulerTick(db, env, { store: createTestMedia(), fetchImpl });
		expect(hits.filter((h) => h.startsWith('https://hc-ping.com/'))).toHaveLength(1);
		hits.length = 0;
		await runSchedulerTick(db, env, { store: createTestMedia(), fetchImpl });
		expect(hits.filter((h) => h.startsWith('https://hc-ping.com/'))).toHaveLength(0);
	});

	it('does nothing without a URL, refuses plain http, and never throws', async () => {
		let called = 0;
		const fetchImpl = (async () => {
			called++;
			throw new Error('network down');
		}) as typeof fetch;
		expect(await pingHeartbeat(TEST_ENV, fetchImpl, null)).toBe(false);
		expect(
			await pingHeartbeat(
				{ ...TEST_ENV, HEARTBEAT_URL: 'http://insecure.example' },
				fetchImpl,
				null
			)
		).toBe(false);
		expect(called).toBe(0);
		expect(
			await pingHeartbeat({ ...TEST_ENV, HEARTBEAT_URL: 'https://hc-ping.com/x' }, fetchImpl, null)
		).toBe(false);
		expect(called).toBe(1);
		const spent = new SubrequestBudget(0);
		expect(
			await pingHeartbeat({ ...TEST_ENV, HEARTBEAT_URL: 'https://hc-ping.com/x' }, fetchImpl, spent)
		).toBe(false);
		expect(called).toBe(1);
	});
});
