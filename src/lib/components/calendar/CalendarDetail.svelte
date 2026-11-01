<script lang="ts">
	import { ExternalLink, PenLine, RotateCcw, ShieldCheck, X } from '@lucide/svelte';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import MediaPreview from '#lib/components/MediaPreview.svelte';
	import MetricsPanel from '#lib/components/MetricsPanel.svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { dialogFocus } from '#lib/components/dialog-focus.js';
	import {
		formatDateTime,
		fromZonedInputValue,
		itemActions,
		STATUS_LABEL,
		toZonedInputValue,
		type CalendarMedia
	} from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { safeHttpUrl } from '#lib/domain/links.js';
	import { STATUS_DOT } from './CalendarChip.svelte';
	import type { ViewItem } from './types.js';

	let {
		item,
		media,
		timeZone,
		busy,
		error,
		onClose,
		onReschedule,
		onCancel,
		onRetry
	}: {
		item: ViewItem;
		media: CalendarMedia[];
		timeZone: string;
		busy: boolean;
		error: string | null;
		onClose: () => void;
		onReschedule: (item: ViewItem, runAt: number) => void;
		onCancel: (item: ViewItem) => void;
		onRetry: (item: ViewItem) => void;
	} = $props();

	const actions = $derived(item.channel.status === 'active' ? itemActions(item.status) : []);
	const permalink = $derived(item.status === 'published' ? safeHttpUrl(item.remoteUrl) : null);
	const handle = $derived(item.channel.handle ? displayAt(item.channel.handle) : '');
	const shownMedia = $derived(media.filter((m) => m.storageKey));

	let picking = $state(false);
	let when = $state('');
	let pickError = $state<string | null>(null);

	function startPicking() {
		pickError = null;
		const base = item.at > Date.now() ? item.at : Date.now() + 60 * 60_000;
		when = toZonedInputValue(base, timeZone);
		picking = true;
	}

	function submitPick(event: SubmitEvent) {
		event.preventDefault();
		const runAt = fromZonedInputValue(when, timeZone);
		if (runAt === null || runAt <= Date.now()) {
			pickError = 'Pick a time in the future';
			return;
		}
		pickError = null;
		onReschedule(item, runAt);
	}

	const pill =
		'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-bold transition-colors disabled:opacity-50';
</script>

