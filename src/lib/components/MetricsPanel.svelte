<script lang="ts" module>
	import type { MetricCounts, MetricState } from '#lib/domain/metrics.js';

	export type MetricsView = {
		targetId: string;
		platform: string;
		state: MetricState;
		message: string | null;
		counts: MetricCounts | null;
		collectedAt: number | null;
		nextAt: number | null;
		snapshots?: { kind: string; collectedAt: number; counts: MetricCounts }[];
	};
</script>

<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { formatDateTime } from '#lib/domain/calendar.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { compactCount, metricLabel, PLATFORM_METRICS } from '#lib/domain/metrics.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';

	let { targetId, timeZone }: { targetId: string; timeZone: string } = $props();

	let view = $state<MetricsView | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const keys = $derived(view ? (PLATFORM_METRICS[view.platform] ?? []) : []);
	const collectable = $derived(
		view ? view.state !== 'unsupported' && Boolean(PLATFORM_METRICS[view.platform]) : false
	);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/targets/${encodeURIComponent(targetId)}/metrics`);
			if (sessionExpiredIfUnauthorized(res)) return;
			const body = await res.json().catch(() => ({}));
			if (!res.ok) error = humanizeError(body.error || 'Could not load metrics');
			else view = body as MetricsView;
		} catch {
			error = humanizeError('fetch failed');
		} finally {
			loading = false;
		}
	}

	async function refresh() {
		refreshing = true;
		error = null;
		notice = null;
		try {
			const res = await fetch(`/api/targets/${encodeURIComponent(targetId)}/metrics`, {
				method: 'POST'
			});
			if (sessionExpiredIfUnauthorized(res)) return;
			const body = await res.json().catch(() => ({}));
			if (!res.ok) error = humanizeError(body.error || 'Could not refresh metrics');
			else {
				view = body.metrics as MetricsView;
				if (!body.refreshed && body.reason) notice = body.reason;
			}
		} catch {
			error = humanizeError('fetch failed');
		} finally {
			refreshing = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<section class="rounded-2xl border border-stone-200/80 p-3" data-testid="metrics-panel">
	<div class="mb-2 flex items-center justify-between gap-2">
		<h3 class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Performance</h3>
		{#if collectable}
			<button
				type="button"
				onclick={refresh}
				disabled={refreshing}
				class="inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
			>
				<RefreshCw class="h-3.5 w-3.5 {refreshing ? 'animate-spin' : ''}" />
				{refreshing ? 'Reading…' : 'Refresh'}
			</button>
		{/if}
	</div>

	{#if loading && !view}
		<p class="text-[13px] text-stone-500">Loading metrics…</p>
	{:else if view}
		{#if view.counts && keys.length}
			<dl class="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="metrics-counts">
				{#each keys as key (key)}
					{#if typeof view.counts[key] === 'number'}
						<div class="rounded-xl bg-stone-50 px-2.5 py-2">
							<dt class="text-[11px] font-bold text-stone-500">
								{metricLabel(view.platform, key)}
							</dt>
							<dd
								class="text-[16px] font-extrabold text-stone-900 tabular-nums"
								title={String(view.counts[key])}
							>
								{compactCount(view.counts[key] ?? 0)}
							</dd>
						</div>
					{/if}
				{/each}
			</dl>
		{/if}
		{#if view.message}
			<p
				class="mt-2 text-[13px] {view.state === 'reconnect'
					? 'rounded-xl bg-amber-50 px-3 py-2 text-amber-900'
					: 'text-stone-600'}"
				data-testid="metrics-message"
			>
				{view.message}
			</p>
		{/if}
		{#if view.collectedAt}
			<p class="mt-2 text-[12px] text-stone-500" title={formatDateTime(view.collectedAt, timeZone)}>
				Read {formatRelativeTime(new Date(view.collectedAt))}{#if view.nextAt}
					· next read {formatDateTime(view.nextAt, timeZone)}{/if}
			</p>
		{/if}
		{#if view.snapshots && view.snapshots.length > 1}
			<details class="mt-2 text-[12px] text-stone-600">
				<summary class="cursor-pointer font-bold">History ({view.snapshots.length})</summary>
				<ul class="mt-1 space-y-0.5">
					{#each view.snapshots as snap (snap.collectedAt)}
						<li class="flex justify-between gap-2 tabular-nums">
							<span>{snap.kind === 'manual' ? 'On demand' : `After ${snap.kind}`}</span>
							<span class="truncate text-right">
								{keys
									.filter((k) => typeof snap.counts[k] === 'number')
									.map((k) => `${snap.counts[k]} ${metricLabel(view!.platform, k).toLowerCase()}`)
									.join(' · ')}
							</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
	{#if notice}
		<p class="mt-2 text-[12px] text-stone-500" role="status">{notice}</p>
	{/if}
	{#if error}
		<p class="mt-2 text-[12px] font-medium text-red-600" role="alert">{error}</p>
	{/if}
</section>
