# MCP server

`<your instance>/api/mcp` is a Model Context Protocol server, so agents such as Claude Code and Codex can create, schedule, move and cancel posts across your brands' channels using your personal API key. Generate one in **Settings → API access**, where you will also find the setup below with your own URL filled in.

## Connect a client

Give an agent a Read-only key unless it needs to change drafts or publish, and keep the key in an environment variable. Never commit a real key.

### Claude Code

Add this to `.mcp.json` and set `COGSEND_API_KEY` in your environment before starting Claude Code:

```json
{
	"mcpServers": {
		"cogsend": {
			"type": "http",
			"url": "https://cogsend.example.com/api/mcp",
			"headers": { "Authorization": "Bearer ${COGSEND_API_KEY}" }
		}
	}
}
```

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.cogsend]
url = "https://cogsend.example.com/api/mcp"
bearer_token_env_var = "COGSEND_API_KEY"
default_tools_approval_mode = "prompt"
```

### Other clients

Point the client at the same URL over Streamable HTTP and send the key as `Authorization: Bearer <key>`. Whether a client expands an environment variable in its config varies, so check its documentation.

To try the connection, list the tools with MCP Inspector:

```sh
npx @modelcontextprotocol/inspector --cli "https://cogsend.example.com/api/mcp" \
  --transport http \
  --protocol-era modern \
  --method tools/list \
  --header "Authorization: Bearer $COGSEND_API_KEY"
```

## Tools

An agent's first call is `list_channels`. Everything after it names channels by the keys it returns, and works out relative dates from the `now` it returns.

| Tool                        | Key needed   | What it does                                                                                       |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `list_channels`             | Read-only    | Brands and their channels (key, platform, @handle, status, colour), `now`, platform summaries      |
| `list_posts`                | Read-only    | Deliveries in time order, filtered by brand, channel, status and date range, paged; or drafts      |
| `get_post`                  | Read-only    | One post: text, variants, media, every delivery, and (detailed) what a platform would refuse       |
| `get_platform_requirements` | Read-only    | Each platform's text, image and video limits, per channel when asked                               |
| `validate_post`             | Read-only    | Checks text or a draft against channels, the way publishing will                                   |
| `schedule_posts`            | Read + write | Creates and schedules up to 10 posts in one call, with a preview and confirmation                  |
| `reschedule_posts`          | Read + write | Changes the time of deliveries or whole posts                                                      |
| `move_post`                 | Read + write | Changes a post's channels, with confirmation                                                       |
| `cancel_posts`              | Read + write | Cancels deliveries, or deletes whole posts                                                         |
| `resubmit_for_review`       | Read + write | Sends deliveries the operator rejected back to review after the agent revised the post             |
| `publish_now`               | Read + write | Publishes an existing post now, or retries a failed delivery, with confirmation                    |
| `save_draft`                | Read + write | Creates or edits a draft: text, per-platform variants and options, intended channels               |
| `attach_media`              | Read + write | Attaches an image or video from a URL, or a small image inline; creates a draft when none is given |
| `media_upload`              | Read + write | Uploads a large video in parts (`start`, `complete`, `abort`)                                      |
| `edit_media`                | Read + write | Changes alt text or segment, removes an attachment, sets or removes a video cover                  |

A post is what the composer calls a draft, and a delivery is that post on one channel; `postId` and `deliveryId` are their ids. Every tool answers a short summary and the same data as JSON, also as structured content matching the tool's output schema. Every write echoes what it resolved (post id, delivery id, brand, channel key, @handle, local and UTC time, status) and a `next` hint. A refused call is an error result that names each problem, says how to fix it and quotes a valid call. Each tool's `_meta["cogsend/inputExamples"]` holds example arguments.

The server also offers one resource, `cogsend://platform-requirements`, which holds what `get_platform_requirements` answers without arguments. Settings, insights, account and brand management, key management, scheduler administration and the internal publish endpoint are not exposed, and neither are prompts or sampling.

### Moving from the earlier tools

The first version had 27 tools that mirrored the REST API. They are gone; this is where each one went.

