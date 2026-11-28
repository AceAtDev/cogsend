<script lang="ts">
	import { ChevronLeft, ChevronRight, Ellipsis, Expand, X } from '@lucide/svelte';
	import AccountAvatar from '#lib/components/AccountAvatar.svelte';
	import PostViewer from '#lib/components/PostViewer.svelte';
	import { dialogFocus } from '#lib/components/dialog-focus.js';
	import { formatDateTime, STATUS_LABEL, type CalendarMedia } from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import type { MenuAction } from './CalendarActionMenu.svelte';
	import { STATUS_DOT } from './CalendarChip.svelte';
	import { sourceOf } from './thumb.js';
	import type { ViewItem } from './types.js';

	let {
		item,
		media,
		timeZone,
		actions,
		onClose,
		onMore
	}: {
		item: ViewItem;
		media: CalendarMedia[];
		timeZone: string;
		/** Shown as a row of icons under the post; the first few only, the rest are under More. */
		actions: MenuAction[];
		onClose: () => void;
		onMore: (x: number, y: number) => void;
	} = $props();

	const shown = $derived(media.filter((m) => m.storageKey));
	let index = $state(0);
	const current = $derived(shown[Math.min(index, shown.length - 1)]);
	const source = $derived(current ? sourceOf(current) : null);
	const handle = $derived(item.channel.handle ? displayAt(item.channel.handle) : '');
	let inspecting = $state(false);

	// Hashtags, mentions and links read as they would in a feed.
	const parts = $derived(
		item.text.split(/(\s+)/).map((word) => ({
			word,
			accent: /^(#|@)\w|^https?:\/\//.test(word)
		}))
	);

	const when = $derived(
		item.status === 'published'
			? `Published ${formatDateTime(item.at, timeZone)}`
			: `${STATUS_LABEL[item.status]} · ${formatDateTime(item.at, timeZone)}`
	);
	const quick = $derived(actions.slice(0, 4));
</script>

<div
	class="fixed inset-0 z-40 flex items-center justify-center bg-stone-950/50 p-4 backdrop-blur-[2px]"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget) onClose();
	}}
>
	<div
		class="flex max-h-[calc(100dvh-2rem)] w-full max-w-[26rem] flex-col overflow-hidden rounded-[1.5rem] bg-white shadow-[0_24px_60px_-12px_rgb(28_25_23/0.45)]"
		role="dialog"
		aria-modal="true"
		aria-label="Preview of the {item.channel.platformName} post"
		data-testid="calendar-preview"
		use:dialogFocus={{ onEscape: onClose }}
	>
		<header class="flex items-center gap-3 px-4 pt-4 pb-3">
			<AccountAvatar
				platform={item.channel.platform}
				handle={item.channel.handle}
				displayName={item.channel.displayName}
				size={36}
			/>
			<div class="min-w-0 flex-1">
				<p class="truncate text-[14px] font-extrabold text-stone-900">
					{item.channel.displayName || handle || item.channel.platformName}
				</p>
				<p class="truncate text-[12px] text-stone-500">
					{handle ? `${handle} · ` : ''}{item.channel.platformName}
				</p>
			</div>
			<button
				type="button"
				class="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-900"
				aria-label="Close preview"
				onclick={onClose}
			>
				<X class="h-4 w-4" />
			</button>
		</header>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if source}
				<div class="relative bg-stone-950">
					{#key current.id}
						{#if source.video}
							<!-- svelte-ignore a11y_media_has_caption -->
							<video
								src={source.src}
								poster={source.poster ?? undefined}
								controls
								playsinline
								preload="metadata"
								class="mx-auto max-h-[55dvh] w-full object-contain"
							></video>
						{:else}
							<img
								src={source.src}
								alt={current.altText ?? ''}
								class="mx-auto max-h-[55dvh] w-full object-contain"
							/>
						{/if}
					{/key}
					{#if shown.length > 1}
						<button
							type="button"
							class="absolute top-1/2 left-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-stone-800 shadow disabled:opacity-0"
							aria-label="Previous media"
							disabled={index === 0}
							onclick={() => (index -= 1)}><ChevronLeft class="h-4 w-4" /></button
						>
						<button
							type="button"
							class="absolute top-1/2 right-2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-stone-800 shadow disabled:opacity-0"
							aria-label="Next media"
							disabled={index >= shown.length - 1}
							onclick={() => (index += 1)}><ChevronRight class="h-4 w-4" /></button
						>
						<div class="absolute inset-x-0 bottom-2 flex justify-center gap-1" aria-hidden="true">
							{#each shown as m, i (m.id)}
								<span class="h-1.5 w-1.5 rounded-full {i === index ? 'bg-white' : 'bg-white/45'}"
								></span>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<div class="px-4 py-3">
				{#if item.previewTitle}
					<p class="mb-1 text-[14px] font-extrabold text-stone-900">{item.previewTitle}</p>
				{/if}
				{#if item.text.trim()}
					<p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-stone-800">
						{#each parts as part, i (i)}{#if part.accent}<span class="font-semibold text-sky-700"
									>{part.word}</span
								>{:else}{part.word}{/if}{/each}
					</p>
				{:else}
					<p class="text-[13px] text-stone-400 italic">No caption</p>
				{/if}
				<p class="mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-stone-500">
					<span class="h-2 w-2 rounded-full {STATUS_DOT[item.status]}" aria-hidden="true"></span>
					{when}
				</p>
				{#if item.errorMessage && item.status === 'failed'}
					<p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] font-medium text-red-800">
						{item.errorMessage}
					</p>
				{/if}
			</div>
		</div>

		<footer class="flex items-stretch gap-1 border-t border-stone-100 px-2 py-2">
			{#each quick as action (action.key)}
				{@const Icon = action.icon}
				<button
					type="button"
					class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-bold transition-colors {action.tone ===
					'danger'
						? 'text-red-700 hover:bg-red-50'
						: action.tone === 'primary'
							? 'text-violet-700 hover:bg-violet-50'
							: 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'}"
					title={action.hint}
					onclick={action.onSelect}
					data-testid="preview-{action.key}"
				>
					<Icon class="h-[18px] w-[18px]" aria-hidden="true" />
					<span class="max-w-full truncate">{action.label}</span>
				</button>
			{/each}
			{#if shown.length}
				<button
					type="button"
					class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-bold text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
					onclick={() => (inspecting = true)}
					data-testid="preview-inspect"
				>
					<Expand class="h-[18px] w-[18px]" aria-hidden="true" />
					<span class="max-w-full truncate">On a phone</span>
				</button>
			{/if}
			<button
				type="button"
				class="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-bold text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
				aria-haspopup="menu"
				onclick={(event) => {
					const box = event.currentTarget.getBoundingClientRect();
					onMore(box.left, box.top - 8);
				}}
				data-testid="preview-more"
			>
				<Ellipsis class="h-[18px] w-[18px]" aria-hidden="true" />
				<span>More</span>
			</button>
		</footer>
	</div>
</div>

<PostViewer
	open={inspecting}
	onClose={() => (inspecting = false)}
	items={shown.map((m) => ({ ...m, meta: m.meta as never }))}
	platform={item.channel.platform}
	content={item.text}
	segments={item.previewSegments}
	segmentIndices={item.previewSegmentIndices}
	title={item.previewTitle}
	account={{ displayName: item.channel.displayName, handle: item.channel.handle }}
	initialIndex={index}
/>
