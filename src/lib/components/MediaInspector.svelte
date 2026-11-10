<script lang="ts">
	import { tick } from 'svelte';
	import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from '@lucide/svelte';
	import type { PreviewItem } from './MediaPreview.svelte';
	import { coverUrl, isVideoMedia, mediaUrl, MEDIA_BASE } from '#lib/domain/media-layout.js';

	let {
		items,
		index,
		onSelect,
		content,
		title,
		name,
		handle,
		platformName,
		mediaBase = MEDIA_BASE
	}: {
		items: PreviewItem[];
		index: number;
		onSelect: (index: number) => void;
		content: string;
		title?: string | null;
		name: string;
		handle?: string | null;
		platformName: string;
		mediaBase?: string;
	} = $props();
	let zoom = $state(0);
	let viewport = $state<HTMLDivElement>();
	let details = $state<HTMLElement>();
	let mediaSection = $state<HTMLElement>();
	let strip = $state<HTMLDivElement>();
	let natural = $state<Record<string, { width: number; height: number }>>({});
	const active = $derived(items[index]);
	const width = $derived(active?.width || (active && natural[active.id]?.width) || 0);
	const height = $derived(active?.height || (active && natural[active.id]?.height) || null);
	let touch = $state<{ x: number; y: number } | null>(null);
	let failed = $state<string | null>(null);

	$effect(() => {
		// Reset pan on slide change without stealing keyboard focus.
		if (active?.id) viewport?.scrollTo({ left: 0, top: 0 });
		failed = null;
	});
	$effect(() => {
		if (items[index] && strip) {
			const selected = strip.querySelector<HTMLElement>('[aria-current="true"]');
			if (selected) {
				const itemBox = selected.getBoundingClientRect(),
					listBox = strip.getBoundingClientRect();
				if (itemBox.right > listBox.right) strip.scrollLeft += itemBox.right - listBox.right;
				else if (itemBox.left < listBox.left) strip.scrollLeft -= listBox.left - itemBox.left;
			}
		}
	});
	function src(item: PreviewItem) {
		return item.previewUrl || mediaUrl(item, mediaBase);
	}
	function toggleZoom() {
		zoom = zoom > 0 ? 0 : 100;
	}
	function choose(next: number) {
		const focused = document.activeElement;
		onSelect(next);
		void tick().then(() => {
			// Keep arrow-key navigation alive when Next/Previous becomes disabled.
			if (focused instanceof HTMLButtonElement && focused.disabled) {
				strip
					?.querySelector<HTMLButtonElement>('[aria-current="true"]')
					?.focus({ preventScroll: true });
			}
		});
	}
</script>

