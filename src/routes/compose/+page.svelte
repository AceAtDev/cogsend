<script lang="ts">
	import ComposeOverview from '#lib/components/ComposeOverview.svelte';
	import Editor from '#lib/components/Editor.svelte';

	let { data } = $props();
</script>

{#await data.overview then overview}
	{#if overview}
		<ComposeOverview {overview} reviewCount={data.reviewCount ?? 0} />
	{/if}
{/await}

<Editor
	initialConnections={data.connections}
	initialSettings={data.settings}
	initialDraft={data.draft}
	displayName={data.displayName}
	canMakeJpegCopies={data.canMakeJpegCopies}
/>
