<script lang="ts" module>
	import type { Eye } from '@lucide/svelte';

	export type MenuAction = {
		key: string;
		label: string;
		icon: typeof Eye;
		onSelect: () => void;
		tone?: 'danger' | 'primary';
		/** A line under the label, such as how many of the selection it covers. */
		hint?: string;
	};
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';

	let {
		x,
		y,
		title = null,
		subtitle = null,
		actions,
		placement = 'below',
		onClose
	}: {
		/** Viewport point to open at: the click, or the trigger's corner. */
		x: number;
		y: number;
		title?: string | null;
		subtitle?: string | null;
		actions: MenuAction[];
		/** "above" grows upward from the point, for a trigger at the bottom of the screen. */
		placement?: 'below' | 'above';
		onClose: () => void;
	} = $props();

	let menu = $state<HTMLDivElement | null>(null);
	let left = $state(0);
	let top = $state(0);

	// Kept inside the window: a post near the right or bottom edge still shows the whole menu.
	async function place() {
		await tick();
		if (!menu) return;
		const box = menu.getBoundingClientRect();
		const margin = 8;
		left = Math.max(margin, Math.min(x, window.innerWidth - box.width - margin));
		const wanted = placement === 'above' ? y - box.height : y;
		top = Math.max(margin, Math.min(wanted, window.innerHeight - box.height - margin));
	}

	onMount(() => {
		void place().then(() => menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
		const away = (event: PointerEvent) => {
			if (menu && !menu.contains(event.target as Node)) onClose();
		};
		const close = () => onClose();
		window.addEventListener('pointerdown', away, true);
		window.addEventListener('resize', close);
		window.addEventListener('scroll', close, true);
		return () => {
			window.removeEventListener('pointerdown', away, true);
			window.removeEventListener('resize', close);
			window.removeEventListener('scroll', close, true);
		};
	});

	function onKeydown(event: KeyboardEvent) {
		const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
		const index = items.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'Escape') onClose();
		else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
		else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
		else if (event.key === 'Home') items[0]?.focus();
		else if (event.key === 'End') items[items.length - 1]?.focus();
		else if (event.key !== 'Tab') return;
		if (event.key === 'Tab') onClose();
		// The page's own Escape clears the selection; closing the menu is all this one should do.
		event.stopPropagation();
		if (event.key !== 'Tab') event.preventDefault();
	}
</script>

<div
	bind:this={menu}
	role="menu"
	tabindex="-1"
	aria-label={title ?? 'Actions'}
	class="fixed z-50 w-60 rounded-2xl border border-stone-200/80 bg-white p-1.5 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.3)]"
	style="left: {left}px; top: {top}px"
	onkeydown={onKeydown}
	data-testid="calendar-action-menu"
>
	{#if title}
		<div class="border-b border-stone-100 px-2.5 pt-1.5 pb-2">
			<p class="truncate text-[12px] font-extrabold text-stone-900">{title}</p>
			{#if subtitle}
				<p class="truncate text-[11px] text-stone-500">{subtitle}</p>
			{/if}
		</div>
	{/if}
	<div class={title ? 'pt-1' : ''}>
		{#each actions as action (action.key)}
			{@const Icon = action.icon}
			<button
				type="button"
				role="menuitem"
				class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-bold transition-colors focus:outline-none {action.tone ===
				'danger'
					? 'text-red-700 hover:bg-red-50 focus:bg-red-50'
					: action.tone === 'primary'
						? 'text-violet-700 hover:bg-violet-50 focus:bg-violet-50'
						: 'text-stone-700 hover:bg-stone-50 focus:bg-stone-50'}"
				onclick={() => {
					onClose();
					action.onSelect();
				}}
				data-testid="menu-{action.key}"
			>
				<Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
				<span class="min-w-0 flex-1">
					{action.label}
					{#if action.hint}
						<span class="block text-[11px] font-medium text-stone-400">{action.hint}</span>
					{/if}
				</span>
			</button>
		{/each}
	</div>
</div>
