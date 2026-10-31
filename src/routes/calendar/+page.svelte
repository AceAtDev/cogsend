<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { ChevronLeft, ChevronRight, Image, PenLine, SlidersHorizontal } from '@lucide/svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import CalendarChip, { STATUS_DOT } from '#lib/components/calendar/CalendarChip.svelte';
	import CalendarDetail from '#lib/components/calendar/CalendarDetail.svelte';
	import type { ViewItem } from '#lib/components/calendar/types.js';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { showToast } from '#lib/components/toast.svelte.js';
	import {
		addDays,
		CALENDAR_STATUSES,
		calendarHref,
		canDrag,
		droppedInstant,
		formatDateTime,
		formatDay,
		formatTime,
		monthStart,
		rangeLabel,
		reschedulePayload,
		shiftAnchor,
		STATUS_LABEL,
		toggleValue,
		weekday,
		zonedParts,
		type CalendarQuery
	} from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { draftExcerpt } from '#lib/domain/excerpt.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import { browserTimeZone } from '#lib/domain/time-zone.js';

	let { data } = $props();

	const tz = $derived(data.timeZone);
	const query = $derived(data.query);
	const days = $derived(data.range.days);
	const HOURS = Array.from({ length: 24 }, (_, h) => h);
	const MONTH_CHIPS = 3;

	const channelById = $derived(new Map(data.channels.map((c) => [c.connectionId, c])));
	const items = $derived<ViewItem[]>(
		data.items.flatMap((item) => {
			const channel = channelById.get(item.connectionId);
			if (!channel) return [];
			const { key, minutes } = zonedParts(item.at, tz);
			return [{ ...item, channel, day: key, hour: Math.floor(minutes / 60) }];
		})
	);
	const byDay = $derived.by(() => {
		const map = new Map<string, ViewItem[]>();
		for (const item of items) map.set(item.day, [...(map.get(item.day) ?? []), item]);
		return map;
	});
	const byHour = $derived.by(() => {
		const map = new Map<string, ViewItem[]>();
		for (const item of items) {
			const slot = `${item.day}:${item.hour}`;
			map.set(slot, [...(map.get(slot) ?? []), item]);
		}
		return map;
	});
	const weeks = $derived(
		Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7))
	);
	const filterActive = $derived(query.brands.length > 0 || query.channels.length > 0);
	const pickableChannels = $derived(data.channels.filter((c) => c.key));
	const agendaDays = $derived(
		query.view === 'week'
			? days
			: days.filter(
					(d) => d.slice(0, 7) === query.date.slice(0, 7) && (byDay.has(d) || d === data.today)
				)
	);

	function href(overrides: Partial<CalendarQuery>): string {
		return calendarHref({ ...query, ...overrides }, data.today);
	}

	function go(overrides: Partial<CalendarQuery>) {
		return goto(href(overrides), { reset: false });
	}

	// The account zone starts as UTC and follows the browser once the layout
	// records it; a first visit would otherwise lay a week out in UTC.
	onMount(() => {
		const zone = browserTimeZone();
		if (!zone || zone === data.timeZone) return;
		void fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ timezone: zone })
		})
			.then((res) => (res.ok ? invalidateAll() : undefined))
			.catch(() => {});
	});

	let weekScroller = $state<HTMLDivElement | null>(null);
	let gridEl = $state<HTMLDivElement | null>(null);

	// Opens on the working day, or on the earliest post if one is earlier.
	let scrolledFor = '';
	$effect(() => {
		const key = `${query.view}:${data.range.start}`;
		if (!weekScroller || scrolledFor === key) return;
		scrolledFor = key;
		const earliest = items.length ? Math.min(...items.map((i) => i.hour)) : 8;
		const row = weekScroller.querySelector<HTMLElement>(
			`[data-hour-row="${Math.min(earliest, 8)}"]`
		);
		if (row) weekScroller.scrollTop = row.offsetTop - 44;
	});

	let focusedDay = $state<string | null>(null);
	let pendingFocus: string | null = null;
	const rovingDay = $derived(
		focusedDay && days.includes(focusedDay)
			? focusedDay
			: days.includes(data.today)
				? data.today
				: query.view === 'month'
					? monthStart(query.date)
					: days[0]
	);

	async function focusDay(key: string) {
		if (!days.includes(key)) {
			pendingFocus = key;
			await go({ date: key });
			return;
		}
		focusedDay = key;
		await tick();
		gridEl?.querySelector<HTMLElement>(`[data-cal-day-btn="${key}"]`)?.focus();
	}

	$effect(() => {
		// Read first, so the effect reruns when the next range arrives.
		const shown = days;
		if (pendingFocus && shown.includes(pendingFocus)) {
			const key = pendingFocus;
			pendingFocus = null;
			void focusDay(key);
		}
	});

	function dayItems(day: string): HTMLElement[] {
		return Array.from(
			gridEl?.querySelectorAll<HTMLElement>(`[data-cal-item][data-day="${day}"]`) ?? []
		);
	}

	function onGridKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		const dayBtn = target.closest<HTMLElement>('[data-cal-day-btn]');
		const itemEl = target.closest<HTMLElement>('[data-cal-item]');
		const day = dayBtn?.dataset.calDayBtn ?? itemEl?.dataset.day;
		if (!day) return;
		const siblings = itemEl ? dayItems(day) : [];
		const index = itemEl ? siblings.indexOf(itemEl) : -1;
		let handled = true;
		switch (event.key) {
			case 'ArrowLeft':
				void focusDay(addDays(day, -1));
				break;
			case 'ArrowRight':
				void focusDay(addDays(day, 1));
				break;
			case 'ArrowUp':
				if (itemEl) {
					if (index > 0) siblings[index - 1].focus();
					else void focusDay(day);
				} else if (query.view === 'month') void focusDay(addDays(day, -7));
				else handled = false;
				break;
			case 'ArrowDown':
				if (itemEl) siblings[index + 1]?.focus();
				else if (query.view === 'month') void focusDay(addDays(day, 7));
				else dayItems(day)[0]?.focus();
				break;
			case 'Home':
				void focusDay(days[0]);
				break;
			case 'End':
				void focusDay(days[days.length - 1]);
				break;
			case 'PageUp':
				void go({ date: shiftAnchor(query.view, query.date, -1) });
				break;
			case 'PageDown':
				void go({ date: shiftAnchor(query.view, query.date, 1) });
				break;
			case 'Escape':
				if (itemEl && !drag) void focusDay(day);
				else handled = false;
				break;
			default:
				handled = false;
		}
		if (handled) event.preventDefault();
	}

	function dayLabel(day: string): string {
		const count = byDay.get(day)?.length ?? 0;
		return `${formatDay(day, 'long')}${day === data.today ? ', today' : ''}: ${
			count ? `${count} post${count === 1 ? '' : 's'}` : 'nothing planned'
		}`;
	}

	let openId = $state<string | null>(null);
	const openItem = $derived(openId ? (items.find((i) => i.id === openId) ?? null) : null);
	let busy = $state(false);
	let detailError = $state<string | null>(null);
	let suppressClick = false;

	function openDetail(item: ViewItem) {
		if (suppressClick) return;
		detailError = null;
		openId = item.id;
	}

	/** One call to the bulk route the Posts page uses; null on success, else what went wrong. */
	async function bulk(
		body: { op: 'cancel' | 'retry' | 'reschedule'; ids: string[]; runAt?: string },
		fallback: string
	): Promise<string | null> {
		let res: Response;
		try {
			res = await fetch('/api/targets/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			return humanizeError('fetch failed');
		}
		if (sessionExpiredIfUnauthorized(res)) return 'Signed out';
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) return humanizeError(payload.error || fallback);
		const failed = (payload.results ?? []).find((r: { ok: boolean }) => !r.ok) as
			{ error?: string } | undefined;
		return failed ? humanizeError(failed.error || fallback) : null;
	}

	function channelName(item: ViewItem): string {
		const handle = item.channel.handle ? ` ${displayAt(item.channel.handle)}` : '';
		return `${item.channel.brand.name} · ${item.channel.platformName}${handle}`;
	}

	type Undo = { ids: string[]; from: number; label: string };
	let undo = $state<Undo | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | null = null;
	onDestroy(() => {
		if (undoTimer) clearTimeout(undoTimer);
	});

	function offerUndo(next: Undo | null) {
		if (undoTimer) clearTimeout(undoTimer);
		undo = next;
		undoTimer = next ? setTimeout(() => (undo = null), 8000) : null;
	}

	async function reschedule(item: ViewItem, runAt: number, fromDrag: boolean): Promise<boolean> {
		busy = true;
		detailError = null;
		const from = item.at;
		const problem = await bulk(reschedulePayload([item.id], runAt), 'Could not reschedule').finally(
			() => (busy = false)
		);
		if (problem) {
			if (fromDrag) showToast(problem, 'error');
			else detailError = problem;
			return false;
		}
		// Moving back is itself a reschedule, so it needs the old time to still be ahead.
		const undoable = item.status === 'scheduled' && from > Date.now() + 60_000;
		offerUndo(
			undoable
				? {
						ids: [item.id],
						from,
						label: `Moved ${item.channel.platformName} to ${formatDateTime(runAt, tz)}`
					}
				: null
		);
		if (!undoable) showToast(`Moved to ${formatDateTime(runAt, tz)}`);
		await invalidateAll();
		return true;
	}

	async function runUndo() {
		const current = undo;
		if (!current) return;
		offerUndo(null);
		const problem = await bulk(reschedulePayload(current.ids, current.from), 'Could not undo');
		if (problem) showToast(problem, 'error');
		else showToast(`Moved back to ${formatDateTime(current.from, tz)}`);
		await invalidateAll();
	}

	let pendingCancel = $state<ViewItem | null>(null);

	async function confirmCancel() {
		const item = pendingCancel;
		if (!item) return;
		busy = true;
		const problem = await bulk({ op: 'cancel', ids: [item.id] }, 'Could not cancel').finally(
			() => (busy = false)
		);
		pendingCancel = null;
		if (problem) {
			detailError = problem;
			return;
		}
		showToast(`${item.status === 'failed' ? 'Removed' : 'Cancelled'} ${channelName(item)}`);
		openId = null;
		await invalidateAll();
	}

	async function retry(item: ViewItem) {
		busy = true;
		detailError = null;
		const problem = await bulk({ op: 'retry', ids: [item.id] }, 'Retry failed').finally(
			() => (busy = false)
		);
		if (problem) detailError = problem;
		else showToast(`Retrying ${channelName(item)}`);
		await invalidateAll();
	}

	type Drop = { day: string; hour: number | null };
	type Drag = { item: ViewItem; x: number; y: number; over: Drop | null };
	let drag = $state<Drag | null>(null);
	let pendingMove = $state<{ item: ViewItem; from: number; to: number } | null>(null);
	let press: {
		item: ViewItem;
		pointerId: number;
		x: number;
		y: number;
		touch: boolean;
		timer: ReturnType<typeof setTimeout> | null;
	} | null = null;

	function dropAt(x: number, y: number): Drop | null {
		const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-day]');
		if (!cell?.dataset.dropDay) return null;
		const hour = cell.dataset.dropHour;
		return { day: cell.dataset.dropDay, hour: hour === undefined ? null : Number(hour) };
	}

	function isOver(day: string, hour: number | null): boolean {
		return Boolean(drag?.over && drag.over.day === day && drag.over.hour === hour);
	}

	function startPress(item: ViewItem, event: PointerEvent) {
		if (!canDrag(item.status) || item.channel.status !== 'active') return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		endPress();
		const touch = event.pointerType !== 'mouse';
		press = {
			item,
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			touch,
			timer: null
		};
		// A finger has to hold still first, so a tap still opens the item.
		if (touch) press.timer = setTimeout(() => press && beginDrag(press.x, press.y), 350);
		window.addEventListener('pointermove', onPointerMove, { passive: false });
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', endPress);
	}

	function beginDrag(x: number, y: number) {
		if (!press) return;
		drag = { item: press.item, x, y, over: dropAt(x, y) };
	}

	function onPointerMove(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;
		if (!drag) {
			const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
			if (press.touch) {
				if (moved > 10) endPress();
				return;
			}
			if (moved < 6) return;
			beginDrag(event.clientX, event.clientY);
		}
		event.preventDefault();
		if (!drag) return;
		drag.x = event.clientX;
		drag.y = event.clientY;
		drag.over = dropAt(event.clientX, event.clientY);
		if (weekScroller) {
			const box = weekScroller.getBoundingClientRect();
			if (event.clientY < box.top + 48) weekScroller.scrollTop -= 16;
			else if (event.clientY > box.bottom - 48) weekScroller.scrollTop += 16;
		}
	}

	function onPointerUp(event: PointerEvent) {
		if (!press || event.pointerId !== press.pointerId) return;
		const done = drag;
		endPress();
		if (!done) return;
		// The click that follows the release must not open the item too.
		suppressClick = true;
		setTimeout(() => (suppressClick = false), 0);
		proposeMove(done.item, done.over);
	}

	function endPress() {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
		drag = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', endPress);
	}
	// Unmount only: the server renders this page too, and it has no window.
	onMount(() => endPress);

	function proposeMove(item: ViewItem, over: Drop | null) {
		if (!over) return;
		const to = droppedInstant(item.at, over, tz);
		if (Math.floor(to / 60_000) === Math.floor(item.at / 60_000)) return;
		if (to <= Date.now()) {
			showToast('That time has already passed', 'warn');
			return;
		}
		pendingMove = { item, from: item.at, to };
	}

	async function confirmMove() {
		const move = pendingMove;
		if (!move) return;
		const done = await reschedule(move.item, move.to, true);
		pendingMove = null;
		if (done) openId = null;
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && drag) endPress();
	}

	const navButton =
		'flex h-10 min-w-10 items-center justify-center rounded-full border border-stone-200/80 bg-white px-3 text-[13px] font-bold text-stone-700 shadow-sm transition-colors hover:border-stone-300 hover:text-stone-900';
	const chip =
		'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-bold transition-colors';
	const chipOn = 'border-stone-900 bg-stone-900 text-white';
	const chipOff =
		'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:text-stone-900';
	let filtersOpen = $state(false);
