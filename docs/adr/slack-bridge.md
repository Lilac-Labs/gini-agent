# Slack Messaging Bridge

## Decision

A Slack bridge is a `MessagingBridgeRecord` with `kind: "slack"` and TWO per-bridge encrypted credentials: a bot token (`xoxb-`) for Web API calls and an app-level token (`xapp-`, `connections:write` scope) for the inbound transport. The runtime talks to `slack.com/api` directly over `fetch` — no SDK dependency, matching the Telegram and Discord clients.

Inbound arrives over **Socket Mode**, not polling and not Events API webhooks. The runtime calls `apps.connections.open` with the app token, receives a one-shot `wss://` URL, and Slack pushes `message.im` event envelopes over the WebSocket. Two constraints force this transport: Slack's non-Marketplace app rate limits (May 2025 policy) cap `conversations.history` at ~1 request/minute with 15 items, which makes a Discord-style REST poll unusable; and the Events API over HTTP needs a public webhook URL that a laptop or Firecracker guest doesn't have. Socket Mode needs no inbound routing at all. Unlike the Discord gateway (a latency optimization layered over a REST source of truth), the Slack socket IS the inbound source of truth.

The session model is **one chat session per thread** — thread-per-message, the shape the bridge exists to deliver. A top-level DM message starts a NEW `ChatSessionRecord` keyed by the message's own `ts`; the assistant reply posts with `thread_ts` = that `ts`, so every answer lands in a thread under the user's message. A message typed inside an existing thread routes to the session keyed by the event's `thread_ts` (find-or-create, so replies to pre-bridge threads still work). Scope is **DM-only**: channel/group/mpim events are dropped entirely, and no channel routing, team-guest, or Block Kit machinery ships with this ADR.

## Context

This ADR follows `telegram-bridge.md` and `discord-bridge.md`. The messaging substrate (`MessagingBridgeRecord`, per-bridge encrypted secrets under `messaging.<bridgeId>`, per-kind dispatch in `packages/runtime/src/integrations/messaging.ts`, the supervisor/reconcile lifecycle, `awaitTerminalTask` + reply mirroring) is reused unchanged; Slack adds a third surface without re-litigating the trust boundary or the chat-task routing path.

Slack differs from the earlier bridges in three material ways. First, the two-token model: Socket Mode authenticates separately from the Web API, so a bridge needs both credentials at create time. Second, the wss URL from `apps.connections.open` is one-shot and Slack asks for a connection refresh roughly every 30 minutes via a `disconnect` frame — reconnect means a fresh `apps.connections.open` call, not re-dialing. Third, sessions key on threads rather than channels: a Slack DM channel is long-lived and shared across every conversation with the bot, so a per-channel session would blend unrelated asks into one transcript.

## App setup

The operator creates the Slack app by hand (one-time, ~2 minutes). Manifest-relevant settings:

- **Socket Mode**: enabled (Settings → Socket Mode).
- **App-level token**: generated under Basic Information → App-Level Tokens with the `connections:write` scope. This is the `appToken` on the create payload.
- **Bot token scopes** (OAuth & Permissions): `chat:write` (replies), `im:history` (DM message events), `reactions:write` (the 👀 ack).
- **Event subscriptions**: bot event `message.im`. With Socket Mode on, no request URL is needed.
- Install the app to the workspace and copy the bot token (`xoxb-`).

## Required Now