<div class="inspection-layout" data-testid="media-inspector">
	<section bind:this={mediaSection} class="inspection-media" aria-label="Media inspection">
		<div class="inspection-tools">
			<span class="slide-number" aria-live="polite"
				>{items.length ? index + 1 : 0} / {items.length}</span
			>
			{#if active && !isVideoMedia(active)}
				<label class="zoom-label"
					><span>Size</span>
					<select
						aria-label="Media zoom"
						value={zoom}
						onchange={(e) => (zoom = Number(e.currentTarget.value))}
					>
						<option value={0}>Fit width</option><option value={-1}>Whole image</option><option
							value={100}>100%</option
						><option value={150}>150%</option><option value={200}>200%</option>
					</select>
				</label>
				<button
					type="button"
					onclick={toggleZoom}
					aria-label={zoom > 0 ? 'Fit media to window' : 'View media at actual size'}
					>{#if zoom > 0}<ZoomOut size={18} />{:else}<ZoomIn size={18} />{/if}<span
						>{zoom > 0 ? 'Fit width' : 'Actual size'}</span
					></button
				>
			{/if}
			<button
				class="details-jump"
				type="button"
				onclick={() => details?.scrollIntoView({ block: 'start' })}>Caption</button
			>
		</div>
		<!-- Keyboard-focusable scroll region lets keyboard users pan actual-size media. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={viewport}
			class="inspection-viewport"
			class:zoomed={zoom > 0}
			class:overview={zoom === -1}
			data-zoomed={zoom > 0}
			role="region"
			aria-label="Post media"
			tabindex="0"
			ontouchstart={(e) => {
				const p = e.touches[0];
				touch = !zoom && p ? { x: p.clientX, y: p.clientY } : null;
			}}
			ontouchend={(e) => {
				const p = e.changedTouches[0];
				if (touch && p) {
					const dx = p.clientX - touch.x,
						dy = p.clientY - touch.y;
					if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3)
						choose(Math.max(0, Math.min(items.length - 1, index + (dx < 0 ? 1 : -1))));
				}
				touch = null;
			}}
		>
			{#if active}
				{#key active.id}
					{#if isVideoMedia(active)}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							src={src(active)}
							poster={coverUrl(active, mediaBase) ?? undefined}
							controls
							playsinline
							preload="metadata"
							aria-label={active.altText || 'Attached video'}
							onloadedmetadata={(e) => {
								const video = e.currentTarget as HTMLVideoElement;
								if (video.videoWidth)
									natural[active.id] = { width: video.videoWidth, height: video.videoHeight };
							}}
						></video>
					{:else if failed === active.id}
						<p class="empty-media">Image unavailable. Close and reopen the preview to retry.</p>
					{:else}
						<img
							src={src(active)}
							alt={active.altText || `Image ${index + 1}`}
							class:actual-size={zoom > 0}
							style={zoom ? `width:${Math.round(((width || 1080) * zoom) / 100)}px;` : undefined}
							onload={(e) => {
								const img = e.currentTarget as HTMLImageElement;
								if (img.naturalWidth)
									natural[active.id] = { width: img.naturalWidth, height: img.naturalHeight };
							}}
							onerror={() => (failed = active.id)}
						/>
					{/if}
				{/key}
			{:else}<p class="empty-media">This post has no media.</p>{/if}
		</div>
		{#if items.length > 1}
			<nav class="inspection-navigation" aria-label="Media navigation">
				<button
					type="button"
					aria-label="Previous media"
					disabled={index === 0}
					onclick={() => choose(index - 1)}><ChevronLeft size={20} /><span>Previous</span></button
				>
				<div bind:this={strip} class="slide-strip" aria-label="Choose slide">
					{#each items as item, i (item.id)}<button
							type="button"
							class:chosen={i === index}
							aria-label={`Show media ${i + 1}`}
							aria-current={i === index ? 'true' : undefined}
							onclick={() => choose(i)}>{i + 1}</button
						>{/each}
				</div>
				<button
					type="button"
					aria-label="Next media"
					disabled={index === items.length - 1}
					onclick={() => choose(index + 1)}><span>Next</span><ChevronRight size={20} /></button
				>
			</nav>
		{/if}
		<p class="inspection-dimensions">
			{active
				? `${width ? `${width}${height ? ` × ${height}` : ''} px · ` : ''}Original, uncropped`
				: ''}{zoom !== -1 ? ' · Scroll to inspect' : ''}
		</p>
	</section>
	<aside bind:this={details} class="inspection-details" aria-label="Post details">
		<button
			class="details-jump details-back"
			type="button"
			onclick={() => mediaSection?.scrollIntoView({ block: 'start' })}>Back to media</button
		>
		<p class="detail-label">{platformName}</p>
		<h3>{name}</h3>
		{#if handle && handle !== name}<p class="inspection-handle">{handle}</p>{/if}
		{#if title}<div class="detail-section">
				<p class="detail-label">Photo title</p>
				<h4>{title}</h4>
			</div>{/if}
		<div class="detail-section">
			<p class="detail-label">Caption</p>
			<p class="inspection-caption">{content || 'No caption'}</p>
		</div>
	</aside>
</div>

<style>
	.inspection-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(16rem, 20rem);
		min-height: 0;
		flex: 1;
		overflow: hidden;
		background: #fff;
	}
	.inspection-media {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: #f5f5f4;
	}
	.inspection-tools {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		flex-shrink: 0;
		background: #fff;
		border-bottom: 1px solid #e7e5e4;
	}
	.slide-number {
		font-size: 0.875rem;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		margin-right: auto;
		white-space: nowrap;
	}
	.zoom-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: #57534e;
	}
	select {
		min-height: 48px;
		border: 1px solid #d6d3d1;
		border-radius: 0.625rem;
		padding: 0 0.75rem;
		font: inherit;
		color: #1c1917;
		background: #fff;
	}
	button {
		min-height: 48px;
		min-width: 48px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 0 0.75rem;
		border-radius: 0.625rem;
		color: #292524;
		font: inherit;
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
		background: transparent;
		touch-action: manipulation;
	}
	button:active:not(:disabled) {
		background: #e7e5e4;
		transform: scale(0.97);
	}
	button:hover:not(:disabled) {
		background: #e7e5e4;
	}
	button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	button:focus-visible,
	select:focus-visible,
	.inspection-viewport:focus-visible {
		outline: 3px solid #2563eb;
		outline-offset: -3px;
	}
	.inspection-viewport {
		flex: 1;
		min-height: 12rem;
		min-width: 0;
		display: block;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 1rem;
		touch-action: pan-x pan-y pinch-zoom;
	}
	.inspection-viewport img,
	.inspection-viewport video {
		display: block;
		max-width: 100%;
		max-height: none;
		width: 100%;
		height: auto;
		object-fit: contain;
		flex-shrink: 0;
	}
	.inspection-viewport.zoomed {
		display: block;
	}
	.inspection-viewport.overview {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.inspection-viewport.overview img {
		height: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.inspection-viewport video {
		height: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.details-jump {
		display: none;
	}
	.inspection-viewport img.actual-size {
		max-width: none;
		max-height: none;
		height: auto;
		object-fit: initial;
	}
	.inspection-navigation {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.5rem;
		background: #fff;
		border-top: 1px solid #e7e5e4;
		flex-shrink: 0;
	}
	.slide-strip {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: thin;
		font-variant-numeric: tabular-nums;
	}
	.slide-strip button {
		flex-shrink: 0;
	}
	.slide-strip button.chosen {
		background: #292524;
		color: #fff;
	}
	.inspection-dimensions {
		padding: 0.25rem 1rem 0.75rem;
		font-size: 0.75rem;
		color: #57534e;
		margin: 0;
		background: #fff;
		flex-shrink: 0;
	}
	.inspection-details {
		min-width: 0;
		overflow: auto;
		padding: 1.5rem;
		border-left: 1px solid #e7e5e4;
		color: #292524;
		background: #fff;
	}
	.inspection-details h3 {
		font-size: 1.125rem;
		font-weight: 650;
		margin: 0.25rem 0;
		overflow-wrap: anywhere;
	}
	.inspection-handle {
		font-size: 0.875rem;
		color: #57534e;
		overflow-wrap: anywhere;
	}
	.detail-label {
		font-size: 0.75rem;
		font-weight: 650;
		color: #57534e;
		letter-spacing: 0.03em;
		margin: 0 0 0.5rem;
	}
	.detail-section {
		margin-top: 1.5rem;
	}
	h4 {
		font-size: 1.125rem;
		font-weight: 650;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.inspection-caption {
		font-size: 1rem;
		line-height: 1.6;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin: 0;
	}
	.empty-media {
		max-width: 24rem;
		padding: 2rem;
		font-size: 1rem;
		line-height: 1.5;
		text-align: center;
		color: #57534e;
	}
	@media (max-width: 700px) {
		.details-back {
			display: inline-flex;
			margin-bottom: 1rem;
			padding: 0;
		}
		.inspection-layout {
			display: block;
			overflow: auto;
		}
		.inspection-media {
			height: calc(100dvh - 9rem);
			min-height: 24rem;
			max-height: 52rem;
		}
		.inspection-details {
			overflow: visible;
			border-left: 0;
			border-top: 1px solid #e7e5e4;
			padding: 1.25rem;
			padding-bottom: calc(1.25rem + env(safe-area-inset-bottom));
		}
		.inspection-tools {
			padding: 0.25rem 0.75rem;
			gap: 0.375rem;
		}
		.inspection-tools select {
			width: 7.5rem;
			max-width: 7.5rem;
			padding: 0 0.5rem;
		}
		.inspection-tools button span {
			display: none;
		}
		.inspection-tools .details-jump {
			display: inline-flex;
			padding: 0 0.5rem;
		}
		.zoom-label > span {
			display: none;
		}
		.inspection-tools button {
			padding: 0;
		}
		.inspection-navigation > button span {
			display: none;
		}
		.inspection-viewport {
			padding: 0.75rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		button:active:not(:disabled) {
			transform: none;
		}
	}
</style>
