<script lang="ts">
	let { email, appName }: { email: string | null; appName: string } = $props();
</script>

{#if email}
	<a href="mailto:{email}" class="font-bold text-stone-900">{email}</a>
{:else}
	the operator of {appName}
{/if}