- `POST /api/messaging` with `kind: "slack"` requires BOTH `botToken` and `appToken` fields. Each is validated as header-safe printable ASCII before storage (same leak-prevention gate as the other bridges — a control-char token would otherwise echo the full `Authorization: Bearer <token>` header into the persisted `bridge.message`), then written through `writeSecret` under purposes `"bot-token"` and `"app-token"` and immediately discarded from memory.
- Slack onboarding goes through the CLI (`gini messaging add <name> slack --bot-token <xoxb> --app-token <xapp>`) or the settings page's Add Slack dialog. The in-chat `request_messaging_bridge` tool deliberately does NOT support `kind: "slack"`: the chat card collects a single bot token and Slack needs two credentials, so the dispatcher refuses synchronously with a points-to-settings error — the same shape as its Discord refusal. When the chat card grows a second token input, drop the refusal and widen the tool's enum.
- No `deliveryTargets` requirement. DM channels are discovered at event time (each event carries its channel id); there is nothing to configure up front. `bridge.deliveryTargets` stays empty and unused for Slack.
- `POST /api/messaging/:id/health` performs a real `auth.test` round-trip with the bot token. `botUserId`, `botUsername`, `teamId`, and `teamName` land on `bridge.metadata`; `botUserId` is load-bearing (the socket loop drops the bot's own messages by it). The app token is NOT probed by health — a probe would consume one of the app's limited concurrent Socket Mode connections, and socket-level auth failures already surface via the supervisor loop's `markBridgeError`.
- `POST /api/messaging/:id/send` dispatches `chat.postMessage` for Slack-kind bridges. `target` is the channel id; an optional `threadTs` input threads the message. Text is truncated client-side at Slack's 40,000-character cap. Outbound Markdown is converted to mrkdwn by `slack-format.ts` (conservative: `**bold**`/`__bold__` → `*bold*`, `[text](url)` → `<url|text>`, `# heading` lines → bold lines; code spans pass through untouched); `parseMode: "none"` sends the literal payload. Photo sends are rejected with a clear error today — Slack's multi-step external-upload flow is a follow-up.
- **thread_ts is always the thread ROOT ts** (`session.source.threadTs`), never `lastInboundMessageId`. Anchoring an outbound on a reply's own `ts` makes Slack fork a broken second thread off that reply. This applies to the socket loop's reply mirror AND to `finalize.ts`'s scheduled-job dispatch, which passes `threadTs` for slack sources where the other kinds pass `replyToMessageId`.
- The gateway runs a Slack bridge supervisor (`slack-bridge.ts`) with the same `{reconcile, stopAll, size}` contract as the pollers, reconciled every `GINI_MESSAGING_RECONCILE_MS` (5s default). `shouldRun` requires kind `slack`, status `configured`, and both secret refs. Each loop resolves the bot identity via `auth.test`, opens the Socket Mode connection, and then ticks on a short status-check cadence purely to observe disable/status flips and token rotation (there is no per-tick polling work).
- Socket client (`slack-socket.ts`): envelopes are **acked immediately on receipt, before processing** — Slack redelivers unacked envelopes and eventually drops the connection, and a poison event must not block the ack (same spirit as the pollers advancing their watermark unconditionally). `disconnect` frames close the socket and re-open via a fresh `apps.connections.open` with exponential backoff (1s..30s). Non-recoverable `apps.connections.open` errors (`invalid_auth`, `not_allowed_token_type`, `account_inactive`, `token_revoked`) resolve the handle's `done` instead of looping; the supervisor loop observes that, flips the bridge to `status: "error"`, and exits.
- Retried envelopes are deduped by `event_id` in a bounded in-memory set (500 entries, FIFO eviction) per loop. No persisted watermark exists — Socket Mode has no cursor to advance.
- **No backfill**: events during a disconnect window are lost; Slack does not replay missed events over a new Socket Mode connection. This is a documented limitation of the DM MVP, in the same spirit as the Discord poller's pagination-cap drop. An Events API webhook deployment (which gets Slack-side retries) is the escape hatch if a hosted deployment needs at-least-once delivery.
- Inbound filtering: only `type: "message"` events with `channel_type: "im"` route. Dropped: any `subtype` (edits, deletes, file_share — plain user messages carry no subtype), `bot_id`-authored messages (including the bridge's own replies), the bot's own `user` id, and empty-text messages.
- Ack UX: Slack has no bot typing API, so on inbound accept the loop adds an 👀 reaction (`reactions.add`) to the user's message, best-effort — a failure (missing `reactions:write` scope, deleted message) is logged and never gates the reply.
- Each thread is bound to a persistent `ChatSessionRecord` tagged `source: { kind: "slack", bridgeId, channelId, threadTs, target }`. `receiveMessagingInput` finds-or-creates the session and submits the user turn via `submitChatMessage` with `bypassQueue` — the same path as the other bridges (see [chat-message-queue.md](chat-message-queue.md)). When the chat-task settles, the detached per-message worker syncs the assistant message via `syncChatTaskResult` and mirrors it out via `sendMessagingOutput` threaded on the session's root ts. `[SILENT]` summaries suppress the mirror.
- Loop teardown mirrors the pollers: the supervisor's `startLoop` `.finally` aborts the controller on any exit; the loop's own `finally` closes the socket; detached workers are tracked and drained with a bounded timeout on `stopAll`; the outbound signal threads into `chat.postMessage` so a hung send cancels on shutdown.
- The Slack client (`slack.ts`) and socket (`slack-socket.ts`) are mockable via injected `fetch` / WebSocket constructors; the messaging module's `setMessagingDeps` gains `slackClientFactory`, and the supervisor accepts `clientFactory` / `socketConnector` seams so tests never open live connections.
- The shared log sanitizer scrubs both Slack token families (`xox?-…`, `xapp-…`) so an echoed Bearer header can't leak into `bridge.message` or the runtime log.

## Trust Boundary

- Both tokens are write-only fields on the create payload: encrypted at rest, never re-emitted on the record, in audit evidence, or on `MessagingMessageRecord`. Re-supplying means recreating the bridge.
- **Workspace-as-auth, DM-only.** Installing the app into a workspace is the explicit operator action, analogous to Discord's channel-as-auth: any member of that workspace can DM the bot and drive the runtime. That is acceptable for the personal/prosumer MVP where the workspace is the operator's own; the later hook for multi-user deployments is a Slack-user→guest membership map, at which point a `bridge.metadata.allowedUserIds` allowlist (mirroring Telegram's shape) becomes the per-user gate. Telegram's verification-code enrollment does NOT apply here — Telegram bots are addressable by anyone who finds the handle, while reaching this bot requires workspace membership.
- The socket loop calls `receiveMessagingInput`, which submits a chat-task. Task-level approvals and active-agent toolset filters apply unchanged; the reply mirror dispatches through `sendMessagingOutput`, which honors the messaging-target filter.
- Inline Block Kit approvals in the DM are out of scope; the web app's approval surface covers approvals, and the surface guards in `tool-dispatch.ts` refuse web-only cards on slack-sourced sessions with a "reply in text, point at the web chat" error — the same contract as telegram/discord.

## Open Questions

- Attachments. File/image events arrive with a `files` payload and (usually) empty text; they are dropped today. The inbound path would mirror the Telegram photo download; outbound needs Slack's `files.getUploadURLExternal` flow.
- Block Kit. Inline approve/deny buttons in the DM (the "if time" item on OPE-41) need the `interactive` Socket Mode envelope type and an approval-resolution bridge; the socket client already acks those envelopes, it just doesn't consume them.
- Channels and multiplayer. Channel routing, mention-gating, and per-user identity mapping are explicitly deferred to the team-workspace milestone.
- Presence. Slack ties bot presence to a Socket Mode connection only when the app sets `presence_sub`; the bridge doesn't manage presence today.

## Verification

- `bun test packages/runtime/src/integrations/slack.test.ts` exercises the Web API client (auth.test mapping, ok:false envelopes, thread_ts pass-through, 40k truncation) against an injected `fetch`.
- `bun test packages/runtime/src/integrations/slack-socket.test.ts` exercises the socket state machine (open via apps.connections.open, immediate ack, consumer-throw isolation, disconnect→fresh-URL reconnect, invalid_auth give-up, transient-error backoff) against stub WebSocket + fetch.
- `bun test packages/runtime/src/integrations/slack-bridge.test.ts` exercises the supervisor (reconcile start/stop, both-secrets gate, thread-per-message session routing, thread-reply continuation, root-ts reply threading, drop filters, event_id dedupe, socket give-up → bridge error, self-exit on status flip).
- `bun test packages/runtime/src/integrations/messaging-slack.test.ts` covers the dispatcher branches (two-token create + header-safety, health metadata, threaded send + mrkdwn conversion, photo rejection, per-thread session keying).
- `bun test packages/runtime/src/jobs.part2.test.ts` pins the finalize dispatch anchoring on the thread root ts rather than `lastInboundMessageId`.
