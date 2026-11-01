<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		Check,
		ChevronDown,
		Clock,
		PauseCircle,
		PenLine,
		ShieldCheck,
		Undo2,
		X
	} from '@lucide/svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import MediaPreview from '#lib/components/MediaPreview.svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { showToast } from '#lib/components/toast.svelte.js';
	import { formatDateTime, fromZonedInputValue, toZonedInputValue } from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { MAX_REVIEW_NOTE } from '#lib/domain/review.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Group = (typeof data.groups)[number];
	type Card = Group['cards'][number];

	/** null shows every brand; otherwise a brand id, or "unbranded". */
	let brandFilter = $state<string | null>(null);
	let overdueOnly = $state(false);
	let busyKey = $state<string | null>(null);
	let rejecting = $state<string | null>(null);
	let rejectNote = $state('');
	let retiming = $state<string | null>(null);
	let retimeValue = $state('');
	let retimeError = $state<string | null>(null);
	let confirmBulk = $state<{ label: string; ids: string[] } | null>(null);
	let showRejected = $state(false);

	const brandKey = (g: Group) => g.brand.id ?? 'unbranded';
	const cardKey = (g: Group, c: Card) => `${brandKey(g)}:${c.postId}:${c.status}`;

	const visible = $derived(
		data.groups
			.filter((g) => brandFilter === null || brandKey(g) === brandFilter)
			.map((g) => ({
				...g,
				waiting: g.cards.filter(
					(c) => c.status === 'awaiting_review' && (!overdueOnly || c.timing === 'overdue')
				),
				rejected: g.cards.filter((c) => c.status === 'rejected')
			}))
	);
	const shownIds = $derived(
		visible.flatMap((g) => g.waiting.flatMap((c) => c.deliveries.map((d) => d.deliveryId)))
	);
	const rejectedCount = $derived(visible.reduce((n, g) => n + g.rejected.length, 0));

	function waitingIn(g: Group) {
		return g.cards
			.filter((c) => c.status === 'awaiting_review')
			.reduce((n, c) => n + c.deliveries.length, 0);
	}

	function idsOf(card: Card) {
		return card.deliveries.map((d) => d.deliveryId);
	}

	function whenLine(card: Card) {
		if (card.scheduledFor === null) return 'Sent “now” by the agent';
		return formatDateTime(card.scheduledFor, data.timeZone);
	}

	async function post(path: string, body: unknown, key: string, success: string) {
		busyKey = key;
		try {
			const res = await fetch(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (sessionExpiredIfUnauthorized(res)) return false;
			const out = await res.json().catch(() => ({}));
			if (!res.ok) {
				showToast(out.error || 'That did not work — try again', 'error');
				return false;
			}
			showToast(success);
			await invalidateAll();
			return true;
		} catch {
			showToast('Could not reach CogSend — check your connection', 'error');
			return false;
		} finally {
			busyKey = null;
		}
	}

	function approve(ids: string[], key: string, runAt?: number) {
		const n = ids.length;
		return post(
			'/api/review/approve',
			{ deliveryIds: ids, ...(runAt ? { runAt: new Date(runAt).toISOString() } : {}) },
			key,
			`Approved ${n} deliver${n === 1 ? 'y' : 'ies'}`
		);
	}

	async function submitReject(card: Card, key: string) {
		const done = await post(
			'/api/review/reject',
			{ deliveryIds: idsOf(card), note: rejectNote },
			key,
			'Rejected — the agent can see your note'
		);
		if (done) {
			rejecting = null;
			rejectNote = '';
		}
	}

	function startRetime(card: Card, key: string) {
		retimeError = null;
		const base =
			card.scheduledFor && card.scheduledFor > Date.now()
				? card.scheduledFor
				: Date.now() + 60 * 60_000;
		retimeValue = toZonedInputValue(base, data.timeZone);
		retiming = key;
	}

	async function submitRetime(card: Card, key: string) {
		const at = fromZonedInputValue(retimeValue, data.timeZone);
		if (at === null || at <= Date.now()) {
			retimeError = 'Pick a time in the future';
			return;
		}
		if (await approve(idsOf(card), key, at)) retiming = null;
	}

	function cancel(card: Card, key: string) {
		return post(
			'/api/targets/bulk',
			{ op: 'cancel', ids: idsOf(card).slice(0, 10) },
			key,
			'Cancelled'
		);
	}

	const pill =
		'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-bold transition-colors disabled:opacity-50';
</script>

<svelte:head>
	<title>Review — {data.counts.waiting} waiting</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col pb-16">
	<div class="mb-6">
		<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Inbox</p>
		<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Review</h1>
		<p class="mt-2 text-[14px] text-stone-600">
			{#if data.counts.waiting}
				{data.counts.waiting} deliver{data.counts.waiting === 1 ? 'y waits' : 'ies wait'} for you{#if data.counts.overdue},
					<span class="font-bold text-amber-700"
						>{data.counts.overdue} past {data.counts.overdue === 1 ? 'its' : 'their'} time</span
					>{/if}. Nothing here is published until you approve it.
			{:else}
				Nothing waits for review. Agent posts on brands that require review land here.
			{/if}
		</p>
	</div>

	{#if data.loadFailed}
		<p class="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-[13px] text-red-800" role="alert">
			The inbox could not be loaded. Refresh to try again.
		</p>
	{/if}
	{#if data.truncated}
		<p class="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
			Showing the first {data.groups.reduce((n, g) => n + g.cards.length, 0)} posts; approve some to see
			the rest.
		</p>
	{/if}

	{#if data.groups.length}
		<div
			class="sticky top-24 z-10 -mx-1 mb-5 rounded-[1.25rem] bg-stone-50/95 px-1 py-2 backdrop-blur"
		>
			<div class="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter by brand">
				<button
					type="button"
					aria-pressed={brandFilter === null}
					onclick={() => (brandFilter = null)}
					class="shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-bold {brandFilter ===
					null
						? 'border-stone-900 bg-stone-900 text-white'
						: 'border-stone-200 bg-white text-stone-700'}">All</button
				>
				{#each data.groups as g (brandKey(g))}
					<button
						type="button"
						aria-pressed={brandFilter === brandKey(g)}
						onclick={() => (brandFilter = brandFilter === brandKey(g) ? null : brandKey(g))}
						class="flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-bold {brandFilter ===
						brandKey(g)
							? 'border-stone-900 bg-stone-900 text-white'
							: 'border-stone-200 bg-white text-stone-700'}"
					>
						<span class="h-2.5 w-2.5 rounded-full" style="background-color: {g.brand.color}"></span>
						{g.brand.name}
						<span class="tabular-nums opacity-70">{waitingIn(g)}</span>
					</button>
				{/each}
			</div>
			<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
				<label class="flex min-h-11 items-center gap-2 text-[13px] font-bold text-stone-700">
					<input type="checkbox" bind:checked={overdueOnly} class="h-4 w-4 rounded" />
					Past their time only
				</label>
				{#if shownIds.length}
					<button
						type="button"
						class="{pill} bg-emerald-600 text-white hover:bg-emerald-700"
						disabled={busyKey !== null}
						onclick={() =>
							(confirmBulk = {
								ids: shownIds,
								label:
									brandFilter === null && !overdueOnly
										? `every waiting delivery (${shownIds.length})`
										: `the ${shownIds.length} shown`
							})}
						data-testid="review-approve-shown"
					>
						<Check class="h-4 w-4" /> Approve {shownIds.length} shown
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#each visible as g (brandKey(g))}
		{#if g.waiting.length || (showRejected && g.rejected.length)}
			<section class="mb-8" aria-labelledby="brand-{brandKey(g)}">
				<div class="mb-3 flex items-center gap-2">
					<span class="h-3 w-3 rounded-full" style="background-color: {g.brand.color}"></span>
					<h2 id="brand-{brandKey(g)}" class="text-[15px] font-extrabold text-stone-900">
						{g.brand.name}
					</h2>
					{#if g.brand.paused}
						<span
							class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900"
							title="Approved posts wait until you resume the brand in Accounts"
						>
							<PauseCircle class="h-3 w-3" /> Paused
						</span>
					{/if}
					{#if g.waiting.length > 1}
						<button
							type="button"
							class="ml-auto text-[13px] font-bold text-emerald-700 hover:text-emerald-900"
							disabled={busyKey !== null}
							onclick={() =>
								(confirmBulk = {
									ids: g.waiting.flatMap(idsOf),
									label: `${g.brand.name}’s ${g.waiting.flatMap(idsOf).length} shown`
								})}
						>
							Approve all {g.brand.name}
						</button>
					{/if}
				</div>

				<ul class="space-y-4">
					{#each g.waiting as card (cardKey(g, card))}
						{@const key = cardKey(g, card)}
						<li
							id="post-{card.postId}"
							class="rounded-[1.5rem] border border-dashed border-violet-200 bg-white p-4 shadow-[0_1px_2px_rgb(28_25_23/0.04)] sm:p-5"
							data-testid="review-card"
						>
							<div class="mb-3 flex flex-wrap items-center gap-2">
								{#each card.deliveries as d (d.deliveryId)}
									<span
										class="inline-flex max-w-full items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-[12px] font-bold text-stone-700"
										title={d.channelKey}
									>
										<span style="color: {g.brand.color}"
											><PlatformLogo platform={d.platform} size={12} /></span
										>
										<span class="truncate">{d.handle ? displayAt(d.handle) : d.platformName}</span>
										{#if d.connectionStatus !== 'active'}
											<span class="text-red-600">(reconnect)</span>
										{/if}
									</span>
								{/each}
							</div>

							<p
								class="flex flex-wrap items-center gap-1.5 text-[13px] font-bold {card.timing ===
								'overdue'
									? 'text-amber-800'
									: 'text-stone-600'}"
							>
								<Clock class="h-3.5 w-3.5" />
								{whenLine(card)}
								{#if card.timing === 'overdue'}
									<span class="font-medium">
										— time passed; approving sends it on the next tick</span
									>
								{:else if card.scheduledFor}
									<span class="font-medium text-stone-500"
										>({formatRelativeTime(new Date(card.scheduledFor), new Date(data.now))})</span
									>
								{/if}
							</p>

							{#if card.reviewNote}
								<p class="mt-3 rounded-2xl bg-stone-100 px-3 py-2 text-[13px] text-stone-700">
									<span class="font-bold">Resubmitted after your note:</span>
									{card.reviewNote}
								</p>
							{/if}

							<p
								class="mt-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-stone-900"
							>
								{card.text || 'Empty post'}
							</p>
							{#each card.deliveries.filter((d) => d.text !== card.text) as d (d.deliveryId)}
								<details class="mt-2 rounded-2xl bg-stone-50 px-3 py-2 text-[13px]">
									<summary class="cursor-pointer font-bold text-stone-600">
										{d.platformName} version
									</summary>
									<p class="mt-2 whitespace-pre-wrap text-stone-800">{d.text}</p>
								</details>
							{/each}

							{#if card.media.filter((m) => m.storageKey).length}
								{@const shown = card.media.filter((m) => m.storageKey)}
								<div class="mt-3">
									<MediaPreview
										items={shown.map((m) => ({ ...m, meta: m.meta as never }))}
										maxHeight={240}
										extra={Math.max(0, shown.length - 4)}
									/>
								</div>
							{/if}

							{#if rejecting === key}
								<form
									class="mt-4 space-y-2"
									onsubmit={(e) => {
										e.preventDefault();
										void submitReject(card, key);
									}}
								>
									<label class="block text-[12px] font-bold text-stone-600" for="note-{key}">
										What should the agent change? (it reads this)
									</label>
									<textarea
										id="note-{key}"
										bind:value={rejectNote}
										maxlength={MAX_REVIEW_NOTE}
										rows="3"
										class="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-[14px] focus:border-stone-400 focus:bg-white"
										placeholder="Too salesy — lead with the job, drop the emoji"></textarea>
									<div class="flex flex-wrap justify-end gap-2">
										<button
											type="button"
											class="{pill} border border-stone-200 text-stone-600"
											onclick={() => (rejecting = null)}>Back</button
										>
										<button
											type="submit"
											disabled={busyKey === key}
											class="{pill} bg-red-600 text-white hover:bg-red-700"
										>
											<X class="h-4 w-4" /> Reject
										</button>
									</div>
								</form>
							{:else if retiming === key}
								<form
									class="mt-4 space-y-2"
									onsubmit={(e) => {
										e.preventDefault();
										void submitRetime(card, key);
									}}
								>
									<label class="block text-[12px] font-bold text-stone-600" for="when-{key}">
										Approve for ({data.timeZone})
									</label>
									<input
										id="when-{key}"
										type="datetime-local"
										bind:value={retimeValue}
										required
										class="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-[14px]"
									/>
									{#if retimeError}
										<p class="text-[12px] font-medium text-red-600" role="alert">{retimeError}</p>
									{/if}
									<div class="flex flex-wrap justify-end gap-2">
										<button
											type="button"
											class="{pill} border border-stone-200 text-stone-600"
											onclick={() => (retiming = null)}>Back</button
										>
										<button
											type="submit"
											disabled={busyKey === key}
											class="{pill} bg-emerald-600 text-white hover:bg-emerald-700"
										>
											<Check class="h-4 w-4" /> Approve at this time
										</button>
									</div>
								</form>
							{:else}
								<div class="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
									<button
										type="button"
										disabled={busyKey !== null}
										onclick={() => void approve(idsOf(card), key)}
										class="{pill} col-span-2 bg-emerald-600 text-white hover:bg-emerald-700 sm:order-last"
										data-testid="review-approve"
									>
										<Check class="h-4 w-4" />
										{busyKey === key ? 'Approving…' : 'Approve'}
									</button>
									<a
										href="/compose?id={encodeURIComponent(card.postId)}"
										class="{pill} bg-stone-100 text-stone-800 hover:bg-stone-200"
									>
										<PenLine class="h-4 w-4" /> Edit
									</a>
									<button
										type="button"
										disabled={busyKey !== null}
										onclick={() => startRetime(card, key)}
										class="{pill} bg-stone-100 text-stone-800 hover:bg-stone-200"
									>
										<Clock class="h-4 w-4" /> New time
									</button>
									<button
										type="button"
										disabled={busyKey !== null}
										onclick={() => {
											rejectNote = '';
											rejecting = key;
										}}
										class="{pill} col-span-2 border border-stone-200 text-red-600 hover:border-red-200 hover:bg-red-50 sm:col-span-1"
									>
										<X class="h-4 w-4" /> Reject
									</button>
								</div>
							{/if}
						</li>
					{/each}

					{#if showRejected}
						{#each g.rejected as card (cardKey(g, card))}
							{@const key = cardKey(g, card)}
							<li
								class="rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4 text-stone-600"
								data-testid="review-rejected"
							>
								<p class="text-[12px] font-bold tracking-wide text-stone-500 uppercase">
									Rejected · {card.deliveries.map((d) => d.platformName).join(', ')}
								</p>
								<p class="mt-2 line-clamp-3 text-[14px] whitespace-pre-wrap">{card.text}</p>
								{#if card.reviewNote}
									<p class="mt-2 text-[13px]">
										<span class="font-bold">Your note:</span>
										{card.reviewNote}
									</p>
								{/if}
								<div class="mt-3 flex flex-wrap justify-end gap-2">
									<button
										type="button"
										disabled={busyKey !== null}
										onclick={() => void cancel(card, key)}
										class="{pill} border border-stone-200 text-red-600"
									>
										Cancel it
									</button>
									<button
										type="button"
										disabled={busyKey !== null}
										onclick={() => void approve(idsOf(card), key)}
										class="{pill} bg-stone-200 text-stone-800"
									>
										<Undo2 class="h-4 w-4" /> Approve anyway
									</button>
								</div>
							</li>
						{/each}
					{/if}
				</ul>
			</section>
		{/if}
	{/each}

	{#if data.groups.length && !shownIds.length && !data.loadFailed}
		<div class="rounded-[1.5rem] border border-dashed border-stone-200 px-6 py-10 text-center">
			<ShieldCheck class="mx-auto h-8 w-8 text-emerald-600" />
			<p class="mt-3 text-[14px] font-bold text-stone-700">
				{overdueOnly || brandFilter ? 'Nothing matches this filter.' : 'All caught up.'}
			</p>
		</div>
	{/if}

	{#if rejectedCount}
		<button
			type="button"
			class="mt-2 flex min-h-11 items-center gap-1.5 self-start text-[13px] font-bold text-stone-600"
			aria-expanded={showRejected}
			onclick={() => (showRejected = !showRejected)}
		>
			<ChevronDown class="h-4 w-4 transition-transform {showRejected ? 'rotate-180' : ''}" />
			{showRejected ? 'Hide' : 'Show'}
			{rejectedCount} rejected, waiting for the agent
		</button>
	{/if}
</div>

<ConfirmDialog
	open={confirmBulk !== null}
	title="Approve {confirmBulk?.label ?? ''}?"
	body="Each goes out at its own time; any whose time has passed goes out on the next tick."
	confirmLabel="Approve"
	cancelLabel="Back"
	tone="primary"
	busy={busyKey === 'bulk'}
	idPrefix="review-bulk"
	onConfirm={async () => {
		if (!confirmBulk) return;
		const ids = confirmBulk.ids;
		if (await approve(ids, 'bulk')) confirmBulk = null;
	}}
	onCancel={() => (confirmBulk = null)}
/>
