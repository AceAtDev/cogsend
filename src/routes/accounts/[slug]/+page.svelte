<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ChevronLeft, Plus, X } from '@lucide/svelte';
	import PlatformLogo from '#lib/components/PlatformLogo.svelte';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';
	import { showToast } from '#lib/components/toast.svelte.js';
	import {
		BRIEF_SECTIONS,
		MAX_BRIEF_SECTION,
		MAX_PLATFORM_NOTE,
		type BriefSectionKey
	} from '#lib/domain/brand-brief.js';
	import { formatDateTime } from '#lib/domain/calendar.js';
	import { displayAt } from '#lib/domain/channel-keys.js';
	import { humanizeError } from '#lib/domain/human-error.js';
	import {
		isPlatformId,
		PLATFORM_ORDER,
		platformName,
		type PlatformId
	} from '#lib/domain/platforms.js';
	import {
		describeRules,
		isSlotTime,
		MAX_GAP_MINUTES,
		MAX_POSTS_PER_DAY,
		WEEKDAY_LABEL,
		WEEKDAYS,
		type Weekday,
		type WeeklySlots
	} from '#lib/domain/posting-slots.js';

	let { data } = $props();

	const card =
		'overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white p-4 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-6';
	const field =
		'w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2 text-[13px] text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base';
	const button =
		'inline-flex min-h-10 items-center gap-1.5 rounded-full bg-stone-900 px-4 text-[13px] font-bold text-white transition-colors hover:bg-stone-700 disabled:opacity-50';
	const quiet =
		'inline-flex min-h-8 items-center gap-1 rounded-full bg-stone-100 px-3 text-[12px] font-bold text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-50';

	// The form is a working copy: it starts from what the server loaded and
	// is only replaced when a different brand or a saved version arrives.
	let sections = $state<Record<BriefSectionKey, string>>(emptySections());
	let notes = $state<Partial<Record<PlatformId, string>>>({});
	let briefFor = '';
	$effect(() => {
		const key = `${data.brand.slug}:${data.brief?.updatedAt ?? ''}`;
		if (key === briefFor) return;
		briefFor = key;
		const next = emptySections();
		for (const s of BRIEF_SECTIONS) next[s.key] = data.brief?.sections[s.key] ?? '';
		sections = next;
		notes = { ...(data.brief?.platformNotes ?? {}) };
	});

	function emptySections(): Record<BriefSectionKey, string> {
		return Object.fromEntries(BRIEF_SECTIONS.map((s) => [s.key, ''])) as Record<
			BriefSectionKey,
			string
		>;
	}

	const notePlatforms = $derived(
		PLATFORM_ORDER.filter(
			(p) =>
				data.channels.some((c) => c.platform === p) || (data.brief?.platformNotes[p] ?? '') !== ''
		)
	);
	let extraNote = $state<PlatformId | ''>('');
	const addablePlatforms = $derived(
		PLATFORM_ORDER.filter((p) => !notePlatforms.includes(p) && notes[p] === undefined)
	);
	const shownNotes = $derived(
		PLATFORM_ORDER.filter((p) => notePlatforms.includes(p) || notes[p] !== undefined)
	);

	let savingBrief = $state(false);
	let briefError = $state<string | null>(null);

	async function request(url: string, body: unknown): Promise<Record<string, unknown> | null> {
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (sessionExpiredIfUnauthorized(res)) return null;
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || 'Could not save');
		return payload;
	}

	async function saveBrief(e: Event) {
		e.preventDefault();
		if (!data.brand.id) return;
		savingBrief = true;
		briefError = null;
		try {
			const platformNotes = Object.fromEntries(
				Object.entries(notes).filter(([p, text]) => isPlatformId(p) && text?.trim())
			);
			const saved = await request(`/api/brands/${data.brand.id}/brief`, {
				sections,
				platformNotes
			});
			if (!saved) return;
			showToast(`Saved the ${data.brand.name} brief`);
			await invalidateAll();
		} catch (err) {
			briefError = humanizeError(err instanceof Error ? err.message : 'Could not save the brief');
		} finally {
			savingBrief = false;
		}
	}

	type Draft = {
		slots: WeeklySlots;
		maxPerDay: number | null;
		minGap: number | null;
		adding: Record<Weekday, string>;
	};
	let drafts = $state<Record<string, Draft>>({});
	let rulesFor = '';
	$effect(() => {
		const key = JSON.stringify(data.channels.map((c) => [c.connectionId, c.rules]));
		if (key === rulesFor) return;
		rulesFor = key;
		drafts = Object.fromEntries(
			data.channels.map((c) => [
				c.connectionId,
				{
					slots: structuredClone(c.rules.slots),
					maxPerDay: c.rules.maxPerDay,
					minGap: c.rules.minGapMinutes,
					adding: Object.fromEntries(WEEKDAYS.map((d) => [d, ''])) as Record<Weekday, string>
				}
			])
		);
	});

	function addTime(id: string, day: Weekday) {
		const draft = drafts[id];
		const time = draft.adding[day];
		if (!isSlotTime(time)) return;
		draft.slots[day] = [...new Set([...(draft.slots[day] ?? []), time])].sort();
		draft.adding[day] = '';
	}

	function removeTime(id: string, day: Weekday, time: string) {
		const draft = drafts[id];
		draft.slots[day] = (draft.slots[day] ?? []).filter((t) => t !== time);
	}

	function copyToWeekdays(id: string) {
		const draft = drafts[id];
		const monday = draft.slots.mon ?? [];
		for (const day of ['tue', 'wed', 'thu', 'fri'] as const) draft.slots[day] = [...monday];
	}

	let savingRules = $state<string | null>(null);
	let rulesError = $state<Record<string, string>>({});

	async function saveRules(id: string, key: string) {
		const draft = drafts[id];
		savingRules = id;
		rulesError = { ...rulesError, [id]: '' };
		try {
			// An emptied number input binds null (or undefined): no limit.
			const number = (raw: number | null | undefined) => (typeof raw === 'number' ? raw : null);
			const saved = await request(`/api/connections/${id}/slots`, {
				slots: Object.fromEntries(WEEKDAYS.map((d) => [d, draft.slots[d] ?? []])),
				maxPerDay: number(draft.maxPerDay),
				minGapMinutes: number(draft.minGap)
			});
			if (!saved) return;
			showToast(`Saved posting slots for ${key}`);
			await invalidateAll();
		} catch (err) {
			rulesError = {
				...rulesError,
				[id]: humanizeError(err instanceof Error ? err.message : 'Could not save the slots')
			};
		} finally {
			savingRules = null;
		}
	}
