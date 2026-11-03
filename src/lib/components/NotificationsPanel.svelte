<script lang="ts">
	import { onMount } from 'svelte';
	import { formatDistanceToNow } from 'date-fns';
	import { docsLinks } from '#lib/domain/docs-links.js';
	import {
		NOTIFICATION_KINDS,
		NOTIFICATION_KIND_LABELS,
		type NotificationKind
	} from '#lib/domain/notifications.js';
	import { sessionExpiredIfUnauthorized } from '#lib/components/session-expired.js';

	type Settings = {
		enabled: boolean;
		provider: 'gmail' | 'resend';
		senderEmail: string | null;
		hasAppPassword: boolean;
		smtpPort: number;
		digestTime: string;
		lastTestAt: string | null;
		lastSentAt: string | null;
		lastError: string | null;
		lastErrorAt: string | null;
		resendAvailable: boolean;
		resendFrom: string | null;
	};
	type Recipient = { id: string; email: string; subscriptions: NotificationKind[] };

	let settings = $state<Settings | null>(null);
	let recipients = $state<Recipient[]>([]);
	let timezone = $state('UTC');
	let loadError = $state<string | null>(null);

	let provider = $state<'gmail' | 'resend'>('gmail');
	let senderEmail = $state('');
	let appPassword = $state('');
	let smtpPort = $state(465);
	let digestTime = $state('08:00');
	let senderBusy = $state(false);
	let senderMessage = $state<{ ok: boolean; text: string } | null>(null);
	let testBusy = $state(false);
	let testMessage = $state<{ ok: boolean; text: string } | null>(null);
	let newRecipient = $state('');
	let recipientBusy = $state(false);
	let recipientError = $state<string | null>(null);

	const inputClass =
		'w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 shadow-sm focus:border-stone-900 focus:bg-white focus:ring-2 focus:ring-stone-900 focus:outline-none disabled:opacity-50 pointer-coarse:text-base';
	const labelClass = 'mb-2 block text-[11px] font-bold tracking-widest text-stone-500 uppercase';

	function apply(next: Settings) {
		settings = next;
		provider = next.provider;
		senderEmail = next.senderEmail ?? '';
		smtpPort = next.smtpPort;
		digestTime = next.digestTime;
		appPassword = '';
	}

	async function errorOf(res: Response): Promise<string> {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		return body?.error ?? `Request failed (${res.status})`;
	}

	async function load() {
		loadError = null;
		const res = await fetch('/api/notifications');
		if (sessionExpiredIfUnauthorized(res)) return;
		if (!res.ok) {
			loadError = await errorOf(res);
			return;
		}
		const body = (await res.json()) as {
			settings: Settings;
			recipients: Recipient[];
			timezone: string;
		};
		apply(body.settings);
		recipients = body.recipients;
		timezone = body.timezone;
	}

	/** A request that never answered or answered with something unreadable, in words. */
	function networkProblem(err: unknown): string {
		return err instanceof Error && err.name === 'AbortError'
			? 'No answer from CogSend in time. Try again.'
			: 'Could not reach CogSend. Check the connection and try again.';
	}

	async function patch(body: Record<string, unknown>): Promise<string | null> {
		try {
			const res = await fetch('/api/notifications', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (sessionExpiredIfUnauthorized(res)) return 'Signed out';
			if (!res.ok) return await errorOf(res);
			apply(((await res.json()) as { settings: Settings }).settings);
			return null;
		} catch (err) {
			return networkProblem(err);
		}
	}

	/** True when the sender fields hold something the server has not saved yet. */
	function senderUnsaved(): boolean {
		if (provider !== (settings?.provider ?? 'gmail')) return true;
		if (provider !== 'gmail') return false;
		return (
			Boolean(appPassword.trim()) ||
			senderEmail.trim() !== (settings?.senderEmail ?? '') ||
			smtpPort !== settings?.smtpPort
		);
	}

	function senderBody(): Record<string, unknown> {
		const body: Record<string, unknown> = { provider };
		if (provider === 'gmail') {
			body.senderEmail = senderEmail.trim();
			body.smtpPort = smtpPort;
			if (appPassword.trim()) body.appPassword = appPassword;
		}
		return body;
	}

	async function saveSender(e: Event) {
		e.preventDefault();
		senderBusy = true;
		senderMessage = null;
		try {
			const problem = await patch(senderBody());
			senderMessage = problem ? { ok: false, text: problem } : { ok: true, text: 'Saved' };
		} finally {
			senderBusy = false;
		}
	}

	async function forgetSender() {
		senderBusy = true;
		const res = await fetch('/api/notifications', { method: 'DELETE' });
		if (res.ok) apply(((await res.json()) as { settings: Settings }).settings);
		senderMessage = res.ok
			? { ok: true, text: 'Sender removed' }
			: { ok: false, text: await errorOf(res) };
		senderBusy = false;
	}

	async function saveSchedule(e: Event) {
		e.preventDefault();
		const problem = await patch({ digestTime });
		senderMessage = problem
			? { ok: false, text: problem }
			: { ok: true, text: 'Digest time saved' };
	}

	async function setEnabled(on: boolean) {
		const problem = await patch({ enabled: on });
		if (problem) senderMessage = { ok: false, text: problem };
	}

	// The server gives Gmail about 45 s in all; past this the request is lost.
	const TEST_TIMEOUT_MS = 60_000;

	async function sendTest() {
		testBusy = true;
		testMessage = null;
		try {
			// What is typed is what gets tested: save it first, as Save sender would.
			if (senderUnsaved()) {
				const problem = await patch(senderBody());
				if (problem) {
					testMessage = { ok: false, text: problem };
					return;
				}
			}
			const res = await fetch('/api/notifications/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
				signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
			});
			if (sessionExpiredIfUnauthorized(res)) return;
			if (res.ok) {
				const body = (await res.json()) as { sentTo: string[] };
				testMessage = { ok: true, text: `Sent to ${body.sentTo.join(', ')}` };
			} else {
				testMessage = { ok: false, text: await errorOf(res) };
			}
		} catch (err) {
			testMessage = { ok: false, text: networkProblem(err) };
		} finally {
			testBusy = false;
			void load().catch(() => {});
		}
	}

	async function addRecipient(e: Event) {
		e.preventDefault();
		recipientBusy = true;
		recipientError = null;
		const res = await fetch('/api/notifications/recipients', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: newRecipient })
		});
		if (res.ok) {
			const body = (await res.json()) as { recipient: Recipient };
			recipients = [...recipients, body.recipient];
			newRecipient = '';
		} else {
			recipientError = await errorOf(res);
		}
		recipientBusy = false;
	}

	async function toggle(recipient: Recipient, kind: NotificationKind) {
		const next = recipient.subscriptions.includes(kind)
			? recipient.subscriptions.filter((k) => k !== kind)
			: [...recipient.subscriptions, kind];
		const res = await fetch(`/api/notifications/recipients/${recipient.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ subscriptions: next })
		});
		if (!res.ok) {
			recipientError = await errorOf(res);
			return;
		}
		const body = (await res.json()) as { recipient: Recipient };
		recipients = recipients.map((r) => (r.id === recipient.id ? body.recipient : r));
	}

	async function remove(recipient: Recipient) {
		const res = await fetch(`/api/notifications/recipients/${recipient.id}`, { method: 'DELETE' });
		if (res.ok) recipients = recipients.filter((r) => r.id !== recipient.id);
		else recipientError = await errorOf(res);
	}

	function ago(iso: string | null): string {
		return iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : '';
	}

	onMount(() => {
		void load();
	});
</script>

<div
	id="notifications"
	class="min-w-0 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
	data-testid="notifications-section"
>
	<div class="mb-2 flex items-center justify-between gap-4">
		<h2 class="text-[17px] font-extrabold tracking-tight text-stone-900">Email notifications</h2>
		{#if settings}
			<button
				type="button"
				role="switch"
				aria-checked={settings.enabled}
				aria-label="Send notification emails"
				onclick={() => void setEnabled(!settings?.enabled)}
				class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors {settings.enabled
					? 'bg-stone-900'
					: 'bg-stone-200'}"
			>
				<span
					class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition {settings.enabled
						? 'translate-x-4'
						: 'translate-x-0'}"
				></span>
			</button>
		{/if}
	</div>
	<p class="mb-6 max-w-md text-[13px] leading-relaxed font-medium text-stone-500">
		A daily digest and prompt alerts, sent from a Gmail account you own with an app password. Use a
		dedicated Gmail account for this: an app password opens the whole mailbox. See the
		<a
			href={docsLinks.notifications}
			target="_blank"
			rel="noopener noreferrer"
			class="font-bold text-stone-700 underline">setup guide</a
		>.
	</p>

	{#if loadError}
		<p class="text-[13px] font-bold text-red-700" role="alert">{loadError}</p>
	{:else if !settings}
		<p class="text-[13px] font-medium text-stone-500">Loading…</p>
	{:else}
		<form class="space-y-4" onsubmit={saveSender}>
			{#if settings.resendAvailable}
				<div class="flex gap-4 text-[13px] font-bold text-stone-700" role="radiogroup">
					<label class="flex items-center gap-2"
						><input type="radio" bind:group={provider} value="gmail" /> Gmail</label
					>
					<label class="flex items-center gap-2"
						><input type="radio" bind:group={provider} value="resend" /> Resend ({settings.resendFrom})</label
					>
				</div>
			{/if}
			{#if provider === 'gmail'}
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label for="notify-sender" class={labelClass}>Gmail address</label>
						<input
							id="notify-sender"
							type="email"
							bind:value={senderEmail}
							placeholder="cogsend.notifier@gmail.com"
							autocomplete="off"
							class={inputClass}
						/>
					</div>
					<div>
						<label for="notify-password" class={labelClass}>App password</label>
						<input
							id="notify-password"
							type="password"
							bind:value={appPassword}
							placeholder={settings.hasAppPassword
								? 'Stored — paste to replace'
								: 'xxxx xxxx xxxx xxxx'}
							autocomplete="new-password"
							class={inputClass}
						/>
					</div>
				</div>
				<div class="max-w-xs">
					<label for="notify-port" class={labelClass}>Port</label>
					<select id="notify-port" bind:value={smtpPort} class={inputClass}>
						<option value={465}>465 (TLS)</option>
						<option value={587}>587 (STARTTLS)</option>
					</select>
				</div>
			{/if}
			<div class="flex flex-wrap items-center gap-3">
				<button
					type="submit"
					disabled={senderBusy}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					>Save sender</button
				>
				<button
					type="button"
					onclick={() => void sendTest()}
					disabled={testBusy}
					class="rounded-full border border-stone-300 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50"
					>{testBusy ? 'Sending…' : 'Send test email'}</button
				>
				{#if provider === 'gmail' && settings.senderEmail}
					<button
						type="button"
						onclick={() => void forgetSender()}
						disabled={senderBusy}
						class="text-[13px] font-bold text-stone-500 underline hover:text-stone-800"
						>Remove sender</button
					>
				{/if}
			</div>
			{#if senderMessage}
				<p
					class="text-[13px] font-bold {senderMessage.ok ? 'text-emerald-700' : 'text-red-700'}"
					role="status"
				>
					{senderMessage.text}
				</p>
			{/if}
			{#if testMessage}
				<p
					class="text-[13px] font-bold break-words {testMessage.ok
						? 'text-emerald-700'
						: 'text-red-700'}"
					role="status"
				>
					{testMessage.text}
				</p>
			{:else if settings.lastError}
				<p class="text-[13px] font-medium break-words text-red-700">
					Last attempt failed {ago(settings.lastErrorAt)}: {settings.lastError}
				</p>
			{:else if settings.lastSentAt}
				<p class="text-[12px] font-medium text-stone-500">
					Last email sent {ago(settings.lastSentAt)}.
				</p>
			{/if}
		</form>

		<form
			class="mt-8 flex flex-wrap items-end gap-3 border-t border-stone-100 pt-6"
			onsubmit={saveSchedule}
		>
			<div>
				<label for="notify-digest" class={labelClass}>Daily digest at</label>
				<input id="notify-digest" type="time" bind:value={digestTime} class={inputClass} />
			</div>
			<button
				type="submit"
				class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
				>Save time</button
			>
			<p class="w-full text-[11px] font-medium text-stone-500">Your time zone: {timezone}.</p>
		</form>

		<div class="mt-8 border-t border-stone-100 pt-6">
			<h3 class={labelClass}>Recipients</h3>
			{#if !recipients.length}
				<p class="mb-4 text-[13px] font-medium text-stone-500">
					Nobody yet. Add the addresses that should hear about this account.
				</p>
			{/if}
			<ul class="space-y-4">
				{#each recipients as recipient (recipient.id)}
					<li class="rounded-xl border border-stone-200/80 p-3">
						<div class="mb-2 flex items-center justify-between gap-3">
							<span class="truncate text-[13px] font-bold text-stone-900">{recipient.email}</span>
							<button
								type="button"
								onclick={() => void remove(recipient)}
								aria-label="Remove {recipient.email}"
								class="text-[12px] font-bold text-stone-500 underline hover:text-red-700"
								>Remove</button
							>
						</div>
						<div class="flex flex-wrap gap-2">
							{#each NOTIFICATION_KINDS as kind (kind)}
								{@const on = recipient.subscriptions.includes(kind)}
								<button
									type="button"
									aria-pressed={on}
									title={NOTIFICATION_KIND_LABELS[kind].hint}
									onclick={() => void toggle(recipient, kind)}
									class="rounded-full border px-3 py-1 text-[12px] font-bold transition-colors {on
										? 'border-stone-900 bg-stone-900 text-white'
										: 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'}"
									>{NOTIFICATION_KIND_LABELS[kind].label}</button
								>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
			<form class="mt-4 flex flex-wrap gap-3" onsubmit={addRecipient}>
				<input
					type="email"
					bind:value={newRecipient}
					placeholder="teammate@example.com"
					aria-label="Recipient email address"
					required
					class="{inputClass} max-w-xs"
				/>
				<button
					type="submit"
					disabled={recipientBusy}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					>Add</button
				>
			</form>
			{#if recipientError}
				<p class="mt-2 text-[13px] font-bold text-red-700" role="alert">{recipientError}</p>
			{/if}
		</div>
	{/if}
</div>
