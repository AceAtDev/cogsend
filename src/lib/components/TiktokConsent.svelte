<script lang="ts">
	import { TIKTOK_BRANDED_CONTENT_URL, TIKTOK_MUSIC_USAGE_URL } from '#lib/domain/tiktok.js';

	// The declaration TikTok's guidelines require right before the publish
	// button, worded exactly as they give it.
	let { branded = false, class: className = '' }: { branded?: boolean; class?: string } = $props();
</script>

<p class="text-[11px] font-medium text-stone-500 {className}" data-testid="tiktok-consent">
	By posting, you agree to TikTok's
	{#if branded}
		<a
			href={TIKTOK_BRANDED_CONTENT_URL}
			target="_blank"
			rel="noopener noreferrer"
			class="font-bold text-stone-700 underline">Branded Content Policy</a
		>
		and
	{/if}
	<a
		href={TIKTOK_MUSIC_USAGE_URL}
		target="_blank"
		rel="noopener noreferrer"
		class="font-bold text-stone-700 underline">Music Usage Confirmation</a
	>.
</p>
