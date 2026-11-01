<script lang="ts">
	import LegalFooter from './LegalFooter.svelte';
	import logo from '#lib/assets/favicon.svg';

	let {
		facts
	}: {
		facts: {
			appName: string;
			contactEmail: string | null;
			operator?: string | null;
			tiktokMetrics?: boolean;
			signup: 'waitlist' | 'open' | null;
		};
	} = $props();

	const features = [
		{
			title: 'Write once, post everywhere',
			body: 'One composer for every connected account, with a preview and the choices each platform asks for, such as who can see a TikTok video.'
		},
		{
			title: 'Schedule ahead',
			body: 'Pick a time or a posting slot. A calendar shows what goes out when, per brand and per account.'
		},
		{
			title: 'Brands and accounts',
			body: 'Group accounts by brand and keep several accounts on the same platform apart, each with its own settings.'
		},
		{
			title: 'Review before it goes out',
			body: 'Posts drafted by AI assistants through the API wait in a review inbox, by default, until you approve them.'
		}
	];
	const platforms = ['TikTok', 'Instagram', 'Threads', 'LinkedIn', 'Bluesky', 'Mastodon', 'X'];
	const screens = [
		{
			src: '/screens/compose.webp',
			alt: 'The composer with a caption and an attached video, ready to publish or schedule.',
			caption: 'Write the post and attach a video or photos.'
		},
		{
			src: '/screens/tiktok-settings.webp',
			alt: 'TikTok post settings: who can see the video, comments, Duet, Stitch and content disclosure.',
			caption: 'Pick TikTok privacy, interactions and disclosure for each post.'
		},
		{
			src: '/screens/accounts.webp',
			alt: 'Connected accounts: two TikTok accounts and a Bluesky account.',
			caption: 'Connect your own accounts and group them by brand.'
		}
	];
</script>

<svelte:head>
	<title>{facts.appName}: schedule and publish social posts</title>
	<meta
		name="description"
		content="{facts.appName} is a social media scheduler: write a post once, preview it, and publish or schedule it to your own TikTok, Instagram, LinkedIn, Bluesky and other accounts."
	/>
</svelte:head>

