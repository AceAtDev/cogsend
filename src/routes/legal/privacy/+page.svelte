<script lang="ts">
	import LegalContact from '#lib/components/LegalContact.svelte';

	let { data } = $props();
	const f = $derived(data.facts);
</script>

<svelte:head><title>Privacy Policy · {f.appName}</title></svelte:head>

<h1>Privacy Policy</h1>
<p>
	{f.appName}{f.host ? ` at ${f.host}` : ''} (“the service”) publishes posts to social media accounts
	connected to it by their owners: its operator's own brands, and creators and partner businesses. This
	page says what it stores about the operator and about those connected accounts, why, and how to have
	it removed. The service runs CogSend on the operator's own Cloudflare account.
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
	<li>Photos and videos attached to posts, in storage on the operator's own Cloudflare account.</li>
</ul>

<h2>How it is used</h2>
<p>
	Only to publish and schedule posts to the accounts their owners connected, and to show the
	operator how those posts did. The service asks each platform only for the permissions publishing
	needs; on TikTok that is <code>user.info.basic</code> (the profile shown when choosing where a
	post goes), <code>video.publish</code> (posting the videos chosen for the account) and
	<code>video.list</code> (reading the view, like, comment and share counts of the videos the service
	itself posted). Counts are looked up only for those videos; the service does not store the account's
	other videos, and it does not read followers or messages.
</p>

<h2>Who it is shared with</h2>
<p>
	Nobody. Nothing is sold or used for advertising. A post and its media go to a platform only when
	it is published or scheduled to an account there. Cloudflare hosts the service and processes its
	data on the operator's behalf. If the operator turns on notification emails, summaries of posts
	(failures, posts waiting for review, a daily digest) are sent to the addresses the operator
	listed, through the email account they configured.
</p>

<h2>Removing access and deleting data</h2>
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
	<li>Deleting the service deletes everything it stored.</li>
</ul>

<h2>Contact</h2>
<p>
	Questions or requests about this data, including disconnecting an account:
	<LegalContact email={f.contactEmail} appName={f.appName} />.
</p>
