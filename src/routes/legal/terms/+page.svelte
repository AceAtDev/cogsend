<script lang="ts">
	import LegalContact from '#lib/components/LegalContact.svelte';

	let { data } = $props();
	const f = $derived(data.facts);
	const who = $derived(f.operator ?? 'its operator');
</script>

<svelte:head><title>Terms of Service · {f.appName}</title></svelte:head>

<h1>Terms of Service</h1>
{#if f.updated}<p class="text-stone-500">Last updated {f.updated}</p>{/if}
<p>
	These terms cover {f.appName}{f.host ? ` at ${f.host}` : ''} (“the service”), a publishing service for
	social media accounts run by {who} (“we”, “the operator”). It runs CogSend, open-source scheduling software
	(MIT licence), on the operator's own infrastructure. By using the service you agree to these terms.
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
			: 'There is no public sign-up.'}
	</li>
	<li>
		<strong>Account owners</strong>, such as the operator's own brands and the creators and partner
		businesses who agree to it, connect a social account by approving the service on the platform's
		own authorization page.
	</li>
	<li>You must be at least 18, or the age of majority where you live, to hold an account.</li>
</ul>

<h2>What the service does</h2>
<p>
	It publishes posts with photos or videos to the connected accounts, at once or at a scheduled
	time, with the settings chosen for each post. It posts only what an account holder publishes or
	schedules, and only to accounts whose owners connected them. Posts prepared with automated tools,
	such as AI assistants using the service's API, wait for the account holder's review by default;
	the account holder stays responsible for everything published from their account.
</p>

<h2>Your responsibilities</h2>
<ul>
	<li>
		Publish only content you have the right to publish, and to a partner's account only what that
		partner has agreed to.
	</li>
	<li>
		Follow the rules of each platform you post to, including TikTok's
		<a href="https://www.tiktok.com/legal/page/global/terms-of-service/en">Terms of Service</a>,
		<a href="https://www.tiktok.com/community-guidelines">Community Guidelines</a>,
		<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
			>Music Usage Confirmation</a
		>
		and, for branded content,
		<a href="https://www.tiktok.com/legal/page/global/bc-policy/en">Branded Content Policy</a>.
	</li>
	<li>
		Do not use the service for spam, for misleading or unlawful content, to post to accounts you do
		not control, or to get around a platform's limits.
	</li>
	<li>Keep your sign-in and API keys secret; you are responsible for what is done with them.</li>
</ul>

<h2>Connecting and disconnecting</h2>
<p>
	An account owner can withdraw the service's access at any time, in the platform's own settings (on
	TikTok, by removing the app from the apps and services allowed to use the account), by
	disconnecting the account in the service, or by asking us. Each platform decides what it accepts
	and may limit, hold for review or remove a post; a post can take a few minutes to appear after it
	is sent.
</p>

<h2>Suspension and closing an account</h2>
<p>
	We may suspend or close an account that breaks these terms or a platform's rules, or to protect
	the service and its users. You can stop using the service and ask us to delete your account at any
	time.
</p>

<h2>No warranty, limited liability</h2>
<p>
	The service and its software are provided “as is”, without warranty of any kind. We do not promise
	that every post will be published on time or at all. To the extent the law allows, we are not
	liable for indirect or consequential losses, or for lost posts, reach or revenue, arising from the
	use of the service.
</p>

{#if f.jurisdiction}
	<h2>Governing law</h2>
	<p>These terms are governed by the laws of {f.jurisdiction}.</p>
{/if}

<h2>Changes and contact</h2>
<p>
	We may change these terms by updating this page and its date. Questions or support:
	<LegalContact email={f.contactEmail} appName={f.appName} />.
</p>
