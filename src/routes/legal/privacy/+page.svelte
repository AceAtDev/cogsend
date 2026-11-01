<script lang="ts">
	import LegalContact from '#lib/components/LegalContact.svelte';

	let { data } = $props();
	const f = $derived(data.facts);
	const who = $derived(f.operator ?? 'its operator');
</script>

<svelte:head><title>Privacy Policy · {f.appName}</title></svelte:head>

<h1>Privacy Policy</h1>
{#if f.updated}<p class="text-stone-500">Last updated {f.updated}</p>{/if}
<p>
	{f.appName}{f.host ? ` at ${f.host}` : ''} (“the service”), run by {who} (“we”, “the operator”), publishes
	posts to social media accounts connected to it by their owners. This page says what it stores about
	the people who use it and about those connected accounts, why, and how to have it removed. The service
	runs CogSend on the operator's own Cloudflare account.
</p>

<h2>What is stored</h2>
<ul>
	<li>
		{f.signup
			? 'The sign-in of the operator and of each person who signs up'
			: "The operator's sign-in"}: email address, a hash of the password, and the two-factor secret,
		encrypted.
	</li>
	<li>
		For each connected account: the access and refresh tokens the platform issued, encrypted with
		AES-GCM under a key only this service holds, and the account's public profile details (name,
		handle, avatar, the platform's id for it). For TikTok this is the basic profile and the posting
		options TikTok reports for the account (the privacy levels offered, whether comments, Duets and
		Stitches are turned off, the longest video it may post). Passwords for connected accounts are
		never seen: they are entered on the platform's own page.
	</li>
	<li>
		Posts scheduled or published to a connected account: their text, the settings chosen for each
		post, schedules, and what the platform answered (the post's id and link, or the error).
	</li>
	<li>
		For posts the service published: the public counts the platform reports for them (views, likes,
		comments, shares), read about an hour, a day and a week after publishing.
	</li>
	<li>
		An activity log of changes made in the account (who did what, from the app or with an API key),
		kept for 90 days.
	</li>
	<li>Photos and videos attached to posts, in storage on the operator's own Cloudflare account.</li>
</ul>

<h2>How it is used</h2>
<p>
	Only to publish and schedule posts to the accounts their owners connected, and to show the account
	holder how those posts did. The service asks each platform only for the permissions it needs; on
	TikTok that is <code>user.info.basic</code> (the profile shown when choosing where a post goes)
	and
	<code>video.publish</code> (posting the videos chosen for the account){#if f.tiktokMetrics}, and <code
			>video.list</code
		> (reading the view, like, comment and share counts of the videos the service itself posted; counts
		are looked up only for those videos){/if}. It does not read a connected account's other videos,
	followers or messages, and it does not use any of this data for advertising or to train AI models.
</p>

<h2>Who it is shared with</h2>
<p>
	Nobody. Nothing is sold or used for advertising. A post and its media go to a platform only when
	it is published or scheduled to an account there. Cloudflare hosts the service and processes its
	data on the operator's behalf. If the operator turns on notification emails, summaries of posts
	(failures, posts waiting for review, a daily digest) are sent to the addresses the operator
	listed, through the email account they configured.
</p>

<h2 id="data-deletion">Removing access and deleting data</h2>
<ul>
	<li>
		An account owner can revoke access in the platform's own settings. On TikTok, remove the app in
		the TikTok app's <em>Settings and privacy</em>, under the apps and services that have permission
		to use the account. The service can then no longer post or read anything there.
	</li>
	<li>
		An account owner can also ask the operator to disconnect the account. Disconnecting deletes its
		tokens at once and cancels its unsent posts; its name and handle stay only on posts already
		published, as history.
	</li>
	<li>Deleting a post deletes its text, settings and media from the service.</li>
	<li>
		You can ask us to delete your account; we delete it with its posts, connected accounts and
		media.
	</li>
	<li>Deleting the service deletes everything it stored.</li>
</ul>

<h2>How long it is kept</h2>
<p>
	Data is kept while the account it belongs to exists, and deleted as described above. The activity
	log keeps 90 days.
</p>

<h2>Security</h2>
<p>
	Sign-in requires a password and an authenticator app. Platform tokens and passwords for connected
	services are stored encrypted, and traffic to the service uses HTTPS.
</p>

<h2>Your rights</h2>
<p>
	You can ask what we hold about you, have it corrected, receive a copy, or have it deleted, by
	writing to the address below. The service is not meant for children and does not knowingly hold
	data about anyone under 13.
</p>

<h2>Changes and contact</h2>
<p>
	We update this page and its date when what we store or how we use it changes. Questions or
	requests about this data, including disconnecting an account:
	<LegalContact email={f.contactEmail} appName={f.appName} />.
</p>