| Earlier tool                                                                | Now                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `list_connections`                                                          | `list_channels`                                                                                  |
| `list_drafts`, `list_queue`                                                 | `list_posts` (`status: ["draft"]` for drafts)                                                    |
| `get_draft`, `list_media`                                                   | `get_post`                                                                                       |
| `create_draft`, `update_draft`, `set_draft_variant`, `delete_draft_variant` | `save_draft`                                                                                     |
| `schedule_draft`                                                            | `schedule_posts` (`posts[].draftId` for an existing draft)                                       |
| `publish_draft`, `retry_delivery`                                           | `publish_now`                                                                                    |
| `reschedule_delivery`                                                       | `reschedule_posts`                                                                               |
| `cancel_delivery`, `delete_draft`                                           | `cancel_posts` (`deletePost: true` to delete)                                                    |
| `duplicate_draft`                                                           | `schedule_posts` with a `draftId` (copies it when channels need different text), or the REST API |
| `attach_media_from_url`, `attach_media_base64`                              | `attach_media` (`url` or `base64`)                                                               |
| `create_media_upload`, `complete_media_upload`, `abort_media_upload`        | `media_upload` (`action`)                                                                        |
| `update_media`, `remove_media`, `set_video_cover`, `remove_video_cover`     | `edit_media` (`action`)                                                                          |
| `validate_post`, `get_platform_requirements`                                | the same names, with `channels` instead of `connectionIds`                                       |

## Review before publishing

