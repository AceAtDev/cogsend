# feat(auth): opt-in multi-user mode with capped public sign-up

## Summary

This adds an optional multi-user mode to CogSend. It is off by default: with the new `REGISTRATION` secret unset, an instance behaves as it does today, with no sign-up page, no Users page and no new settings.

When an operator sets `REGISTRATION=waitlist` or `REGISTRATION=open`, the instance accepts public sign-ups at `/signup`. New accounts are `member`s who get their own posts, connected accounts, API key and MCP access, strictly scoped to their own `user_id`. The existing account becomes the `admin` and keeps sole control of instance settings, platform OAuth app credentials, the scheduler's admin actions, the updater and a new Users page. `MAX_ACTIVE_USERS` caps how many accounts can be active before `open` sign-up falls back to a waitlist, and the admin can hand out single-use, expiring invite links that skip the waitlist.

I know the project deliberately stays minimal and single-tenant, and I have tried to keep this change in that spirit: everything is behind one environment switch, there are no new runtime dependencies or bindings, and the single-user code paths are kept as close to today's as I could manage. If you would rather not carry this upstream, I completely understand, and I would be happy to maintain it as a documented fork instead (see the open questions at the end).

## Why

I want to run a CogSend instance for my own businesses, a creator programme and some partner businesses, and to publish to TikTok through it. That needs a TikTok developer app approved for the Content Posting API, and TikTok's review rules exclude tools that only serve the developer's own accounts:

- The [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) (updated Aug 4 2026) say: "API Clients must not be limited to test applications and should be intended for a wide audience, not limited to internal groups/private use. Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages."
- The App Review Guidelines add: "Apps must not be for private or personal use."

A single-user instance cannot meet that. An instance that genuinely accepts public registrations, with an operator-controlled cap and waitlist to keep it affordable and safe, can. This PR is independent of any TikTok provider work: it does not add TikTok, only the multi-user foundation such an app needs, and it is useful on its own to anyone who wants to share an instance with a team or clients.

## What changes

**Off (the default, `REGISTRATION` unset or `off`)**

- `/signup`, `/signup/verify`, `/api/auth/signup` and `/api/auth/signup/verify` answer 404, without reading D1.
- No Users link, no sign-up link on the login page, no new Settings cards. The account is the admin, so every existing screen and route works as before.
- Small differences a single-user operator will not notice: the sign-in route looks the account up by email instead of taking the first row (one extra indexed read); the root layout does one two-row `users` read per page load for the admin, to decide whether to show the Users link; `npm run admin:reset` now has a `WHERE email = …` on its `UPDATE` and session delete. The list of these is short on purpose, and I am happy to trim further.

**On (`waitlist` or `open`)**

