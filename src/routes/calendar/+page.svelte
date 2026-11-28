<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import {
		CalendarClock,
		CalendarRange,
		ChevronLeft,
		ChevronRight,
		Copy,
		Ellipsis,
		FileText,
		Play,
		ExternalLink,
		Eye,
		Image,
		ListChecks,
		PenLine,
		RotateCcw,
		ShieldCheck,
		ShieldX,
		SlidersHorizontal,
		Check,
		SquareCheck,
		Trash2,
		X
	} from '@lucide/svelte';
	import CalendarPreview from '#lib/components/calendar/CalendarPreview.svelte';
	import { thumbOf } from '#lib/components/calendar/thumb.js';
	import CalendarActionMenu, {
		type MenuAction
	} from '#lib/components/calendar/CalendarActionMenu.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import CalendarChip, { STATUS_DOT } from '#lib/components/calendar/CalendarChip.svelte';
	import CalendarDetail from '#lib/components/calendar/CalendarDetail.svelte';
	import type { ViewItem } from '#lib/components/calendar/types.js';
	import {
		boxBetween,
		boxesOverlap,
		bulkPlan,
		rangeBetween,
		rescheduleCalls,
		spreadMoves
	} from '#lib/domain/calendar-selection.js';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { showToast } from '#lib/components/toast.svelte.js';
	import {
		addDays,
		addMonths,
		CALENDAR_STATUSES,
		calendarHref,
		canMove,
		droppedInstant,
		formatDateTime,
		formatDay,
		formatTime,
		monthStart,
		weekStart,
		rangeLabel,
		reschedulePayload,
		shiftAnchor,
		STATUS_LABEL,
		toggleValue,
		weekday,
		zonedParts,
		type CalendarItem,
		type CalendarMedia,
		type CalendarQuery
	} from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { draftExcerpt } from '#lib/domain/excerpt.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import { formatRelativeTime } from '#lib/domain/relative-time.js';
	import { browserTimeZone } from '#lib/domain/time-zone.js';

	let { data } = $props();

	// The scrolling month view's weeks on the page, and the posts it fetched past the page's own.
	let renderStart = $state('');
	let renderEnd = $state('');
	let extraItems = $state<CalendarItem[]>([]);
	let extraMedia = $state<Record<string, CalendarMedia[]>>({});

	const tz = $derived(data.timeZone);
	const query = $derived(data.query);
	const days = $derived(
		query.view === 'month' && renderStart ? daysBetween(renderStart, renderEnd) : data.range.days
	);
	const HOURS = Array.from({ length: 24 }, (_, h) => h);
	const MONTH_CHIPS = 3;
	const monthName = (day: string) =>
		new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(
			Date.parse(`${day}T12:00:00Z`)
		);

	function daysBetween(from: string, to: string): string[] {
		const out: string[] = [];
		for (let day = from; day < to; day = addDays(day, 1)) out.push(day);
		return out;
	}

	const channelById = $derived(new Map(data.channels.map((c) => [c.connectionId, c])));
	// The page's own posts, plus those the scrolling month fetched for weeks past them.
	const allItems = $derived.by(() => {
		if (!extraItems.length) return data.items;
		const own = new Set(data.items.map((i) => i.id));
		return [...data.items, ...extraItems.filter((i) => !own.has(i.id))];
	});
	const media = $derived<Record<string, CalendarMedia[]>>(
		Object.keys(extraMedia).length ? { ...extraMedia, ...data.media } : data.media
	);
	const items = $derived<ViewItem[]>(
		allItems.flatMap((item) => {
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
	// Open posting slots: a hint of where an agent's next post would go.
	const openSlots = $derived(
		(data.openSlots ?? []).flatMap((slot) => {
			const channel = channelById.get(slot.connectionId);
			if (!channel) return [];
			const { key, minutes } = zonedParts(slot.at, tz);
			return [{ ...slot, channel, day: key, hour: Math.floor(minutes / 60) }];
		})
	);
	const slotsByHour = $derived.by(() => {
		const map = new Map<string, typeof openSlots>();
		for (const slot of openSlots) {
			const key = `${slot.day}:${slot.hour}`;
			map.set(key, [...(map.get(key) ?? []), slot]);
		}
		return map;
	});
	const slotsByDay = $derived.by(() => {
		const map = new Map<string, number>();
		for (const slot of openSlots) map.set(slot.day, (map.get(slot.day) ?? 0) + 1);
		return map;
	});
	const weeks = $derived(
		Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7))
	);
	// Hours nothing sits in stay short, so a week reads without scrolling past empty rows.
	const busyHours = $derived(
		new Set([...items.map((i) => i.hour), ...openSlots.map((slot) => slot.hour)])
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

	// The month view scrolls without ever reloading the page. Weeks are added
	// well before they come into view, as empty rows straight away, and their
	// posts are fetched in the background and merged in; the address follows the
	// month in view so a reload or a shared link opens the same place.
	let monthScroller = $state<HTMLDivElement | null>(null);
	let monthHeader = $state<HTMLDivElement | null>(null);
	// Empty until the grid has placed itself; the title falls back to the address.
	let visibleMonth = $state('');
	const pending = new SvelteSet<string>();
	let covered = { start: '', end: '' };
	let fetchGen = 0;
	let filterKey = '';
	let lastView = '';
	let placeOnLoad = true;
	let readFrame = 0;
	let urlTimer: ReturnType<typeof setTimeout> | null = null;
	const shownMonth = $derived(visibleMonth || monthStart(query.date));
	const headerLabel = $derived(
		rangeLabel(
			query.view,
			data.range,
			query.view === 'month' && visibleMonth ? visibleMonth : query.date
		)
	);
	/** Weeks added past either end at a time, and how close to an end that happens. */
	const GROW_DAYS = 63;
	const GROW_WITHIN_WEEKS = 6;

	function activeScroller(): HTMLDivElement | null {
		return weekScroller ?? monthScroller;
	}

	function weekRowAt(y: number): HTMLElement | null {
		const rows = monthScroller?.querySelectorAll<HTMLElement>('[data-week]') ?? [];
		for (const row of rows) if (row.offsetTop + row.offsetHeight > y) return row;
		return null;
	}

	function isPending(day: string): boolean {
		for (const range of pending) {
			const [from, to] = range.split('|');
			if (day >= from && day < to) return true;
		}
		return false;
	}

	/** The range route reads at most 100 days a call. */
	function spans(from: string, to: string): [string, string][] {
		const out: [string, string][] = [];
		for (let day = from; day < to; day = addDays(day, 98)) {
			const next = addDays(day, 98);
			out.push([day, next < to ? next : to]);
		}
		return out;
	}

	async function fetchRange(from: string, to: string) {
		const params = new URL(href({}), location.origin).searchParams;
		params.set('start', from);
		params.set('end', to);
		const res = await fetch(`/api/calendar?${params}`);
		if (!res.ok) throw new Error(`calendar range ${res.status}`);
		return (await res.json()) as {
			items: CalendarItem[];
			media: Record<string, CalendarMedia[]>;
		};
	}

	function mergeExtra(found: CalendarItem[], foundMedia: Record<string, CalendarMedia[]>) {
		const seen = new Set(extraItems.map((i) => i.id));
		extraItems = [...extraItems, ...found.filter((i) => !seen.has(i.id))];
		extraMedia = { ...extraMedia, ...foundMedia };
	}

	function loadSpan(from: string, to: string) {
		if (from >= to) return;
		const gen = fetchGen;
		for (const [a, b] of spans(from, to)) {
			const key = `${a}|${b}`;
			pending.add(key);
			fetchRange(a, b)
				.then((found) => {
					if (gen === fetchGen) mergeExtra(found.items, found.media);
				})
				.catch(() => {
					// A failed span stays empty; the next reload of the page fills it.
				})
				.finally(() => pending.delete(key));
		}
	}

	async function growStart() {
		const box = monthScroller;
		if (!box) return;
		const top = weekRowAt(box.scrollTop + (monthHeader?.offsetHeight ?? 0));
		const key = top?.dataset.week;
		const offset = top ? top.offsetTop - box.scrollTop : 0;
		const from = addDays(renderStart, -GROW_DAYS);
		renderStart = from;
		// Rows added above push everything down; put the same week back under the eye.
		await tick();
		const row = key ? box.querySelector<HTMLElement>(`[data-week="${key}"]`) : null;
		if (row) box.scrollTop = row.offsetTop - offset;
		if (from < covered.start) {
			loadSpan(from, covered.start);
			covered.start = from;
		}
	}

	function growEnd() {
		const to = addDays(renderEnd, GROW_DAYS);
		renderEnd = to;
		if (to > covered.end) {
			loadSpan(covered.end, to);
			covered.end = to;
		}
	}

	function growIfNear() {
		const box = monthScroller;
		const row = box?.querySelector<HTMLElement>('[data-week]');
		if (!box || !row) return;
		const rowHeight = row.offsetHeight || 112;
		const below = (box.scrollHeight - box.scrollTop - box.clientHeight) / rowHeight;
		if (below < GROW_WITHIN_WEEKS) growEnd();
		// Growing upward moves the scroll position, which would cut a glide short.
		if (!gliding && box.scrollTop / rowHeight < GROW_WITHIN_WEEKS) void growStart();
	}

	// While a glide runs nothing above it changes.
	let gliding: ReturnType<typeof setTimeout> | null = null;

	function endGlide() {
		if (!gliding) return;
		clearTimeout(gliding);
		gliding = null;
		readVisibleMonth();
	}

	function scrollToDay(day: string, behavior: ScrollBehavior): boolean {
		const box = monthScroller;
		const row = box?.querySelector<HTMLElement>(`[data-week="${weekStart(day)}"]`);
		// Hidden on a phone, where the agenda shows instead.
		if (!box || !row || box.offsetParent === null) return false;
		if (behavior === 'smooth') {
			if (gliding) clearTimeout(gliding);
			// scrollend is not everywhere yet; the timeout is the fallback.
			gliding = setTimeout(endGlide, 900);
			box.addEventListener('scrollend', endGlide, { once: true });
		}
		box.scrollTo({ top: row.offsetTop - (monthHeader?.offsetHeight ?? 0), behavior });
		return true;
	}

	function readVisibleMonth() {
		const box = monthScroller;
		if (!box) return;
		const head = monthHeader?.offsetHeight ?? 0;
		// A third of the way down is where the eye rests; that week names the month.
		const row = weekRowAt(box.scrollTop + head + (box.clientHeight - head) / 3);
		if (row?.dataset.mid) {
			const month = monthStart(row.dataset.mid);
			if (month !== visibleMonth) {
				visibleMonth = month;
				if (urlTimer) clearTimeout(urlTimer);
				// The address only: no load runs, so nothing on screen waits for it.
				urlTimer = setTimeout(() => replaceState(href({ date: month }), page.state), 300);
			}
		}
		growIfNear();
	}

	function onMonthScroll() {
		if (readFrame) return;
		readFrame = requestAnimationFrame(() => {
			readFrame = 0;
			readVisibleMonth();
		});
	}

	// New page data: a fresh month (first visit, a filter, a jump past the loaded
	// weeks) starts over at its first week; a reload of the same view after an
	// action keeps the weeks on screen and refreshes the ones it fetched itself.
	$effect(() => {
		const d = data;
		untrack(() => {
			const cameFromWeek = lastView !== 'month';
			lastView = d.query.view;
			if (d.query.view !== 'month') return;
			const key = `${d.query.brands}|${d.query.channels}|${d.query.cancelled}`;
			const apart = !renderStart || d.range.end < renderStart || d.range.start > renderEnd;
			if (key !== filterKey || placeOnLoad || cameFromWeek || apart) {
				filterKey = key;
				placeOnLoad = false;
				fetchGen++;
				pending.clear();
				renderStart = d.range.start;
				renderEnd = d.range.end;
				covered = { start: d.range.start, end: d.range.end };
				extraItems = [];
				extraMedia = {};
				const target = monthStart(d.query.date);
				visibleMonth = target;
				void tick().then(() => scrollToDay(target, 'instant'));
				return;
			}
			if (d.range.start < renderStart) renderStart = d.range.start;
			if (d.range.end > renderEnd) renderEnd = d.range.end;
			covered = { start: renderStart, end: renderEnd };
			const gen = ++fetchGen;
			const outside = [...spans(renderStart, d.range.start), ...spans(d.range.end, renderEnd)];
			void Promise.all(outside.map(([a, b]) => fetchRange(a, b)))
				.then((parts) => {
					if (gen !== fetchGen) return;
					extraItems = parts.flatMap((p) => p.items);
					extraMedia = Object.assign({}, ...parts.map((p) => p.media));
				})
				.catch(() => {});
		});
	});

	onDestroy(() => {
		if (readFrame) cancelAnimationFrame(readFrame);
		if (gliding) clearTimeout(gliding);
		if (urlTimer) clearTimeout(urlTimer);
	});

	/** Arrows and Today glide through the weeks on the page; past them the month loads afresh. */
	function stepMonth(event: MouseEvent, day: string) {
		if (query.view !== 'month' || scrollToDay(day, 'smooth')) {
			if (query.view === 'month') event.preventDefault();
			return;
		}
		if (monthScroller?.offsetParent === null) return;
		event.preventDefault();
		placeOnLoad = true;
		void go({ date: monthStart(day) });
	}

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
			placeOnLoad = true;
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
			case 'PageDown': {
				const step = event.key === 'PageUp' ? -1 : 1;
				const month = addMonths(shownMonth, step);
				if (query.view !== 'month' || !scrollToDay(month, 'smooth')) {
					placeOnLoad = true;
					void go({
						date: query.view === 'month' ? month : shiftAnchor(query.view, query.date, step)
					});
				}
				break;
			}
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

	function channelName(item: Pick<ViewItem, 'channel'>): string {
		const handle = item.channel.handle ? ` ${displayAt(item.channel.handle)}` : '';
		return `${item.channel.brand.name} · ${item.channel.platformName}${handle}`;
	}

	type Move = { id: string; to: number };
	type Undo = { moves: Move[]; label: string };
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
		const problem = await bulk(
			reschedulePayload([item.id], runAt, true),
			'Could not reschedule'
		).finally(() => (busy = false));
		if (problem) {
			if (fromDrag) showToast(problem, 'error');
			else detailError = problem;
			return false;
		}
		// Moving back is itself a reschedule, so it needs the old time to still be ahead.
		const undoable = canMove(item.status) && from > Date.now() + 60_000;
		offerUndo(
			undoable
				? {
						moves: [{ id: item.id, to: from }],
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
		const problem = await applyMoves(current.moves, 'Could not undo');
		if (problem) showToast(problem, 'error');
		else
			showToast(
				current.moves.length === 1
					? `Moved back to ${formatDateTime(current.moves[0].to, tz)}`
					: `Moved ${current.moves.length} posts back`
			);
		await invalidateAll();
	}

	/** Reschedules each item to its own instant, one call per shared minute; the first problem, else null. */
	async function applyMoves(moves: Move[], fallback: string): Promise<string | null> {
		let problem: string | null = null;
		for (const call of rescheduleCalls(moves)) {
			problem = (await bulk(reschedulePayload(call.ids, call.runAt, true), fallback)) ?? problem;
		}
		return problem;
	}

	/** The bulk route takes ten ids a call; the first problem, else null. */
	async function inChunks(
		op: 'cancel' | 'retry',
		ids: string[],
		fallback: string
	): Promise<string | null> {
		let problem: string | null = null;
		for (let i = 0; i < ids.length; i += 10) {
			problem = (await bulk({ op, ids: ids.slice(i, i + 10) }, fallback)) ?? problem;
		}
		return problem;
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
		if (!canMove(item.status) || item.channel.status !== 'active') return;
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
		const scroller = activeScroller();
		if (scroller) {
			const box = scroller.getBoundingClientRect();
			if (event.clientY < box.top + 48) scroller.scrollTop -= 16;
			else if (event.clientY > box.bottom - 48) scroller.scrollTop += 16;
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
		if (selected.has(item.id) && plan.move.length > 1) {
			proposeShift(to - item.at);
			return;
		}
		if (to <= Date.now()) {
			showToast('That time has already passed', 'warn');
			return;
		}
		// No confirmation: the move is instant and Undo stays up for a few seconds.
		void reschedule(item, to, true).then((done) => {
			if (done) openId = null;
		});
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && drag) {
			endPress();
			return;
		}
		if (event.key === 'Escape' && marquee) {
			endMarquee();
			return;
		}
		if (event.key === 'Escape' && (moveMenuOpen || itemMenu || moreMenu || filterMenuOpen)) {
			moveMenuOpen = false;
			itemMenu = null;
			moreMenu = null;
			filterMenuOpen = false;
			return;
		}
		const dialogOpen = openItem || previewItem || pendingCancel || bulkConfirm;
		if (event.key === 'Escape' && selected.size && !dialogOpen) {
			event.preventDefault();
			clearSelection();
			return;
		}
		const typing = (event.target as HTMLElement | null)?.closest(
			'input, textarea, select, [contenteditable]'
		);
		if ((event.metaKey || event.ctrlKey) && event.key === 'a' && !typing && !dialogOpen) {
			event.preventDefault();
			for (const item of items) selected.add(item.id);
		}
	}

	// Selection: drag across empty grid, Shift/Ctrl/Cmd-click a post, or Select mode (taps).
	const selected = new SvelteSet<string>();
	let selectMode = $state(false);
	const selectedItems = $derived(items.filter((i) => selected.has(i.id)));
	const plan = $derived(
		bulkPlan(
			selectedItems.map((i) => ({
				id: i.id,
				status: i.status,
				at: i.at,
				channelStatus: i.channel.status
			})),
			Date.now()
		)
	);
	const statusCounts = $derived.by(() => {
		const counts = new Map<string, string[]>();
		// The month view holds three months; the counts are for the one in view.
		const inView =
			query.view === 'month'
				? items.filter((i) => i.day.slice(0, 7) === shownMonth.slice(0, 7))
				: items;
		for (const item of inView)
			counts.set(item.status, [...(counts.get(item.status) ?? []), item.id]);
		return CALENDAR_STATUSES.filter((s) => counts.has(s)).map((status) => ({
			status,
			ids: counts.get(status)!
		}));
	});

	// A post that left the range (moved, cancelled out of view) leaves the selection too.
	$effect(() => {
		const present = new Set(items.map((i) => i.id));
		for (const id of [...selected]) if (!present.has(id)) selected.delete(id);
	});

	function clearSelection() {
		selected.clear();
		selectMode = false;
		moveMenuOpen = false;
		moreMenu = null;
		anchorId = null;
	}

	function toggleSelected(id: string) {
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
		anchorId = id;
	}

	// Shift-click selects everything between the last post picked and this one, in time order.
	let anchorId = $state<string | null>(null);
	const ordered = $derived(
		[...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((i) => i.id)
	);

	function selectRange(id: string) {
		if (!anchorId || !selected.has(anchorId)) {
			toggleSelected(id);
			return;
		}
		for (const each of rangeBetween(ordered, anchorId, id)) selected.add(each);
	}

	function selectOnly(ids: string[]) {
		selected.clear();
		for (const id of ids) selected.add(id);
	}

	function onItemClick(item: ViewItem, trigger: HTMLElement | null, event: MouseEvent) {
		if (suppressClick) return;
		if (event.shiftKey) {
			selectRange(item.id);
			return;
		}
		if (selectMode || event.metaKey || event.ctrlKey) {
			toggleSelected(item.id);
			return;
		}
		previewId = item.id;
	}

	// A plain click shows the post the way a viewer sees it; its actions sit under it.
	let previewId = $state<string | null>(null);
	const previewItem = $derived(previewId ? (items.find((i) => i.id === previewId) ?? null) : null);

	const SHORT_LABEL: Record<string, string> = { edit: 'Edit', view: 'Open post' };

	function previewActions(item: ViewItem): MenuAction[] {
		const all = itemMenuActions(item);
		return ['edit', 'approve', 'retry', 'view', 'details']
			.map((key) => all.find((a) => a.key === key))
			.filter((a): a is MenuAction => Boolean(a))
			.slice(0, 3)
			.map((a) => ({
				...a,
				label: SHORT_LABEL[a.key] ?? a.label,
				onSelect: () => {
					previewId = null;
					a.onSelect();
				}
			}));
	}

	// A click on one post offers what can be done with it, each with an icon, instead of
	// opening the drawer straight away; Details is the first choice.
	let itemMenu = $state<{ item: ViewItem; x: number; y: number } | null>(null);

	function openItemMenu(item: ViewItem, event: MouseEvent, trigger?: HTMLElement | null) {
		// A keyboard press reports (0, 0): open beside the post instead.
		let { clientX: x, clientY: y } = event;
		if (!x && !y && (trigger ?? event.currentTarget)) {
			const box = ((trigger ?? event.currentTarget) as HTMLElement).getBoundingClientRect();
			x = box.left;
			y = box.bottom + 4;
		}
		itemMenu = { item, x, y };
	}

	function itemMenuActions(item: ViewItem): MenuAction[] {
		const plan1 = bulkPlan(
			[{ id: item.id, status: item.status, at: item.at, channelStatus: item.channel.status }],
			Date.now()
		);
		const list: MenuAction[] = [
			{ key: 'details', label: 'Details', icon: Eye, onSelect: () => openDetail(item) },
			{
				key: 'edit',
				label: 'Edit in composer',
				icon: PenLine,
				onSelect: () => goto(`/compose?id=${encodeURIComponent(item.draftId)}`)
			}
		];
		if (plan1.approve.length)
			list.push({
				key: 'approve',
				label: 'Approve',
				icon: ShieldCheck,
				tone: 'primary',
				hint: plan1.approveNow.length ? 'Its time has passed: it publishes now' : undefined,
				onSelect: () => startApprove(plan1.approve, plan1.approveNow)
			});
		if (plan1.reject.length)
			list.push({
				key: 'reject',
				label: 'Reject',
				icon: ShieldX,
				onSelect: () => (bulkConfirm = { kind: 'reject', ids: plan1.reject })
			});
		if (plan1.move.length)
			list.push({
				key: 'reschedule',
				label: 'Reschedule',
				icon: CalendarClock,
				onSelect: () => openDetail(item)
			});
		if (plan1.retry.length)
			list.push({ key: 'retry', label: 'Retry', icon: RotateCcw, onSelect: () => retry(item) });
		list.push({
			key: 'duplicate',
			label: 'Duplicate as draft',
			icon: Copy,
			onSelect: () => duplicateDrafts([item.draftId])
		});
		if (item.remoteUrl)
			list.push({
				key: 'view',
				label: 'View on ' + item.channel.platformName,
				icon: ExternalLink,
				onSelect: () => window.open(item.remoteUrl!, '_blank', 'noopener')
			});
		list.push({
			key: 'select',
			label: selected.has(item.id) ? 'Unselect' : 'Select',
			icon: SquareCheck,
			hint: selected.has(item.id) ? undefined : 'Shift-click picks a range',
			onSelect: () => toggleSelected(item.id)
		});
		if (plan1.cancel.length)
			list.push({
				key: 'cancel',
				label: item.status === 'failed' ? 'Remove' : 'Cancel post',
				icon: Trash2,
				tone: 'danger',
				onSelect: () => (pendingCancel = item)
			});
		return list;
	}

	type Point = { x: number; y: number };
	let marquee = $state<{
		start: Point;
		current: Point;
		scrollStart: number;
		base: string[];
		moved: boolean;
	} | null>(null);

	function onGridPointerDown(event: PointerEvent) {
		if (event.pointerType !== 'mouse' || event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (target.closest('[data-cal-item], button, a, input')) return;
		if (!target.closest('[data-drop-day]')) return;
		// Keeps the browser from starting a text selection across the grid.
		event.preventDefault();
		const additive = event.shiftKey || event.metaKey || event.ctrlKey;
		marquee = {
			start: { x: event.clientX, y: event.clientY },
			current: { x: event.clientX, y: event.clientY },
			scrollStart: activeScroller()?.scrollTop ?? 0,
			base: additive ? [...selected] : [],
			moved: false
		};
		window.addEventListener('pointermove', onMarqueeMove);
		window.addEventListener('pointerup', onMarqueeUp);
		window.addEventListener('pointercancel', endMarquee);
	}

	// The start point is anchored to the content, so autoscrolling stretches the box.
	const marqueeBox = $derived.by(() => {
		if (!marquee?.moved) return null;
		const drift = (activeScroller()?.scrollTop ?? 0) - marquee.scrollStart;
		return boxBetween({ x: marquee.start.x, y: marquee.start.y - drift }, marquee.current);
	});

	function onMarqueeMove(event: PointerEvent) {
		if (!marquee) return;
		marquee.current = { x: event.clientX, y: event.clientY };
		if (!marquee.moved) {
			const dist = Math.hypot(event.clientX - marquee.start.x, event.clientY - marquee.start.y);
			if (dist < 5) return;
			marquee.moved = true;
		}
		const scroller = activeScroller();
		if (scroller) {
			const box = scroller.getBoundingClientRect();
			if (event.clientY < box.top + 40) scroller.scrollTop -= 14;
			else if (event.clientY > box.bottom - 40) scroller.scrollTop += 14;
		}
		const area = marqueeBox;
		if (!area) return;
		const hits = Array.from(gridEl?.querySelectorAll<HTMLElement>('[data-cal-item]') ?? [])
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return boxesOverlap(area, { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
			})
			.map((el) => el.dataset.calItem!);
		selectOnly([...new Set([...marquee.base, ...hits])]);
	}

	function onMarqueeUp() {
		// A plain click on an empty cell clears the selection, as in a file manager.
		if (marquee && !marquee.moved && !marquee.base.length) selected.clear();
		endMarquee();
	}

	function endMarquee() {
		marquee = null;
		window.removeEventListener('pointermove', onMarqueeMove);
		window.removeEventListener('pointerup', onMarqueeUp);
		window.removeEventListener('pointercancel', endMarquee);
	}
	onMount(() => endMarquee);

	let bulkBusy = $state(false);
	let moveMenuOpen = $state(false);
	let moveDate = $state('');

	type BulkConfirm = { kind: 'approve-now' | 'reject' | 'cancel'; ids: string[] };
	let bulkConfirm = $state<BulkConfirm | null>(null);
	let rejectNote = $state('');

	function count(n: number, word = 'post'): string {
		return `${n} ${word}${n === 1 ? '' : 's'}`;
	}

	function proposeShift(delta: number) {
		const moving = selectedItems.filter((i) => plan.move.includes(i.id));
		const moves = moving.map((i) => ({ id: i.id, to: i.at + delta }));
		if (!moves.length || delta === 0) return;
		if (moves.some((m) => m.to <= Date.now())) {
			showToast('That would put a post in the past', 'warn');
			return;
		}
		moveMenuOpen = false;
		void runMoves(moves);
	}

	function proposeMoveToDay(day: string) {
		if (!day) return;
		const moving = selectedItems.filter((i) => plan.move.includes(i.id));
		const moves = moving.map((i) => ({ id: i.id, to: droppedInstant(i.at, { day }, tz) }));
		if (moves.some((m) => m.to <= Date.now())) {
			showToast('That would put a post in the past', 'warn');
			return;
		}
		moveMenuOpen = false;
		void runMoves(moves);
	}

	/** Moves at once, with Undo for whatever can still go back to a time that has not passed. */
	async function runMoves(moves: Move[], verb = 'Moved') {
		if (!moves.length) return;
		bulkBusy = true;
		const before = new Map(items.map((i) => [i.id, i.at]));
		const problem = await applyMoves(moves, 'Could not reschedule').finally(
			() => (bulkBusy = false)
		);
		if (problem) showToast(problem, 'error');
		else {
			const back = moves
				.map((m) => ({ id: m.id, to: before.get(m.id)! }))
				.filter((m) => m.to > Date.now() + 60_000);
			offerUndo(back.length ? { moves: back, label: `${verb} ${count(moves.length)}` } : null);
			if (!back.length) showToast(`${verb} ${count(moves.length)}`);
		}
		await invalidateAll();
	}

	async function postReview(
		path: 'approve' | 'reject',
		body: Record<string, unknown>
	): Promise<string | null> {
		try {
			const res = await fetch(`/api/review/${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (sessionExpiredIfUnauthorized(res)) return 'Signed out';
			const payload = await res.json().catch(() => ({}));
			return res.ok ? null : humanizeError(payload.error || `Could not ${path}`);
		} catch {
			return humanizeError('fetch failed');
		}
	}

	function startApprove(ids = plan.approve, pastIds = plan.approveNow) {
		if (pastIds.length) {
			approveNowCount = pastIds.length;
			bulkConfirm = { kind: 'approve-now', ids };
		} else void approve(ids);
	}
	let approveNowCount = $state(0);

	async function duplicateDrafts(draftIds: string[]) {
		bulkBusy = true;
		let made = 0;
		let problem: string | null = null;
		for (const id of [...new Set(draftIds)]) {
			try {
				const res = await fetch(`/api/drafts/${encodeURIComponent(id)}/duplicate`, {
					method: 'POST'
				});
				if (sessionExpiredIfUnauthorized(res)) {
					problem = 'Signed out';
					break;
				}
				if (res.ok) made++;
				else
					problem = humanizeError(
						(await res.json().catch(() => ({}))).error || 'Could not duplicate'
					);
			} catch {
				problem = humanizeError('fetch failed');
			}
		}
		bulkBusy = false;
		if (made) showToast(`Duplicated ${count(made)} as draft${made === 1 ? '' : 's'}`);
		if (problem) showToast(problem, 'error');
		await invalidateAll();
	}

	function proposeSpread() {
		const moving = selectedItems.filter((i) => plan.move.includes(i.id));
		const moves = spreadMoves(moving, tz);
		if (moves.some((m) => m.to <= Date.now())) {
			showToast('That would put a post in the past', 'warn');
			return;
		}
		void runMoves(moves, 'Spread out');
	}

	// The bar keeps at most two actions in view; the rest sit under More, with icons.
	const bulkActions = $derived.by(() => {
		const n = selected.size;
		const of = (k: number) => (k < n ? `${k} of ${n}` : undefined);
		const list: (MenuAction & { primary?: boolean })[] = [];
		if (plan.approve.length)
			list.push({
				key: 'approve',
				label: 'Approve',
				icon: ShieldCheck,
				tone: 'primary',
				hint: of(plan.approve.length),
				onSelect: () => startApprove()
			});
		if (plan.retry.length)
			list.push({
				key: 'retry',
				label: 'Retry',
				icon: RotateCcw,
				hint: of(plan.retry.length),
				onSelect: retrySelected
			});
		if (plan.move.length)
			list.push({
				key: 'move',
				label: 'Move',
				icon: CalendarClock,
				hint: of(plan.move.length),
				onSelect: () => (moveMenuOpen = true)
			});
		if (plan.reject.length)
			list.push({
				key: 'reject',
				label: 'Reject',
				icon: ShieldX,
				hint: of(plan.reject.length),
				onSelect: () => (bulkConfirm = { kind: 'reject', ids: plan.reject })
			});
		if (plan.move.length > 1)
			list.push({
				key: 'spread',
				label: 'Spread out',
				icon: CalendarRange,
				hint: 'One post a day, same times',
				onSelect: proposeSpread
			});
		list.push({
			key: 'duplicate',
			label: 'Duplicate as drafts',
			icon: Copy,
			hint: 'Copies to reuse later',
			onSelect: () => duplicateDrafts(selectedItems.map((i) => i.draftId))
		});
		if (plan.cancel.length)
			list.push({
				key: 'cancel',
				label: 'Cancel',
				icon: Trash2,
				tone: 'danger',
				hint: of(plan.cancel.length),
				onSelect: () => (bulkConfirm = { kind: 'cancel', ids: plan.cancel })
			});
		return list;
	});
	const barActions = $derived(bulkActions.filter((a) => a.key !== 'cancel').slice(0, 2));
	const moreActions = $derived(bulkActions.filter((a) => !barActions.includes(a)));
	let moreMenu = $state<{ x: number; y: number } | null>(null);
	let movePanel = $state<HTMLDivElement | null>(null);
	$effect(() => {
		if (!moveMenuOpen) return;
		const away = (event: PointerEvent) => {
			if (movePanel && !movePanel.contains(event.target as Node)) moveMenuOpen = false;
		};
		// Next frame, so the click that opened it does not close it.
		const id = requestAnimationFrame(() => window.addEventListener('pointerdown', away, true));
		return () => {
			cancelAnimationFrame(id);
			window.removeEventListener('pointerdown', away, true);
		};
	});
	let filterMenuOpen = $state(false);

	async function approve(ids: string[]) {
		bulkBusy = true;
		const problem = await postReview('approve', { deliveryIds: ids }).finally(
			() => (bulkBusy = false)
		);
		bulkConfirm = null;
		if (problem) showToast(problem, 'error');
		else {
			showToast(`Approved ${count(ids.length)}`);
			for (const id of ids) selected.delete(id);
		}
		await invalidateAll();
	}

	async function confirmBulk() {
		const current = bulkConfirm;
		if (!current) return;
		if (current.kind === 'approve-now') return approve(current.ids);
		bulkBusy = true;
		const problem =
			current.kind === 'reject'
				? await postReview('reject', {
						deliveryIds: current.ids,
						note: rejectNote.trim() || undefined
					})
				: await inChunks('cancel', current.ids, 'Could not cancel');
		bulkBusy = false;
		bulkConfirm = null;
		rejectNote = '';
		if (problem) showToast(problem, 'error');
		else {
			showToast(
				`${current.kind === 'reject' ? 'Rejected' : 'Cancelled'} ${count(current.ids.length)}`
			);
			for (const id of current.ids) selected.delete(id);
		}
		await invalidateAll();
	}

	async function retrySelected() {
		const ids = plan.retry;
		bulkBusy = true;
		const problem = await inChunks('retry', ids, 'Retry failed').finally(() => (bulkBusy = false));
		if (problem) showToast(problem, 'error');
		else showToast(`Retrying ${count(ids.length)}`);
		await invalidateAll();
	}

	const barButton =
		'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold transition-colors disabled:opacity-40';
	const navButton =
		'flex h-10 min-w-10 items-center justify-center rounded-full border border-stone-200/80 bg-white px-3 text-[13px] font-bold text-stone-700 shadow-sm transition-colors hover:border-stone-300 hover:text-stone-900';
	const filterRow =
		'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-50';
	let filterPanel = $state<HTMLDivElement | null>(null);
	$effect(() => {
		if (!filterMenuOpen) return;
		const away = (event: PointerEvent) => {
			const target = event.target as HTMLElement;
			if (filterPanel?.contains(target) || target.closest('[data-testid="calendar-filter-button"]'))
				return;
			filterMenuOpen = false;
		};
		window.addEventListener('pointerdown', away, true);
		return () => window.removeEventListener('pointerdown', away, true);
	});
</script>

<svelte:head>
	<title>Calendar — {headerLabel}</title>
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet filterMenu()}
	<div
		bind:this={filterPanel}
		id="calendar-filters"
		role="dialog"
		aria-label="Filter the calendar"
		class="absolute top-full right-0 z-40 mt-2 max-h-[70dvh] w-72 overflow-y-auto rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.25)]"
		data-testid="calendar-filters"
	>
		<p class="px-2.5 pt-1 pb-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">
			Brands
		</p>
		{#each data.brands as brand (brand.slug)}
			{@const on = query.brands.includes(brand.slug)}
			<button
				type="button"
				role="menuitemcheckbox"
				aria-checked={on}
				class={filterRow}
				data-testid="brand-filter-{brand.slug}"
				onclick={() => go({ brands: toggleValue(query.brands, brand.slug) })}
			>
				<span
					class="h-2.5 w-2.5 shrink-0 rounded-full"
					style="background-color: {brand.color}"
					aria-hidden="true"
				></span>
				<span class="min-w-0 flex-1 truncate">{brand.name}</span>
				{#if on}<Check class="h-4 w-4 shrink-0" aria-hidden="true" />{/if}
			</button>
		{/each}
		{#if pickableChannels.length > 1}
			<p
				class="mt-1 border-t border-stone-100 px-2.5 pt-2.5 pb-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase"
			>
				Accounts
			</p>
			{#each pickableChannels as channel (channel.connectionId)}
				{@const on = query.channels.includes(channel.key)}
				<button
					type="button"
					role="menuitemcheckbox"
					aria-checked={on}
					class={filterRow}
					title={channel.key}
					aria-label="{channel.brand.name} {channel.platformName} {displayAt(channel.handle)}"
					data-testid="channel-filter-{channel.key}"
					onclick={() => go({ channels: toggleValue(query.channels, channel.key) })}
				>
					<span class="shrink-0" style="color: {channel.brand.color}">
						<PlatformLogo platform={channel.platform} size={13} />
					</span>
					<span class="min-w-0 flex-1 truncate"
						>{channel.handle ? displayAt(channel.handle) : channel.platformName}</span
					>
					{#if on}<Check class="h-4 w-4 shrink-0" aria-hidden="true" />{/if}
				</button>
			{/each}
		{/if}
		<div class="mt-1 border-t border-stone-100 pt-1">
			<button
				type="button"
				role="menuitemcheckbox"
				aria-checked={query.cancelled}
				class={filterRow}
				onclick={() => go({ cancelled: !query.cancelled })}
			>
				<span class="min-w-0 flex-1">Show cancelled</span>
				{#if query.cancelled}<Check class="h-4 w-4 shrink-0" aria-hidden="true" />{/if}
			</button>
			{#if filterActive || query.cancelled}
				<button
					type="button"
					class="{filterRow} text-stone-500"
					onclick={() => go({ brands: [], channels: [], cancelled: false })}
				>
					Clear filters
				</button>
			{/if}
		</div>
	</div>
{/snippet}

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
					{@const thumb = thumbOf(media[draft.id])}
					<li>
						<a
							href="/compose?id={encodeURIComponent(draft.id)}"
							class="flex gap-3 rounded-2xl border border-stone-200/80 bg-white p-2.5 shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors hover:border-stone-300"
						>
							<span
								class="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-stone-100 text-stone-400"
								aria-hidden="true"
							>
								{#if thumb?.url}
									<img src={thumb.url} alt="" loading="lazy" class="h-full w-full object-cover" />
								{:else}
									<FileText class="h-5 w-5" />
								{/if}
								{#if thumb?.video}
									<span class="absolute inset-0 flex items-center justify-center text-white">
										<Play class="h-3.5 w-3.5 fill-current drop-shadow" />
									</span>
								{/if}
							</span>
							<span class="min-w-0 flex-1">
								{#if draft.title}
									<span class="line-clamp-1 text-[13px] font-bold text-stone-900"
										>{draft.title}</span
									>
								{/if}
								<span
									class="line-clamp-2 text-[12px] {draft.title
										? 'text-stone-500'
										: 'font-semibold text-stone-800'}"
									>{draftExcerpt(draft.body, 120) || 'No text yet'}</span
								>
								<span class="mt-0.5 block text-[11px] font-medium text-stone-400"
									>Edited {formatRelativeTime(new Date(draft.updatedAt))}</span
								>
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
	<h1 class="sr-only">Calendar</h1>
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<a
			href={href({ date: shiftAnchor(query.view, query.date, -1) })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Previous {query.view}"
			onclick={(event) => stepMonth(event, addMonths(shownMonth, -1))}
		>
			<ChevronLeft class="h-4 w-4" />
		</a>
		<a
			href={href({ date: data.today })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Go to today"
			onclick={(event) => stepMonth(event, data.today)}>Today</a
		>
		<a
			href={href({ date: shiftAnchor(query.view, query.date, 1) })}
			data-sveltekit-reset="false"
			class={navButton}
			aria-label="Next {query.view}"
			onclick={(event) => stepMonth(event, addMonths(shownMonth, 1))}
		>
			<ChevronRight class="h-4 w-4" />
		</a>
		<div class="order-first w-full min-w-0 md:order-none md:ml-2 md:w-auto md:flex-1">
			<h2 class="truncate text-xl font-extrabold tracking-tight text-stone-900" aria-live="polite">
				{headerLabel}
			</h2>
			<p class="text-[11px] font-medium text-stone-400" data-testid="calendar-zone">
				Times in {tz}
			</p>
		</div>
		<div class="ml-auto flex items-center gap-2">
			<button
				type="button"
				class="{navButton} md:hidden {selectMode
					? '!border-stone-900 !bg-stone-900 !text-white'
					: ''}"
				aria-pressed={selectMode}
				onclick={() => (selectMode ? clearSelection() : (selectMode = true))}
				data-testid="calendar-select-mode"
			>
				<ListChecks class="h-4 w-4" />
				<span class="ml-1.5">{selectMode ? 'Done' : 'Select'}</span>
			</button>
			<div class="relative">
				<button
					type="button"
					class="{navButton} {filterActive || query.cancelled ? '!border-stone-900' : ''}"
					aria-haspopup="dialog"
					aria-expanded={filterMenuOpen}
					aria-controls="calendar-filters"
					onclick={() => (filterMenuOpen = !filterMenuOpen)}
					data-testid="calendar-filter-button"
				>
					<SlidersHorizontal class="h-4 w-4" />
					<span class="ml-1.5">Filter</span>
					{#if filterActive || query.cancelled}
						<span
							class="ml-1.5 rounded-full bg-stone-900 px-1.5 text-[11px] text-white tabular-nums"
							>{query.brands.length + query.channels.length + (query.cancelled ? 1 : 0)}</span
						>
					{/if}
				</button>
				{#if filterMenuOpen}
					{@render filterMenu()}
				{/if}
			</div>
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

	{#if statusCounts.length}
		<div
			class="mb-3 flex flex-wrap items-center gap-x-1 gap-y-1"
			role="group"
			aria-label="Posts in view by status. Pick one to select them all."
			data-testid="calendar-summary"
		>
			{#each statusCounts as row (row.status)}
				{@const all = row.ids.every((id) => selected.has(id))}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold transition-colors {all
						? 'bg-stone-900 text-white'
						: 'text-stone-600 hover:bg-white hover:text-stone-900'}"
					title="Select every {STATUS_LABEL[row.status].toLowerCase()} post in view"
					aria-pressed={all}
					onclick={() => (all ? row.ids.forEach((id) => selected.delete(id)) : selectOnly(row.ids))}
				>
					<span class="h-2 w-2 rounded-full {STATUS_DOT[row.status]}" aria-hidden="true"></span>
					<span class="tabular-nums">{row.ids.length}</span>
					{STATUS_LABEL[row.status]}
				</button>
			{/each}
		</div>
	{/if}

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
				class="hidden md:block {marquee ? 'select-none' : ''}"
				bind:this={gridEl}
				onkeydown={onGridKeydown}
				onpointerdown={onGridPointerDown}
				role="presentation"
				data-testid="calendar-grid"
			>
				{#if query.view === 'week'}
					<div
						class="relative max-h-[max(24rem,calc(100dvh-17rem))] overflow-y-auto rounded-[1.25rem] border border-stone-200/80 bg-white shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)]"
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
									class="border-b border-stone-100 pr-2 text-right text-[10px] font-bold tabular-nums {busyHours.has(
										hour
									)
										? 'pt-1.5 text-stone-500'
										: 'pt-0.5 text-stone-300'}"
									data-hour-row={hour}
								>
									{formatTime(Date.UTC(2000, 0, 1, hour), 'UTC').replace(':00', '')}
								</div>
								{#each days as day (day)}
									{@const slot = byHour.get(`${day}:${hour}`) ?? []}
									<div
										data-drop-day={day}
										data-drop-hour={hour}
										class="{busyHours.has(hour)
											? 'min-h-11'
											: 'min-h-6'} space-y-1 border-b border-l border-stone-100 p-0.5 {isOver(
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
												dragging={drag?.item.id === item.id ||
													Boolean(drag && selected.has(drag.item.id) && selected.has(item.id))}
												selected={selected.has(item.id)}
												thumb={thumbOf(media[item.draftId])}
												onOpen={onItemClick}
												onMenu={(item, event) => openItemMenu(item, event)}
												onPointerDown={startPress}
											/>
										{/each}
										{#each slotsByHour.get(`${day}:${hour}`) ?? [] as open (`${open.connectionId}:${open.at}`)}
											<span
												class="flex items-center gap-1 truncate rounded-lg border border-dashed border-stone-200 px-1.5 py-0.5 text-[10px] font-medium text-stone-400"
												title="Open slot for {open.channel.key} at {formatTime(open.at, tz)}"
												data-testid="open-slot"
											>
												<span class="sr-only">Open slot:</span>
												<span class="tabular-nums">{formatTime(open.at, tz)}</span>
												<span style="color: {open.channel.brand.color}" class="opacity-60">
													<PlatformLogo platform={open.channel.platform} size={10} />
												</span>
												<span class="sr-only">{channelName(open)}</span>
											</span>
										{/each}
									</div>
								{/each}
							{/each}
						</div>
					</div>
				{:else}
					<div
						class="relative max-h-[max(24rem,calc(100dvh-17rem))] overflow-y-auto overscroll-contain rounded-[1.25rem] border border-stone-200/80 bg-white shadow-[0_4px_20px_-8px_rgb(28_25_23/0.08)] [overflow-anchor:none]"
						bind:this={monthScroller}
						onscroll={onMonthScroll}
						data-testid="calendar-month-scroller"
					>
						<div
							class="sticky top-0 z-10 grid grid-cols-7 border-b border-stone-200 bg-white"
							bind:this={monthHeader}
						>
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
							<div
								class="grid grid-cols-7 {w ? 'border-t border-stone-100' : ''}"
								data-week={week[0]}
								data-mid={week[3]}
							>
								{#each week as day (day)}
									{@const list = byDay.get(day) ?? []}
									{@const inMonth = day.slice(0, 7) === shownMonth.slice(0, 7)}
									<div
										data-drop-day={day}
										class="flex min-h-28 min-w-0 flex-col gap-1 border-l border-stone-100 p-1 transition-colors duration-300 first:border-l-0 {isOver(
											day,
											null
										)
											? 'bg-stone-100 ring-2 ring-stone-900 ring-inset'
											: inMonth
												? ''
												: 'bg-stone-50/70'}"
									>
										{#if day.endsWith('-01')}
											<span
												class="-mb-7 self-start px-1 pt-1 text-[11px] font-extrabold tracking-wide text-stone-900 uppercase"
												aria-hidden="true">{monthName(day)}</span
											>
										{/if}
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
												dragging={drag?.item.id === item.id ||
													Boolean(drag && selected.has(drag.item.id) && selected.has(item.id))}
												selected={selected.has(item.id)}
												thumb={thumbOf(media[item.draftId])}
												onOpen={onItemClick}
												onMenu={(item, event) => openItemMenu(item, event)}
												onPointerDown={startPress}
											/>
										{/each}
										{#if !list.length && isPending(day)}
											<span
												class="mx-0.5 h-8 rounded-md bg-stone-100 motion-safe:animate-pulse"
												aria-hidden="true"
											></span>
										{/if}
										{#if slotsByDay.get(day)}
											<span
												class="px-1 text-[10px] font-medium text-stone-400"
												data-testid="open-slots-{day}"
												>{slotsByDay.get(day)} open slot{slotsByDay.get(day) === 1 ? '' : 's'}</span
											>
										{/if}
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
					Click a post to preview it; right-click for everything else.{query.view === 'month'
						? ' Scroll to move through the months.'
						: ''} Drag a post to move it (held posts stay held), and Undo puts it back. Drag across empty
					space or Shift-click to select several.
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
													onclick={(event) => onItemClick(item, null, event)}
													aria-pressed={selectMode ? selected.has(item.id) : undefined}
													aria-label="{channelName(item)}, {item.retrying
														? 'Retrying'
														: STATUS_LABEL[item.status]}, {formatDateTime(
														item.at,
														tz
													)}: {draftExcerpt(item.text, 80)}"
													class="flex min-h-14 w-full items-start gap-3 rounded-2xl border border-l-4 border-stone-200/80 bg-white px-3 py-2.5 text-left shadow-[0_1px_2px_rgb(28_25_23/0.04)] {selected.has(
														item.id
													)
														? 'ring-2 ring-stone-900'
														: ''}"
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
					Tap a post to preview it. Press Select to act on several at once.
				</p>
			</div>
			{#if openSlots.length}
				<p class="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-stone-500">
					<span class="h-2 w-3 rounded-sm border border-dashed border-stone-300" aria-hidden="true"
					></span>
					Open posting slot
				</p>
			{/if}
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
		media={media[openItem.draftId] ?? []}
		timeZone={tz}
		{busy}
		error={detailError}
		onClose={() => (openId = null)}
		onReschedule={(item, runAt) => reschedule(item, runAt, false)}
		onCancel={(item) => (pendingCancel = item)}
		onRetry={retry}
	/>
{/if}

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

{#if marqueeBox}
	<div
		class="pointer-events-none fixed z-30 rounded-md border border-stone-900/50 bg-stone-900/5"
		style="left: {marqueeBox.left}px; top: {marqueeBox.top}px; width: {marqueeBox.right -
			marqueeBox.left}px; height: {marqueeBox.bottom - marqueeBox.top}px"
		aria-hidden="true"
	></div>
{/if}

{#if selected.size}
	<div
		class="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2"
		role="toolbar"
		aria-label="Selected posts"
		data-testid="calendar-bulk-bar"
	>
		<div
			class="flex items-center gap-1 rounded-full border border-stone-200/80 bg-white/95 p-1.5 pl-4 shadow-[0_12px_40px_-12px_rgb(28_25_23/0.35)] backdrop-blur-xl"
		>
			<span class="mr-1 text-[13px] font-extrabold whitespace-nowrap text-stone-900 tabular-nums"
				>{selected.size} selected</span
			>
			{#each barActions as action (action.key)}
				{@const Icon = action.icon}
				<button
					type="button"
					class="{barButton} {action.tone === 'primary'
						? 'bg-violet-600 text-white hover:bg-violet-700'
						: 'text-stone-700 hover:bg-stone-100'}"
					disabled={bulkBusy}
					title={action.hint}
					onclick={action.onSelect}
					data-testid="bulk-{action.key}"
				>
					<Icon class="h-4 w-4" />
					{action.label}
				</button>
			{/each}
			{#if moreActions.length}
				<button
					type="button"
					class="{barButton} text-stone-700 hover:bg-stone-100"
					disabled={bulkBusy}
					aria-haspopup="menu"
					aria-expanded={moreMenu !== null}
					onclick={(event) => {
						const box = event.currentTarget.getBoundingClientRect();
						moreMenu = moreMenu ? null : { x: box.left, y: box.top - 8 };
					}}
					data-testid="bulk-more"
				>
					<Ellipsis class="h-4 w-4" /> More
				</button>
			{/if}
			<button
				type="button"
				class="{barButton} text-stone-500 hover:bg-stone-100"
				aria-label="Clear selection"
				title="Clear selection (Esc)"
				onclick={clearSelection}
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	</div>

	{#if moveMenuOpen}
		<div
			bind:this={movePanel}
			class="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 w-64 -translate-x-1/2 rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.25)]"
			role="dialog"
			aria-label="Move {count(plan.move.length)}"
			data-testid="calendar-move-menu"
		>
			<p class="px-3 pt-1 pb-1.5 text-[11px] font-bold tracking-wide text-stone-500 uppercase">
				Move {count(plan.move.length)}
			</p>
			{#each [{ label: 'A day earlier', delta: -86_400_000 }, { label: 'A day later', delta: 86_400_000 }, { label: 'A week later', delta: 7 * 86_400_000 }] as option (option.label)}
				<button
					type="button"
					class="block w-full rounded-xl px-3 py-2 text-left text-[13px] font-bold text-stone-700 hover:bg-stone-50"
					onclick={() => proposeShift(option.delta)}>{option.label}</button
				>
			{/each}
			<form
				class="mt-1 border-t border-stone-100 px-3 pt-2 pb-1"
				onsubmit={(event) => {
					event.preventDefault();
					proposeMoveToDay(moveDate);
				}}
			>
				<label
					for="calendar-move-day"
					class="block text-[11px] font-bold tracking-wide text-stone-500 uppercase"
					>To a day, same times</label
				>
				<div class="mt-1.5 flex gap-2">
					<input
						id="calendar-move-day"
						type="date"
						min={data.today}
						bind:value={moveDate}
						class="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-[13px]"
					/>
					<button
						type="submit"
						disabled={!moveDate}
						class="rounded-full bg-stone-900 px-3 text-[12px] font-bold text-white disabled:opacity-40"
						>Move</button
					>
				</div>
			</form>
		</div>
	{/if}
{/if}

{#if moreMenu}
	<CalendarActionMenu
		x={moreMenu.x}
		y={moreMenu.y}
		placement="above"
		actions={moreActions}
		onClose={() => (moreMenu = null)}
	/>
{/if}

{#if previewItem}
	<CalendarPreview
		item={previewItem}
		media={media[previewItem.draftId] ?? []}
		timeZone={tz}
		actions={previewActions(previewItem)}
		onClose={() => (previewId = null)}
		onMore={(x, y) => {
			const item = previewItem;
			previewId = null;
			if (item) itemMenu = { item, x, y };
		}}
	/>
{/if}

{#if itemMenu}
	<CalendarActionMenu
		x={itemMenu.x}
		y={itemMenu.y}
		title="{formatDateTime(itemMenu.item.at, tz)} · {itemMenu.item.channel.platformName}"
		subtitle={draftExcerpt(itemMenu.item.text.split('\n')[0], 60)}
		actions={itemMenuActions(itemMenu.item)}
		onClose={() => (itemMenu = null)}
	/>
{/if}

{#snippet rejectDetails()}
	<label for="calendar-reject-note" class="block text-[12px] font-bold text-stone-600"
		>Note for the agent (optional)</label
	>
	<textarea
		id="calendar-reject-note"
		bind:value={rejectNote}
		maxlength="2000"
		rows="3"
		class="mt-1 w-full rounded-xl border border-stone-200 px-3 py-2 text-[13px]"
		placeholder="What should change?"></textarea>
{/snippet}

<ConfirmDialog
	open={bulkConfirm !== null}
	title={bulkConfirm?.kind === 'approve-now'
		? `Approve ${count(bulkConfirm.ids.length)}?`
		: bulkConfirm?.kind === 'reject'
			? `Reject ${count(bulkConfirm.ids.length)}?`
			: `Cancel ${count(bulkConfirm?.ids.length ?? 0)}?`}
	body={bulkConfirm?.kind === 'approve-now'
		? `${count(approveNowCount)} ${approveNowCount === 1 ? 'is' : 'are'} past ${approveNowCount === 1 ? 'its' : 'their'} time and will publish right away.${approveNowCount < bulkConfirm.ids.length ? ' The rest keep their times.' : ''}`
		: bulkConfirm?.kind === 'cancel'
			? 'They will not publish. Other accounts on the same posts are not touched.'
			: null}
	details={bulkConfirm?.kind === 'reject' ? rejectDetails : null}
	confirmLabel={bulkConfirm?.kind === 'approve-now'
		? 'Approve'
		: bulkConfirm?.kind === 'reject'
			? 'Reject'
			: 'Cancel posts'}
	cancelLabel="Keep"
	tone={bulkConfirm?.kind === 'approve-now' ? 'primary' : 'danger'}
	busy={bulkBusy}
	idPrefix="calendar-bulk"
	onConfirm={confirmBulk}
	onCancel={() => (bulkConfirm = null)}
/>

{#if undo}
	<div
		class="fixed {selected.size
			? 'bottom-[calc(5.5rem+env(safe-area-inset-bottom))]'
			: 'bottom-[calc(1.5rem+env(safe-area-inset-bottom))]'} left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-stone-200/80 bg-white/95 py-2 pr-2 pl-4 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.25)] backdrop-blur-xl"
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
