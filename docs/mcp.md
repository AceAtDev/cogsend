# MCP server

`<your instance>/api/mcp` is a Model Context Protocol server, so agents such as Claude Code and Codex can work with drafts and the publish queue using your personal API key. Generate one in **Settings → API access**, where you will also find the setup below with your own URL filled in.

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

| Tools                                                                                                                                                                                                         | Key needed   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `list_connections`, `list_drafts`, `get_draft`, `list_queue`, `validate_post`, `get_platform_requirements`, `list_media`                                                                                      | Read-only    |
| `create_draft`, `update_draft`, `duplicate_draft`, `delete_draft`, `set_draft_variant`, `delete_draft_variant`, `schedule_draft`, `reschedule_delivery`, `cancel_delivery`, `publish_draft`, `retry_delivery` | Read + write |
| `attach_media_from_url`, `attach_media_base64`, `create_media_upload`, `complete_media_upload`, `abort_media_upload`, `update_media`, `remove_media`, `set_video_cover`, `remove_video_cover`                 | Read + write |

The server also offers one resource, `cogsend://platform-requirements`, which holds what `get_platform_requirements` answers without arguments. Settings, insights, account and provider management, key management, scheduler administration and the internal publish endpoint are not exposed, and neither are prompts or sampling.

## Platform requirements

`get_platform_requirements` tells an agent what each platform takes before it builds a post, from the same limits the composer and the publishers enforce. For each platform it answers the text limit; whether media is required (Instagram refuses a post without a photo or video); how many images a post takes, of which types and how large, and whether the count is per post or for the whole thread; that images and a video never share a post; the video's container, codecs, size, duration, aspect ratio, width, pixel count and frame rate limits where CogSend knows them, and whether a cover is sent; thread support; alt text support and length; and a one-line `summary`. `platforms` narrows the list.

Give it `connectionIds` and each of those accounts is added under `accounts`, with what its own connection changes: a Mastodon instance's character and video limits, or an X account's long posts and longer videos. `store` lists CogSend's own ceilings (16 MB an image, 300 MB a video, 4 attachments on a segment, 32 a draft), and `attach` the ways in below with their caps.

A draft's `segmentIndex` 0 is the first post of a thread, 1 the second, and so on: media on a segment goes out with that post. LinkedIn and Instagram have no threads, so every segment's text and media are joined into one post there, and their image counts are for the whole draft.

## Attaching media

Three ways in, all landing in the same store and checks as the composer and the [API](api.md#media):

- `attach_media_from_url` fetches a public `http` or `https` URL and attaches it to one segment, with optional `altText`. Images go up to 16 MB, videos as far as one request can carry, around 200 MB on Workers Free and the full 300 MB on Paid with `SUBREQUEST_LIMIT` raised (see [Configuration](configuration.md#secrets)). The type is read from the file itself, never from the server's `Content-Type`. Addresses on loopback, private, link-local or cloud metadata networks are refused, and so is every redirect to one, before the server connects. A video too large for one request is refused with `useUploadSession: true`: send that one with `create_media_upload`.
- `attach_media_base64` takes a small image inline, PNG, JPEG, WebP or GIF, at most 3 MB once decoded. A video never goes this way.
- `create_media_upload` starts an upload of an MP4 of up to 300 MB that the agent sends itself over HTTP with its API key, in 10 MiB parts. It answers the URL, offset and length of every part and the headers to send. `PUT` each part's bytes to its URL, keep each answer's `etag`, then call `complete_media_upload` with the `upload` object and every `{ partNumber, etag }` in order. `abort_media_upload` gives one up.

For example, after `create_media_upload` answered two parts for `clip.mp4`:

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

A segment holds up to four images or one video, never both, and a draft up to 32 attachments, as in the composer; a platform that takes fewer is caught by validation, below. `list_media` lists a draft's attachments (they are in `get_draft` too). `update_media` changes alt text or moves an attachment to another segment, and `remove_media` deletes it. `set_video_cover` sets a video's cover from a JPEG of at most 8 MB, inline or by URL, for the platforms whose requirements say `video.cover`; `remove_video_cover` goes back to each platform's own frame. CogSend converts nothing: send MP4 video, and JPEG for Instagram unless the deployment has the Images binding.

## Validation

`validate_post` checks text as before. Give it a `draftId`, with optional `connectionIds` (the draft's selected accounts otherwise, or every active one), and it also checks the whole draft for each account the way publishing will, under `draft`: `ok`, one `problems` line per issue such as `LinkedIn @pat: LinkedIn allows max 4 images, 6 attached` or `Mastodon @me@example.social: Mastodon takes videos up to 40 MB — this one is 50 MB`, and per account the same `issues` with their `kind` (`media`, `text`, `post` or `account`), `code`, the thread `post` they belong to and the images and videos `attached` there.

`publish_draft` and `schedule_draft` run the same check first and refuse, before anything is sent or scheduled for any account, when a platform would refuse the media: the error carries every `problems` line and the `accounts` they belong to, so an agent can fix them all and try again. Accounts the draft has already published to are left out. Text and other problems still surface per account when the post is sent, as they do through the API.

## Before an agent publishes

`publish_draft` and `retry_delivery` post to real accounts. Set your client to ask before it runs tools that write or publish, and check the content, the accounts and the timing before you approve one.

CogSend marks `update_draft`, `set_draft_variant`, `delete_draft`, `delete_draft_variant`, `publish_draft`, `schedule_draft`, `cancel_delivery`, `retry_delivery`, `reschedule_delivery`, `update_media`, `remove_media`, `abort_media_upload`, `set_video_cover` and `remove_video_cover` as destructive, and `publish_draft`, `retry_delivery` and `attach_media_from_url` as reaching outside CogSend. Those marks are hints: only the client can stop and ask, and CogSend has no preview step of its own before a tool runs.

## How requests work

- The server is stateless Streamable HTTP over `POST`, and answers JSON. `GET` and `DELETE` answer **405**.
- It accepts only a personal key as `Authorization: Bearer`. Cookies, `X-API-Key`, `API_TOKEN`, scheduler credentials and keys in the URL are refused.
- Tool results carry a text summary and structured data.
- `ping` is not implemented, so a client that sends one can get JSON-RPC `-32601` or an HTTP 404.

If Cloudflare Access protects the instance, also send `CF-Access-Client-Id` and `CF-Access-Client-Secret` from your environment. [Cloudflare Access](access.md#the-paths-it-has-to-let-through) covers clients that cannot send them.
