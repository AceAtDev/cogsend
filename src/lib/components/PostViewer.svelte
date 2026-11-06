<script lang="ts">
	import { tick } from 'svelte';
	import {
		ChevronLeft,
		ChevronRight,
		X,
		Heart,
		MessageCircle,
		Repeat2,
		Send,
		Bookmark,
		Share2,
		ThumbsUp,
		MoreHorizontal,
		Music2
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

	const uid = $props.id();
	const profile = $derived(viewerProfile(platform));
	let index = $state(0);
	let expanded = $state(false);
	let enlarged = $state(false);
	let touch = $state<{ x: number; y: number } | null>(null);
	let natural = $state<Record<string, number>>({});
	let segment = $state(0);
	let device = $state<'mobile' | 'desktop'>('mobile');
	const items = $derived(segmentItems(allItems, segment, segments.length, segmentIndices));
	const shownContent = $derived(segments.length > 0 ? (segments[segment] ?? '') : content);
	const active = $derived(items[clampSlide(index, items.length)]);
	const isReel = $derived(platform === 'instagram' && items.length === 1 && isVideoMedia(items[0]));
	const gridMode = $derived(profile.layout === 'grid' && items.length > 1 && !enlarged);
	const gridItems = $derived(items.slice(0, 4));
	const grid = $derived(gridFor(gridItems.length));
	const longCaption = $derived(Array.from(shownContent).length > profile.captionLimit);
	const name = $derived(account.displayName || account.handle || 'Account');
	const ratio = $derived(active ? (aspectOf(active) ?? natural[active.id] ?? 1) : 1);

	$effect(() => {
		if (open) {
			const position = initialPosition(allItems, initialIndex, segments.length, segmentIndices);
			segment = position.segment;
			index = position.index;
			expanded = false;
			enlarged = false;
		}
	});

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
	}
	function keyboard(event: KeyboardEvent) {
		// A native top-layer modal owns these keys, including when another modal is behind it.
		event.stopPropagation();
		if (
			gridMode ||
			event.target instanceof HTMLVideoElement ||
			event.target instanceof HTMLSelectElement
		)
			return;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			move(event.key === 'ArrowLeft' ? -1 : 1);
		}
	}
	function source(item: PreviewItem) {
		return item.previewUrl || mediaUrl(item, mediaBase);
	}
</script>

