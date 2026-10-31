<script lang="ts" module>
	import type { CalendarStatus } from '#lib/domain/calendar.js';

	/** Chip tint per state; the brand colour stays on the left edge either way. */
	export const STATUS_TONE: Record<CalendarStatus, string> = {
		scheduled: 'bg-white text-stone-800',
		due: 'bg-amber-50 text-amber-900',
		sending: 'bg-sky-50 text-sky-900',
		processing: 'bg-violet-50 text-violet-900',
		published: 'bg-emerald-50 text-emerald-900',
		failed: 'bg-red-50 text-red-900',
		cancelled: 'bg-stone-100 text-stone-500'
	};

	export const STATUS_DOT: Record<CalendarStatus, string> = {
		scheduled: 'bg-stone-400',
		due: 'bg-amber-500',
		sending: 'bg-sky-500 motion-safe:animate-pulse',
		processing: 'bg-violet-500',
		published: 'bg-emerald-500',
		failed: 'bg-red-500',
		cancelled: 'bg-stone-300'
	};
</script>

<script lang="ts">
	import { Image } from '@lucide/svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { canDrag, formatDateTime, formatTime, STATUS_LABEL } from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { draftExcerpt } from '#lib/domain/excerpt.js';
	import type { ViewItem } from './types.js';

	let {
		item,
		timeZone,
		compact = false,
		dragging = false,
		onOpen,
		onPointerDown
	}: {
		item: ViewItem;
		timeZone: string;
		/** Month cells: one line, no text. */
		compact?: boolean;
		dragging?: boolean;
		onOpen: (item: ViewItem, trigger: HTMLElement) => void;
		onPointerDown?: (item: ViewItem, event: PointerEvent) => void;
	} = $props();

	const movable = $derived(canDrag(item.status) && item.channel.status === 'active');
	const handle = $derived(item.channel.handle ? displayAt(item.channel.handle) : '');
	const label = $derived(
		[
			item.channel.brand.name,
			`${item.channel.platformName} ${handle}`.trim(),
			item.retrying ? 'Retrying' : STATUS_LABEL[item.status],
			formatDateTime(item.at, timeZone),
			draftExcerpt(item.text, 80)
		].join(', ') + (movable ? '. Drag to reschedule.' : '')
	);
</script>

<button
	type="button"
	data-cal-item={item.id}
	data-day={item.day}
	data-at={item.at}
	aria-label={label}
	title={label}
	class="group flex w-full min-w-0 flex-col rounded-md border border-l-4 border-stone-200/80 px-1.5 py-1 text-left text-[11px] leading-tight shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-shadow hover:shadow-md {STATUS_TONE[
		item.status
	]} {movable ? 'cursor-grab touch-none select-none' : ''} {dragging ? 'opacity-40' : ''}"
	style="border-left-color: {item.channel.brand.color}"
	onclick={(event) => onOpen(item, event.currentTarget)}
	onpointerdown={(event) => onPointerDown?.(item, event)}
>
	<span class="flex w-full min-w-0 items-center gap-1">
		<span class="shrink-0 font-bold tabular-nums">{formatTime(item.at, timeZone)}</span>
		<span class="shrink-0" style="color: {item.channel.brand.color}">
			<PlatformLogo platform={item.channel.platform} size={11} />
		</span>
		<span
			class="min-w-0 flex-1 truncate font-semibold {item.status === 'cancelled'
				? 'line-through'
				: ''}">{handle || item.channel.platformName}</span
		>
		{#if item.mediaCount}
			<Image class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
		{/if}
		<span class="h-1.5 w-1.5 shrink-0 rounded-full {STATUS_DOT[item.status]}" aria-hidden="true"
		></span>
	</span>
	{#if !compact}
		<span
			class="mt-0.5 block w-full truncate opacity-75 {item.status === 'cancelled'
				? 'line-through'
				: ''}">{draftExcerpt(item.text.split('\n')[0], 60)}</span
		>
	{/if}
</button>