- **Sign-up** (`/signup`): email and password with the existing credential rules, then the same mandatory TOTP enrollment as the admin. In `waitlist` mode the account is `pending` until approved; in `open` mode it is `active` until `MAX_ACTIVE_USERS` active accounts exist (default 10, admin included), then `pending`. The cap is checked inside the `INSERT` statement itself, so concurrent sign-ups cannot overshoot it.
- **Email confirmation**: only when `RESEND_API_KEY` and `NOTIFY_FROM` are both set (Resend's shared sender cannot reach strangers). The link is a stateless HMAC token and is confirmed with a button (POST), so mail scanners that prefetch links do not confirm addresses. Unconfirmed addresses are released after 24 hours. Without a sender, the docs recommend `waitlist` mode and admin approval.
- **Invites**: single-use, expiring (7 days by default, 90 max), stored as an HMAC under `AUTH_SECRET`, shown once. Claimed with one conditional `UPDATE`, released again if the sign-up it was spent on did not happen.
- **Users page** (`/admin/users`, admin only): accounts with role, status, created and last-seen times, post and connection counts; approve, suspend, reinstate, promote, demote, delete; cap usage; mode and cap overrides (saved in `app_settings`, they win over the env values but cannot turn sign-up on while `REGISTRATION` is off); invite links.
- **Self-service deletion**: members get a "Delete my account" card in Settings (the existing `DELETE /api/auth/me`, which already re-checks password and TOTP). It is hidden for the admin so the single-user Settings page is unchanged.
- **Scheduler**: due posts of suspended or waiting accounts are not claimed; they go out once the account is active again. The failure digest to `NOTIFY_EMAIL` now covers admins' posts only, so the operator's inbox does not receive members' post text.

## Schema and migration

- `drizzle/0020_user_roles.sql`: `users.role` (default `'admin'`), `users.status` (default `'active'`), `users.last_login_at`. The defaults are what every existing row already is, so no data migration is needed and the existing account becomes the admin automatically. Sign-up always writes `role = 'member'` and its status explicitly, in one place (`insertMember`).
- `drizzle/0021_invites.sql`: the `invites` table and its unique index on `code_hash`.
- Mirrored in `INIT_SQL`, in the self-repair path (`COLUMN_BACKFILLS` and `LEGACY_TABLES_SQL`), and in `scripts/lib/migration-sync.mjs` postconditions, so an in-place update from Settings or the Update CogSend Action adds them on its own and `db:migrate:remote` still works on a bootstrapped database. `schema-bootstrap` and `migration-sync` tests pass.
- `release.json`: `schemaChange: true` with a note, following the 1.22.0 precedent: the change is additive and an earlier version ignores it, so rollback is safe. `manualOnly` stays false (no new bindings). Feel free to move this into your release commit instead.
- New optional secrets `REGISTRATION` and `MAX_ACTIVE_USERS` are added to `put-secrets.mjs`, `.dev.vars.example` and the configuration docs.

## Security model

- **Roles**: `SessionUser.role` is read from the `users` row on every session read and on every API-key request, so a role change applies on the next request. New guards `requireAdmin` and `requireAdminSession` protect instance settings (instance name, pre-release channel), platform app credentials, the tick token, "Tick now" (which publishes every account's due posts), the release check, the updater (state, steps, unlock, remember), and all of `/api/admin/*`. The hook also refuses members on `/admin*` and `/api/admin*` before any route runs.
- **Status**: only `active` accounts get or keep a session. `getSessionUser` drops the session of any other status, sessions are revoked on suspension, MFA enrollment and verification refuse to mint a session for a non-active account, and personal API keys of a non-active account stop working (without being revoked, so reinstating restores them).
- **Isolation**: the existing data routes were already scoped by `user_id` almost everywhere; I audited each route, page load, MCP tool and the public media/preview routes and found no cross-account read or write. The one shared-data leak was the failure digest (fixed above). The new isolation suite pins this down.
- **No account enumeration**: sign-in never says whether an email exists. The per-address wrong-password counter is now kept on the owner's row for every account, so a guesser locked out on one address cannot probe another and read "not locked" as "exists"; on a single-user instance this is the same row as before. Account states (waitlist, suspended, unconfirmed) are only revealed after the correct password. Sign-up gives a taken address the same answer as a new one when email confirmation is on; without it, an `open` instance answers a new address differently (it goes to TOTP setup), which is documented as a residual and bounded by the edge rate limit.
- **Bot friction without third parties**: a signed form timestamp (refuses direct POSTs and sub-two-second submissions), a honeypot field that is answered with a fake success, and a separate `signup:` bucket on the existing `AUTH_RATE_LIMITER`.
- **Destructive admin actions**: deleting another account requires the admin's password, behind the existing lockout. The instance can never be left with members and no active admin: the last admin cannot be demoted, suspended, deleted, or delete themselves while other accounts exist.
- **Deletion**: deleting an account (admin or self-service) removes its R2 objects first (originals plus previews, covers, thumbnails and JPEG variants, in resumable batches within the Workers Free budget), then the `users` row, which cascades to drafts, variants, media rows, targets, attempts, shares, connections, API keys, sessions, backup codes, MFA challenges and pending OAuth rows. The shared batch logic moved from `api/auth/me` into `#lib/server/user-data`.
- **Updater token**: a member changing their password no longer forgets the saved Cloudflare token, which only an admin can have saved.
- `SECURITY.md` now says that on an instance with `REGISTRATION` set, cross-member access or a member reaching an admin control is a real finding.

## Scripts

- `npm run admin:reset -- --email someone@example.com` resets that account only; without `--email` it resets the oldest account (the owner), as before. Its `UPDATE` and session delete are now scoped by email, so it can never rewrite every row on an instance with members.
- `npm run doctor` adds one line when a `REGISTRATION` secret exists, warning if email confirmation is not possible. Single-user deployments see no new line.
- `setup`, `seed-local` and the claim form are unchanged in behaviour: the first account takes the schema defaults and is the admin.

## Tests

`npm run check`, `npm run lint`, `npm test` and `npm run build` all pass. The unit suite goes from 1,607 to 1,725 tests (153 to 157 files). I did not run the Playwright suite locally (my browser build did not match the pinned Playwright revision); the single-user screens it drives are unchanged for the admin, but please let CI confirm.

- `tests/multi-user-isolation.test.ts` (78 tests): two members, Alice and Bob. Bob, signed in by session and again by personal API key, tries to read, edit, delete, duplicate, publish and schedule Alice's draft, set and delete her variants, read, mint and revoke her preview link, edit and delete her media and video cover, start an upload into her draft, read her media file, disconnect, edit and verify her connection, cancel, retry and reschedule her deliveries (singly and in bulk), and point his own draft at her connection. Each attempt must fail and leave a snapshot of all of Alice's rows and R2 bytes unchanged; a control test shows the same requests succeed for Alice. It also covers list endpoints (drafts, queue, connections, insights), seven MCP tools, API key resolution and management, preview-link media and signed media URLs (a signature for one key does not open another), and a member calling each of 19 admin-only routes (all 403).
- `tests/multi-user-hook.test.ts`: through the real request hook, members are kept out of `/admin` and `/api/admin` (session and key), the role reaches routes, waitlisted accounts' sessions and keys are refused, and suspension stops a session at once and a key until reinstated.
- `tests/registration.test.ts`: mode resolution (env is the master switch), cap and invite rules, form-token signing, every sign-up outcome (off, waitlist, open until the cap, taken address, honeypot, forged form, invites used once, expired, released on a taken address, paused sign-up), email confirmation end to end with a stubbed Resend, release of day-old unconfirmed addresses, and the shared per-address lockout.
- `tests/admin-users.test.ts`: the Users API (listing with cap usage, approve, suspend with session revocation, self-change refused, last-admin protection, deletion of rows, R2 objects and keys), invites and registration controls, the admin-only failure digest, the scheduler holding suspended accounts' posts, and the single-user layout and login page showing nothing new.
- Existing tests were updated only where hand-built session users needed the new `role` field, and where `admin-reset` now scopes its SQL.

## Docs

- New `docs/multi-user.md`: turning it on, the modes, invites, sign-up and email confirmation, what a stranger can learn, bot friction, roles, managing accounts, costs and limits (Workers Free request and subrequest budgets, D1 and R2 quotas, per-app provider rate limits and Resend limits are all shared across users; no per-account storage quota), and what an operator takes on (they can read members' data, need a privacy policy and terms, must honour deletion, answer for their OAuth apps, and must keep the instance updated).
- **The website needs a nav entry for `docs/multi-user.md` in `src/docs/nav.mjs`**, or its build fails. No existing pinned heading was renamed.
- `docs/configuration.md` (new secrets row, the login section, `admin:reset --email`), `docs/access.md` (bypass the sign-up paths), `README.md` (docs index), `SECURITY.md` and `AGENTS.md` (the multi-user rules for future changes) are updated.

## Reviewing

The Settings page diff looks large because the Scheduled publishing and Instance cards moved inside an `{#if isAdmin}` block; `git diff -w` shows the real change (about 115 lines, most of it the member-only delete card).

## Known gaps

- No emailed password reset or approval notification; recovery is `admin:reset --email` from the operator's checkout, consistent with the existing no-reset-route stance.
- No per-member quotas for storage, posts or provider calls; the cap on active accounts is the only lever.
- Without a mail sender, `open` mode can distinguish a new address from a taken one at sign-up (documented).
- A suspended member's existing preview links keep working until they expire or the account is deleted.

## Open questions for you

1. Would you consider this upstream at all, given the single-tenant goal? If not, I will keep it as a documented fork and would appreciate a pointer on how you would like forks to describe themselves.
2. If yes: is `REGISTRATION` as an env-only master switch the right shape, or would you prefer the mode to live only in the admin UI (or only in env, without the UI overrides)?
3. `role` defaults to `'admin'` so existing rows need no data migration. The alternative is a `'member'` default plus a repair that promotes the oldest account. I chose the former for the smaller, safer migration; happy to switch.
4. Should the admin's own Settings page also get "Delete my account", or should self-deletion stay members-only so the single-user page is untouched?
5. Is the extra two-row `users` read in the root layout (admins only, to show the Users link when leftover accounts exist after turning `REGISTRATION` off) acceptable, or would you rather show the link only while `REGISTRATION` is on?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