<div
	role="presentation"
	class="fixed inset-0 z-40 flex items-end justify-center bg-black/30 md:items-stretch md:justify-end"
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
>
	<div
		role="dialog"
		aria-modal="true"
		aria-labelledby="calendar-detail-title"
		data-testid="calendar-detail"
		class="flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-[1.5rem] border border-stone-200/80 bg-white shadow-[0_16px_40px_-12px_rgb(28_25_23/0.25)] md:max-h-none md:w-[420px] md:rounded-none md:rounded-l-[1.5rem]"
		use:dialogFocus={{ onEscape: onClose }}
	>
		<div class="flex items-start gap-3 border-b border-stone-100 px-5 pt-5 pb-4">
			<div class="min-w-0 flex-1">
				<p
					class="flex items-center gap-2 text-[11px] font-bold tracking-widest text-stone-500 uppercase"
				>
					<span
						class="h-2.5 w-2.5 shrink-0 rounded-full"
						style="background-color: {item.channel.brand.color}"
						aria-hidden="true"
					></span>
					{item.channel.brand.name}
				</p>
				<h2
					id="calendar-detail-title"
					class="mt-1.5 flex items-center gap-2 text-lg font-extrabold tracking-tight text-stone-900"
				>
					<span style="color: {item.channel.brand.color}">
						<PlatformLogo platform={item.channel.platform} size={16} />
					</span>
					<span class="truncate">{item.channel.platformName} {handle}</span>
				</h2>
			</div>
			<button
				type="button"
				onclick={onClose}
				aria-label="Close"
				class="-mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
			>
				<X class="h-5 w-5" />
			</button>
		</div>

		<div class="flex-1 space-y-4 overflow-y-auto px-5 py-4">
			<dl class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
				<dt class="font-bold text-stone-500">Status</dt>
				<dd class="flex items-center gap-2 font-bold text-stone-900">
					<span class="h-2 w-2 rounded-full {STATUS_DOT[item.status]}" aria-hidden="true"></span>
					{item.retrying ? 'Retrying' : STATUS_LABEL[item.status]}
				</dd>
				<dt class="font-bold text-stone-500">
					{item.scheduledFor === null
						? item.status === 'cancelled'
							? 'Cancelled'
							: 'Updated'
						: item.status === 'published'
							? 'Published'
							: 'When'}
				</dt>
				<dd class="text-stone-900">{formatDateTime(item.at, timeZone)}</dd>
				{#if item.channel.key}
					<dt class="font-bold text-stone-500">Channel</dt>
					<dd class="flex min-w-0 items-center gap-1">
						<code
							class="truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[12px] text-stone-700"
							>{item.channel.key}</code
						>
						<CopyButton value={item.channel.key} ariaLabel="Copy channel key" />
					</dd>
				{:else}
					<dt class="font-bold text-stone-500">Account</dt>
					<dd class="text-stone-600">Disconnected</dd>
				{/if}
			</dl>

			{#if item.status === 'review'}
				<p class="rounded-2xl bg-violet-50 px-3 py-2 text-[13px] text-violet-900">
					An agent wrote this. It keeps its time but goes out only once you approve it{item.at <=
					Date.now()
						? '; its time has passed, so approving sends it on the next tick'
						: ''}.
				</p>
			{:else if item.status === 'rejected'}
				<p class="rounded-2xl bg-stone-100 px-3 py-2 text-[13px] text-stone-700">
					You rejected this; the agent can revise and resubmit it.
				</p>
			{/if}
			{#if item.errorMessage}
				<p
					class="rounded-2xl px-3 py-2 text-[13px] {item.status === 'failed'
						? 'bg-red-50 text-red-800'
						: 'bg-amber-50 text-amber-900'}"
				>
					{humanizeError(item.errorMessage)}
				</p>
			{/if}

			<p class="text-[14px] leading-relaxed whitespace-pre-wrap text-stone-800">
				{item.text || 'Empty post'}
			</p>

			{#if shownMedia.length}
				<MediaPreview
					items={shownMedia.map((m) => ({ ...m, meta: m.meta as never }))}
					maxHeight={220}
					extra={Math.max(0, shownMedia.length - 4)}
				/>
			{/if}

			{#if item.status === 'published'}
				{#key item.id}
					<MetricsPanel targetId={item.id} {timeZone} />
				{/key}
			{/if}

			<div class="flex flex-wrap gap-2">
				<a
					href="/compose?id={encodeURIComponent(item.draftId)}"
					class="{pill} bg-stone-100 text-stone-800 hover:bg-stone-200"
				>
					<PenLine class="h-4 w-4" /> Open in composer
				</a>
				{#if permalink}
					<a
						href={permalink}
						target="_blank"
						rel="noopener noreferrer"
						class="{pill} bg-stone-100 text-stone-800 hover:bg-stone-200"
					>
						<ExternalLink class="h-4 w-4" /> View post
					</a>
				{/if}
			</div>
		</div>

		{#if actions.length}
			<div class="border-t border-stone-100 px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
				{#if picking}
					<form class="space-y-2" onsubmit={submitPick}>
						<label class="block text-[12px] font-bold text-stone-500" for="calendar-reschedule-at">
							New time ({timeZone})
						</label>
						<input
							id="calendar-reschedule-at"
							type="datetime-local"
							bind:value={when}
							required
							class="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[14px] text-stone-900 focus:border-stone-400 focus:bg-white"
						/>
						{#if pickError}
							<p class="text-[12px] font-medium text-red-600" role="alert">{pickError}</p>
						{/if}
						<div class="flex justify-end gap-2">
							<button
								type="button"
								class="{pill} border border-stone-200 text-stone-600 hover:text-stone-900"
								onclick={() => (picking = false)}>Back</button
							>
							<button
								type="submit"
								disabled={busy}
								class="{pill} bg-stone-900 text-white hover:bg-stone-800"
							>
								{busy ? 'Saving…' : 'Reschedule'}
							</button>
						</div>
					</form>
				{:else}
					<div class="flex flex-wrap justify-end gap-2">
						{#if actions.includes('review')}
							<a
								href="/review#post-{encodeURIComponent(item.draftId)}"
								class="{pill} bg-violet-600 text-white hover:bg-violet-700"
							>
								<ShieldCheck class="h-4 w-4" /> Review
							</a>
						{/if}
						{#if actions.includes('cancel')}
							<button
								type="button"
								disabled={busy}
								onclick={() => onCancel(item)}
								class="{pill} border border-stone-200 text-red-600 hover:border-red-200 hover:bg-red-50"
							>
								{item.status === 'failed' ? 'Remove' : 'Cancel'}
							</button>
						{/if}
						{#if actions.includes('reschedule')}
							<button
								type="button"
								disabled={busy}
								onclick={startPicking}
								class="{pill} bg-stone-900 text-white hover:bg-stone-800">Reschedule</button
							>
						{/if}
						{#if actions.includes('retry')}
							<button
								type="button"
								disabled={busy}
								onclick={() => onRetry(item)}
								class="{pill} bg-stone-900 text-white hover:bg-stone-800"
							>
								<RotateCcw class="h-4 w-4" />
								{busy ? 'Retrying…' : 'Retry'}
							</button>
						{/if}
					</div>
				{/if}
				{#if error}
					<p class="mt-2 text-right text-[12px] font-medium text-red-600" role="alert">{error}</p>
				{/if}
			</div>
		{/if}
	</div>
</div>