<div class="min-h-dvh bg-stone-50 font-sans text-stone-900" data-testid="public-home">
	<header class="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
		<a href="/" class="flex items-center gap-2 text-[15px] font-extrabold tracking-tight">
			<img src={logo} alt="" class="h-7 w-7" />
			{facts.appName}
		</a>
		<nav class="flex items-center gap-2">
			<a
				href="/login"
				class="rounded-full px-4 py-2 text-[13px] font-bold text-stone-700 hover:bg-stone-200/60"
				data-testid="public-home-sign-in">{facts.signup ? 'Sign in' : 'Operator sign in'}</a
			>
			{#if facts.signup}
				<a
					href="/signup"
					class="rounded-full bg-stone-900 px-4 py-2 text-[13px] font-bold text-white hover:bg-stone-800"
					data-testid="public-home-sign-up"
					>{facts.signup === 'open' ? 'Sign up' : 'Join the waitlist'}</a
				>
			{/if}
		</nav>
	</header>

	<main id="main" class="mx-auto w-full max-w-5xl px-6">
		<section class="py-16 text-center sm:py-24">
			<h1 class="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-5xl">
				Plan, schedule and publish your social posts from one place.
			</h1>
			<p class="mx-auto mt-5 max-w-2xl text-[16px] leading-relaxed font-medium text-stone-600">
				{facts.appName} is a social media scheduler for creators and small businesses. Write a post once,
				preview it for each platform, and publish it now or at the time you choose, to the accounts you
				connect yourself.
			</p>
			<div class="mt-8 flex flex-wrap justify-center gap-3">
				{#if facts.signup}
					<a
						href="/signup"
						class="rounded-full bg-stone-900 px-6 py-3 text-[14px] font-bold text-white hover:bg-stone-800"
						>{facts.signup === 'open' ? 'Create a free account' : 'Join the waitlist'}</a
					>
				{/if}
				<a
					href="/login"
					class="rounded-full border border-stone-300 bg-white px-6 py-3 text-[14px] font-bold text-stone-900 hover:bg-stone-100"
					>Sign in</a
				>
			</div>
			<p class="mt-6 text-[12px] font-bold tracking-wide text-stone-500 uppercase">
				Works with {platforms.join(' · ')}
			</p>
		</section>

		<section class="pb-16" data-testid="public-home-screens">
			<h2 class="sr-only">See it in action</h2>
			<div class="grid gap-4 md:grid-cols-3">
				{#each screens as s (s.src)}
					<figure class="overflow-hidden rounded-3xl border border-stone-200 bg-white">
						<img src={s.src} alt={s.alt} loading="lazy" class="block w-full" />
						<figcaption
							class="border-t border-stone-200 px-5 py-4 text-[13px] font-bold text-stone-700"
						>
							{s.caption}
						</figcaption>
					</figure>
				{/each}
			</div>
		</section>

		<section class="grid gap-4 pb-16 sm:grid-cols-2">
			{#each features as f (f.title)}
				<div class="rounded-3xl border border-stone-200 bg-white p-6">
					<h2 class="text-[15px] font-extrabold">{f.title}</h2>
					<p class="mt-2 text-[14px] leading-relaxed font-medium text-stone-600">{f.body}</p>
				</div>
			{/each}
		</section>

		<section class="pb-16">
			<h2 class="text-2xl font-extrabold tracking-tight">How it works</h2>
			<ol class="mt-6 grid gap-4 sm:grid-cols-3">
				<li class="rounded-3xl border border-stone-200 bg-white p-6">
					<p class="text-[12px] font-extrabold text-stone-400">1</p>
					<h3 class="mt-1 text-[15px] font-extrabold">Connect your accounts</h3>
					<p class="mt-2 text-[14px] leading-relaxed font-medium text-stone-600">
						Each account is connected on the platform's own sign-in page, where you approve only the
						permissions needed to publish. Your password is never seen here.
					</p>
				</li>
				<li class="rounded-3xl border border-stone-200 bg-white p-6">
					<p class="text-[12px] font-extrabold text-stone-400">2</p>
					<h3 class="mt-1 text-[15px] font-extrabold">Write and preview</h3>
					<p class="mt-2 text-[14px] leading-relaxed font-medium text-stone-600">
						Add your text, photos or video, see how it will look, and make the choices each platform
						requires for every post.
					</p>
				</li>
				<li class="rounded-3xl border border-stone-200 bg-white p-6">
					<p class="text-[12px] font-extrabold text-stone-400">3</p>
					<h3 class="mt-1 text-[15px] font-extrabold">Publish or schedule</h3>
					<p class="mt-2 text-[14px] leading-relaxed font-medium text-stone-600">
						Nothing is posted until you publish it or pick a time. You see each post's status until
						the platform has published it.
					</p>
				</li>
			</ol>
		</section>

		<section class="rounded-3xl border border-stone-200 bg-white p-8 sm:p-10">
			<h2 class="text-2xl font-extrabold tracking-tight">Posting to TikTok</h2>
			<p class="mt-4 max-w-3xl text-[14px] leading-relaxed font-medium text-stone-600">
				With TikTok's Login Kit and Content Posting API, {facts.appName} reads a connected account's basic
				profile (name and avatar) and the posting options TikTok reports for it, and posts the videos
				you choose with the privacy, interaction and content-disclosure settings you pick for each post.
				You confirm TikTok's Music Usage Confirmation before every post.
				{facts.tiktokMetrics
					? 'After a video is posted, it reads that video’s view, like, comment and share counts so you can see how it did. It does not read your other videos, followers or messages.'
					: 'It does not read your other videos, followers or messages.'}
				You can stop this at any time by removing the app in TikTok's settings or disconnecting the account
				here.
			</p>
		</section>

		{#if facts.signup}
			<section class="py-16 text-center">
				<h2 class="text-2xl font-extrabold tracking-tight">Get started</h2>
				<p
					class="mx-auto mt-3 max-w-xl text-[14px] leading-relaxed font-medium text-stone-600"
					data-testid="public-home-signup"
				>
					{facts.signup === 'open'
						? `Anyone can sign up for an account of their own on ${facts.appName}, to connect their own social accounts and schedule their own posts. Each account sees only its own posts and connected accounts.`
						: `You can sign up to join the waitlist for an account of your own on ${facts.appName}; each one is approved by hand. Each account sees only its own posts and connected accounts.`}
				</p>
				<a
					href="/signup"
					class="mt-6 inline-block rounded-full bg-stone-900 px-6 py-3 text-[14px] font-bold text-white hover:bg-stone-800"
					>{facts.signup === 'open' ? 'Sign up' : 'Join the waitlist'}</a
				>
			</section>
		{:else}
			<div class="py-16"></div>
		{/if}
	</main>

	<footer class="border-t border-stone-200 bg-white">
		<div
			class="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-6 py-8 text-center text-[13px] font-medium text-stone-500"
		>
			<p>
				{facts.appName}{facts.operator ? ` is operated by ${facts.operator}` : ''}.
				{#if facts.contactEmail}
					Support:
					<a href="mailto:{facts.contactEmail}" class="font-bold text-stone-900 underline"
						>{facts.contactEmail}</a
					>
				{/if}
			</p>
			<LegalFooter />
		</div>
	</footer>
</div>
