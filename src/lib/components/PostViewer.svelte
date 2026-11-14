<script lang="ts">
	import { tick } from 'svelte';
	import {
		BatteryFull,
		Bell,
		Bookmark,
		Check,
		ChevronLeft,
		ChevronRight,
		Clapperboard,
		Ellipsis,
		Heart,
		House,
		Mail,
		MessageCircle,
		MessageSquare,
		Music2,
		Plus,
		Repeat2,
		Ruler,
		Search,
		Send,
		Share2,
		Signal,
		SquarePlus,
		ThumbsUp,
		User,
		Users,
		Wifi,
		X
	} from '@lucide/svelte';
	import type { PreviewItem } from './MediaPreview.svelte';
	import {
		aspectOf,
		coverUrl,
		gridFor,
		isVideoMedia,
		MEDIA_BASE,
		mediaUrl
	} from '#lib/domain/media-layout.js';
	import {
		captionPreview,
		clampSlide,
		initialPosition,
		segmentItems,
		stepSlide,
		swipeStep,
		viewerProfile
	} from '#lib/domain/post-viewer.js';
	import {
		CARD_CM,
		clampPxPerCm,
		feedAspect,
		formatCm,
		guessPxPerCm,
		phoneById,
		phoneLayout,
		PHONES,
		PX_PER_CM_RANGE,
		screenCm,
		toCm
	} from '#lib/domain/true-size.js';

	let {
		open,
		onClose,
		items: allItems,
		platform,
		content = '',
		title = null,
		account = {},
		initialIndex = 0,
		mediaBase = MEDIA_BASE,
		segments = [],
		segmentIndices
	}: {
		open: boolean;
		onClose: () => void;
		items: PreviewItem[];
		platform: string;
		content?: string;
		title?: string | null;
		account?: { displayName?: string | null; handle?: string | null; avatarUrl?: string | null };
		initialIndex?: number;
		mediaBase?: string;
		segments?: string[];
		segmentIndices?: number[];
	} = $props();

	type View = 'phone' | 'desktop' | 'file';
	const VIEWS: { id: View; label: string }[] = [
		{ id: 'phone', label: 'Phone' },
		{ id: 'desktop', label: 'Desktop' },
		{ id: 'file', label: 'File' }
	];
	const STORE_SCALE = 'cogsend.preview.pxPerCm';
	const STORE_PHONE = 'cogsend.preview.phone';
	const BEZEL_CM = 0.3;

	const uid = $props.id();
	const profile = $derived(viewerProfile(platform));
	let index = $state(0);
	let segment = $state(0);
	let view = $state<View>('phone');
	let expanded = $state(false);
	let enlarged = $state(false);
	let overlays = $state(true);
	let phoneId = $state(PHONES[0].id);
	let pxPerCm = $state(96 / 2.54);
	let calibrated = $state(false);
	let calibrating = $state(false);
	let draftScale = $state(96 / 2.54);
	let fileActual = $state(false);
	let narrow = $state(false);
	let stageWidth = $state(0);
	let stageHeight = $state(0);
	let natural = $state<Record<string, { width: number; height: number }>>({});
	let failed = $state<string | null>(null);
	let touch: { x: number; y: number } | null = null;
	let measuredCm = $state<{ width: number; height: number } | null>(null);
	let stage = $state<HTMLElement>();

	const items = $derived(segmentItems(allItems, segment, segments.length, segmentIndices));
	const shownContent = $derived(segments.length > 0 ? (segments[segment] ?? '') : content);
	const active = $derived(items[clampSlide(index, items.length)]);
	const isReel = $derived(platform === 'instagram' && items.length === 1 && isVideoMedia(items[0]));
	const immersive = $derived(platform === 'tiktok' || isReel);
	const gridMode = $derived(
		view !== 'file' && profile.layout === 'grid' && items.length > 1 && !enlarged
	);
	const gridItems = $derived(items.slice(0, 4));
	const grid = $derived(gridFor(gridItems.length));
	const longCaption = $derived(Array.from(shownContent).length > profile.captionLimit);
	const name = $derived(account.displayName || account.handle || 'Account');
	const handle = $derived(
		account.handle ? (account.handle.startsWith('@') ? account.handle : `@${account.handle}`) : null
	);
	const size = $derived(
		active
			? {
					width: active.width || natural[active.id]?.width || 0,
					height: active.height || natural[active.id]?.height || 0
				}
			: { width: 0, height: 0 }
	);
	const ratio = $derived(
		active ? (aspectOf(active) ?? (size.width && size.height ? size.width / size.height : 1)) : 1
	);
	const phone = $derived(phoneById(phoneId));
	const screen = $derived(screenCm(phone));
	const layout = $derived(
		phoneLayout(
			phone,
			pxPerCm,
			{ width: stageWidth, height: narrow ? Number.POSITIVE_INFINITY : stageHeight },
			narrow ? 0 : BEZEL_CM
		)
	);
	const platformLabel = $derived(isReel ? 'Instagram Reels' : profile.name);
	const navIcons = $derived(
		platform === 'tiktok'
			? [House, Users, Plus, MessageSquare, User]
			: platform === 'instagram'
				? [House, Search, SquarePlus, Clapperboard, User]
				: platform === 'x' || platform === 'bluesky'
					? [House, Search, Bell, Mail, User]
					: [House, Search, Plus, Bell, User]
	);

	$effect(() => {
		if (!open) return;
		const position = initialPosition(allItems, initialIndex, segments.length, segmentIndices);
		segment = position.segment;
		index = position.index;
		expanded = false;
		enlarged = false;
		calibrating = false;
		fileActual = false;
		view = 'phone';
		overlays = true;
		narrow = window.matchMedia('(max-width: 700px)').matches;
		const raw = localStorage.getItem(STORE_SCALE);
		const stored = raw === null ? null : clampPxPerCm(Number(raw));
		calibrated = stored !== null;
		pxPerCm =
			stored ?? guessPxPerCm(window.innerWidth, window.matchMedia('(pointer: coarse)').matches);
		phoneId = phoneById(localStorage.getItem(STORE_PHONE)).id;
	});

	$effect(() => {
		if (!open) return;
		const query = window.matchMedia('(max-width: 700px)');
		const update = () => (narrow = query.matches);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// Measure the drawn media, not its box: contain-fitted media is letterboxed inside it.
	$effect(() => {
		void [
			view,
			index,
			segment,
			phoneId,
			pxPerCm,
			stageWidth,
			stageHeight,
			overlays,
			ratio,
			enlarged
		];
		void [narrow, fileActual, gridMode];
		void tick().then(() => requestAnimationFrame(measure));
	});

	function measure() {
		const el = stage?.querySelector<HTMLElement>('[data-measure]');
		if (!el || gridMode) {
			measuredCm = null;
			return;
		}
		const box = el.getBoundingClientRect();
		let width = box.width,
			height = box.height;
		if (el.dataset.measure === 'contain' && ratio > 0) {
			width = Math.min(box.width, box.height * ratio);
			height = width / ratio;
		}
		const fit = view === 'phone' ? layout.fit : 1;
		measuredCm = { width: toCm(width, pxPerCm, fit), height: toCm(height, pxPerCm, fit) };
	}

	function modal(node: HTMLDialogElement) {
		const previous = document.activeElement as HTMLElement | null;
		const overflow = document.body.style.overflow;
		let destroyed = false;
		document.body.style.overflow = 'hidden';
		void tick().then(() => {
			if (!destroyed) node.showModal();
		});
		return {
			destroy() {
				destroyed = true;
				node.close();
				document.body.style.overflow = overflow;
				if (previous?.isConnected) previous.focus();
			}
		};
	}

	function move(delta: number) {
		index = stepSlide(index, delta, items.length);
		expanded = false;
	}
	function show(next: number) {
		index = clampSlide(next, items.length);
	}
	function keyboard(event: KeyboardEvent) {
		// A native top-layer modal owns these keys, including when another modal is behind it.
		event.stopPropagation();
		const target = event.target;
		if (
			calibrating ||
			gridMode ||
			target instanceof HTMLVideoElement ||
			target instanceof HTMLSelectElement ||
			target instanceof HTMLInputElement ||
			(target instanceof HTMLElement && target.closest('[data-pan="true"]'))
		)
			return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			move(event.key === 'ArrowLeft' ? -1 : 1);
		}
	}
	function touchStart(event: TouchEvent) {
		const point = event.touches[0];
		touch =
			point && !(view === 'file' && fileActual) ? { x: point.clientX, y: point.clientY } : null;
	}
	function touchEnd(event: TouchEvent) {
		const point = event.changedTouches[0];
		if (touch && point && !(event.target instanceof HTMLVideoElement))
			move(swipeStep(point.clientX - touch.x, point.clientY - touch.y));
		touch = null;
	}
	function source(item: PreviewItem) {
		return item.previewUrl || mediaUrl(item, mediaBase);
	}
	function loaded(item: PreviewItem, width: number, height: number) {
		if (width && height && !natural[item.id]) natural[item.id] = { width, height };
		requestAnimationFrame(measure);
	}
	function choosePhone(id: string) {
		phoneId = phoneById(id).id;
		localStorage.setItem(STORE_PHONE, phoneId);
	}
	function startCalibration() {
		draftScale = pxPerCm;
		calibrating = true;
	}
	function saveCalibration() {
		const value = clampPxPerCm(draftScale);
		if (value) {
			pxPerCm = value;
			calibrated = true;
			localStorage.setItem(STORE_SCALE, String(value));
		}
		calibrating = false;
	}
	function resetCalibration() {
		localStorage.removeItem(STORE_SCALE);
		calibrated = false;
		pxPerCm = guessPxPerCm(window.innerWidth, window.matchMedia('(pointer: coarse)').matches);
		draftScale = pxPerCm;
		calibrating = false;
	}
</script>

{#if open}
	<dialog
		use:modal
		class="post-viewer"
		aria-labelledby={`${uid}-title`}
		onkeydown={keyboard}
		onanimationend={(event) => {
			// The entrance scale distorts any measurement taken while it runs.
			if (event.target === event.currentTarget) measure();
		}}
		oncancel={(event) => {
			event.preventDefault();
			event.stopPropagation();
			if (calibrating) calibrating = false;
			else onClose();
		}}
		onclick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
		data-testid="post-viewer"
		data-view={view}
	>
		<header class="viewer-bar">
			<div class="viewer-title">
				<h2 id={`${uid}-title`}>{platformLabel} preview</h2>
				<p>
					{handle ?? name}{items.length
						? ` · ${items.length} ${isVideoMedia(items[0]) ? 'video' : items.length === 1 ? 'photo' : 'photos'}`
						: ''}
				</p>
			</div>
			<div
				class="segmented"
				role="group"
				aria-label="Preview as"
				style={`--count:${VIEWS.length};--at:${VIEWS.findIndex((v) => v.id === view)}`}
			>
				<span class="segmented-thumb" aria-hidden="true"></span>
				{#each VIEWS as option (option.id)}
					<button
						type="button"
						aria-pressed={view === option.id}
						onclick={() => {
							view = option.id;
							calibrating = false;
						}}>{option.label}</button
					>
				{/each}
			</div>
			<button
				type="button"
				class="icon-button close"
				aria-label="Close post preview"
				onclick={onClose}><X size={20} /></button
			>
		</header>

		<div class="viewer-body">
			<section class="stage-column" aria-label="Preview">
				<div
					class="stage"
					class:narrow
					role="group"
					aria-roledescription="carousel"
					aria-label="Post media"
					bind:this={stage}
					bind:clientWidth={stageWidth}
					bind:clientHeight={stageHeight}
					style={view === 'phone' && narrow ? `height:${layout.frame.height}px` : undefined}
					ontouchstart={touchStart}
					ontouchend={touchEnd}
				>
					{#if !active && view !== 'file' && !shownContent}
						<p class="empty">This post has no media or caption.</p>
					{:else if view === 'phone'}
						<div
							class="device"
							class:bezel-less={narrow}
							style={`width:${layout.frame.width}px;height:${layout.frame.height}px;--px:${layout.scale};--bezel:${(narrow ? 0 : BEZEL_CM) * pxPerCm * layout.fit}px`}
						>
							<div
								class="screen"
								class:rounded={phone.homeIndicator > 0}
								class:immersive
								data-platform={platform}
								style={`width:${phone.viewport.width}px;height:${phone.viewport.height}px;transform:scale(${layout.scale});--status:${phone.statusBar}px;--home:${phone.homeIndicator}px`}
							>
								{#if immersive}{@render immersivePost(true)}{:else}{@render feedScreen()}{/if}
							</div>
						</div>
					{:else if view === 'desktop'}
						<div class="desktop" data-platform={platform}>
							{#if immersive}
								<div class="desktop-player" style={`height:${Math.min(stageHeight - 32, 780)}px`}>
									{@render immersivePost(false)}
								</div>
							{:else}
								<div class="desktop-column">{@render post()}</div>
							{/if}
						</div>
					{:else}
						<!-- Focusable so keyboard users can pan 100% media. -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							class="file-view"
							class:actual={fileActual}
							data-pan={fileActual}
							role="region"
							aria-label="Original file"
							tabindex="0"
						>
							{#if active}
								{@render mediaElement(active, 'contain', fileActual)}
							{:else}<p class="empty">This post has no media.</p>{/if}
						</div>
					{/if}

					{#if calibrating}
						<div class="calibrate" role="group" aria-labelledby={`${uid}-cal`}>
							<div
								class="card-outline"
								style={`width:${CARD_CM.width * draftScale}px;height:${CARD_CM.height * draftScale}px`}
								aria-hidden="true"
							>
								<span>Bank card</span>
							</div>
							<div class="calibrate-panel">
								<h3 id={`${uid}-cal`}>Match a bank card</h3>
								<p>
									Hold any bank or ID card flat on the screen with its corner in the outline's top
									left. Drag until the outline matches the card's edges.
								</p>
								<label class="slider">
									<span class="visually-hidden">Card outline size</span>
									<input
										type="range"
										min={PX_PER_CM_RANGE.min}
										max={PX_PER_CM_RANGE.max}
										step="0.1"
										bind:value={draftScale}
									/>
								</label>
								<div class="calibrate-actions">
									{#if calibrated}<button
											type="button"
											class="text-button"
											onclick={resetCalibration}>Reset</button
										>{/if}
									<button type="button" class="text-button" onclick={() => (calibrating = false)}
										>Cancel</button
									>
									<button type="button" class="primary" onclick={saveCalibration}>Save</button>
								</div>
							</div>
						</div>
					{/if}
				</div>

				<nav class="pager" aria-label="Media navigation">
					{#if enlarged && profile.layout === 'grid' && items.length > 1 && view !== 'file'}
						<button type="button" class="text-button" onclick={() => (enlarged = false)}
							>Back to grid</button
						>
					{:else if view === 'file' && active && !isVideoMedia(active)}
						<button
							type="button"
							class="text-button"
							aria-pressed={fileActual}
							onclick={() => (fileActual = !fileActual)}>{fileActual ? 'Fit' : '100%'}</button
						>
					{:else}<span class="pager-spacer"></span>{/if}
					{#if items.length > 1 && !gridMode}
						<div class="pager-steps">
							<button
								type="button"
								class="icon-button"
								aria-label="Previous media"
								disabled={index === 0}
								onclick={() => move(-1)}><ChevronLeft size={20} /></button
							>
							<span class="count" aria-live="polite">{index + 1} / {items.length}</span>
							<button
								type="button"
								class="icon-button"
								aria-label="Next media"
								disabled={index === items.length - 1}
								onclick={() => move(1)}><ChevronRight size={20} /></button
							>
						</div>
					{:else if gridMode}
						<span class="count">Tap a tile to open it</span>
					{/if}
					<span class="pager-spacer"></span>
				</nav>
			</section>

			<aside class="details" aria-label="Post details">
				<section class="measure" aria-label="Size on screen">
					{#if view === 'file'}
						<p class="label">Original file</p>
						<p class="figure">
							{size.width && size.height ? `${size.width} × ${size.height} px` : 'Size unknown'}
						</p>
						<p class="note">Uncropped, nothing covering it.</p>
					{:else}
						<p class="label">{view === 'phone' ? 'Media on the phone' : 'Media on desktop'}</p>
						<p class="figure">
							{measuredCm
								? formatCm(measuredCm.width, measuredCm.height)
								: gridMode
									? 'Open a tile'
									: '—'}
						</p>
						{#if view === 'phone'}
							<p class="note">
								Screen {formatCm(screen.width, screen.height)} · {phone.label}, {phone.inches}″
							</p>
						{:else}
							<p class="note">Browser at 100% zoom on a screen like yours.</p>
						{/if}
						{#if view === 'phone' && layout.fit < 0.995}
							<p class="status warn">
								Shrunk to {Math.round(layout.fit * 100)}% to fit this window. Enlarge it for true
								size.
							</p>
						{:else if calibrated}
							<p class="status ok"><Check size={14} /> True size on this screen</p>
						{:else}
							<p class="status warn">Approximate until you calibrate this screen.</p>
						{/if}
						<button type="button" class="secondary" onclick={startCalibration}
							><Ruler size={16} />{calibrated ? 'Recalibrate' : 'Calibrate screen'}</button
						>
					{/if}
				</section>

				{#if view !== 'file'}
					<section class="settings" aria-label="Display">
						{#if view === 'phone'}
							<label class="field">
								<span>Phone</span>
								<select value={phoneId} onchange={(e) => choosePhone(e.currentTarget.value)}>
									{#each PHONES as option (option.id)}<option value={option.id}
											>{option.label} · {option.inches}″</option
										>{/each}
								</select>
							</label>
						{/if}
						{#if immersive}
							<label class="switch">
								<input type="checkbox" role="switch" bind:checked={overlays} />
								<span>App buttons and caption over the media</span>
							</label>
						{/if}
					</section>
				{/if}

				{#if segments.length > 1}
					<label class="field">
						<span>Thread post</span>
						<select
							value={segment}
							onchange={(e) => {
								segment = Number(e.currentTarget.value);
								index = 0;
								expanded = false;
								enlarged = false;
							}}
						>
							{#each segments as _, i (i)}<option value={i}
									>Post {i + 1} of {segments.length}</option
								>{/each}
						</select>
					</label>
				{/if}

				<section class="copy" aria-label="Caption">
					<p class="label">{platformLabel} · {handle ?? name}</p>
					{#if title}<h3 class="copy-title">{title}</h3>{/if}
					<p class="copy-text">{shownContent || 'No caption'}</p>
				</section>
			</aside>
		</div>
	</dialog>
{/if}

{#snippet mediaElement(item: PreviewItem, fit: 'contain' | 'cover', actual = false)}
	{#key item.id}
		{#if isVideoMedia(item)}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				src={source(item)}
				poster={coverUrl(item, mediaBase) ?? undefined}
				controls
				playsinline
				preload="metadata"
				data-measure={fit}
				aria-label={item.altText || 'Attached video'}
				style={`object-fit:${fit}`}
				onloadedmetadata={(e) => {
					const el = e.currentTarget as HTMLVideoElement;
					loaded(item, el.videoWidth, el.videoHeight);
				}}
			></video>
		{:else if failed === item.id}
			<p class="empty">Image unavailable. Close and reopen the preview to retry.</p>
		{:else}
			<img
				src={source(item)}
				alt={item.altText || `Image ${index + 1}`}
				data-measure={fit}
				class:actual
				style={actual ? `width:${size.width || 1080}px` : `object-fit:${fit}`}
				onload={(e) => {
					const el = e.currentTarget as HTMLImageElement;
					loaded(item, el.naturalWidth, el.naturalHeight);
				}}
				onerror={() => (failed = item.id)}
			/>
		{/if}
	{/key}
{/snippet}

{#snippet statusBar(dark: boolean)}
	<div class="status-bar" class:dark aria-hidden="true">
		<span>9:41</span>
		<span class="status-icons"><Signal size={15} /><Wifi size={15} /><BatteryFull size={18} /></span
		>
	</div>
{/snippet}

{#snippet captionText(limit: number)}
	{#if title}<strong class="sim-title">{title}</strong>{/if}
	{#if shownContent}
		<span class="sim-caption" class:expanded>{captionPreview(shownContent, limit, expanded)}</span>
	{/if}
	{#if longCaption || (shownContent && shownContent.includes('\n'))}<button
			type="button"
			class="sim-more"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}>{expanded ? 'less' : 'more'}</button
		>{/if}
{/snippet}

{#snippet immersivePost(onPhone: boolean)}
	<div class="immersive-media" class:with-nav={onPhone}>
		{#if active}{@render mediaElement(active, 'contain')}{/if}
	</div>
	{#if onPhone}{@render statusBar(false)}{/if}
	{#if overlays}
		<div class="sim-top" aria-hidden="true">
			{#if isReel}<strong>Reels</strong>{:else}<span>Following</span><strong>For You</strong>{/if}
		</div>
		<div class="sim-rail" aria-label="Simulated app buttons">
			<span class="sim-avatar" aria-hidden="true">{Array.from(name)[0]?.toUpperCase()}</span>
			<span><Heart size={30} fill="white" /><small>0</small></span>
			<span><MessageCircle size={30} fill="white" /><small>0</small></span>
			<span><Bookmark size={28} fill="white" /><small>0</small></span>
			<span><Share2 size={28} /><small>Share</small></span>
		</div>
		<div class="sim-overlay-caption">
			<strong class="sim-handle">{handle ?? name}</strong>
			{@render captionText(profile.captionLimit)}
			{#if active && isVideoMedia(active)}<span class="sim-sound"
					><Music2 size={13} /> Original sound · {name}</span
				>{/if}
		</div>
	{/if}
	{#if items.length > 1}
		<div class="sim-dots" aria-hidden="true">
			{#each items as item, i (item.id)}<span class:on={i === index}></span>{/each}
		</div>
	{/if}
	{#if onPhone}
		<div class="sim-nav dark" aria-hidden="true">
			{#each navIcons as Icon, i (i)}<Icon size={26} />{/each}
		</div>
	{/if}
{/snippet}

{#snippet feedScreen()}
	{@render statusBar(true)}
	<div class="sim-appbar" aria-hidden="true">
		{#if platform === 'instagram'}<span class="ig-word">Instagram</span>
		{:else if platform === 'x'}<span class="x-word">𝕏</span>
		{:else if platform === 'linkedin'}<span class="li-word">in</span><span class="sim-search"
				>Search</span
			>
		{:else}<strong>{profile.name}</strong>{/if}
	</div>
	<div class="sim-feed">{@render post()}</div>
	<div class="sim-nav" aria-hidden="true">
		{#each navIcons as Icon, i (i)}<Icon size={24} />{/each}
	</div>
{/snippet}

{#snippet post()}
	<article class="sim-post" data-platform={platform}>
		<header class="sim-account">
			<span class="sim-avatar" class:square={profile.avatar === 'square'} aria-hidden="true"
				>{Array.from(name)[0]?.toUpperCase()}</span
			>
			<span class="sim-names"
				><strong>{name}</strong>{#if handle && platform !== 'instagram'}<span>{handle}</span
					>{/if}</span
			>
			<Ellipsis size={18} aria-hidden="true" />
		</header>
		{#if profile.captionFirst && (title || shownContent)}
			<p class="sim-body">{@render captionText(profile.captionLimit)}</p>
		{/if}
		{#if items.length}
			{#if gridMode}
				<div
					class="sim-grid"
					style={`grid-template-rows:repeat(${grid.rows}, minmax(0, 1fr))`}
					aria-label={`${profile.name} media layout`}
				>
					{#each gridItems as item, i (item.id)}
						<button
							type="button"
							style={`grid-column:${grid.cells[i].column};grid-row:${grid.cells[i].row}`}
							onclick={() => {
								show(i);
								enlarged = true;
							}}
							aria-label={`Open ${isVideoMedia(item) ? 'video' : 'image'} ${i + 1}`}
						>
							{#if isVideoMedia(item)}
								{#if coverUrl(item, mediaBase)}<img
										src={coverUrl(item, mediaBase)!}
										alt={item.altText || ''}
									/>{/if}
							{:else}<img src={source(item)} alt={item.altText || `Image ${i + 1}`} />{/if}
							{#if i === 3 && items.length > 4}<span class="extra">+{items.length - 4}</span>{/if}
						</button>
					{/each}
				</div>
			{:else if active}
				<div class="sim-media" style={`aspect-ratio:${feedAspect(platform, ratio)}`}>
					{@render mediaElement(active, platform === 'instagram' ? 'cover' : 'contain')}
				</div>
				{#if items.length > 1 && platform === 'instagram'}
					<div class="sim-dots inline" aria-hidden="true">
						{#each items as item, i (item.id)}<span class:on={i === index}></span>{/each}
					</div>
				{/if}
			{/if}
		{/if}
		<div class="sim-actions" aria-hidden="true">
			{#if platform === 'linkedin'}
				<span><ThumbsUp size={18} />Like</span><span><MessageCircle size={18} />Comment</span><span
					><Repeat2 size={18} />Repost</span
				><span><Send size={18} />Send</span>
			{:else if platform === 'instagram'}
				<Heart size={24} /><MessageCircle size={24} /><Send size={24} /><span class="push"
					><Bookmark size={24} /></span
				>
			{:else}
				<MessageCircle size={19} /><Repeat2 size={19} /><Heart size={19} /><Share2 size={19} />
			{/if}
		</div>
		{#if !profile.captionFirst && (title || shownContent)}
			<p class="sim-body">
				{#if platform === 'instagram'}<strong>{account.handle ?? name}</strong>{/if}
				{@render captionText(profile.captionLimit)}
			</p>
		{/if}
	</article>
{/snippet}

<style>
	.post-viewer {
		--ink: #1c1917;
		--muted: #57534e;
		--line: #e7e5e4;
		--canvas: #efedeb;
		--ease: cubic-bezier(0.2, 0.8, 0.2, 1);
		width: min(calc(100vw - 2rem), 84rem);
		height: min(94dvh, 64rem);
		max-width: none;
		max-height: none;
		margin: auto;
		padding: 0;
		border: 0;
		border-radius: 1.25rem;
		color: var(--ink);
		background: #fff;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		box-shadow: 0 30px 80px rgb(0 0 0 / 35%);
		animation: viewer-in 220ms var(--ease);
	}
	.post-viewer:not([open]) {
		display: none;
	}
	.post-viewer::backdrop {
		background: rgb(12 10 9 / 60%);
		backdrop-filter: blur(6px);
	}
	@keyframes viewer-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.985);
		}
	}

	/* Chrome */
	.viewer-bar {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 1rem;
		padding: 0.625rem 0.75rem 0.625rem 1.25rem;
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}
	.viewer-title {
		min-width: 0;
	}
	h2 {
		font-size: 1rem;
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.viewer-title p {
		font-size: 0.8125rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.close {
		justify-self: end;
	}
	button {
		cursor: pointer;
		font: inherit;
		color: inherit;
		background: none;
		touch-action: manipulation;
		transition:
			background-color 120ms,
			transform 100ms;
	}
	button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	button:active:not(:disabled) {
		transform: scale(0.97);
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible,
	.file-view:focus-visible {
		outline: 3px solid #2563eb;
		outline-offset: 2px;
	}
	.icon-button {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.icon-button:hover:not(:disabled),
	.text-button:hover:not(:disabled),
	.secondary:hover {
		background: rgb(120 113 108 / 12%);
	}
	.text-button {
		min-height: 48px;
		min-width: 48px;
		padding: 0 0.875rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.segmented {
		position: relative;
		display: grid;
		grid-template-columns: repeat(var(--count), minmax(5.5rem, 1fr));
		padding: 3px;
		border-radius: 0.875rem;
		background: #f0efee;
	}
	.segmented button {
		position: relative;
		z-index: 1;
		min-height: 48px;
		padding: 0 1rem;
		border-radius: 0.6875rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--muted);
	}
	.segmented button[aria-pressed='true'] {
		color: var(--ink);
	}
	.segmented-thumb {
		position: absolute;
		top: 3px;
		bottom: 3px;
		left: 3px;
		width: calc((100% - 6px) / var(--count));
		border-radius: 0.6875rem;
		background: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 10%),
			0 2px 8px rgb(0 0 0 / 6%);
		transform: translateX(calc(100% * var(--at)));
		transition: transform 240ms var(--ease);
	}

	/* Layout */
	.viewer-body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 21rem;
	}
	.stage-column {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--canvas);
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: center;
		overflow: hidden;
		padding: 0;
		touch-action: pan-y pinch-zoom;
	}
	.pager {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		min-height: 64px;
		padding: 0.5rem 0.75rem;
		flex-shrink: 0;
	}
	.pager-steps {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.25rem;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
	}
	.count {
		min-width: 3.5rem;
		text-align: center;
		font-size: 0.875rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.pager > .text-button {
		justify-self: start;
	}
	.empty {
		max-width: 22rem;
		padding: 2rem;
		text-align: center;
		color: var(--muted);
		line-height: 1.5;
	}

	.details {
		min-height: 0;
		overflow: auto;
		border-left: 1px solid var(--line);
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--muted);
		margin-bottom: 0.25rem;
	}
	.figure {
		font-size: 1.75rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.15;
		font-variant-numeric: tabular-nums;
	}
	.note {
		font-size: 0.8125rem;
		color: var(--muted);
		margin-top: 0.25rem;
		line-height: 1.45;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.4;
	}
	.status.ok {
		color: #15803d;
	}
	.status.warn {
		color: #a16207;
	}
	.secondary,
	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 48px;
		padding: 0 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		font-weight: 600;
	}
	.secondary {
		margin-top: 0.75rem;
		border: 1px solid #d6d3d1;
	}
	.primary {
		background: var(--ink);
		color: #fff;
	}
	.settings {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--line);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--muted);
	}
	.field select {
		min-height: 48px;
		padding: 0 0.75rem;
		border: 1px solid #d6d3d1;
		border-radius: 0.75rem;
		background: #fff;
		color: var(--ink);
		font: inherit;
		font-size: 0.9375rem;
		font-weight: 500;
	}
	.switch {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 48px;
		font-size: 0.875rem;
		cursor: pointer;
	}
	.switch input {
		appearance: none;
		flex-shrink: 0;
		position: relative;
		width: 44px;
		height: 26px;
		border-radius: 999px;
		background: #d6d3d1;
		cursor: pointer;
		transition: background-color 180ms;
	}
	.switch input::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
		transition: transform 220ms var(--ease);
	}
	.switch input:checked {
		background: var(--ink);
	}
	.switch input:checked::after {
		transform: translateX(18px);
	}
	.copy {
		padding-top: 1.25rem;
		border-top: 1px solid var(--line);
	}
	.copy-title {
		font-size: 1rem;
		font-weight: 650;
		margin-bottom: 0.5rem;
		overflow-wrap: anywhere;
	}
	.copy-text {
		font-size: 1rem;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* True-size phone */
	.device {
		position: relative;
		flex-shrink: 0;
		border-radius: calc(var(--px) * 55px + var(--bezel));
		background: #0c0a09;
		box-shadow:
			0 0 0 1px rgb(255 255 255 / 8%) inset,
			0 24px 60px rgb(0 0 0 / 22%);
	}
	.device.bezel-less {
		border-radius: 0;
		box-shadow: none;
		background: none;
	}
	.screen {
		position: absolute;
		top: var(--bezel);
		left: var(--bezel);
		transform-origin: 0 0;
		overflow: hidden;
		background: #fff;
		color: #0f0f0f;
		display: flex;
		flex-direction: column;
		font-family:
			-apple-system, BlinkMacSystemFont, 'SF Pro Text', Roboto, 'Helvetica Neue', Arial, sans-serif;
		font-size: 15px;
		line-height: 1.35;
	}
	.screen.rounded {
		border-radius: 55px;
	}
	.bezel-less .screen.rounded {
		border-radius: 0;
	}
	.screen.immersive {
		background: #000;
		color: #fff;
	}
	.status-bar {
		position: relative;
		z-index: 3;
		height: var(--status);
		flex-shrink: 0;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		padding: 0 30px 10px 36px;
		font-size: 16px;
		font-weight: 600;
		color: #fff;
	}
	.status-bar.dark {
		color: #0f0f0f;
	}
	.status-icons {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.immersive .status-bar {
		position: absolute;
		inset: 0 0 auto;
	}
	.sim-nav {
		height: calc(49px + var(--home));
		flex-shrink: 0;
		display: flex;
		justify-content: space-around;
		align-items: flex-start;
		padding-top: 10px;
		border-top: 1px solid #efefef;
		background: #fff;
		color: #0f0f0f;
	}
	.sim-nav.dark {
		position: absolute;
		inset: auto 0 0;
		z-index: 3;
		background: #000;
		color: #fff;
		border-color: #1f1f1f;
	}

	/* Immersive (TikTok, Reels): media letterboxed above the tab bar, UI floats over it. */
	.immersive-media {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: #000;
	}
	.immersive-media.with-nav {
		bottom: calc(49px + var(--home));
	}
	.immersive-media img,
	.immersive-media video {
		width: 100%;
		height: 100%;
	}
	.sim-top {
		position: absolute;
		z-index: 2;
		top: calc(var(--status, 0px) + 8px);
		left: 0;
		right: 0;
		display: flex;
		justify-content: center;
		gap: 22px;
		font-size: 17px;
		text-shadow: 0 1px 2px rgb(0 0 0 / 50%);
	}
	.sim-top span {
		opacity: 0.7;
	}
	.sim-top strong {
		font-weight: 700;
	}
	.sim-rail {
		position: absolute;
		z-index: 2;
		right: 8px;
		bottom: calc(var(--nav-offset, 0px) + 96px);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		filter: drop-shadow(0 1px 2px rgb(0 0 0 / 45%));
	}
	.screen .sim-rail,
	.screen .sim-overlay-caption,
	.screen .sim-dots {
		--nav-offset: calc(49px + var(--home));
	}
	.sim-rail > span {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.sim-rail small {
		font-size: 12px;
		font-weight: 600;
	}
	.sim-rail .sim-avatar {
		width: 46px;
		height: 46px;
		border: 2px solid #fff;
		margin-bottom: 6px;
	}
	.sim-overlay-caption {
		position: absolute;
		z-index: 2;
		left: 12px;
		right: 76px;
		bottom: calc(var(--nav-offset, 0px) + 14px);
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		font-size: 15px;
		line-height: 1.3;
		text-shadow: 0 1px 2px rgb(0 0 0 / 55%);
		max-height: 55%;
		overflow: auto;
		scrollbar-width: none;
	}
	.sim-handle {
		font-size: 16px;
	}
	.sim-sound {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		margin-top: 4px;
	}
	.sim-caption {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.sim-caption:not(.expanded) {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.sim-more {
		font-weight: 600;
		padding: 0;
		opacity: 0.8;
	}
	.sim-dots {
		position: absolute;
		z-index: 2;
		left: 0;
		right: 0;
		bottom: calc(var(--nav-offset, 0px) + 4px);
		display: flex;
		justify-content: center;
		gap: 4px;
	}
	.sim-dots span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgb(255 255 255 / 45%);
		transition: background-color 150ms;
	}
	.sim-dots span.on {
		background: #fff;
	}
	.sim-dots.inline {
		position: static;
		padding-top: 8px;
	}
	.sim-dots.inline span {
		background: #c7c7c7;
	}
	.sim-dots.inline span.on {
		background: #0095f6;
	}

	/* Feed apps */
	.sim-appbar {
		height: 44px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 16px;
		font-size: 19px;
		border-bottom: 1px solid #efefef;
	}
	.ig-word {
		font-family: 'Snell Roundhand', 'Brush Script MT', Georgia, serif;
		font-size: 27px;
		font-weight: 600;
	}
	.x-word {
		margin: 0 auto;
		font-size: 22px;
	}
	.li-word {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 4px;
		background: #0a66c2;
		color: #fff;
		font-weight: 700;
	}
	.sim-search {
		flex: 1;
		padding: 6px 12px;
		border-radius: 4px;
		background: #edf3f8;
		color: #666;
		font-size: 14px;
	}
	.sim-feed {
		flex: 1;
		min-height: 0;
		overflow: auto;
		scrollbar-width: none;
		background: #fff;
	}
	.sim-post {
		background: #fff;
		color: #0f0f0f;
		font-size: 15px;
		line-height: 1.35;
	}
	.sim-account {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
	}
	.sim-avatar {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: 50%;
		background: linear-gradient(135deg, #a8a29e, #57534e);
		color: #fff;
		font-weight: 700;
		font-size: 15px;
	}
	.sim-avatar.square {
		border-radius: 6px;
	}
	.sim-names {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		font-size: 14px;
		line-height: 1.2;
	}
	.sim-names span {
		color: #6b6b6b;
		font-size: 13px;
	}
	.sim-body {
		padding: 0 12px 10px;
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.sim-body .sim-title {
		display: block;
	}
	.sim-body strong + .sim-caption {
		margin-left: 4px;
	}
	.sim-post[data-platform='instagram'] .sim-body {
		padding-top: 2px;
		font-size: 14px;
	}
	.sim-media {
		position: relative;
		width: 100%;
		max-height: 80vh;
		background: #000;
		display: grid;
		place-items: center;
		overflow: hidden;
	}
	.sim-post:not([data-platform='instagram']):not([data-platform='linkedin']) .sim-media,
	.sim-post:not([data-platform='instagram']):not([data-platform='linkedin']) .sim-grid {
		width: calc(100% - 24px);
		margin: 0 12px;
		border-radius: 14px;
		border: 1px solid #e5e5e5;
	}
	.sim-media img,
	.sim-media video {
		width: 100%;
		height: 100%;
	}
	.sim-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		background: #e5e5e5;
	}
	.sim-grid button {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		padding: 0;
	}
	.sim-grid img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.sim-grid .extra {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 55%);
		color: #fff;
		font-size: 24px;
	}
	.sim-actions {
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 10px 14px;
	}
	.sim-post:not([data-platform='instagram']) .sim-actions {
		justify-content: space-between;
		color: #536471;
	}
	.sim-actions .push {
		margin-left: auto;
	}
	.sim-actions span {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 600;
	}

	/* Desktop */
	.desktop {
		width: 100%;
		height: 100%;
		overflow: auto;
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 1rem;
	}
	.desktop-column {
		width: 100%;
		max-width: 598px;
		border-radius: 0.75rem;
		overflow: hidden;
		box-shadow: 0 2px 16px rgb(0 0 0 / 8%);
	}
	.desktop[data-platform='instagram'] .desktop-column {
		max-width: 470px;
	}
	.desktop[data-platform='linkedin'] .desktop-column {
		max-width: 555px;
	}
	.desktop[data-platform='threads'] .desktop-column {
		max-width: 640px;
	}
	.desktop-player {
		position: relative;
		aspect-ratio: 9 / 16;
		max-width: 100%;
		border-radius: 1rem;
		overflow: hidden;
		background: #000;
		color: #fff;
		align-self: center;
	}
	.desktop:has(.desktop-column) {
		align-items: flex-start;
	}
	.desktop .sim-overlay-caption {
		font-size: 14px;
	}

	/* Original file */
	.file-view {
		width: 100%;
		height: 100%;
		overflow: auto;
		overscroll-behavior: contain;
		display: grid;
		place-items: center;
		padding: 1rem;
	}
	.file-view img,
	.file-view video {
		max-width: 100%;
		max-height: 100%;
		box-shadow: 0 2px 16px rgb(0 0 0 / 10%);
	}
	.file-view.actual {
		display: block;
		touch-action: pan-x pan-y pinch-zoom;
	}
	.file-view img.actual {
		max-width: none;
		max-height: none;
		height: auto;
	}

	/* Calibration */
	.calibrate {
		position: absolute;
		inset: 0;
		z-index: 5;
		background: rgb(255 255 255 / 96%);
		animation: fade-in 160ms ease-out;
	}
	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}
	.card-outline {
		position: absolute;
		top: 1.5rem;
		left: 1.5rem;
		border: 2px solid #2563eb;
		border-radius: 0.35rem;
		background: rgb(37 99 235 / 6%);
	}
	.card-outline span {
		position: absolute;
		left: 0.75rem;
		bottom: 0.5rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: #2563eb;
	}
	.calibrate-panel {
		position: absolute;
		left: 1.5rem;
		right: 1.5rem;
		bottom: 1.5rem;
		max-width: 30rem;
		margin-left: auto;
		padding: 1rem 1.25rem;
		border-radius: 1rem;
		background: #fff;
		box-shadow: 0 8px 30px rgb(0 0 0 / 14%);
	}
	.calibrate-panel h3 {
		font-weight: 650;
	}
	.calibrate-panel p {
		font-size: 0.875rem;
		color: var(--muted);
		line-height: 1.45;
		margin-top: 0.25rem;
	}
	.slider input {
		width: 100%;
		min-height: 48px;
		accent-color: #2563eb;
	}
	.calibrate-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* Phones: the viewer is the whole screen and details flow under the preview. */
	@media (max-width: 700px) {
		.post-viewer {
			width: 100%;
			height: 100dvh;
			border-radius: 0;
		}
		.viewer-bar {
			grid-template-columns: 1fr auto;
			padding: max(0.5rem, env(safe-area-inset-top)) 0.25rem 0.5rem 1rem;
			gap: 0.5rem 0.25rem;
		}
		.segmented {
			grid-column: 1 / -1;
			grid-row: 2;
			margin-right: 0.75rem;
		}
		.close {
			grid-column: 2;
			grid-row: 1;
		}
		.viewer-body {
			display: block;
			overflow: auto;
			overscroll-behavior: contain;
		}
		.stage-column {
			min-height: 0;
		}
		.stage {
			flex: none;
			min-height: 60dvh;
		}
		.stage.narrow {
			place-items: start center;
		}
		.post-viewer[data-view='phone'] .stage {
			min-height: 0;
		}
		.details {
			border-left: 0;
			border-top: 1px solid var(--line);
			overflow: visible;
			padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
		}
		.calibrate {
			position: fixed;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.post-viewer,
		.calibrate {
			animation: none;
		}
		.segmented-thumb,
		.switch input::after,
		button {
			transition: none;
		}
		button:active:not(:disabled) {
			transform: none;
		}
	}
</style>
