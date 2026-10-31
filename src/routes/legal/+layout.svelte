<script lang="ts">
	import LegalFooter from '#lib/components/LegalFooter.svelte';

	let { children } = $props();
</script>

<main
	id="main"
	class="legal mx-auto w-full max-w-2xl px-6 py-14 font-sans text-[14px] leading-relaxed font-medium text-stone-700"
>
	{@render children()}
	<p class="mt-10">
		<a href="/" class="font-bold text-stone-900 underline">Back to the start page</a>
	</p>
	<LegalFooter class="mt-8" />
</main>

<style>
	.legal :global(h1) {
		font-size: 1.875rem;
		font-weight: 800;
		color: var(--color-stone-900);
		margin-bottom: 0.5rem;
	}
	.legal :global(h2) {
		font-size: 1.05rem;
		font-weight: 800;
		color: var(--color-stone-900);
		margin-top: 2rem;
		margin-bottom: 0.5rem;
	}
	.legal :global(p),
	.legal :global(ul) {
		margin-top: 0.75rem;
	}
	.legal :global(ul) {
		list-style: disc;
		padding-left: 1.25rem;
	}
	.legal :global(li) {
		margin-top: 0.35rem;
	}
	.legal :global(a) {
		text-decoration: underline;
	}
</style>
