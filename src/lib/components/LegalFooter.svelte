<script lang="ts">
	// In the page itself, never behind a menu: TikTok's app review wants the
	// terms and privacy policy visible from the website URL.
	let { class: className = '' }: { class?: string } = $props();
</script>

<footer
	class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] font-bold text-stone-500 {className}"
	data-testid="legal-footer"
>
	<a href="/legal/terms" class="underline hover:text-stone-900">Terms of Service</a>
	<a href="/legal/privacy" class="underline hover:text-stone-900">Privacy Policy</a>
	<a
		href="https://github.com/cogsend/cogsend"
		target="_blank"
		rel="noopener noreferrer"
		class="underline hover:text-stone-900">Source code</a
	>
</footer>
