<script lang="ts">
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { addDays, formatDay, formatTime, STATUS_LABEL } from '#lib/domain/calendar.js';
	import type { ComposeOverviewData } from '#lib/domain/compose-overview.js';

	let { overview, reviewCount = 0 }: { overview: ComposeOverviewData; reviewCount?: number } =
		$props();

	const weekCount = $derived(overview.days.reduce((n, d) => n + d.lines.length, 0));
	const todayCount = $derived(
		overview.days.find((d) => d.day === overview.today)?.lines.length ?? 0
	);
	// The next thing still to go out: anything earlier has already happened or is overdue.
	const next = $derived.by(() => {
		const now = Date.now();
		for (const group of overview.days) {
			const line = group.lines.find((l) => l.at >= now && l.status !== 'published');
			if (line) return { day: group.day, line };
		}
		return null;
	});

	function dayName(day: string): string {
		if (day === overview.today) return 'Today';
		if (day === addDays(overview.today, 1)) return 'Tomorrow';
		return formatDay(day);
	}

	const drafts = $derived(`${overview.draftCount}${overview.moreDrafts ? '+' : ''}`);

	// One row per question a person opens the app with; rows with nothing to say stay out.
	const rows = $derived(
		[
			{ label: 'Today', value: String(todayCount), href: '/calendar', tone: '', show: true },
			{ label: 'This week', value: String(weekCount), href: '/calendar', tone: '', show: true },
			{
				label: 'Need review',
				value: String(reviewCount),
				href: '/review',
				tone: 'text-violet-700',
				show: reviewCount > 0
			},
			{
				label: 'Failed',
				value: String(overview.failed),
				href: '/posts?tab=failed',
				tone: 'text-red-700',
				show: overview.failed > 0
			},
			{
				label: 'Drafts',
				value: drafts,
				href: '/posts?tab=drafts',
				tone: '',
				show: overview.draftCount > 0
			}
		].filter((r) => r.show)
	);

	let open = $state(false);
</script>

{#snippet body()}
	{#if next}
		<a
			href={next.line.status === 'review'
				? `/review#post-${encodeURIComponent(next.line.draftId)}`
				: `/compose?id=${encodeURIComponent(next.line.draftId)}`}
			class="block rounded-2xl border border-stone-200/80 bg-white p-3.5 shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors hover:border-stone-300"
			data-testid="overview-next"
		>
			<span class="block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
				>Next up</span
			>
			<span class="mt-1 block text-[15px] font-extrabold text-stone-900"
				>{dayName(next.day)}, {formatTime(next.line.at, overview.timeZone)}</span
			>
			<span class="mt-0.5 line-clamp-2 block text-[13px] text-stone-600"
				>{next.line.text || 'Untitled'}</span
			>
			<span class="mt-2 flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
				{#each next.line.accounts.slice(0, 4) as account, i (i)}
					<span style="color: {account.color}" aria-hidden="true">
						<PlatformLogo platform={account.platform} size={12} />
					</span>
				{/each}
				<span class={next.line.status === 'review' ? 'text-violet-700' : ''}
					>{STATUS_LABEL[next.line.status]}</span
				>
			</span>
		</a>
	{:else}
		<p
			class="rounded-2xl border border-dashed border-stone-200 p-3.5 text-[13px] text-stone-500"
			data-testid="overview-next"
		>
			Nothing scheduled yet.
		</p>
	{/if}

	<ul class="mt-3 divide-y divide-stone-200/70">
		{#each rows as row (row.label)}
			<li>
				<a
					href={row.href}
					class="flex items-center gap-2 py-2.5 text-[13px] font-semibold text-stone-600 transition-colors hover:text-stone-900"
				>
					<span class="flex-1">{row.label}</span>
					<span class="font-extrabold tabular-nums {row.tone || 'text-stone-900'}">{row.value}</span
					>
					<ChevronRight class="h-3.5 w-3.5 text-stone-400" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

<!-- Wide screens: a short summary beside the centred editor. -->
<aside
	class="fixed top-32 left-[calc(50%+23rem)] z-20 hidden w-60 xl:block"
	aria-label="Coming up"
	data-testid="compose-overview"
>
	{@render body()}
</aside>

<!-- Narrower screens: one line that opens the same summary, so the editor stays first. -->
<div class="mx-auto mb-6 w-full max-w-2xl xl:hidden" data-testid="compose-overview-strip">
	<button
		type="button"
		class="flex w-full items-center gap-2 rounded-2xl border border-stone-200/80 bg-white px-4 py-2.5 text-left text-[12px] font-bold text-stone-600 shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors hover:border-stone-300"
		aria-expanded={open}
		aria-controls="compose-overview-panel"
		onclick={() => (open = !open)}
	>
		<span class="min-w-0 flex-1 truncate">
			{#if next}
				Next: <span class="text-stone-900"
					>{dayName(next.day)}, {formatTime(next.line.at, overview.timeZone)}</span
				>
			{:else}
				Nothing scheduled yet
			{/if}
			{#if reviewCount}<span class="text-violet-700"> · {reviewCount} to review</span>{/if}
			{#if overview.failed}<span class="text-red-700"> · {overview.failed} failed</span>{/if}
		</span>
		<ChevronDown
			class="h-4 w-4 shrink-0 transition-transform {open ? 'rotate-180' : ''}"
			aria-hidden="true"
		/>
	</button>
	{#if open}
		<div id="compose-overview-panel" class="mt-2 rounded-2xl bg-stone-100/60 p-3">
			{@render body()}
		</div>
	{/if}
</div>
