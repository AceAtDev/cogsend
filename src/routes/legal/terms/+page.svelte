<script lang="ts">
	import LegalContact from '#lib/components/LegalContact.svelte';

	let { data } = $props();
	const f = $derived(data.facts);
</script>

<svelte:head><title>Terms of Service · {f.appName}</title></svelte:head>

<h1>Terms of Service</h1>
<p>
	These terms cover {f.appName}{f.host ? ` at ${f.host}` : ''} (“the service”), a publishing service for
	social media accounts run by its operator. It runs CogSend, open-source scheduling software (MIT licence),
	on the operator's own infrastructure.
</p>

<h2>Who uses it</h2>
<ul>
	<li>
		<strong>The operator</strong> signs in, connects accounts, and writes, schedules and publishes
		posts.
		{f.signup
			? 'Other people may sign up for an account of their own' +
				(f.signup === 'waitlist' ? ', which the operator approves,' : '') +
				' and use the service the same way for the accounts they connect; each account sees only its own posts and connected accounts, and these terms apply to them too.'
			: 'There is no public sign-up.'} The operator may use automated tools of their own to prepare and
		schedule posts through the service.
	</li>
	<li>
		<strong>Account owners</strong>, such as the operator's own brands and the creators and partner
		businesses who agree to it, connect a social account by approving the service on the platform's
		own authorization page. They do not get a login to the service.
	</li>
</ul>

<h2>What the service does</h2>
<p>
	It publishes posts with photos or videos to the connected accounts, at once or at a scheduled
	time, with the settings chosen for each post. It posts only what the operator publishes or
	schedules, and only to accounts whose owners connected them.
</p>

<h2>Responsibilities</h2>
<ul>
	<li>
		The operator publishes to a partner's account only what that partner has agreed to, and both
		follow the rules of each platform, including TikTok's
		<a href="https://www.tiktok.com/legal/page/global/terms-of-service/en">Terms of Service</a>,
		<a href="https://www.tiktok.com/community-guidelines">Community Guidelines</a>,
		<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
			>Music Usage Confirmation</a
		>
		and, for branded content,
		<a href="https://www.tiktok.com/legal/page/global/bc-policy/en">Branded Content Policy</a>.
	</li>
	<li>Content must be content its poster has the right to publish.</li>
</ul>

<h2>Connecting and disconnecting</h2>
<p>
	An account owner can withdraw the service's access at any time, in the platform's own settings (on
	TikTok, by removing the app from the apps and services allowed to use the account) or by asking
	the operator to disconnect the account. Each platform decides what it accepts and may limit, hold
	for review or remove a post; a post can take a few minutes to appear after it is sent.
</p>

<h2>No warranty</h2>
<p>
	The software is provided “as is”, without warranty of any kind, as its licence says. The operator
	does not promise that every post will be published on time or at all.
</p>

<h2>Changes and contact</h2>
<p>
	The operator may change these terms by updating this page. Questions:
	<LegalContact email={f.contactEmail} appName={f.appName} />.
</p>
