# Posts and Insights

**Posts** is everything you have written, and what happened to it. **Calendar** lays the same posts out by day, per brand. **Review** holds what agents wrote until you approve it, and **Activity** says who changed what. **Insights** is
how publishing has gone over time.

## Posts

The tabs filter by state — **All Posts**, **Scheduled**, **Published**, **Failed**
and **Drafts** — each with its count. **All accounts** narrows the list to one
account, and the search box matches the post text. The tab and account stay in
the address, so reloading or sharing the link keeps them, and coming back from
editing a post returns you to the same tab, account and search. Every card shows
the accounts it goes to, the text, its images or video, and when: **Will publish** with the time in
your own timezone and how far away it is, **Due** once that time has passed, **Started** while it is being sent, or **Published**, or when a draft was
last edited. A video shows its cover and loads only when you press play.

A post being sent right now is marked **Sending** and offers nothing to press until it is done; the list refreshes on its own every few seconds while anything is sending, and every half minute while a platform is processing a video. A send that stops answering — Cloudflare cut it off — is given up on after 7 minutes: the card leaves **Sending** with **Reschedule** and **Cancel** again, and the next tick retries it.

What a card offers depends on its state:

| State           | Actions                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Awaiting review | **Edit Post**, **Review**, **Cancel**                                                                       |
| Rejected        | **Edit Post**, **Cancel**                                                                                   |
| Scheduled       | **Edit Post**, **Reschedule** (an offset or a specific time), **Cancel**                                    |
| Failed          | **Edit & re-draft**, **Post again**, **Retry** (or **Retry N failed** for many)                             |
| Published       | **Post again**, which copies it into a new draft; on X, **Quote on X**, which starts a new draft quoting it |
| Draft           | **Edit Post**, **Duplicate**, **Remove**                                                                    |

