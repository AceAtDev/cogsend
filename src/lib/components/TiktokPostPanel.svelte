<script lang="ts">
	import { LoaderCircle, RefreshCw } from '@lucide/svelte';
	import AccountAvatar from './AccountAvatar.svelte';
	import TiktokConsent from './TiktokConsent.svelte';
	import { displayHandle } from '#lib/domain/platforms.js';
	import {
		EMPTY_TIKTOK_CHOICE,
		TIKTOK_BRANDED_PRIVATE_MESSAGE,
		TIKTOK_DISCLOSURE_MISSING_MESSAGE,
		TIKTOK_DRAFT_NOTE,
		TIKTOK_PROCESSING_NOTE,
		tiktokDisclosureNotice,
		tiktokDurationProblem,
		tiktokNeedsBrandedConsent,
		tiktokPrivacyAllowed,
		tiktokPrivacyLabel,
		tiktokPrivacyOptions,
		type TiktokCreatorState,
		type TiktokPostChoice
	} from '#lib/domain/tiktok.js';

	type Account = {
		id: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl?: string | null;
	};

	let {
		accounts,
		choices,
		creators,
		caption,
		video = null,
		disabled = false,
		onChange,
		onRetry
	}: {
		accounts: Account[];
		choices: Record<string, TiktokPostChoice>;
		creators: Record<string, TiktokCreatorState>;
		caption: string;
		video?: { src: string; poster: string | null; durationMs: number | null } | null;
		disabled?: boolean;
		onChange: (connectionId: string, choice: TiktokPostChoice) => void;
		onRetry: (connectionId: string) => void;
	} = $props();

	const choiceOf = (id: string): TiktokPostChoice => choices[id] ?? EMPTY_TIKTOK_CHOICE;
	const anyBranded = $derived(accounts.some((a) => tiktokNeedsBrandedConsent(choiceOf(a.id))));
	const anyDirect = $derived(accounts.some((a) => !choiceOf(a.id).draft));

	function update(id: string, patch: Partial<TiktokPostChoice>) {
		const next = { ...choiceOf(id), ...patch };
		if (!next.disclose) {
			next.yourBrand = false;
			next.brandedContent = false;
		}
		onChange(id, next);
	}

	const INTERACTIONS = [
		{ key: 'allowComment', off: 'commentDisabled', label: 'Allow comments' },
		{ key: 'allowDuet', off: 'duetDisabled', label: 'Allow Duet' },
		{ key: 'allowStitch', off: 'stitchDisabled', label: 'Allow Stitch' }
	] as const;
</script>

<section
	class="mt-6 rounded-[1.25rem] border border-stone-200/80 bg-white p-4 shadow-sm"
	data-testid="tiktok-panel"
	aria-label="TikTok post settings"
