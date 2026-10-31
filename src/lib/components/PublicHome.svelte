<script lang="ts">
	import LegalFooter from './LegalFooter.svelte';

	let {
		facts
	}: {
		facts: { appName: string; host: string; contactEmail: string | null };
	} = $props();
</script>

<svelte:head>
	<title>{facts.appName}</title>
	<meta
		name="description"
		content="{facts.appName} schedules and publishes posts and videos to the social accounts of its operator's brands and partners."
	/>
</svelte:head>

<main
	id="main"
	class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-16 font-sans text-stone-900"
	data-testid="public-home"
>
	<h1 class="text-4xl font-extrabold tracking-tight">{facts.appName}</h1>
	<p class="mt-4 text-[15px] leading-relaxed font-medium text-stone-600">
		{facts.appName} is a publishing service{facts.host ? ` at ${facts.host}` : ''} for social media accounts.
		Its operator plans, schedules and publishes posts and videos to the accounts connected to it: the
		brand accounts of the operator's own businesses, and the accounts of creators and partner businesses
		who choose to connect theirs. It covers Mastodon, Bluesky, LinkedIn, Threads, Instagram, TikTok and
		X, and runs
		<a
			href="https://github.com/cogsend/cogsend"
			target="_blank"
			rel="noopener noreferrer"
			class="font-bold text-stone-900 underline">CogSend</a
		>, open-source scheduling software.
	</p>

	<h2 class="mt-10 text-lg font-extrabold">How it works</h2>
	<ol
		class="mt-3 list-decimal space-y-2 pl-5 text-[14px] leading-relaxed font-medium text-stone-600"
	>
		<li>
			An account is connected through the platform's own authorization page, where the account's
			owner signs in and approves only the permissions needed to publish. Its password is never seen
			here.
		</li>
		<li>
			The operator writes a post in the composer, which previews it and asks for each platform's own
			choices, such as who can see a TikTok video, whether it allows comments, Duets and Stitches,
			and whether it promotes a brand.
		</li>
		<li>
			The operator publishes it or picks a time. Nothing is posted without that action, and the
			post's status is shown until the platform has published it.
		</li>
	</ol>

	<h2 class="mt-10 text-lg font-extrabold">TikTok</h2>
	<p class="mt-3 text-[14px] leading-relaxed font-medium text-stone-600">
		With TikTok's Login Kit and Content Posting API, {facts.appName} reads a connected account's basic
		profile (name and avatar) and the posting options TikTok reports for it, and posts the videos chosen
		for that account with the privacy, interaction and content-disclosure settings picked for each post.
		It does not read the account's other videos, followers or messages. An account owner can stop this
		at any time by removing the app in TikTok's settings, or by asking the operator to disconnect the
		account.
	</p>

	<div class="mt-10 flex flex-wrap items-center gap-3">
		<a
			href="/login"
			class="rounded-full bg-stone-900 px-5 py-2.5 text-[13px] font-bold text-white hover:bg-stone-800"
			data-testid="public-home-sign-in">Operator sign in</a
		>
		{#if facts.contactEmail}
			<span class="text-[13px] font-medium text-stone-500"
				>Contact: <a href="mailto:{facts.contactEmail}" class="font-bold text-stone-900 underline"
					>{facts.contactEmail}</a
				></span
			>
		{/if}
	</div>

	<LegalFooter class="mt-auto pt-16" />
</main>