</script>

<svelte:head>
	<title>Calendar — {rangeLabel(query.view, data.range, query.date)}</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet unscheduledList()}
	<section aria-labelledby="unscheduled-heading" data-testid="calendar-unscheduled">
		<h2
			id="unscheduled-heading"
			class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
		>
			Unscheduled drafts
		</h2>
		{#if data.unscheduled.length}
			<ul class="mt-3 space-y-2">
				{#each data.unscheduled as draft (draft.id)}
					<li>
						<a
							href="/compose?id={encodeURIComponent(draft.id)}"
							class="block rounded-2xl border border-stone-200/80 bg-white px-3 py-2.5 shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors hover:border-stone-300"
						>
							<span class="line-clamp-2 text-[13px] font-semibold text-stone-800"
								>{draft.title || draftExcerpt(draft.body, 90)}</span
							>
							<span class="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-stone-500">
								{#if draft.mediaCount}
									<Image class="h-3 w-3" aria-hidden="true" />
									<span class="sr-only">Has media,</span>
								{/if}
								Edited {formatRelativeTime(new Date(draft.updatedAt))}
							</span>
						</a>
					</li>
				{/each}
			</ul>
			{#if data.unscheduledHasMore}
				<a
					href="/posts?tab=drafts"
					class="mt-2 inline-block text-[12px] font-bold text-stone-500 hover:text-stone-900"
					>All drafts in Posts</a
				>
			{/if}
		{:else}
			<p class="mt-3 text-[13px] text-stone-500">No drafts waiting for a time.</p>
		{/if}
	</section>
{/snippet}

<div class="flex w-full flex-1 flex-col">
	<div class="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
		<div>
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Plan</p>
			<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Calendar</h1>
			<p class="mt-1 text-[12px] font-medium text-stone-500" data-testid="calendar-zone">
				Times in {tz}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<div
				class="flex rounded-full border border-stone-200/80 bg-white p-1 shadow-sm"
				role="group"
				aria-label="View"
			>
				{#each ['week', 'month'] as const as view (view)}
					<a
						href={href({ view })}
						data-sveltekit-reset="false"
						aria-current={query.view === view ? 'page' : undefined}
						class="rounded-full px-4 py-1.5 text-[13px] font-bold capitalize transition-colors {query.view ===
						view
							? 'bg-stone-900 text-white'
							: 'text-stone-600 hover:text-stone-900'}">{view}</a
					>
				{/each}
			</div>
		</div>
	</div>

	<div class="mb-4 flex flex-wrap items-center gap-2">
		<a
			href={href({ date: shiftAnchor(query.view, query.date, -1) })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Previous {query.view}"
		>
			<ChevronLeft class="h-4 w-4" />
		</a>
		<a
			href={href({ date: data.today })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Go to today">Today</a
		>
		<a
			href={href({ date: shiftAnchor(query.view, query.date, 1) })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Next {query.view}"
		>
			<ChevronRight class="h-4 w-4" />
		</a>
		<h2
			class="order-first w-full min-w-0 truncate text-[15px] font-extrabold tracking-tight text-stone-900 md:order-none md:ml-2 md:w-auto md:flex-1"
			aria-live="polite"
		>
			{rangeLabel(query.view, data.range, query.date)}
		</h2>
		<button
			type="button"
			class="{navButton} ml-auto md:hidden"
			aria-expanded={filtersOpen}
			aria-controls="calendar-filters"
			onclick={() => (filtersOpen = !filtersOpen)}
		>
			<SlidersHorizontal class="h-4 w-4" />
			<span class="ml-1.5"
				>Filter{filterActive ? ` (${query.brands.length + query.channels.length})` : ''}</span
			>
		</button>
	</div>

	<div
		id="calendar-filters"
		class="mb-5 space-y-2 {filtersOpen ? '' : 'hidden'} md:block"
		data-testid="calendar-filters"
	>
		<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by brand">
			<button
				type="button"
				class="{chip} {filterActive ? chipOff : chipOn}"
				aria-pressed={!filterActive}
				onclick={() => go({ brands: [], channels: [] })}>All</button
			>
			{#each data.brands as brand (brand.slug)}
				{@const on = query.brands.includes(brand.slug)}
				<button
					type="button"
					class="{chip} {on ? chipOn : chipOff}"
					aria-pressed={on}
					data-testid="brand-filter-{brand.slug}"
					onclick={() => go({ brands: toggleValue(query.brands, brand.slug) })}
				>
					<span
						class="h-2.5 w-2.5 rounded-full ring-2 ring-white/70"
						style="background-color: {brand.color}"
						aria-hidden="true"
					></span>
					{brand.name}
				</button>
			{/each}
			<button
				type="button"
				class="{chip} {query.cancelled ? chipOn : chipOff}"
				aria-pressed={query.cancelled}
				onclick={() => go({ cancelled: !query.cancelled })}>Show cancelled</button
			>
		</div>
		{#if pickableChannels.length > 1}
			<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by channel">
				{#each pickableChannels as channel (channel.connectionId)}
					{@const on = query.channels.includes(channel.key)}
					<button
						type="button"
						class="{chip} {on ? chipOn : chipOff}"
						aria-pressed={on}
						title={channel.key}
						aria-label="{channel.brand.name} {channel.platformName} {displayAt(channel.handle)}"
						data-testid="channel-filter-{channel.key}"
						onclick={() => go({ channels: toggleValue(query.channels, channel.key) })}
					>
						<span style="color: {on ? 'currentColor' : channel.brand.color}">
							<PlatformLogo platform={channel.platform} size={12} />
						</span>
						<span class="max-w-36 truncate"
							>{channel.handle ? displayAt(channel.handle) : channel.platformName}</span
						>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if data.loadFailed}
		<p
			class="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-[13px] font-medium text-red-800"
			role="alert"
		>
			The calendar could not load. Reload the page to try again.
		</p>
	{:else if data.truncated}
		<p class="mb-4 rounded-2xl bg-amber-50 px-4 py-3 text-[13px] font-medium text-amber-900">
			Showing the first {data.items.length} posts in this range. Filter by brand or channel to see the
			rest.
		</p>
	{/if}

	<div class="lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-6">
		<div class="min-w-0">
			<!-- Grid views: tablet and up. A phone gets the agenda below. -->
			<div
				class="hidden md:block"
				bind:this={gridEl}
				onkeydown={onGridKeydown}
				role="presentation"
				data-testid="calendar-grid"
			>
				{#if query.view === 'week'}
					<div
						class="relative max-h-[70dvh] overflow-y-auto rounded-[1.25rem] border border-stone-200/80 bg-white shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)]"
						bind:this={weekScroller}
					>
						<div class="grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]">
							<div class="sticky top-0 z-10 border-b border-stone-200 bg-white"></div>
							{#each days as day (day)}
								<div
									class="sticky top-0 z-10 border-b border-l border-stone-200 bg-white px-1 py-1.5"
								>
									<button
										type="button"
										data-cal-day-btn={day}
										tabindex={day === rovingDay ? 0 : -1}
										aria-label={dayLabel(day)}
										onfocus={() => (focusedDay = day)}
										onclick={() => dayItems(day)[0]?.focus()}
										class="flex w-full flex-col items-center rounded-xl py-1 transition-colors hover:bg-stone-50"
									>
										<span class="text-[11px] font-bold tracking-wide text-stone-500 uppercase"
											>{formatDay(day, 'weekday')}</span
										>
										<span
											class="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-extrabold {day ===
											data.today
												? 'bg-stone-900 text-white'
												: 'text-stone-900'}">{Number(day.slice(8))}</span
										>
									</button>
								</div>
							{/each}
							{#each HOURS as hour (hour)}
								<div
									class="border-b border-stone-100 pt-1 pr-2 text-right text-[10px] font-bold text-stone-400 tabular-nums"
									data-hour-row={hour}
								>
									{formatTime(Date.UTC(2000, 0, 1, hour), 'UTC').replace(':00', '')}
								</div>
								{#each days as day (day)}
									{@const slot = byHour.get(`${day}:${hour}`) ?? []}
									<div
										data-drop-day={day}
										data-drop-hour={hour}
										class="min-h-11 space-y-1 border-b border-l border-stone-100 p-0.5 {isOver(
											day,
											hour
										)
											? 'bg-stone-100 ring-2 ring-stone-900 ring-inset'
											: weekday(day) === 0 || weekday(day) === 6
												? 'bg-stone-50/60'
												: ''}"
									>
										{#each slot as item (item.id)}
											<CalendarChip
												{item}
												timeZone={tz}
												dragging={drag?.item.id === item.id}
												onOpen={openDetail}
												onPointerDown={startPress}
											/>
										{/each}
									</div>
								{/each}
							{/each}
						</div>
					</div>
				{:else}
					<div
						class="overflow-hidden rounded-[1.25rem] border border-stone-200/80 bg-white shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)]"
					>
						<div class="grid grid-cols-7 border-b border-stone-200">
							{#each weeks[0] ?? [] as day (day)}
								<div
									class="py-2 text-center text-[11px] font-bold tracking-wide text-stone-500 uppercase"
									aria-hidden="true"
								>
									{formatDay(day, 'weekday')}
								</div>
							{/each}
						</div>
						{#each weeks as week, w (week[0])}
							<div class="grid grid-cols-7 {w ? 'border-t border-stone-100' : ''}">
								{#each week as day (day)}
									{@const list = byDay.get(day) ?? []}
									{@const inMonth = day.slice(0, 7) === query.date.slice(0, 7)}
									<div
										data-drop-day={day}
										class="flex min-h-28 min-w-0 flex-col gap-1 border-l border-stone-100 p-1 first:border-l-0 {isOver(
											day,
											null
										)
											? 'bg-stone-100 ring-2 ring-stone-900 ring-inset'
											: inMonth
												? ''
												: 'bg-stone-50/70'}"
									>
										<button
											type="button"
											data-cal-day-btn={day}
											tabindex={day === rovingDay ? 0 : -1}
											aria-label={dayLabel(day)}
											onfocus={() => (focusedDay = day)}
											onclick={() => go({ view: 'week', date: day })}
											class="flex h-6 w-6 items-center justify-center self-end rounded-full text-[12px] font-extrabold transition-colors {day ===
											data.today
												? 'bg-stone-900 text-white'
												: inMonth
													? 'text-stone-800 hover:bg-stone-100'
													: 'text-stone-400 hover:bg-stone-100'}"
										>
											{Number(day.slice(8))}
										</button>
										{#each list.slice(0, MONTH_CHIPS) as item (item.id)}
											<CalendarChip
												{item}
												timeZone={tz}
												compact
												dragging={drag?.item.id === item.id}
												onOpen={openDetail}
												onPointerDown={startPress}
											/>
										{/each}
										{#if list.length > MONTH_CHIPS}
											<a
												href={href({ view: 'week', date: day })}
												data-sveltekit-reset="false"
												class="px-1 text-[11px] font-bold text-stone-500 hover:text-stone-900"
												>+{list.length - MONTH_CHIPS} more</a
											>
										{/if}
									</div>
								{/each}
							</div>
						{/each}
					</div>
				{/if}
				<p class="mt-3 text-[11px] font-medium text-stone-500">
					Drag a scheduled post to another {query.view === 'week' ? 'hour or day' : 'day'} to reschedule
					it, or open it and press Reschedule. Arrow keys move between days.
				</p>
			</div>

			<!-- Agenda: phones. -->
			<div class="md:hidden" data-testid="calendar-agenda">
				{#if agendaDays.length}
					<ol class="space-y-5">
						{#each agendaDays as day (day)}
							{@const list = byDay.get(day) ?? []}
							<li>
								<h3
									class="mb-2 flex items-center gap-2 text-[12px] font-extrabold tracking-wide text-stone-500 uppercase"
								>
									{formatDay(day)}
									{#if day === data.today}
										<span
											class="rounded-full bg-stone-900 px-2 py-0.5 text-[10px] text-white normal-case"
											>Today</span
										>
									{/if}
								</h3>
								{#if list.length}
									<ul class="space-y-2">
										{#each list as item (item.id)}
											<li>
												<button
													type="button"
													data-cal-item={item.id}
													onclick={() => openDetail(item)}
													aria-label="{channelName(item)}, {item.retrying
														? 'Retrying'
														: STATUS_LABEL[item.status]}, {formatDateTime(
														item.at,
														tz
													)}: {draftExcerpt(item.text, 80)}"
													class="flex min-h-14 w-full items-start gap-3 rounded-2xl border border-l-4 border-stone-200/80 bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgb(28_25_23/0.04)]"
													style="border-left-color: {item.channel.brand.color}"
												>
													<span
														class="w-14 shrink-0 pt-0.5 text-[12px] font-extrabold text-stone-900 tabular-nums"
														>{formatTime(item.at, tz)}</span
													>
													<span class="min-w-0 flex-1">
														<span
															class="flex items-center gap-1.5 text-[12px] font-bold text-stone-700"
														>
															<span style="color: {item.channel.brand.color}">
																<PlatformLogo platform={item.channel.platform} size={12} />
															</span>
															<span class="truncate"
																>{item.channel.handle
																	? displayAt(item.channel.handle)
																	: item.channel.platformName}</span
															>
															<span class="shrink-0 text-stone-400"
																>· {item.channel.brand.name}</span
															>
														</span>
														<span
															class="mt-0.5 block truncate text-[13px] text-stone-600 {item.status ===
															'cancelled'
																? 'line-through'
																: ''}">{draftExcerpt(item.text.split('\n')[0], 80)}</span
														>
													</span>
													<span class="flex shrink-0 flex-col items-end gap-1 pt-0.5">
														<span
															class="flex items-center gap-1 text-[11px] font-bold text-stone-500"
														>
															<span
																class="h-1.5 w-1.5 rounded-full {STATUS_DOT[item.status]}"
																aria-hidden="true"
															></span>
															{item.retrying ? 'Retrying' : STATUS_LABEL[item.status]}
														</span>
														{#if item.mediaCount}
															<Image class="h-3.5 w-3.5 text-stone-400" aria-hidden="true" />
														{/if}
													</span>
												</button>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="text-[13px] text-stone-400">Nothing planned</p>
								{/if}
							</li>
						{/each}
					</ol>
				{:else}
					<p
						class="rounded-2xl border border-dashed border-stone-200 px-4 py-8 text-center text-[13px] text-stone-500"
					>
						Nothing planned this month.
					</p>
				{/if}
				<p class="mt-4 text-[11px] font-medium text-stone-500">
					Tap a post to see it, reschedule, cancel or retry.
				</p>
			</div>

			<ul class="mt-4 flex flex-wrap gap-x-4 gap-y-1" aria-label="Status legend">
				{#each CALENDAR_STATUSES as status (status)}
					<li class="flex items-center gap-1.5 text-[11px] font-medium text-stone-500">
						<span class="h-1.5 w-1.5 rounded-full {STATUS_DOT[status]}" aria-hidden="true"></span>
						{STATUS_LABEL[status]}
					</li>
				{/each}
			</ul>
		</div>

		<aside class="mt-8 lg:mt-0">
			{@render unscheduledList()}
			<a
				href="/compose"
				class="mt-4 inline-flex min-h-10 items-center gap-1.5 rounded-full bg-stone-100 px-4 text-[13px] font-bold text-stone-800 transition-colors hover:bg-stone-200"
			>
				<PenLine class="h-4 w-4" /> New post
			</a>
		</aside>
	</div>
</div>

{#if drag}
	<div
		class="pointer-events-none fixed z-50 max-w-56 -translate-x-1/2 -translate-y-full rounded-xl border border-l-4 border-stone-300 bg-white px-3 py-2 text-[12px] font-bold text-stone-800 shadow-xl"
		style="left: {drag.x}px; top: {drag.y - 8}px; border-left-color: {drag.item.channel.brand
			.color}"
		aria-hidden="true"
	>
		{#if drag.over}
			{formatDateTime(droppedInstant(drag.item.at, drag.over, tz), tz)}
		{:else}
			{channelName(drag.item)}
		{/if}
	</div>
{/if}

{#if openItem}
	<CalendarDetail
		item={openItem}
		media={data.media[openItem.draftId] ?? []}
		timeZone={tz}
		{busy}
		error={detailError}
		onClose={() => (openId = null)}
		onReschedule={(item, runAt) => reschedule(item, runAt, false)}
		onCancel={(item) => (pendingCancel = item)}
		onRetry={retry}
	/>
{/if}

{#snippet moveDetails()}
	{#if pendingMove}
		<dl class="space-y-1.5 rounded-2xl bg-stone-50 px-3 py-2.5 text-[13px]">
			<div class="flex items-center gap-2 font-bold text-stone-800">
				<span style="color: {pendingMove.item.channel.brand.color}">
					<PlatformLogo platform={pendingMove.item.channel.platform} size={13} />
				</span>
				{channelName(pendingMove.item)}
			</div>
			<div class="flex gap-2">
				<dt class="w-10 shrink-0 font-bold text-stone-500">From</dt>
				<dd class="text-stone-500 line-through">{formatDateTime(pendingMove.from, tz)}</dd>
			</div>
			<div class="flex gap-2">
				<dt class="w-10 shrink-0 font-bold text-stone-500">To</dt>
				<dd class="font-bold text-stone-900">{formatDateTime(pendingMove.to, tz)}</dd>
			</div>
		</dl>
	{/if}
{/snippet}

<ConfirmDialog
	open={pendingMove !== null}
	title="Reschedule this post?"
	details={moveDetails}
	confirmLabel="Reschedule"
	cancelLabel="Keep time"
	tone="primary"
	{busy}
	idPrefix="calendar-move"
	onConfirm={confirmMove}
	onCancel={() => (pendingMove = null)}
/>

<ConfirmDialog
	open={pendingCancel !== null}
	title={pendingCancel?.status === 'failed'
		? 'Remove this account from the post?'
		: 'Cancel this post?'}
	body={pendingCancel
		? `${channelName(pendingCancel)} will not publish it. The other accounts on the post are not touched.`
		: null}
	confirmLabel={pendingCancel?.status === 'failed' ? 'Remove' : 'Cancel post'}
	cancelLabel="Keep"
	{busy}
	idPrefix="calendar-cancel"
	onConfirm={confirmCancel}
	onCancel={() => (pendingCancel = null)}
/>

{#if undo}
	<div
		class="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-stone-200/80 bg-white/95 py-2 pr-2 pl-4 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.25)] backdrop-blur-xl"
		role="status"
		data-testid="calendar-undo"
	>
		<span class="truncate text-[13px] font-bold text-stone-700">{undo.label}</span>
		<button
			type="button"
			onclick={runUndo}
			class="shrink-0 rounded-full bg-stone-900 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-stone-700"
			>Undo</button
		>
	</div>
{/if}