**Edit Post** on a scheduled card opens it in the composer, which shows when and where it goes out and offers **Change time** and **Unschedule** there too; see [Publish now, or schedule](composer.md#publish-now-or-schedule).

A post that went to several accounts is one card, with a result per account, so a
post that published on four and failed on one shows exactly that. Retrying a card
retries only the accounts that failed.

A post that published to every account can't be edited, since changing it would no longer match what went out. Opening it shows it read-only, with **Duplicate to post again** to start a copy, which is what **Post again** does from its card. A post that failed on some accounts stays editable, so it can be fixed and retried.

A scheduled post that fails with something retryable — a rate limit, a platform
timeout — is not failed yet: it backs off and tries again on its own, up to five
attempts, and only then lands in **Failed**. A post whose video a platform is still processing is marked **Processing** instead: it publishes on its own once the platform is done, without spending any of the five attempts ([Video](composer.md#video)). **Retry** and **Reschedule** start the five attempts afresh; publishing or scheduling the same post to the same account again does not. The dashboard shows a banner when
something has failed, and [failure emails](scheduling.md#failure-alerts-optional)
can tell you the next morning.

### Preview links

To get feedback on a draft without handing out your login, press **Share** above the composer and then **Create link**. Anyone with the link can read the draft without signing in: its text as the cards it will post, its images and video, and a version for each platform it is going to whose text you changed. They don't see which accounts it goes to, or anything else on the instance.

The link shows the latest save, so a reviewer who refreshes sees your newest edits. Each draft has one link: opening **Share** again shows the same one, **New link** replaces it (the old one stops working), and **Turn off** ends it. A link also stops working after 14 days, when the draft is deleted, and as soon as the post publishes to any account. Search engines are told not to index preview pages.

## Calendar

**Calendar** shows every post going to every account on a week (the default) or month grid, in your account's time zone, which is named under the heading. On a phone it is a list of days instead. The arrows step a week or a month, **Today** comes back, and the view, the date and the filters stay in the address, so a link opens the same calendar.

A post going to three accounts is three entries, one per account. Each shows its time, the account's platform and handle, the first line of its text (the version written for that platform, if there is one), a mark when it has images or video, and a dot for its state: **Awaiting review** (dashed and violet, with a shield: an agent wrote it and it goes out only once you approve it), **Rejected**, **Scheduled**, **Due** (its time has passed and the next tick sends it), **Sending**, **Processing**, **Published**, **Failed** or **Cancelled**. The left edge takes the colour of the account's brand ([Brands](accounts.md#brands)); accounts with no brand are grey and grouped as **Unbranded**. A post published straight away, and a cancelled one, sit at the time they last changed. Cancelled posts are hidden until you press **Show cancelled**.

The brand chips double as the legend. Pick one or more brands, accounts, or both, to see only those; brands and accounts add up, so **JobJob** with **@465cal** shows JobJob's accounts and that one. **All** clears the filter.

Pressing an entry opens it: the full text, its media, the channel key an agent uses for that account (with a copy button), and its state. **Open in composer** edits the post and **View post** opens it on the platform once it is published. A published entry also shows its [performance](#performance-metrics), with **Refresh** to read it now. A scheduled or due entry offers **Reschedule** and **Cancel**, a failed one **Retry** and **Remove**, the same as its card in Posts; each acts on that one account only.

To move a scheduled entry, drag it to another hour (week) or day (month; it keeps its time of day). A confirmation shows the account and the old and new times before anything changes, and an **Undo** button stays up for a few seconds after. On a touch screen hold the entry a moment before dragging, or open it and press **Reschedule** to pick a new time. With a keyboard, the arrow keys move between days, **Page Up** and **Page Down** change the week or month, and **Tab** reaches the entries.

Drafts with no time yet are listed beside the calendar under **Unscheduled drafts**; open one in the composer to schedule it.

## Review

**Review** in the workspace menu is where posts an agent wrote wait for you: anything scheduled or published through an API key or [MCP](mcp.md#review-before-publishing) on a brand that reviews agent posts ([Review and pause](accounts.md#review-and-pause)), which is every brand until you trust one. While a post waits it keeps its time on the calendar, but nothing sends it. A violet button in the header says how many wait, on every page, so it is one tap from a phone.

Posts are grouped by brand, one card per post and brand, with the channels it goes to, when, its text (and each platform's own version when it differs), and its images or video. Each card offers:

- **Approve**: it goes out at its own time. A post whose time has already passed while it waited (the card says so) goes out on the next tick.
- **Edit** opens it in the composer; save, then approve it here. Your own edits never send a post back to review.
- **New time** approves it for a time you pick.
- **Reject** asks for a note, which the agent reads back (through `list_posts` and `get_post`) before it revises the post and resubmits it. A resubmitted post comes back with your earlier note beside it.

**Approve N shown** approves everything the filters show: tap brands to narrow the list, and tick **Past their time only** to clear the backlog that is already late. **Approve all <brand>** does one brand. Rejected posts are listed under **Show rejected** until the agent resubmits them, where **Approve anyway** and **Cancel it** are there too.

An agent never approves anything: approving and rejecting need you signed in, and an agent that edits a post you already approved on a reviewed brand sends it back here.

## Activity

**Activity** lists who changed what over the last 90 days: you in the app, an agent with your API key (named by the key's first characters), the API_TOKEN, or the scheduler. Each line says what happened, when, before and after where that applies, and links to the post. Filter by who and by what: review decisions, posts, deliveries, brands or MCP tool calls. Every write through the REST API or MCP is recorded, as are approvals, rejections, pauses, trust changes and posts that reached their time while waiting for review. The composer's own saves as you type are not, so they do not bury the rest.

## Insights

Insights counts what was published and what failed over the last **7**, **30** or
**90** days, bucketed by your local days (weeks for 90), with the period before it
alongside. Local means your browser's time zone: the app records it when you open
it, so the days follow you if you move or travel.

- **Published**, with the change against the previous period as a signed count.
- **Scheduled**, with how long until the next one goes out.
- **Last post**, so a week where nothing went out is obvious.
- A chart of posts per day, as **Bars** or **Cumulative** against the previous
  period. Hover, tap or use the arrow keys to read any day; red dots mark days
  with failures.
- The failures, grouped by reason — a platform-wide problem reads differently from
  one bad post — with a link to review them in Posts.
- A row per account, including disconnected ones, which are kept and marked
  **Archived** so their history still counts.

Below the accounts, **Performance** sums what people did with the posts published in the same range: engagement (likes, comments, shares and quotes), and views or impressions where a platform reports them, per brand and per channel, with the ten top posts. See [Performance metrics](#performance-metrics) for where the numbers come from.

## Performance metrics

CogSend reads each published post's public counts about **1 hour**, **1 day** and **7 days** after it goes out, and keeps every reading with its time. The latest counts show on the post's card in **Posts**, in the calendar entry (with the history of readings and a **Refresh** button that reads them again, at most every five minutes), on **Insights**, and to agents through MCP (`get_post` and `get_performance`).

| Platform  | What CogSend reads                                               | Permission it needs                                                           |
| --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Bluesky   | Likes, reposts, replies, quotes                                  | None: public posts are read from Bluesky's public API                         |
| Mastodon  | Favourites, boosts, replies, and quotes on Mastodon 4.5 or later | The account's existing token (`read`), on its own server                      |
| TikTok    | Views, likes, comments, shares of the account's public videos    | `video.list`, asked for since this release; older connections must reconnect  |
| LinkedIn  | Company pages only: impressions, likes, comments, shares, clicks | `rw_organization_admin` as a page administrator, with `r_organization_social` |
| Instagram | Not collected yet                                                |                                                                               |
| Threads   | Not collected yet                                                |                                                                               |
| X         | Not collected yet                                                |                                                                               |

- **TikTok** accounts connected before CogSend asked for `video.list` keep posting as before; their posts say **Reconnect this TikTok account to enable metrics** until you connect the account again from **Accounts**. TikTok only answers for public videos, so a post published as **Only me** (every post, while the app is unaudited) has no counts.
- **LinkedIn** reports post statistics only for company pages. CogSend connects personal profiles, so their posts say **Not available on LinkedIn for personal profiles**.
- A post deleted on the platform keeps its last counts and is marked as no longer there. An account that needs reconnecting is asked again once a day, and nothing is read for a post more than nine days old except with **Refresh**.
- The readings run at the end of each scheduler tick, with whatever is left of its [budget](scheduling.md#how-a-tick-works) once posts are published, so they never hold a post back. A platform that asks CogSend to slow down is left alone for as long as it asked.
