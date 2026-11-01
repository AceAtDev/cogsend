<script lang="ts">
	import { page } from '$app/state';
	import { Bot, KeyRound, Timer, User } from '@lucide/svelte';
	import { formatDateTime } from '#lib/domain/calendar.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const ACTORS = [
		{ value: null, label: 'Everyone' },
		{ value: 'session', label: 'You' },
		{ value: 'api_key', label: 'API key' },
		{ value: 'api_token', label: 'API_TOKEN' },
		{ value: 'system', label: 'Scheduler' }
	] as const;
	const ACTIONS = [
		{ value: null, label: 'Everything' },
		{ value: 'review', label: 'Review' },
		{ value: 'post', label: 'Posts' },
		{ value: 'delivery', label: 'Deliveries' },
		{ value: 'brand', label: 'Brands' },
		{ value: 'mcp', label: 'MCP tools' }
	] as const;

	function hrefWith(changes: Record<string, string | null>) {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.delete('cursor');
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) params.delete(key);
			else params.set(key, value);
		}
		const query = params.toString();
		return query ? `/activity?${query}` : '/activity';
	}

	function targetHref(entry: (typeof data.entries)[number]) {
		if (entry.targetType === 'post' && entry.targetId)
			return `/compose?id=${encodeURIComponent(entry.targetId)}`;
		return null;
	}

	const chip = (active: boolean) =>
		`inline-flex min-h-10 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-bold ${
			active
				? 'border-stone-900 bg-stone-900 text-white'
				: 'border-stone-200 bg-white text-stone-700'
		}`;
</script>

<svelte:head>
	<title>Activity</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col pb-16">
	<div class="mb-6">
		<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Log</p>
		<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Activity</h1>
		<p class="mt-2 text-[14px] text-stone-600">
			Who changed what: you in the app, an agent with your API key, or the scheduler. Kept for 90
			days.
		</p>
	</div>

	<div class="mb-2 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Who">
		{#each ACTORS as a (a.label)}
			<a href={hrefWith({ actor: a.value })} class={chip(data.filter.actor === a.value)}
				>{a.label}</a
			>
		{/each}
	</div>
	<div class="mb-6 flex gap-2 overflow-x-auto pb-1" role="group" aria-label="What">
		{#each ACTIONS as a (a.label)}
			<a href={hrefWith({ action: a.value })} class={chip(data.filter.action === a.value)}
				>{a.label}</a
			>
		{/each}
	</div>

	{#if data.loadFailed}
		<p class="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-[13px] text-red-800" role="alert">
			The activity log could not be loaded. Refresh to try again.
		</p>
	{/if}

	{#if data.entries.length}
		<ol class="space-y-2" data-testid="activity-list">
			{#each data.entries as entry (entry.id)}
				{@const href = targetHref(entry)}
				<li class="rounded-2xl border border-stone-200/80 bg-white px-4 py-3">
					<div class="flex items-start gap-3">
						<span
							class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600"
							aria-hidden="true"
						>
							{#if entry.actor.type === 'session'}
								<User class="h-3.5 w-3.5" />
							{:else if entry.actor.type === 'system'}
								<Timer class="h-3.5 w-3.5" />
							{:else if entry.actor.type === 'api_key'}
								<Bot class="h-3.5 w-3.5" />
							{:else}
								<KeyRound class="h-3.5 w-3.5" />
							{/if}
						</span>
						<div class="min-w-0 flex-1">
							<p class="text-[14px] break-words text-stone-900">{entry.summary}</p>
							<p class="mt-1 flex flex-wrap gap-x-2 text-[12px] text-stone-500">
								<span class="font-bold">{entry.actor.label}</span>
								<span>{formatDateTime(entry.at, data.timeZone)}</span>
								<code class="text-[11px]">{entry.action}</code>
								{#if entry.before || entry.after}
									<span>{entry.before ?? '—'} → {entry.after ?? '—'}</span>
								{/if}
								{#if href}
									<a {href} class="font-bold text-stone-700 underline-offset-2 hover:underline"
										>Open post</a
									>
								{/if}
							</p>
						</div>
					</div>
				</li>
			{/each}
		</ol>
		{#if data.next}
			<a
				href={`${hrefWith({})}${hrefWith({}).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.next)}`}
				class="mt-4 inline-flex min-h-11 items-center self-start rounded-full bg-stone-100 px-4 text-[13px] font-bold text-stone-800 hover:bg-stone-200"
				>Older</a
			>
		{/if}
	{:else if !data.loadFailed}
		<p
			class="rounded-[1.5rem] border border-dashed border-stone-200 px-6 py-10 text-center text-[14px] text-stone-500"
		>
			Nothing recorded{data.filter.actor || data.filter.action ? ' for this filter' : ' yet'}.
		</p>
	{/if}
</div>