</script>

<svelte:head>
	<title>{data.brand.name} — brief and posting slots</title>
</svelte:head>

<div class="flex w-full flex-1 flex-col gap-8">
	<div>
		<a
			href="/accounts"
			class="inline-flex items-center gap-1 text-[12px] font-bold text-stone-500 hover:text-stone-900"
		>
			<ChevronLeft class="h-4 w-4" /> Accounts
		</a>
		<h1 class="mt-3 flex items-center gap-3 text-3xl font-extrabold tracking-tight text-stone-900">
			<span
				class="h-3.5 w-3.5 shrink-0 rounded-full"
				style="background-color: {data.brand.color}"
				aria-hidden="true"
			></span>
			{data.brand.name}
		</h1>
		<p class="mt-1 text-[13px] font-medium text-stone-500">
			{#if data.brief}
				What agents read before they write for this brand, and when its accounts may post.
			{:else}
				When the accounts without a brand may post.
			{/if}
			Times are in {data.timeZone}.
		</p>
	</div>

	{#if data.brief}
		<section class={card} aria-labelledby="brief-title" data-testid="brief-editor">
			<h2 id="brief-title" class="text-[17px] font-extrabold tracking-tight text-stone-900">
				Brief
			</h2>
			<p class="mt-1 text-[13px] font-medium text-stone-500">
				Markdown. Agents get it from <code class="font-mono text-[12px]">get_brand_brief</code> and follow
				it in every post; leave a section empty to skip it.
			</p>
			<form class="mt-4 space-y-4" onsubmit={saveBrief}>
				{#each BRIEF_SECTIONS as section (section.key)}
					<label class="block">
						<span class="text-[12px] font-bold text-stone-700">{section.label}</span>
						<span class="ml-1 text-[11px] font-medium text-stone-400">{section.hint}</span>
						<textarea
							class="{field} mt-1 min-h-20 font-mono"
							maxlength={MAX_BRIEF_SECTION}
							bind:value={sections[section.key]}
							data-testid="brief-{section.key}"></textarea>
					</label>
				{/each}
				<fieldset class="space-y-3">
					<legend class="text-[12px] font-bold text-stone-700">Platform notes</legend>
					{#each shownNotes as platform (platform)}
						<label class="block">
							<span class="flex items-center gap-1.5 text-[12px] font-bold text-stone-600">
								<PlatformLogo {platform} size={12} />
								{platformName(platform)}
							</span>
							<textarea
								class="{field} mt-1 min-h-16 font-mono"
								maxlength={MAX_PLATFORM_NOTE}
								value={notes[platform] ?? ''}
								oninput={(e) => (notes = { ...notes, [platform]: e.currentTarget.value })}
								data-testid="brief-note-{platform}"></textarea>
						</label>
					{/each}
					{#if addablePlatforms.length}
						<div class="flex flex-wrap items-center gap-2">
							<select
								class="rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-1.5 text-[13px]"
								bind:value={extraNote}
								aria-label="Platform to add a note for"
							>
								<option value="">Add a note for…</option>
								{#each addablePlatforms as platform (platform)}
									<option value={platform}>{platformName(platform)}</option>
								{/each}
							</select>
							<button
								type="button"
								class={quiet}
								disabled={!extraNote}
								onclick={() => {
									if (extraNote) notes = { ...notes, [extraNote]: '' };
									extraNote = '';
								}}><Plus class="h-3.5 w-3.5" /> Add</button
							>
						</div>
					{/if}
				</fieldset>
				{#if briefError}
					<p class="text-[13px] font-medium text-red-700" role="alert">{briefError}</p>
				{/if}
				<button type="submit" class={button} disabled={savingBrief}>
					{savingBrief ? 'Saving…' : 'Save brief'}
				</button>
			</form>
		</section>
	{/if}

	<section class={card} aria-labelledby="slots-title" data-testid="slots-editor">
		<h2 id="slots-title" class="text-[17px] font-extrabold tracking-tight text-stone-900">
			Posting slots
		</h2>
		<p class="mt-1 text-[13px] font-medium text-stone-500">
			When each account posts, in {data.timeZone}. An agent asking for the next slot gets the first
			open one; a time that breaks the limits is refused with the next allowed time. The calendar
			shows open slots.
		</p>
		{#if !data.channels.length}
			<p class="mt-4 text-[13px] text-stone-500">No accounts here yet.</p>
		{/if}
		<div class="mt-4 space-y-6">
			{#each data.channels as channel (channel.connectionId)}
				{@const draft = drafts[channel.connectionId]}
				{#if draft}
					<form
						class="rounded-2xl border border-stone-200/80 p-4"
						data-testid="slots-{channel.key}"
						onsubmit={(e) => {
							e.preventDefault();
							void saveRules(channel.connectionId, channel.key);
						}}
					>
						<h3 class="flex flex-wrap items-center gap-2 text-[14px] font-extrabold text-stone-900">
							<PlatformLogo platform={channel.platform} size={14} />
							{channel.handle ? displayAt(channel.handle) : channel.platformName}
							<code class="font-mono text-[11px] font-medium text-stone-500">{channel.key}</code>
						</h3>
						<p class="mt-1 text-[12px] text-stone-500">{describeRules(channel.rules)}</p>
						<div class="mt-3 divide-y divide-stone-100">
							{#each WEEKDAYS as day (day)}
								<div class="flex flex-wrap items-center gap-2 py-1.5">
									<span class="w-24 text-[12px] font-bold text-stone-600">{WEEKDAY_LABEL[day]}</span
									>
									{#each draft.slots[day] ?? [] as time (time)}
										<span
											class="inline-flex items-center gap-1 rounded-full bg-stone-100 py-0.5 pr-1 pl-2.5 text-[12px] font-bold text-stone-800 tabular-nums"
										>
											{time}
											<button
												type="button"
												class="flex h-5 w-5 items-center justify-center rounded-full hover:bg-stone-200"
												aria-label="Remove {time} on {WEEKDAY_LABEL[day]}"
												onclick={() => removeTime(channel.connectionId, day, time)}
											>
												<X class="h-3 w-3" />
											</button>
										</span>
									{/each}
									<input
										type="time"
										class="rounded-lg border border-stone-200/80 bg-stone-50 px-2 py-0.5 text-[12px]"
										bind:value={draft.adding[day]}
										aria-label="New time on {WEEKDAY_LABEL[day]}"
										onkeydown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												addTime(channel.connectionId, day);
											}
										}}
									/>
									<button
										type="button"
										class={quiet}
										disabled={!isSlotTime(draft.adding[day])}
										aria-label="Add time on {WEEKDAY_LABEL[day]}"
										onclick={() => addTime(channel.connectionId, day)}
									>
										<Plus class="h-3.5 w-3.5" />
									</button>
									{#if day === 'mon' && (draft.slots.mon ?? []).length}
										<button
											type="button"
											class="text-[11px] font-bold text-stone-500 hover:text-stone-900"
											onclick={() => copyToWeekdays(channel.connectionId)}>Copy to Tue–Fri</button
										>
									{/if}
								</div>
							{/each}
						</div>
						<div class="mt-3 flex flex-wrap gap-4">
							<label class="text-[12px] font-bold text-stone-700">
								Max posts a day
								<input
									type="number"
									min="1"
									max={MAX_POSTS_PER_DAY}
									placeholder="No limit"
									class="{field} mt-1 w-32"
									bind:value={draft.maxPerDay}
								/>
							</label>
							<label class="text-[12px] font-bold text-stone-700">
								Minutes between posts
								<input
									type="number"
									min="1"
									max={MAX_GAP_MINUTES}
									placeholder="No minimum"
									class="{field} mt-1 w-32"
									bind:value={draft.minGap}
								/>
							</label>
						</div>
						{#if channel.nextOpen.length}
							<p class="mt-3 text-[12px] text-stone-500">
								Next open: {channel.nextOpen
									.map((at) => formatDateTime(at, data.timeZone))
									.join(' · ')}
							</p>
						{/if}
						{#if rulesError[channel.connectionId]}
							<p class="mt-2 text-[13px] font-medium text-red-700" role="alert">
								{rulesError[channel.connectionId]}
							</p>
						{/if}
						<button
							type="submit"
							class="{button} mt-3"
							disabled={savingRules === channel.connectionId}
						>
							{savingRules === channel.connectionId ? 'Saving…' : 'Save slots'}
						</button>
					</form>
				{/if}
			{/each}
		</div>
	</section>
</div>
