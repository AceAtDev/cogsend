# Connecting accounts

**Accounts** lists every connected account and how to add another. **Connect new**
opens the platform picker.

## Mastodon and Bluesky

These two connect with what you already have:

- **Mastodon** — enter your instance's address and approve CogSend on your
  instance. The app registers itself there; there is nothing to create first.
- **Bluesky** — enter your handle and an **app password**, which you create in
  Bluesky under Settings → Privacy and security → App passwords. Never use your
  main password.

## LinkedIn, Threads, Instagram, TikTok and X

These five need a developer app of your own before they can connect, because the
platform issues the client id and secret the Worker uses. Until one is set up, the
picker shows the platform with a **Needs setup** badge, and choosing it shows that
platform's steps — the redirect URI to register and a form for the app's
credentials — instead of a connect attempt that cannot succeed. The full steps
are in [OAuth apps](oauth-apps.md).

Paste the credentials into that form and press **Save and connect**: nothing to
deploy and no checkout needed, which suits an instance installed with the
Deploy button. Worker secrets work too, set from a checkout or in the Cloudflare
dashboard; reload the page once they are on the Worker.

Instagram connects only a Business or Creator account; a personal account is refused with a note on switching its type in Instagram's settings.

TikTok connects any account, but until TikTok audits your app it posts only to an account set to private in TikTok, and only as **Only me**; see [OAuth apps → TikTok](oauth-apps.md#tiktok).

If you would rather not set up an app, you can connect LinkedIn, Threads, Instagram and X through
[Zernio](zernio.md) instead.

## Long posts on X

An X account connected directly shows whether it can post long: **Long posts on, up to 25,000 characters** or **Long posts off, 280 characters**, and where that came from. CogSend asks X for the account's plan when you connect it and when you press **Check plan**, and any paid plan (Basic, Premium or Premium+) turns long posts on.

Some accounts that can post long, such as Verified Organizations, report no plan, so **Turn on** and **Turn off** let you decide. **Use what X reports** goes back to the plan. A reconnect keeps your choice. If X refuses a long post, CogSend turns long posts off for that account; turn them back on if it does have a paid plan.

X accounts connected through [Zernio](zernio.md) stay at 280, since Zernio's X route stops there.

## TikTok post settings

TikTok's guidelines want who can see a video, its comments, Duets and Stitches, and whether it is promotional chosen for each post, with nothing picked in advance, so a TikTok account has no settings here: the composer asks for them on every post ([Composer → TikTok](composer.md#tiktok)). A reconnect brings no defaults with it either.

## Brands

Brands group accounts, such as a LinkedIn page and an Instagram account that both belong to one business. Add a brand under **Brands** at the bottom of **Accounts**, then pick it in the **Brand** menu on each of its accounts; the list shows accounts grouped by brand, with a colour each. Renaming or recolouring a brand changes nothing else. Deleting one leaves its accounts connected and unbranded, and leaves their scheduled posts alone.

Every account has a **channel key**, shown next to it, which is how agents and the [MCP server](mcp.md) name it:

- `<brand>.<platform>`, such as `jobjob.linkedin` or `465cal.instagram`. The brand part is the brand's slug, made from its name when it is created and kept when it is renamed, so saved keys keep working.
- When a brand has two accounts on the same platform, neither gets the short key: both become `<brand>.<platform>.<handle>`, such as `jobjob.instagram.jobjob-careers`, and `jobjob.instagram` on its own is refused as ambiguous. The long form is accepted for every account, so it is the safer one to save.
- Accounts with no brand use `unbranded`, such as `unbranded.bluesky`.
- The handle part is the handle in lowercase with anything other than letters and digits turned into dashes. Two handles that come out the same also get the start of the account's id, such as `pat-dev-1a2b3c`.

Assigning an account to a brand changes its key, so it is done from the browser only; an API key can manage brands but cannot move an account between them.

## When an account needs reconnecting

A token that stops working marks the account as needing a reconnect, both here and
in the composer's account list; **Reconnect** starts the same flow again and keeps
the account's history. The usual cause is LinkedIn: a self-created LinkedIn app
gets a 60-day token and nothing to renew it with, so it has to be reconnected every
60 days ([why](oauth-apps.md#linkedin)).

Posts already scheduled for the account still go out at their time, and the first one that succeeds clears the reconnect flag on its own; you can't publish, schedule, retry or reschedule anything new to it until then.

## Disconnecting

Disconnecting an account removes its scheduled posts, returns drafts that were
still waiting, and keeps what it already published — the confirmation says how many
of each. A disconnected account's history stays in [Insights](posts.md#insights),
marked **Archived**.