On a brand that reviews agent posts, which is every brand until the operator trusts it in **Accounts**, and on every account with no brand ([Review and pause](accounts.md#review-and-pause)), a committed `schedule_posts`, `publish_now` or `move_post` writes each delivery as `awaiting_review` instead of scheduling or sending it. The delivery keeps its time, and nothing goes out until the operator approves it in the [Review inbox](posts.md#review); a held "publish now" goes out on the next tick once approved. `list_channels` gives each brand `requireApproval` and `paused`, and says the same in its summary.

A write that held anything answers `heldForReview` (how many) and starts its summary with a line an agent cannot miss:

```text
HELD FOR REVIEW: 1 delivery waits for the operator, who approves in the Review inbox. Nothing is published until then; do not resend or publish_now it.
Submitted for review 1 delivery:
jobjob.linkedin @jobjob — awaiting_review at Tue 3 Nov 2026, 09:00 (Europe/Berlin) (post 7f…, delivery 2c…)
```

Its `status` is `awaiting_review` when every delivery was held; a batch across a trusted and a reviewed brand answers `scheduled` and holds only the reviewed ones.

- `list_posts` lists `awaiting_review` and `rejected` deliveries by default, beside the scheduled, pending, publishing and failed ones, and takes either in `status`. Each carries `review`: `state` (`waiting`, `overdue` once its time has passed unapproved, or `rejected`), the reviewer's `note` and `reviewedAt`. `get_post` adds the same `review` to each delivery.
- The operator approves (it becomes `scheduled`) or rejects it with a note (`rejected`). Read the note, revise the post with `save_draft`, `attach_media` or `edit_media`, then call `resubmit_for_review` with the `postId` (or `deliveryId`s); give `runAt` when the old time has passed. It answers the deliveries back in `awaiting_review`, and repeating it changes nothing more.
- `reschedule_posts` keeps a held delivery held at its new time and refuses a rejected one. Changing the text, variants or media of a post the operator already approved sends its deliveries on reviewed brands back to `awaiting_review`.
- An agent cannot approve: there is no tool for it, and the REST routes for it refuse every API key. A paused brand publishes nothing until the operator resumes it, whatever its deliveries' state.

Every committed write tool call is recorded in **Activity** with the key that made it.

## Naming channels

Channels are named by their [channel key](accounts.md#brands), such as `jobjob.linkedin`, exactly as `list_channels` lists it; `{"brand": "jobjob", "platform": "linkedin"}` (brand by slug or exact name, with an optional exact `handle`) and connection ids work too. Matching is exact and never guessed:

- A bare platform such as `instagram` is refused when more than one channel posts there, and the error lists every candidate with its brand and @handle. So is a brand alone, a misspelt key, and `jobjob.instagram` once JobJob has two Instagram accounts.
- An account that needs reconnecting is refused rather than replaced by another on the same platform.
- Naming the same account twice in one post is refused.

## Times

`runAt` is either an ISO 8601 time with `Z` or an offset, such as `2026-11-03T09:00:00+01:00`, or `{"localTime": "2026-11-03T09:00", "timeZone": "Europe/Berlin"}`. A time without a zone, a time in the past and a time more than a year ahead are refused, and the error states the server's current time in UTC and in your time zone (the one the app records from your browser when you open it). A local time that does not exist because the clocks jump forward, or happens twice because they go back, is refused with the instants it could mean. Every time CogSend answers comes in UTC and in your time zone with its weekday, and `list_posts` reads a `from` or `to` such as `2026-11-03` as that whole day in your time zone.

## Preview and confirmation

Writes that could put a post on the wrong account take two calls:

- `schedule_posts` when the batch targets more than one channel or more than one brand, or uses `runAt: "now"`;
- `move_post` and `publish_now`, always.

The first call validates everything and writes nothing. It answers `status: "confirmation_required"`, a preview per delivery (brand, channel key, @handle, local time with weekday, UTC, a text excerpt, media) with warnings such as another post on the same channel less than an hour away or one post going to two brands, and a `confirmToken`. Repeating the identical call with that token commits it. The token lasts ten minutes, works once, and is bound to a hash of the plan it previewed, with every channel resolved to its account and every time to UTC: change the text, a channel or a time, or re-point a key at another account in **Accounts**, and the commit is refused with nothing written. Only a hash of the token is stored. `dryRun: true` gives the same preview for any call, including a single-channel schedule, which otherwise commits at once.

`schedule_posts` checks every post against each of its channels' platform rules before writing any of them, and refuses the whole batch with every problem listed. Media given by URL is fetched when the batch is committed and checked again then; if a platform would refuse it, the drafts made for the batch are removed and nothing is scheduled. When one post gives two channels on the same platform different text, it is saved as one post per text, and the preview says so. A batch takes up to 10 posts and 20 deliveries. On the Workers Free plan a large batch can run out of the request's call budget; when that happens after some posts were committed, the answer says `status: "partial"` and lists the posts in `notCommitted` to send again.

CogSend does not use MCP elicitation for confirmation: an answer to an elicitation comes from the client, which for an unattended agent may be the agent itself, while a token checked by the server binds the confirmation to the exact payload. Set your client to ask before it runs tools that write, too.

## Idempotency keys

`schedule_posts`, `move_post`, `publish_now` and `save_draft` take an optional `idempotencyKey` (8 to 128 letters, digits, `_`, `.`, `:` or `-`). The first call with a key runs and its answer is kept for 24 hours; repeating the identical call with the same key answers the same result with `idempotentReplay: true` instead of writing again, even with a fresh `confirmToken`. The same key with different arguments is refused, and a call still running with that key answers 409. A call that fails before writing anything forgets its key, so a corrected retry can reuse it. `reschedule_posts` and `cancel_posts` are safe to repeat as they are.

## Platform requirements

`get_platform_requirements` tells an agent what each platform takes before it builds a post, from the same limits the composer and the publishers enforce. For each platform it answers the text limit; whether media is required (Instagram refuses a post without a photo or video); how many images a post takes, of which types and how large, and whether the count is per post or for the whole thread; that images and a video never share a post; the video's container, codecs, size, duration, aspect ratio, width, pixel count and frame rate limits where CogSend knows them, and whether a cover is sent; thread support; alt text support and length; and a one-line `summary`. `platforms` narrows the list; `list_channels` carries the summaries of the platforms you use.

Give it `channels` and each of those accounts is added under `accounts`, with what its own connection changes: a Mastodon instance's character and video limits, or an X account's long posts and longer videos. `store` lists CogSend's own ceilings (16 MB an image, 300 MB a video, 4 attachments on a segment, 32 a draft), and `attach` the ways in below with their caps.

A draft's `segmentIndex` 0 is the first post of a thread, 1 the second, and so on: media on a segment goes out with that post. LinkedIn and Instagram have no threads, so every segment's text and media are joined into one post there, and their image counts are for the whole draft.

## Attaching media

Simple media goes straight into `schedule_posts` as `posts[].media: [{"url", "altText"}]`. For anything else, attach it to a draft first and schedule the draft with `posts[].draftId`. `attach_media` and `media_upload` create a new draft when no `draftId` is given and answer its `postId`. Three ways in, all landing in the same store and checks as the composer and the [API](api.md#media):

- `attach_media` with `url` fetches a public `http` or `https` URL and attaches it to one segment, with optional `altText`. Images go up to 16 MB, videos as far as one request can carry, around 200 MB on Workers Free and the full 300 MB on Paid with `SUBREQUEST_LIMIT` raised (see [Configuration](configuration.md#secrets)). The type is read from the file itself, never from the server's `Content-Type`. Addresses on loopback, private, link-local or cloud metadata networks are refused, and so is every redirect to one, before the server connects. A video too large for one request is refused with `useUploadSession: true`: send that one with `media_upload`.
- `attach_media` with `base64` takes a small image inline, PNG, JPEG, WebP or GIF, at most 3 MB once decoded. A video never goes this way.
- `media_upload` with `action: "start"` and the file's `size` starts an upload of an MP4 of up to 300 MB that the agent sends itself over HTTP with its API key, in 10 MiB parts. It answers the URL, offset and length of every part and the headers to send. `PUT` each part's bytes to its URL, keep each answer's `etag`, then call `media_upload` with `action: "complete"`, the `draftId`, the `upload` object and every `{ partNumber, etag }` in order. `action: "abort"` gives one up.

For example, after `media_upload` answered two parts for `clip.mp4`:

```sh
curl -s -X PUT "PART_1_URL" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @<(head -c 10485760 clip.mp4)

curl -s -X PUT "PART_2_URL" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @<(tail -c +10485761 clip.mp4)
```

Each answers `{ "partNumber": n, "etag": "…" }`.

A segment holds up to four images or one video, never both, and a draft up to 32 attachments, as in the composer; a platform that takes fewer is caught by validation, below. `get_post` lists a draft's attachments with their `mediaId`. `edit_media` with `action: "update"` changes alt text or moves an attachment to another segment, `"remove"` deletes it, `"set_cover"` sets a video's cover from a JPEG of at most 8 MB (`coverBase64` or `coverUrl`) for the platforms whose requirements say `video.cover`, and `"remove_cover"` goes back to each platform's own frame. CogSend converts nothing: send MP4 video, and JPEG for Instagram unless the deployment has the Images binding.

## Validation

`validate_post` with `channels` checks `text`, or a saved draft (`draftId`), for each of those channels the way publishing will: `ok`, one `problems` line per issue such as `LinkedIn @pat: LinkedIn allows max 4 images, 6 attached` or `Mastodon @me@example.social: Mastodon takes videos up to 40 MB — this one is 50 MB`, and per channel the same `issues` with their `kind` (`media`, `text`, `post` or `account`), `code`, the thread `post` they belong to and the images and videos `attached` there. Without `channels` it checks a draft against its own selected accounts, or text against every platform's length rules.

`schedule_posts`, `move_post` and `publish_now` run the same check first and refuse, before anything is written or sent for any channel, listing every problem. Accounts a post has already published to are left out.

## How requests work

- The server is stateless Streamable HTTP over `POST`, and answers JSON. `GET` and `DELETE` answer **405**.
- It accepts only a personal key as `Authorization: Bearer`. Cookies, `X-API-Key`, `API_TOKEN`, scheduler credentials and keys in the URL are refused.
- Tool results carry a text summary and structured data.
- `ping` is not implemented, so a client that sends one can get JSON-RPC `-32601` or an HTTP 404.

If Cloudflare Access protects the instance, also send `CF-Access-Client-Id` and `CF-Access-Client-Secret` from your environment. [Cloudflare Access](access.md#the-paths-it-has-to-let-through) covers clients that cannot send them.