{#if open}
	<dialog
		use:modal
		class="post-viewer"
		class:tiktok={platform === 'tiktok'}
		class:linkedin={platform === 'linkedin'}
		class:instagram-reel={isReel}
		class:mobile-preview={device === 'mobile'}
		class:desktop-preview={device === 'desktop'}
		aria-labelledby={`${uid}-title`}
		onkeydown={keyboard}
		oncancel={(event) => {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		}}
		onclick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
		data-testid="post-viewer"
	>
		<div class="viewer-panel">
			<div class="viewer-bar">
				<div>
					<h2 id={`${uid}-title`}>{profile.name} preview</h2>
					<p>Original-media simulation · app layout and provider crops may vary</p>
				</div>
				<button type="button" class="icon-button" aria-label="Close post preview" onclick={onClose}
					><X size={20} /></button
				>
			</div>
			<div class="device-toolbar" role="group" aria-label="Preview device">
				<button type="button" aria-pressed={device === 'mobile'} onclick={() => (device = 'mobile')}
					>Mobile</button
				>
				<button
					type="button"
					aria-pressed={device === 'desktop'}
					onclick={() => (device = 'desktop')}>Desktop</button
				>
				<span>{device === 'mobile' ? 'Mobile feed' : 'Desktop feed'}</span>
			</div>
			<article class="provider-post" data-platform={platform}>
				{#if platform === 'tiktok'}<div class="platform-top">
						<span>Following</span><strong>For You</strong>
					</div>
				{:else if platform === 'instagram'}<div class="platform-top instagram-wordmark">
						{isReel ? 'Reels' : 'Instagram'}
					</div>
				{:else if platform === 'threads'}<div class="platform-top">
						<strong>Threads</strong><span>For you</span>
					</div>
				{:else if platform === 'x'}<div class="platform-top">
						<strong>𝕏</strong><span>For you</span>
					</div>
				{:else if platform === 'linkedin'}<div class="platform-top linkedin-wordmark">
						<strong>in</strong><span>Home</span>
					</div>
				{:else if platform === 'mastodon'}<div class="platform-top">
						<strong>Mastodon</strong><span>Home</span>
					</div>
				{:else if platform === 'bluesky'}<div class="platform-top">
						<strong>Bluesky</strong><span>Following</span>
					</div>{/if}
				{#if segments.length > 1}
					<nav class="thread-nav" aria-label="Thread posts">
						<label for={`${uid}-segment`}>Post {segment + 1} of thread</label>
						<select
							id={`${uid}-segment`}
							value={segment}
							onchange={(event) => {
								segment = Number(event.currentTarget.value);
								index = 0;
								expanded = false;
								enlarged = false;
							}}
						>
							{#each segments as _, i (i)}<option value={i}
									>Post {i + 1} of {segments.length}</option
								>{/each}
						</select>
					</nav>
				{/if}
				<header class="account">
					{#if account.avatarUrl}<img
							src={account.avatarUrl}
							alt=""
							class:square={profile.avatar === 'square'}
						/>{:else}<span
							class="avatar"
							class:square={profile.avatar === 'square'}
							aria-hidden="true">{Array.from(name)[0]?.toUpperCase()}</span
						>{/if}
					<div>
						<strong>{name}</strong>{#if account.handle && account.handle !== name}<p>
								{account.handle}
							</p>{/if}
					</div>
					<span class="provider-label">{profile.name}</span>
					<MoreHorizontal size={18} aria-hidden="true" />
				</header>
				{#if profile.captionFirst}{@render caption()}{/if}
				{#if items.length}
					{#if gridMode}
						<div
							class="feed-grid"
							style={`grid-template-rows:repeat(${grid.rows}, minmax(0, 1fr))`}
							aria-label={`${profile.name} feed media layout`}
						>
							{#each gridItems as item, i (item.id)}
								<button
									type="button"
									style={`grid-column:${grid.cells[i].column};grid-row:${grid.cells[i].row}`}
									onclick={() => {
										index = i;
										enlarged = true;
									}}
									aria-label={`Enlarge ${isVideoMedia(item) ? 'video' : 'image'} ${i + 1}`}
								>
									{#if isVideoMedia(item)}
										{#if coverUrl(item, mediaBase)}<img
												src={coverUrl(item, mediaBase)!}
												alt={item.altText || ''}
											/>{/if}<span class="video-label">▶ Video</span>
									{:else}<img src={source(item)} alt={item.altText || `Image ${i + 1}`} />{/if}
									{#if i === 3 && items.length > 4}<span class="extra">+{items.length - 4}</span
										>{/if}
								</button>
							{/each}
						</div>
						<p class="media-hint">Select media to enlarge</p>
					{:else if active}
						{#if enlarged}<button
								type="button"
								class="back-button"
								onclick={() => (enlarged = false)}>← Back to feed layout</button
							>{/if}
						<div
							class="media-stage"
							style={`--media-ratio:${ratio}`}
							role="group"
							aria-roledescription="carousel"
							aria-label="Post media"
							ontouchstart={(event) => {
								const point = event.touches[0];
								touch = point ? { x: point.clientX, y: point.clientY } : null;
							}}
							ontouchend={(event) => {
								const point = event.changedTouches[0];
								if (touch && point && !(event.target instanceof HTMLVideoElement))
									move(swipeStep(point.clientX - touch.x, point.clientY - touch.y));
								touch = null;
							}}
						>
							{#key active.id}
								{#if isVideoMedia(active)}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										src={source(active)}
										poster={coverUrl(active, mediaBase) ?? undefined}
										controls
										playsinline
										preload="metadata"
										aria-label={active.altText || `Video ${index + 1}`}
										onloadedmetadata={(event) => {
											const el = event.currentTarget as HTMLVideoElement;
											if (el.videoWidth && el.videoHeight)
												natural[active.id] = el.videoWidth / el.videoHeight;
										}}
									></video>
								{:else}<img
										src={source(active)}
										alt={active.altText || `Image ${index + 1}`}
										onload={(event) => {
											const el = event.currentTarget as HTMLImageElement;
											if (el.naturalWidth && el.naturalHeight)
												natural[active.id] = el.naturalWidth / el.naturalHeight;
										}}
									/>{/if}
							{/key}
							{#if platform === 'tiktok' || isReel}<div
									class="tiktok-actions"
									aria-label={`Simulated ${isReel ? 'Reels' : 'TikTok'} actions`}
								>
									<button disabled aria-label="Like (preview only)"><Heart size={25} /></button
									><button disabled aria-label="Comments (preview only)"
										><MessageCircle size={25} /></button
									><button disabled aria-label="Save (preview only)"><Bookmark size={25} /></button
									><button disabled aria-label="Share (preview only)"><Share2 size={25} /></button>
								</div>{/if}
							{#if items.length > 1}
								<nav class="carousel-controls" aria-label="Media navigation">
									<button
										type="button"
										class="icon-button"
										aria-label="Previous media"
										disabled={index === 0}
										onclick={() => move(-1)}><ChevronLeft size={20} /></button
									>
									<div class="dots">
										{#each items as item, i (item.id)}<button
												type="button"
												class="dot-button"
												class:selected={i === index}
												aria-label={`Show media ${i + 1}`}
												aria-current={i === index ? 'true' : undefined}
												onclick={() => (index = i)}><span></span></button
											>{/each}
									</div>
									<button
										type="button"
										class="icon-button"
										aria-label="Next media"
										disabled={index === items.length - 1}
										onclick={() => move(1)}><ChevronRight size={20} /></button
									>
								</nav>
								<p class="media-count" aria-live="polite">{index + 1} / {items.length}</p>
							{/if}
						</div>
					{/if}
				{/if}
				{#if platform !== 'tiktok' && !isReel}
					<div class="platform-actions" aria-label={`Simulated ${profile.name} actions`}>
						{#if platform === 'linkedin'}
							<button disabled><ThumbsUp size={18} /><span>Like</span></button><button disabled
								><MessageCircle size={18} /><span>Comment</span></button
							><button disabled><Repeat2 size={18} /><span>Repost</span></button><button disabled
								><Send size={18} /><span>Send</span></button
							>
						{:else if platform === 'instagram'}
							<button disabled aria-label="Like (preview only)"><Heart size={23} /></button><button
								disabled
								aria-label="Comment (preview only)"><MessageCircle size={23} /></button
							><button disabled aria-label="Send (preview only)"><Send size={23} /></button><button
								class="save-action"
								disabled
								aria-label="Save (preview only)"><Bookmark size={23} /></button
							>
						{:else if platform === 'mastodon'}
							<button disabled aria-label="Reply (preview only)"><MessageCircle size={20} /></button
							><button disabled aria-label="Boost (preview only)"><Repeat2 size={20} /></button
							><button disabled aria-label="Favourite (preview only)"><Heart size={20} /></button
							><button disabled aria-label="Bookmark (preview only)"><Bookmark size={20} /></button>
						{:else}
							<button disabled aria-label="Reply (preview only)"><MessageCircle size={20} /></button
							><button disabled aria-label="Repost (preview only)"><Repeat2 size={20} /></button
							><button disabled aria-label="Like (preview only)"><Heart size={20} /></button><button
								disabled
								aria-label="Share (preview only)"><Share2 size={20} /></button
							>
						{/if}
					</div>
				{/if}
				{#if !profile.captionFirst}{@render caption()}{/if}
				{#if platform === 'tiktok' && active && isVideoMedia(active)}<div class="sound-row">
						<Music2 size={16} /><span>Original video audio</span>
					</div>{/if}
			</article>
			<div class="preview-metadata">
				{#if active && !gridMode}<span
						>{active.width && active.height
							? `${active.width} × ${active.height}px · `
							: ''}{ratio.toFixed(2)}:1 original aspect · uncropped</span
					>{:else if gridMode}<span>Feed arrangement · select a tile for original dimensions</span
					>{/if}
				<span>Platform action icons are display-only.</span>
			</div>
		</div>
	</dialog>
{/if}

{#snippet caption()}
	{#if title || shownContent}
		<div class="caption" class:expanded>
			{#if title}<h3>{title}</h3>{/if}
			{#if shownContent}<p>{captionPreview(shownContent, profile.captionLimit, expanded)}</p>{/if}
			{#if longCaption}<button
					type="button"
					aria-expanded={expanded}
					onclick={() => (expanded = !expanded)}>{expanded ? 'Show less' : 'Show more'}</button
				>{/if}
		</div>
	{/if}
{/snippet}

<style>
	.device-toolbar {
		display: flex;
		gap: 0.25rem;
		align-items: center;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid #e7e5e4;
	}
	.device-toolbar button {
		min-height: 44px;
		padding: 0 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.device-toolbar button[aria-pressed='true'] {
		background: #292524;
		color: white;
	}
	.device-toolbar span {
		margin-left: auto;
		font-size: 0.6875rem;
		color: #57534e;
	}
	.mobile-preview .provider-post {
		width: min(390px, 100%);
	}
	.desktop-preview {
		width: min(100% - 2rem, 64rem);
	}
	.desktop-preview .provider-post {
		width: min(100% - 3rem, 42rem);
	}
	.desktop-preview.tiktok .provider-post {
		max-width: 32rem;
	}
	.desktop-preview .provider-post[data-platform='instagram'] {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(15rem, 1fr);
		width: min(100% - 2rem, 54rem);
	}
	.desktop-preview .provider-post[data-platform='instagram'] .platform-top {
		grid-column: 1 / -1;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .account {
		grid-column: 2;
		grid-row: 2;
		align-self: start;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .media-stage {
		grid-column: 1;
		grid-row: 2 / 5;
		align-self: center;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .platform-actions {
		grid-column: 2;
		grid-row: 3;
		align-self: start;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .caption {
		grid-column: 2;
		grid-row: 4;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .carousel-controls {
		grid-column: 1;
		grid-row: 5;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .media-count {
		grid-column: 1;
		grid-row: 6;
	}
	.platform-top {
		display: flex;
		align-items: center;
		justify-content: space-around;
		gap: 1rem;
		min-height: 48px;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid #e7e5e4;
		font-size: 0.875rem;
	}
	.platform-top span {
		color: #57534e;
		font-size: 0.75rem;
	}
	.instagram-wordmark {
		justify-content: flex-start;
		font-family: Georgia, serif;
		font-size: 1.4rem;
		font-style: italic;
		font-weight: 700;
	}
	.linkedin-wordmark strong {
		background: #0a66c2;
		color: white;
		border-radius: 0.15rem;
		padding: 0 0.2rem;
		font-size: 1.2rem;
	}
	.platform-actions {
		display: flex;
		align-items: center;
		justify-content: space-around;
		padding: 0.25rem 0.5rem;
		border-top: 1px solid #e7e5e4;
	}
	.platform-actions button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-width: 44px;
		min-height: 44px;
		font-size: 0.7rem;
	}
	.platform-actions button:disabled,
	.tiktok-actions button:disabled {
		opacity: 0.8;
	}
	.platform-actions .save-action {
		margin-left: auto;
	}
	.provider-post[data-platform='instagram'] .platform-actions {
		justify-content: flex-start;
	}
	.provider-post[data-platform='threads'] .account {
		padding-bottom: 0.5rem;
	}
	.provider-post[data-platform='threads'] .platform-actions {
		justify-content: flex-start;
		border: 0;
	}
	.provider-post[data-platform='bluesky'] .platform-top strong {
		color: #0074d9;
	}
	.provider-post[data-platform='mastodon'] .platform-top strong {
		color: #584cc7;
	}
	.tiktok .platform-top {
		border-color: #292929;
	}
	.tiktok .platform-top span {
		color: #d6d3d1;
	}
	.tiktok .media-stage {
		position: relative;
		min-height: 0;
		aspect-ratio: 9/16;
	}
	.tiktok-actions {
		position: absolute;
		right: 0.25rem;
		bottom: 0.75rem;
		display: flex;
		flex-direction: column;
		color: white;
		filter: drop-shadow(0 1px 2px black);
	}
	.tiktok-actions button {
		width: 48px;
		height: 48px;
		display: grid;
		place-items: center;
	}
	.sound-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 1rem 1rem;
		font-size: 0.75rem;
	}
	.preview-metadata {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 0.5rem 1rem 1rem;
		font-size: 0.6875rem;
		color: #57534e;
		text-align: center;
	}
	.post-viewer {
		width: min(100% - 2rem, 48rem);
		max-height: 92dvh;
		padding: 0;
		border: 0;
		border-radius: 1.25rem;
		color: #1c1917;
		background: #f5f5f4;
		overflow: auto;
		overscroll-behavior: contain;
	}
	.post-viewer::backdrop {
		background: rgb(0 0 0 / 70%);
		backdrop-filter: blur(5px);
	}
	.viewer-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		position: sticky;
		top: 0;
		z-index: 2;
		background: #f5f5f4;
		border-bottom: 1px solid #e7e5e4;
	}
	h2 {
		font-size: 0.875rem;
		font-weight: 700;
	}
	.viewer-bar p {
		font-size: 0.6875rem;
		color: #57534e;
		margin-top: 0.15rem;
	}
	.icon-button {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		border-radius: 50%;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	button:focus-visible {
		outline: 3px solid #2563eb;
		outline-offset: -3px;
	}
	.icon-button:hover:not(:disabled) {
		background: rgb(120 113 108 / 12%);
	}
	.provider-post {
		background: white;
		margin: 1.5rem auto;
		width: min(100% - 2rem, 36rem);
		overflow: hidden;
		border: 1px solid #e7e5e4;
		border-radius: 0.875rem;
	}
	.account {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1rem;
	}
	.account img,
	.avatar {
		width: 42px;
		height: 42px;
		object-fit: cover;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.avatar {
		display: grid;
		place-items: center;
		background: #e7e5e4;
		color: #44403c;
		font-weight: 700;
	}
	.account .square {
		border-radius: 0.3rem;
	}
	.account strong {
		font-size: 0.875rem;
	}
	.account p {
		font-size: 0.75rem;
		color: #57534e;
		overflow-wrap: anywhere;
	}
	.provider-label {
		margin-left: auto;
		font-size: 0.6875rem;
		color: #57534e;
	}
	.thread-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid #e7e5e4;
		font-size: 0.75rem;
	}
	.thread-nav select {
		min-height: 44px;
		max-width: 60%;
		border: 1px solid #a8a29e;
		border-radius: 0.4rem;
		padding: 0 0.5rem;
		background: white;
		color: #1c1917;
	}
	.caption {
		padding: 0 1rem 1rem;
		overflow-wrap: anywhere;
	}
	.caption h3 {
		font-weight: 700;
		margin-bottom: 0.5rem;
	}
	.caption p {
		white-space: pre-wrap;
		font-size: 0.9375rem;
		line-height: 1.55;
	}
	.caption button {
		font-size: 0.8125rem;
		color: #57534e;
		min-height: 44px;
		text-decoration: underline;
	}
	.media-stage {
		background: #0c0a09;
		width: 100%;
		aspect-ratio: var(--media-ratio);
		max-height: 64dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		touch-action: pan-y pinch-zoom;
	}
	.media-stage img,
	.media-stage video {
		width: 100%;
		height: 100%;
		max-height: 64dvh;
		object-fit: contain;
	}
	.feed-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		height: min(54dvh, 25rem);
		background: #e7e5e4;
	}
	.feed-grid button {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: #0c0a09;
	}
	.feed-grid img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.video-label,
	.extra {
		position: absolute;
		inset: auto 0 0;
		padding: 0.5rem;
		background: rgb(0 0 0 / 60%);
		color: white;
		font-size: 0.75rem;
	}
	.extra {
		inset: 0;
		display: grid;
		place-items: center;
		font-size: 1.5rem;
	}
	.media-hint,
	.media-count {
		text-align: center;
		font-size: 0.6875rem;
		color: #57534e;
		padding: 0.4rem 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	.back-button {
		min-height: 44px;
		padding: 0 1rem;
		font-size: 0.75rem;
		text-decoration: underline;
	}
	.carousel-controls {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.25rem 0.5rem;
		gap: 0.25rem;
	}
	.dots {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		max-width: calc(100% - 96px);
	}
	.dot-button {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
	}
	.dot-button span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #a8a29e;
		transition: transform 0.15s;
	}
	.dot-button.selected span {
		background: #1c1917;
		transform: scale(1.4);
	}
	.tiktok .provider-post {
		max-width: 25rem;
		background: #141414;
		color: #fff;
		border-color: #292929;
	}
	.tiktok .account p,
	.tiktok .provider-label,
	.tiktok .media-count {
		color: #d6d3d1;
	}
	.tiktok .caption {
		padding-top: 0.75rem;
	}
	.tiktok .caption button {
		color: #d6d3d1;
	}
	.tiktok .dot-button.selected span {
		background: white;
	}
	.linkedin .provider-post {
		border-radius: 0.375rem;
	}
	@media (max-width: 600px) {
		.post-viewer {
			width: 100%;
			max-width: 100%;
			max-height: 100dvh;
			height: 100dvh;
			margin: 0;
			border-radius: 0;
		}
		.provider-post {
			width: 100%;
			margin: 0;
			border-radius: 0;
			border: 0;
		}
		.viewer-bar {
			padding-top: max(0.5rem, env(safe-area-inset-top));
		}
		.viewer-panel {
			padding-bottom: env(safe-area-inset-bottom);
		}
		.media-stage,
		.media-stage img,
		.media-stage video {
			max-height: 62dvh;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot-button span {
			transition: none;
		}
	}
	/* The preview shell and the simulated device share a viewport budget. */
	.post-viewer {
		--viewer-height: 92dvh;
	}
	.provider-post {
		margin-block: 0.5rem;
	}
	.media-stage {
		position: relative;
	}
	.media-stage .carousel-controls {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 2;
		color: white;
		background: linear-gradient(transparent, rgb(0 0 0 / 80%));
	}
	.media-stage .dots {
		flex-wrap: nowrap;
		overflow-x: auto;
	}
	.media-stage .dot-button {
		flex: 0 0 24px;
	}
	.media-stage .dot-button.selected span {
		background: white;
	}
	.media-stage .media-count {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		border-radius: 1rem;
		background: rgb(0 0 0 / 65%);
		color: white;
	}
	.caption:not(.expanded) p {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	.caption h3 {
		font-size: 0.875rem;
		line-height: 1.3;
		margin-bottom: 0.25rem;
	}
	.provider-post[data-platform='instagram'] {
		display: flex;
		flex-direction: column;
		max-height: calc(var(--viewer-height) - 180px);
	}
	.provider-post[data-platform='instagram'] .platform-top {
		display: none;
	}
	.provider-post[data-platform='instagram'] .account {
		padding: 0.375rem 0.75rem;
	}
	.provider-post[data-platform='instagram'] .media-stage {
		min-height: 0;
		flex: 1 1 auto;
		max-height: calc(var(--viewer-height) - 400px);
	}
	.provider-post[data-platform='instagram'] .media-stage img,
	.provider-post[data-platform='instagram'] .media-stage video {
		min-height: 0;
		max-height: inherit;
	}
	.provider-post[data-platform='instagram'] .caption {
		flex-shrink: 0;
		padding: 0 0.75rem 0.5rem;
	}
	.provider-post[data-platform='instagram'] .caption p {
		font-size: 0.8125rem;
		line-height: 1.4;
	}
	.provider-post[data-platform='instagram'] .caption.expanded {
		max-height: 35dvh;
		overflow: auto;
		flex-shrink: 1;
	}
	.desktop-preview .provider-post[data-platform='instagram'] {
		grid-template-rows: auto auto minmax(0, 1fr);
	}
	.desktop-preview .provider-post[data-platform='instagram'] .media-stage {
		grid-row: 1 / 4;
		max-height: calc(var(--viewer-height) - 200px);
		align-self: stretch;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .account {
		grid-row: 1;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .platform-actions {
		grid-row: 2;
	}
	.desktop-preview .provider-post[data-platform='instagram'] .caption {
		grid-row: 3;
	}
	.tiktok .provider-post,
	.desktop-preview.tiktok .provider-post {
		position: relative;
		height: calc(var(--viewer-height) - 188px);
		width: min(100%, calc((var(--viewer-height) - 188px) * 9 / 16));
		max-width: 390px;
		isolation: isolate;
	}
	.tiktok .media-stage {
		height: 100%;
		max-height: none;
		aspect-ratio: 9 / 16;
	}
	.tiktok .media-stage img,
	.tiktok .media-stage video {
		height: 100%;
		max-height: none;
	}
	.tiktok .platform-top {
		position: absolute;
		inset: 0 0 auto;
		z-index: 3;
		border: 0;
		background: linear-gradient(rgb(0 0 0 / 65%), transparent);
	}
	.tiktok .account {
		position: absolute;
		left: 0.75rem;
		bottom: 164px;
		right: 3.25rem;
		z-index: 3;
		padding: 0;
		gap: 0.4rem;
		text-shadow: 0 1px 3px black;
	}
	.tiktok .account img,
	.tiktok .avatar {
		width: 28px;
		height: 28px;
	}
	.tiktok .account p,
	.tiktok .provider-label,
	.tiktok .account :global(svg) {
		display: none;
	}
	.tiktok .caption {
		position: absolute;
		inset: auto 3rem 52px 0;
		z-index: 3;
		padding: 0.5rem 0.75rem;
		background: linear-gradient(transparent, rgb(0 0 0 / 75%));
		text-shadow: 0 1px 3px black;
		max-height: 112px;
		overflow: auto;
	}
	.tiktok .caption p {
		font-size: 0.75rem;
		line-height: 1.35;
	}
	.tiktok .caption.expanded {
		max-height: 55%;
		background: rgb(0 0 0 / 85%);
	}
	.tiktok .caption button {
		font-size: 0.75rem;
		color: white;
	}
	.tiktok-actions {
		bottom: 56px;
		right: 0;
	}
	.tiktok-actions button {
		width: 44px;
		height: 44px;
	}
	.tiktok .sound-row {
		position: absolute;
		left: 0.75rem;
		bottom: 48px;
		z-index: 4;
		padding: 0;
		font-size: 0.625rem;
	}
	.instagram-reel .provider-post[data-platform='instagram'] .platform-top {
		display: flex;
		min-height: 36px;
	}
	.instagram-reel .provider-post[data-platform='instagram'] .media-stage {
		aspect-ratio: 9 / 16;
		height: calc(var(--viewer-height) - 400px);
		flex: 0 1 auto;
	}
	.instagram-reel .tiktok-actions {
		bottom: 40px;
	}
	.desktop-preview.instagram-reel .provider-post[data-platform='instagram'] .platform-top {
		grid-column: 2;
		grid-row: 1;
	}
	.desktop-preview.instagram-reel .provider-post[data-platform='instagram'] .account {
		grid-row: 2;
	}
	.desktop-preview.instagram-reel .provider-post[data-platform='instagram'] .media-stage {
		height: calc(var(--viewer-height) - 220px);
	}
	@media (max-width: 600px) {
		.post-viewer {
			--viewer-height: 100dvh;
		}
		.desktop-preview .provider-post[data-platform='instagram'] {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			width: 100%;
		}
		.desktop-preview .provider-post[data-platform='instagram'] .account {
			flex-wrap: wrap;
		}
		.device-toolbar span {
			display: none;
		}
	}
	.desktop-preview.tiktok .provider-post {
		display: grid;
		width: min(100% - 2rem, 52rem);
		max-width: none;
		height: calc(var(--viewer-height) - 188px);
		grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		grid-template-rows: auto auto 1fr;
		aspect-ratio: auto;
	}
	.desktop-preview.tiktok .provider-post .platform-top {
		position: static;
		grid-column: 1 / 3;
		grid-row: 1;
	}
	.desktop-preview.tiktok .provider-post .account {
		position: static;
		grid-column: 2;
		grid-row: 2;
		width: auto;
		max-width: 100%;
		padding: 1rem;
		background: transparent;
	}
	.desktop-preview.tiktok .provider-post .caption {
		position: static;
		grid-column: 2;
		grid-row: 3;
		align-self: start;
		width: auto;
		max-height: 100%;
		overflow: auto;
		padding: 1rem;
		background: transparent;
	}
	.desktop-preview.tiktok .provider-post .media-stage {
		position: relative;
		grid-column: 1;
		grid-row: 2 / 4;
		width: 100%;
		height: 100%;
		min-height: 0;
		max-height: none;
		aspect-ratio: auto;
	}
</style>
