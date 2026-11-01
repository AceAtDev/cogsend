<script lang="ts" module>
	import type { MetricCounts } from '#lib/domain/metrics.js';

	type Totals = {
		posts: number;
		measured: number;
		engagement: number;
		likes: number;
		comments: number;
		shares: number;
		quotes: number;
		views: number;
		impressions: number;
		clicks: number;
	};
	export type PerformancePayload = {
		totals: Totals;
		brands: Array<Totals & { id: string | null; name: string; slug: string; color: string }>;
		channels: Array<
			Totals & {
				connectionId: string;
				key: string;
				platform: string;
				platformName: string;
				handle: string | null;
				brand: { name: string; color: string };
				notice: string | null;
			}
		>;
		top: Array<{
			deliveryId: string;
			postId: string;
			channel: string;
			brand: string;
			platform: string;
			handle: string | null;
			publishedAt: number;
			permalink: string | null;
			excerpt: string;
			counts: MetricCounts;
			engagement: number;
		}>;
	};
</script>

<script lang="ts">
	import { ExternalLink } from '@lucide/svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { safeHttpUrl } from '#lib/domain/links.js';
	import {
		compactCount,
		metricLabel,
		NOT_COLLECTED_YET,
		PLATFORM_METRICS
	} from '#lib/domain/metrics.js';
	import { displayHandle } from '#lib/domain/platforms.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';

	let { days, initial }: { days: 7 | 30 | 90; initial: PerformancePayload | null } = $props();

	// svelte-ignore state_referenced_locally
	let report = $state<PerformancePayload | null>(initial);
	// svelte-ignore state_referenced_locally
	let shownDays = $state(days);
	let error = $state<string | null>(null);
	let token = 0;

	async function load(next: number) {
		const mine = ++token;
		error = null;
		try {
			const res = await fetch(`/api/insights/performance?days=${next}`);
			if (sessionExpiredIfUnauthorized(res)) return;
			const body = await res.json().catch(() => ({}));
			if (mine !== token) return;
			if (!res.ok || !body?.totals) {
				error = humanizeError(body?.error || 'Could not load performance');
				return;
			}
			report = body as PerformancePayload;
		} catch {
			if (mine === token) error = 'Could not reach the server — check your connection and retry.';
		}
	}

	$effect(() => {
		if (days !== shownDays) {
			shownDays = days;
			void load(days);
		}
	});

	const tiles = $derived(
		report
			? (
					[
						['Engagement', report.totals.engagement],
						['Likes', report.totals.likes],
						['Comments', report.totals.comments],
						['Shares', report.totals.shares],
						['Views', report.totals.views],
						['Impressions', report.totals.impressions]
					] as const
				).filter(([label, n]) => n > 0 || label === 'Engagement')
			: []
	);

	function countsText(platform: string, counts: MetricCounts): string {
		return (PLATFORM_METRICS[platform] ?? [])
			.filter((k) => typeof counts[k] === 'number')
			.map((k) => `${compactCount(counts[k] ?? 0)} ${metricLabel(platform, k).toLowerCase()}`)
			.join(' · ');
	}
</script>