>
	<h2 class="text-[13px] font-extrabold text-stone-900">Post to TikTok</h2>

	<div class="mt-3 flex gap-3" data-testid="tiktok-preview">
		<div
			class="flex aspect-[9/16] w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-stone-900"
		>
			{#if video}
				<video
					src={video.src}
					poster={video.poster ?? undefined}
					class="h-full w-full object-cover"
					controls
					muted
					playsinline
					preload="metadata"
				></video>
			{:else}
				<span class="px-2 text-center text-[10px] font-bold text-stone-400">No video yet</span>
			{/if}
		</div>
		<p
			class="line-clamp-6 min-w-0 flex-1 text-[12px] font-medium whitespace-pre-wrap text-stone-700"
			data-testid="tiktok-preview-caption"
		>
			{caption.trim() || 'No caption'}
		</p>
	</div>

	{#each accounts as account (account.id)}
		{@const state = creators[account.id]}
		{@const choice = choiceOf(account.id)}
		<div
			class="mt-4 border-t border-stone-100 pt-4"
			data-testid="tiktok-account-{account.id}"
			aria-busy={!state || state.status === 'loading'}
		>
			{#if !state || state.status === 'loading'}
				<p class="flex items-center gap-2 text-[12px] font-medium text-stone-500">
					<LoaderCircle class="h-3.5 w-3.5 animate-spin" /> Reading the TikTok account's settings…
				</p>
			{:else if state.status !== 'ready'}
				<div class="flex items-start gap-2" role="alert">
					<p class="flex-1 text-[12px] font-medium text-red-700" data-testid="tiktok-creator-error">
						{account.displayName || displayHandle(account.handle)}: {state.status === 'cannot_post'
							? `${state.reason}. Try again later.`
							: state.message}
					</p>
					<button
						type="button"
						class="flex items-center gap-1 text-[11px] font-bold text-stone-600 underline"
						onclick={() => onRetry(account.id)}><RefreshCw class="h-3 w-3" /> Try again</button
					>
				</div>
			{:else}
				{@const creator = state.creator}
				{@const levels = tiktokPrivacyOptions(creator)}
				{@const tooLong = tiktokDurationProblem(creator.maxVideoSec, video?.durationMs)}
				{@const notice = tiktokDisclosureNotice(choice)}
				<div class="flex items-center gap-2.5" data-testid="tiktok-creator">
					<AccountAvatar
						platform="tiktok"
						handle={creator.username ? `@${creator.username}` : account.handle}
						displayName={creator.nickname}
						avatarUrl={creator.avatarUrl ?? account.avatarUrl ?? null}
						size={32}
					/>
					<p class="min-w-0 text-[12px] font-medium text-stone-500">
						Posting to
						<span class="font-bold text-stone-900" data-testid="tiktok-creator-nickname"
							>{creator.nickname || account.displayName || 'TikTok'}</span
						>
						{#if creator.username}<span class="text-stone-400">@{creator.username}</span>{/if}
					</p>
				</div>

				{#if tooLong}
					<p class="mt-2 text-[12px] font-bold text-red-700" role="alert">{tooLong}</p>
				{/if}

				<label
					class="mt-3 flex items-center justify-between gap-3 text-[12px] font-bold text-stone-900"
				>
					Send as a draft to the TikTok inbox
					<input
						type="checkbox"
						role="switch"
						data-testid="tiktok-draft-{account.id}"
						checked={choice.draft}
						{disabled}
						onchange={(e) => update(account.id, { draft: e.currentTarget.checked })}
					/>
				</label>
				{#if choice.draft}
					<p class="mt-1 text-[11px] font-medium text-stone-500" data-testid="tiktok-draft-note">
						{TIKTOK_DRAFT_NOTE}
					</p>
				{:else}
					<label class="mt-3 flex flex-col gap-1.5 text-[11px] font-bold text-stone-500">
						Who can see this video
						<select
							data-testid="tiktok-privacy-{account.id}"
							value={choice.privacy ?? ''}
							{disabled}
							required
							onchange={(e) =>
								update(account.id, {
									privacy: (e.currentTarget.value || null) as TiktokPostChoice['privacy']
								})}
							class="rounded-lg border bg-stone-50 px-2.5 py-1.5 text-[12px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none pointer-coarse:text-base {choice.privacy
								? 'border-stone-200'
								: 'border-amber-400'}"
						>
							<option value="" disabled>Choose who can see it</option>
							{#each levels as level (level)}
								{@const allowed = tiktokPrivacyAllowed(level, choice)}
								<option
									value={level}
									disabled={!allowed}
									title={allowed ? undefined : TIKTOK_BRANDED_PRIVATE_MESSAGE}
									>{tiktokPrivacyLabel(level)}{allowed ? '' : ' (not for branded content)'}</option
								>
							{/each}
						</select>
					</label>
					{#if !choice.privacy}
						<p class="mt-1 text-[11px] font-medium text-amber-700">
							TikTok asks you to choose this for every post.
						</p>
					{/if}

					<fieldset class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
						<legend class="sr-only">Interactions</legend>
						{#each INTERACTIONS as option (option.key)}
							{@const off = creator[option.off]}
							<label
								class="flex items-center gap-1.5 text-[12px] font-bold {off
									? 'text-stone-400'
									: 'text-stone-700'}"
								title={off ? 'Turned off in this account’s TikTok privacy settings' : undefined}
							>
								<input
									type="checkbox"
									data-testid="tiktok-{option.key}-{account.id}"
									checked={choice[option.key] && !off}
									disabled={disabled || off}
									onchange={(e) => update(account.id, { [option.key]: e.currentTarget.checked })}
								/>
								{option.label}
							</label>
						{/each}
					</fieldset>
					{#if creator.commentDisabled || creator.duetDisabled || creator.stitchDisabled}
						<p class="mt-1 text-[11px] font-medium text-stone-400">
							Greyed out: turned off in this account's TikTok privacy settings.
						</p>
					{/if}

					<div class="mt-4">
						<label
							class="flex items-center justify-between gap-3 text-[12px] font-bold text-stone-900"
						>
							Disclose video content
							<input
								type="checkbox"
								role="switch"
								data-testid="tiktok-disclose-{account.id}"
								checked={choice.disclose}
								{disabled}
								onchange={(e) => update(account.id, { disclose: e.currentTarget.checked })}
							/>
						</label>
						<p class="mt-1 text-[11px] font-medium text-stone-500">
							Turn on to disclose that this video promotes goods or services in exchange for
							something of value. Your video could promote yourself, a third party, or both.
						</p>
						{#if choice.disclose}
							<div class="mt-2 flex flex-col gap-2 rounded-lg bg-stone-50 p-2.5">
								<label class="flex items-start gap-2 text-[12px] font-bold text-stone-800">
									<input
										type="checkbox"
										class="mt-0.5"
										data-testid="tiktok-your-brand-{account.id}"
										checked={choice.yourBrand}
										{disabled}
										onchange={(e) => update(account.id, { yourBrand: e.currentTarget.checked })}
									/>
									<span>
										Your brand
										<span class="block text-[11px] font-medium text-stone-500"
											>You are promoting yourself or your own business. This video will be
											classified as Brand Organic.</span
										>
									</span>
								</label>
								<label
									class="flex items-start gap-2 text-[12px] font-bold {choice.privacy ===
									'SELF_ONLY'
										? 'text-stone-400'
										: 'text-stone-800'}"
									title={choice.privacy === 'SELF_ONLY'
										? TIKTOK_BRANDED_PRIVATE_MESSAGE
										: undefined}
								>
									<input
										type="checkbox"
										class="mt-0.5"
										data-testid="tiktok-branded-{account.id}"
										checked={choice.brandedContent}
										disabled={disabled || choice.privacy === 'SELF_ONLY'}
										onchange={(e) =>
											update(account.id, { brandedContent: e.currentTarget.checked })}
									/>
									<span>
										Branded content
										<span class="block text-[11px] font-medium text-stone-500"
											>You are promoting another brand or a third party. This video will be
											classified as Branded Content.</span
										>
										{#if choice.privacy === 'SELF_ONLY'}
											<span class="block text-[11px] font-medium text-amber-700"
												>{TIKTOK_BRANDED_PRIVATE_MESSAGE}</span
											>
										{/if}
									</span>
								</label>
								{#if notice}
									<p class="text-[11px] font-bold text-stone-700" data-testid="tiktok-label-notice">
										{notice}
									</p>
								{:else}
									<p class="text-[11px] font-bold text-amber-700" role="alert">
										{TIKTOK_DISCLOSURE_MISSING_MESSAGE}
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
	{/each}

	<div class="mt-4 border-t border-stone-100 pt-3">
		{#if anyDirect}<TiktokConsent branded={anyBranded} />{/if}
		<p class="mt-1 text-[11px] font-medium text-stone-400">{TIKTOK_PROCESSING_NOTE}</p>
	</div>
</section>
