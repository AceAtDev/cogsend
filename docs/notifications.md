# Email notifications

CogSend can email you a daily digest of your posts and alert you when something goes wrong. It sends from a Gmail account you own, signed in with a Google **app password**, to the addresses you list. Each recipient picks what they get.

Everything here is per account: on an instance with [several users](multi-user.md), each person sets up their own sender, recipients and digest time, and hears only about their own posts.

## What you can get

| Subscription               | When                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Daily digest               | Once a day at the time you choose, in your time zone                                    |
| Failed posts               | Soon after a post fails to publish                                                      |
| Published / sent to inbox  | Soon after a post goes live or a TikTok draft reaches the inbox, grouped per email      |
| Review waiting / overdue   | Soon after a post an agent wrote passes its time without being approved                 |
| Account needs reconnecting | Soon after an account expires or loses access                                           |
| Paused brand reminder      | With the digest, while a brand is paused; a reminder-only recipient gets just that line |

The digest is a brief: attention items first, then Today and Yesterday with up to three thumbnail cards each and accurate totals. Links open each post or the full list. TikTok inbox drafts are labeled separately from live posts. Empty attention sections are omitted; the weekly highlight shows only the best post with positive engagement and skips zero metrics. The immediate on-post email is unchanged.

Alerts are batched: at most one email per kind every 15 minutes. Whatever happens in between goes out together in the next one. A recipient hears only about what happens after they were added, not about older failures.

## Accounts that are about to expire

Every hour CogSend refreshes Instagram, Threads and LinkedIn sign-ins that are within a week of running out, so an account that rarely posts does not lapse between posts. When a sign-in will end in a way only a reconnect fixes (a LinkedIn app without refresh tokens every 60 days, TikTok once a year), the **Account needs reconnecting** alert arrives a week ahead with the date, and the home page shows it until you reconnect. The home page also says when email alerts are off or failing, so you know they cannot reach you.

## Set it up

### 1. Use a dedicated Gmail account

Create a new Gmail account just for sending these emails, such as `yourname.cogsend@gmail.com`. An app password gives full access to the mailbox it belongs to (reading, deleting and sending mail), and it is stored on your instance. If it ever leaked, you want it to open an empty mailbox, not your personal one.

### 2. Turn on 2-Step Verification

Google only offers app passwords on accounts with 2-Step Verification. Sign in to the sender account and turn it on at [myaccount.google.com/security](https://myaccount.google.com/security).

### 3. Create an app password

Open [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), give it a name such as `CogSend`, and create it. Google shows a 16-letter password once, in four groups of four. Copy it; the spaces do not matter.

If the page says app passwords are not available, the account either has no 2-Step Verification yet, uses Advanced Protection, or is a work or school account whose administrator turned them off.

### 4. Enter it in CogSend

In **Settings → Email notifications**:

1. Enter the Gmail address and paste the app password, then **Save sender**. The password is encrypted with `APP_ENCRYPTION_KEY` before it is stored and is never shown again.
2. Add the recipients and choose, per recipient, what they get.
3. Set the time of the daily digest. It follows the time zone in your profile.
4. Press **Send test email**. It goes to your recipients (or to the sender address when the list is empty) and reports exactly what went wrong if it fails.

## When the test fails

| Message                                           | What to do                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Gmail did not accept the address and app password | Check the address and paste a new app password. Changing the Google account's password revokes its app passwords. |
| Gmail wants an app password                       | You entered the account's own password. Create an app password (step 3).                                          |
| Could not connect to smtp.gmail.com               | The connection was refused or dropped. Try the other port (465 or 587); if neither works, use Resend below.       |
| The secure (TLS) connection failed                | Try the other port. If it persists, report it with the full message.                                              |
| Stopped answering                                 | A temporary network problem: try again in a minute.                                                               |

The same messages appear under the button when a scheduled email fails, with when it happened. A failed alert is tried again after 15 minutes, with the same events.

CogSend connects to `smtp.gmail.com` on port 465 (TLS from the start) by default, or 587 (upgraded with STARTTLS) if you choose it. Cloudflare Workers can open outbound connections on both; only port 25 is blocked.

## Limits

- **Gmail**: a personal Gmail account can send to about 500 recipients a day, and a Google Workspace account to about 2,000. Every recipient of every email counts. A digest a day and the occasional alert stay far below that, but ten recipients on every alert kind during a bad day add up. Going over locks sending for up to a day.
- **Workers Free**: the emails go out on the scheduler tick after the posts, using only what the tick has left of its 50 subrequests. When there is not enough left, they wait for the next tick. An account with nothing set up costs the tick one database read.
- **Digest timing**: the digest goes out on the first tick after its time. If the scheduler was not running then, it is still sent up to three hours late; after that it waits for the next day. Setting a time that already passed today does not send one at once.

## Resend instead of Gmail

If the instance has `RESEND_API_KEY` and `NOTIFY_FROM` set ([Configuration](configuration.md)), an admin can choose **Resend** as the sender instead of Gmail. Members cannot: Resend sends from the operator's own domain.

The older failure digest (`NOTIFY_EMAIL`, [Scheduling](scheduling.md#failure-alerts-optional)) keeps working on its own. If you set up these notifications with the failures subscription, you can remove `NOTIFY_EMAIL` to avoid hearing about the same failure twice.