<div class="mt-7 mb-2.5 flex items-center justify-between gap-3">
	<h2 class="text-[15px] font-extrabold tracking-tight text-stone-900">Performance</h2>
	{#if report}
		<p class="text-[12px] font-semibold text-stone-500">
			{report.totals.measured} of {report.totals.posts} posts measured
		</p>
	{/if}
</div>
<div
	class="space-y-5 rounded-[2rem] border border-stone-200/80 bg-white p-5 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
	data-testid="insights-performance"
>
	{#if error}
		<p class="text-[13px] font-medium text-red-600" role="alert">{error}</p>
	{/if}
	{#if !report}
		<p class="text-[13px] text-stone-500">Performance is not available right now.</p>
	{:else if report.totals.posts === 0}
		<p class="text-[13px] text-stone-500">No published posts in this range yet.</p>
	{:else}
		<dl class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
			{#each tiles as [label, n] (label)}
				<div class="rounded-2xl bg-stone-50 px-3 py-2.5">
					<dt class="text-[10px] font-bold tracking-widest text-stone-500 uppercase">{label}</dt>
					<dd class="text-[18px] font-extrabold text-stone-900 tabular-nums" title={String(n)}>
						{compactCount(n)}
					</dd>
				</div>
			{/each}
		</dl>

		{#if report.brands.length > 1}
			<div>
				<h3 class="mb-1.5 text-[11px] font-bold tracking-widest text-stone-500 uppercase">
					By brand
				</h3>
				<ul class="divide-y divide-stone-100" data-testid="performance-brands">
					{#each report.brands as brand (brand.slug)}
						<li class="flex items-center justify-between gap-3 py-2 text-[13px]">
							<span class="flex min-w-0 items-center gap-2 font-bold text-stone-900">
								<span
									class="h-2.5 w-2.5 shrink-0 rounded-full"
									style="background-color: {brand.color}"
									aria-hidden="true"
								></span>
								<span class="truncate">{brand.name}</span>
							</span>
							<span class="text-stone-600 tabular-nums">
								{brand.posts} posts · {compactCount(brand.engagement)} engagement
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div>
			<h3 class="mb-1.5 text-[11px] font-bold tracking-widest text-stone-500 uppercase">
				By channel
			</h3>
			<ul class="divide-y divide-stone-100" data-testid="performance-channels">
				{#each report.channels as channel (channel.connectionId)}
					<li class="py-2 text-[13px]">
						<div class="flex items-center justify-between gap-3">
							<span class="flex min-w-0 items-center gap-2 font-bold text-stone-900">
								<span style="color: {channel.brand.color}">
									<PlatformLogo platform={channel.platform} size={14} />
								</span>
								<span class="truncate">
									{channel.brand.name} · {channel.platformName}
									<span class="font-medium text-stone-500">{displayHandle(channel.handle)}</span>
								</span>
							</span>
							<span class="shrink-0 text-stone-600 tabular-nums">
								{channel.posts} posts{#if channel.measured}
									· {compactCount(channel.engagement)} engagement{/if}
							</span>
						</div>
						{#if channel.notice}
							<p class="mt-0.5 text-[12px] text-stone-500">{channel.notice}</p>
						{/if}
					</li>
				{/each}
			</ul>
		</div>

		<div>
			<h3 class="mb-1.5 text-[11px] font-bold tracking-widest text-stone-500 uppercase">
				Top posts
			</h3>
			{#if report.top.length === 0}
				<p class="text-[13px] text-stone-500">
					Nothing measured yet: counts are read about an hour after a post goes out.
				</p>
			{:else}
				<ol class="space-y-2" data-testid="performance-top">
					{#each report.top as post, i (post.deliveryId)}
						{@const href = safeHttpUrl(post.permalink)}
						<li class="flex gap-3 rounded-2xl bg-stone-50 px-3 py-2.5">
							<span class="w-5 shrink-0 text-[13px] font-extrabold text-stone-400">{i + 1}</span>
							<div class="min-w-0 flex-1">
								<p class="truncate text-[13px] font-medium text-stone-900">
									{post.excerpt || 'Empty post'}
								</p>
								<p class="mt-0.5 text-[12px] text-stone-500">
									{post.brand} · {post.channel || post.platform} · {formatRelativeTime(
										new Date(post.publishedAt)
									)}
								</p>
								<p class="mt-0.5 text-[12px] font-semibold text-stone-700 tabular-nums">
									{countsText(post.platform, post.counts)}
								</p>
							</div>
							{#if href}
								<a
									{href}
									target="_blank"
									rel="noopener noreferrer"
									aria-label="View post"
									class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-stone-200 hover:text-stone-900"
								>
									<ExternalLink class="h-4 w-4" />
								</a>
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	{/if}
	<p class="text-[12px] text-stone-500">
		Counts from Bluesky, Mastodon, TikTok and LinkedIn company pages, read about 1 hour, 1 day and 7
		days after publishing. Instagram, Threads and X: {NOT_COLLECTED_YET.toLowerCase()}
	</p>
</div>
