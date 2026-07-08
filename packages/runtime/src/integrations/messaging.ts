import { randomBytes } from "node:crypto";
import type { ChatSessionRecord, ConnectorSecretRef, MessagingBridgeRecord, RuntimeConfig } from "../types";
import { submitTask } from "../agent";
import {
  addAudit,
  appendLog,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  findOrCreateDiscordChatSession,
  findOrCreateSlackChatSession,
  findOrCreateTelegramChatSession,
  id,
  mutateState,
  now,
  readState
} from "../state";
import { submitChatMessage } from "../execution/chat";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../state/secrets";
import { resolveEffectiveContext } from "../execution/effective-context";
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramClientOptions,
  type TelegramPhotoSource
} from "./telegram";
import {
  createDiscordClient,
  type DiscordClient,
  type DiscordClientOptions
} from "./discord";
import {
  createSlackClient,
  type SlackClient,
  type SlackClientOptions
} from "./slack";
import { formatTelegramMarkdownV2 } from "./telegram-format";
import { formatSlackMrkdwn } from "./slack-format";
import type { MessagingMessageMedia } from "../types";

// Namespace used when storing per-bridge secrets through the connector
// secret store. Keeping it stable lets `deleteConnectorSecrets` find every
// secret a bridge owns even if the bridge's secretRefs list ever drifts.
function bridgeSecretNamespace(bridgeId: string): string {
  return `messaging.${bridgeId}`;
}

// Validate that a bot token is safe to embed in an HTTP request line —
// printable ASCII only, no whitespace, no control characters. Without
// this, a token containing a newline or control char would be rejected
// at fetch time and the resulting error message includes the full
// `Authorization: Bot <token>` header value, which then lands in
// `bridge.message` / `MessagingMessageRecord.error` and leaks via
// `GET /api/messaging`. Rejecting at create time stops the leak at
// the source.
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;
export function assertHeaderSafeToken(kind: string, raw: string, tokenLabel = "bot token"): void {
  if (!HEADER_SAFE_TOKEN.test(raw)) {
    throw new Error(
      `${bridgeKindLabel(kind)} ${tokenLabel} contains invalid characters — header-safe printable ASCII only.`
    );
  }
}

function bridgeKindLabel(kind: string): string {
  if (kind === "telegram") return "Telegram";
  if (kind === "discord") return "Discord";
  if (kind === "slack") return "Slack";
  return kind;
}

// Re-export the shared sanitizer so existing call sites in this file
// stay readable. The helper covers Discord auth-header tokens,
// Telegram URL-path tokens, and filesystem paths under <root>/secrets/
// — see messaging-poller-helpers.ts for the full pattern list.
import { isBridgeSurfaceKind, sanitizeBridgeStatusMessage as sanitizeBridgeError, sleepUnlessAbortedThrow } from "./messaging-poller-helpers";

// Test seam: production code calls Telegram / Discord for real, but tests
// inject stubbed clients so we can exercise send/health/poll without
// network IO. Each provider gets its own factory so a test can swap one
// without disturbing the other.
export interface MessagingDeps {
  telegramClientFactory?: (token: string) => TelegramClient;
  discordClientFactory?: (token: string) => DiscordClient;
  slackClientFactory?: (token: string) => SlackClient;
}

let injectedDeps: MessagingDeps = {};
export function setMessagingDeps(deps: MessagingDeps): void {
  injectedDeps = deps;
}
export function resetMessagingDeps(): void {
  injectedDeps = {};
}

function telegramClientFor(token: string, options?: TelegramClientOptions): TelegramClient {
  if (injectedDeps.telegramClientFactory) return injectedDeps.telegramClientFactory(token);
  return createTelegramClient(token, options);
}

function discordClientFor(token: string, options?: DiscordClientOptions): DiscordClient {
  if (injectedDeps.discordClientFactory) return injectedDeps.discordClientFactory(token);
  return createDiscordClient(token, options);
}

function slackClientFor(token: string, options?: SlackClientOptions): SlackClient {
  if (injectedDeps.slackClientFactory) return injectedDeps.slackClientFactory(token);
  return createSlackClient(token, options);
}

// Translate the caller's photo input into a TelegramPhotoSource. Returns
// undefined when no photo is supplied. We accept url/fileId/path on a
// nested `photo` object; bytes uploads aren't reachable from the HTTP
// surface today (no multipart inbound) and are reserved for in-process
// callers like the agent's tool dispatcher.
function parsePhotoInput(raw: unknown): TelegramPhotoSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const photo = raw as { url?: unknown; fileId?: unknown; path?: unknown; filename?: unknown; contentType?: unknown };
  if (typeof photo.url === "string" && photo.url) return { kind: "url", url: photo.url };
  if (typeof photo.fileId === "string" && photo.fileId) return { kind: "fileId", fileId: photo.fileId };
  if (typeof photo.path === "string" && photo.path) {
    return {
      kind: "path",
      path: photo.path,
      filename: typeof photo.filename === "string" ? photo.filename : undefined,
      contentType: typeof photo.contentType === "string" ? photo.contentType : undefined
    };
  }
  return undefined;
}

function mediaRecordForOutbound(source: TelegramPhotoSource | undefined): MessagingMessageMedia | undefined {
  if (!source) return undefined;
  if (source.kind === "url") return { kind: "photo", url: source.url };
  if (source.kind === "fileId") return { kind: "photo", fileId: source.fileId };
  if (source.kind === "path") return { kind: "photo", path: source.path };
  return { kind: "photo" };
}

// The bot-token secret used to be stored under purpose "token" before a
// rename to "bot-token". Existing on-disk state from older bridges still
// references the old purpose string; the encrypted file lives under
// secrets/<bridge>.token.json. Accept either purpose so a bridge created
// pre-rename keeps polling without forcing the operator to recreate it.
const BOT_TOKEN_PURPOSES = ["bot-token", "token"] as const;
export function isBotTokenRef(ref: { purpose: string }): boolean {
  return (BOT_TOKEN_PURPOSES as readonly string[]).includes(ref.purpose);
}

export function readBridgeBotToken(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  const ref = bridge.secretRefs?.find(isBotTokenRef);
  if (!ref) return undefined;
  return readSecret(config.instance, ref);
}

// Slack bridges carry a second secret: the app-level xapp- token that
// authenticates the Socket Mode connection (`connections:write`). Web
// API calls keep using the bot token; the two are separate credentials
// in Slack's model and are stored as separate purposes under the same
// bridge namespace.
export function isAppTokenRef(ref: { purpose: string }): boolean {
  return ref.purpose === "app-token";
}

export function readBridgeAppToken(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  const ref = bridge.secretRefs?.find(isAppTokenRef);
  if (!ref) return undefined;
  return readSecret(config.instance, ref);
}

// Read the bot token without 500ing the API on a secret-read
// failure. Both ENOENT and other read failures (corrupt JSON, AES
// auth tag mismatch, permission denied) collapse to undefined so
// the per-kind branches in checkMessagingBridge / sendMessagingOutput
// produce a typed "missing token" bridge error instead of a stack
// trace. Non-ENOENT errors get a runtime log entry with the raw
// (sanitized) message so the underlying cause stays diagnosable
// from runtime.jsonl even though the API surface shows "missing".
// The poller path uses the throwing readBridgeBotToken + markBridgeError
// so it surfaces the real reason on bridge.message directly.
function readBridgeBotTokenQuiet(config: RuntimeConfig, bridge: MessagingBridgeRecord): string | undefined {
  try {
    return readBridgeBotToken(config, bridge);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      appendLog(config.instance, "messaging.secret_read_error", {
        bridgeId: bridge.id,
        kind: bridge.kind,
        error: sanitizeBridgeError(message)
      });
    }
    return undefined;
  }
}

export async function addMessagingBridge(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const kind = String(input.kind ?? "demo");
  if (!name) throw new Error("Messaging bridge name is required.");

  // Telegram, Discord, and Slack all need a bot token. The credential
  // travels in on the create payload exactly once and is immediately
  // handed to the encrypted secret store; the plaintext never lands on
  // the bridge record or in audit evidence.
  const requiresToken = isBridgeSurfaceKind(kind);
  const botToken = requiresToken && typeof input.botToken === "string" ? input.botToken.trim() : "";
  if (requiresToken && !botToken) {
    throw new Error(`${bridgeKindLabel(kind)} bridges require a botToken in the create payload.`);
  }
  if (requiresToken) {
    // Reject malformed tokens at create time. Without this, a token
    // containing a control character would be accepted, persisted to
    // the encrypted secret store, and then leak via the eventual
    // fetch error (Bun's HTTP layer echoes the auth header value in
    // its rejection message, which we persist to bridge.message).
    assertHeaderSafeToken(kind, botToken);
  }
  // Slack additionally needs the app-level Socket Mode token — the
  // inbound WebSocket authenticates with xapp-, not the bot token.
  // Same one-shot handling: validated here, encrypted at rest, never
  // on the record.
  const appToken = kind === "slack" && typeof input.appToken === "string" ? input.appToken.trim() : "";
  if (kind === "slack" && !appToken) {
    throw new Error("Slack bridges require an appToken (xapp- app-level token with connections:write) in the create payload.");
  }
  if (appToken) {
    assertHeaderSafeToken(kind, appToken, "app-level token");
  }

  // Pre-generate the bridge id outside mutateState so the secret can be
  // written under a known namespace BEFORE the single state mutation
  // lands. Previously add called mutateState twice (create row, then
  // attach secret ref) with the writeSecret in between, which let a
  // concurrent removeMessagingBridge observe the row from the first
  // mutation, delete the namespace, and drop the row — then add's
  // second mutation threw "bridge not found" with an orphaned encrypted
  // secret file on disk. Collapsing to one mutation closes the window.
  const bridgeId = id("bridge");
  const secretRef = requiresToken
    ? writeSecret(config.instance, bridgeSecretNamespace(bridgeId), "bot-token", botToken)
    : undefined;
  const appSecretRef = appToken
    ? writeSecret(config.instance, bridgeSecretNamespace(bridgeId), "app-token", appToken)
    : undefined;

  const bridge = await mutateState(config.instance, (state) => {
    const item = createMessagingBridgeRecord(state, {
      id: bridgeId,
      name,
      kind,
      deliveryTargets: Array.isArray(input.deliveryTargets) ? input.deliveryTargets.map(String) : []
    });
    if (secretRef) attachSecretRef(state.messagingBridges, item.id, secretRef);
    if (appSecretRef) attachSecretRef(state.messagingBridges, item.id, appSecretRef);
    return item;
  });

  // Every bridge kind stores its token(s) here; enrollment is per-chat
  // from this point on. For telegram, the poller mints a verification
  // code when any unrecognized chat DMs the bot and surfaces a matching
  // entry to the operator UI. Discord uses channel-as-auth (see ADR
  // discord-bridge.md) so the operator configured the target channel
  // IDs at create time. Slack uses workspace-as-auth (see ADR
  // slack-bridge.md): installing the app into a workspace is the
  // operator action, and any member's DM to the bot routes.
  return bridge;
}

function attachSecretRef(
  bridges: MessagingBridgeRecord[],
  bridgeId: string,
  ref: ConnectorSecretRef
): MessagingBridgeRecord {
  const bridge = bridges.find((item) => item.id === bridgeId);
  if (!bridge) throw new Error(`Messaging bridge not found: ${bridgeId}`);
  const existing = bridge.secretRefs ?? [];
  const filtered = existing.filter((candidate) => candidate.purpose !== ref.purpose);
  bridge.secretRefs = [...filtered, ref];
  bridge.updatedAt = now();
  return bridge;
}

export async function checkMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  // Disabled bridges short-circuit the entire health check — no
  // network call, no metadata mutation, no audit row. The user
  // explicitly turned this bridge off; a health probe shouldn't
  // touch its state at all.
  if (bridge.status === "disabled") return bridge;

  // Per-kind health round-trip. We do the network call *outside*
  // mutateState so the lock isn't held for the duration of the
  // request, then fold the outcome back in. Only fields we actually
  // refresh (botUsername, botId) land in `metadataPatch` — the final
  // mutateState merges them into the live bridge so concurrent
  // metadata writes (the inbound poller advancing watermarks, etc.)
  // don't get clobbered by a stale snapshot.
  let nextStatus: MessagingBridgeRecord["status"] = "configured";
  let nextMessage: string;
  const metadataPatch: Record<string, unknown> = {};

  if (bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Telegram bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await telegramClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        nextMessage = me.username
          ? `Connected as @${me.username}.`
          : `Connected as bot ${me.id}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Discord bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await discordClientFor(token).getMe();
        metadataPatch.botUsername = me.username;
        metadataPatch.botId = me.id;
        // Set explicitly to null when the API returns no
        // global_name (older bots, removed display name), so the
        // metadata merge clears any stale value instead of
        // preserving it indefinitely.
        metadataPatch.globalName = typeof me.global_name === "string" && me.global_name.length > 0
          ? me.global_name
          : null;
        // Newer Discord accounts return discriminator "0" and surface
        // the handle via global_name; older bots keep username#discriminator.
        const handle = me.global_name && me.global_name.length > 0
          ? me.global_name
          : me.discriminator && me.discriminator !== "0"
            ? `${me.username}#${me.discriminator}`
            : me.username;
        nextMessage = `Connected as ${handle}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (bridge.kind === "slack") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      nextStatus = "error";
      nextMessage = "Slack bot token is missing — recreate the bridge with a botToken.";
    } else {
      try {
        const me = await slackClientFor(token).authTest();
        // botUserId is load-bearing beyond display: the socket loop
        // uses it to drop the bot's own messages from inbound routing.
        metadataPatch.botUserId = me.userId;
        metadataPatch.botUsername = me.user;
        metadataPatch.teamId = me.teamId;
        metadataPatch.teamName = me.team;
        nextMessage = me.user
          ? `Connected as @${me.user}${me.team ? ` in ${me.team}` : ""}.`
          : `Connected as bot ${me.userId}.`;
      } catch (error) {
        nextStatus = "error";
        nextMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
    // The app-level token is deliberately NOT probed here — Socket
    // Mode auth failures surface via the supervisor loop's
    // markBridgeError, and a probe would burn one of the app's
    // limited concurrent socket slots for no signal the loop doesn't
    // already produce.
  } else if (bridge.kind === "demo") {
    nextMessage = "Demo messaging bridge is available for local inbound/outbound task messages.";
  } else {
    nextMessage = `${bridge.kind} bridge is configured with local Gini task routing.`;
  }

  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.lastHealthAt = now();
    // Disable race: a user-initiated disableMessagingBridge can land
    // while we were awaiting getMe(). Don't stamp the snapshotted
    // status/message back over "disabled" — preserve the user's
    // explicit intent. Metadata still merges so any concurrent
    // poller writes survive regardless.
    if (live.status !== "disabled") {
      live.status = nextStatus;
      live.message = nextMessage;
    }
    // Merge into the live metadata instead of overwriting from the
    // pre-await snapshot — concurrent poller writes to
    // metadata.lastInboundExternalIds / lastOffset must survive.
    live.metadata = { ...(live.metadata ?? {}), ...metadataPatch };
    live.updatedAt = live.lastHealthAt;
    // Bridge health probes are instance-level — the bridge serves every
    // agent, so the row doesn't belong to any one of them.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "messaging.health",
        target: live.id,
        risk: "low",
        evidence: { kind: live.kind, status: live.status }
      },
      { system: true }
    );
    return live;
  });
}

export function listMessagingMessages(config: RuntimeConfig, bridgeId?: string) {
  const messages = readState(config.instance).messagingMessages;
  return bridgeId ? messages.filter((message) => message.bridgeId === bridgeId) : messages;
}

export async function receiveMessagingInput(config: RuntimeConfig, idOrName: string, input: Record<string, unknown>) {
  const bridge = readState(config.instance).messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  if (bridge.status !== "configured") throw new Error(`Messaging bridge is not configured: ${idOrName}`);
  const text = String(input.text ?? "").trim();
  const media = parseInboundMedia(input.media);
  if (!text && !media) throw new Error("Inbound message text or media is required.");

  // Target validation is per-kind. Don't coerce a missing target to
  // "local" before the kind branches — that would mask required-target
  // guards (e.g. Discord's channel id). Each branch decides whether
  // the target is optional and what default applies. We accept
  // strings and finite numbers (JSON clients commonly send Telegram
  // chat_ids as numbers); everything else collapses to the empty
  // string which the per-kind guards reject.
  const rawTarget = typeof input.target === "string"
    ? input.target
    : typeof input.target === "number" && Number.isFinite(input.target)
      ? String(input.target)
      : "";

  // Telegram + Discord inbound run through the chat-task path so each
  // chat / channel gets a persistent conversation — same surface as the
  // web chat UI. The session carries a `source` descriptor so the
  // runtime can mirror assistant replies back out to the originating
  // chat. demo / generic bridges keep the standalone-task path for
  // tests and CLI parity.
  // Messaging bypasses the interactive-client queue (ADR
  // chat-message-queue.md): each inbound message runs immediately and gets
  // its own taskId, which the poller's reply-mirror needs to wait on and
  // send the assistant reply back out. A queued submit would land without a
  // taskId and silently drop the reply.
  let taskId: string | undefined;
  let target: string;
  if (bridge.kind === "telegram") {
    // Strict integer parse: `Number.parseInt("123abc", 10)` returns 123
    // (the leading-numeric prefix), which would silently route a
    // malformed target to chat 123. Require the entire string to be a
    // signed integer with no trailing garbage.
    if (!/^-?\d+$/.test(rawTarget)) {
      throw new Error(`Telegram inbound target must be a numeric chat_id (got '${rawTarget}').`);
    }
    const chatId = Number.parseInt(rawTarget, 10);
    if (!Number.isFinite(chatId) || !Number.isSafeInteger(chatId)) {
      throw new Error(`Telegram inbound target must be a numeric chat_id (got '${rawTarget}').`);
    }
    target = String(chatId);
    const inboundMessageId = typeof input.messageId === "number" && Number.isFinite(input.messageId)
      ? (input.messageId as number)
      : undefined;
    const session = await mutateState(config.instance, (state) => {
      const sess = findOrCreateTelegramChatSession(state, bridge.id, chatId);
      // Stamp the originating message id on the source so scheduled-job
      // replies that fire later (after the inbound poll cycle moves on)
      // can thread back onto the original message via Telegram's
      // reply_to_message_id. Only stamp when the poller supplied one
      // so the HTTP /receive path doesn't blank it out.
      if (sess.source?.kind === "telegram" && inboundMessageId !== undefined) {
        sess.source.lastInboundMessageId = inboundMessageId;
      }
      return sess;
    });
    const result = await submitChatMessage(config, session.id, { content: text }, { bypassQueue: true });
    taskId = result.taskId;
  } else if (bridge.kind === "discord") {
    const channelId = rawTarget.trim();
    if (!channelId) {
      throw new Error("Discord inbound target (channel id) is required.");
    }
    target = channelId;
    const inboundMessageId = typeof input.messageId === "string" && input.messageId.length > 0
      ? input.messageId
      : undefined;
    const session = await mutateState(config.instance, (state) => {
      const sess = findOrCreateDiscordChatSession(state, bridge.id, channelId);
      // See Telegram branch — same rationale for the source-level
      // message id stamp.
      if (sess.source?.kind === "discord" && inboundMessageId !== undefined) {
        sess.source.lastInboundMessageId = inboundMessageId;
      }
      return sess;
    });
    const result = await submitChatMessage(config, session.id, { content: text }, { bypassQueue: true });
    taskId = result.taskId;
  } else if (bridge.kind === "slack") {
    const channelId = rawTarget.trim();
    if (!channelId) {
      throw new Error("Slack inbound target (channel id) is required.");
    }
    target = channelId;
    const inboundMessageId = typeof input.messageId === "string" && input.messageId.length > 0
      ? input.messageId
      : undefined;
    // Slack sessions key per-thread: threadTs is the thread ROOT ts.
    // The socket loop supplies it explicitly (event thread_ts for a
    // thread reply, the message's own ts for a top-level message). A
    // caller that only has the message ts (HTTP /receive, CLI) gets
    // the top-level semantics — the message anchors its own thread.
    const threadTs = typeof input.threadTs === "string" && input.threadTs.length > 0
      ? input.threadTs
      : inboundMessageId;
    if (!threadTs) {
      throw new Error("Slack inbound requires a threadTs (thread root ts) or a messageId to key the per-thread session.");
    }
    const session = await mutateState(config.instance, (state) => {
      const sess = findOrCreateSlackChatSession(state, bridge.id, channelId, threadTs);
      // See Telegram branch — same rationale for the source-level
      // message id stamp. Note this is NOT the outbound thread anchor
      // (that's source.threadTs); it exists for parity/diagnostics.
      if (sess.source?.kind === "slack" && inboundMessageId !== undefined) {
        sess.source.lastInboundMessageId = inboundMessageId;
      }
      return sess;
    });
    const result = await submitChatMessage(config, session.id, { content: text }, { bypassQueue: true });
    taskId = result.taskId;
  } else {
    target = rawTarget || "local";
    const task = await submitTask(config, text);
    taskId = task.id;
  }

  // Note: the chat session id is intentionally NOT persisted on the
  // MessagingMessageRecord. Callers that need it look it up via the
  // task's session linkage (or via findTelegram/DiscordChatSession on
  // the bridge + chat coordinate).
  return mutateState(config.instance, (state) =>
    createMessagingMessageRecord(state, {
      bridgeId: bridge.id,
      direction: "inbound",
      status: "received",
      target,
      text,
      taskId,
      media
    })
  );
}

// Resolve a telegram-sourced chat session from a (bridge, chat_id)
// pair. The reply-mirror loop calls this to find where to land the
// assistant message and where to dispatch the outbound reply.
export function findTelegramChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: number
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "telegram" &&
      session.source.bridgeId === bridgeId &&
      session.source.chatId === chatId
  );
}

// Same shape, Discord side: resolve the chat session bound to a
// (bridge, channel) pair so the reply-mirror in the discord poller can
// look up the dispatch target without re-querying Discord.
export function findDiscordChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "discord" &&
      session.source.bridgeId === bridgeId &&
      session.source.channelId === channelId
  );
}

// Slack side: resolve the chat session bound to a (bridge, channel,
// thread) triple so the reply mirror in the slack bridge loop can look
// up the dispatch target + thread anchor without re-querying Slack.
// threadTs is the thread ROOT ts (the session key), never a reply's ts.
export function findSlackChatSession(
  config: RuntimeConfig,
  bridgeId: string,
  channelId: string,
  threadTs: string
): ChatSessionRecord | undefined {
  return readState(config.instance).chatSessions.find(
    (session) =>
      session.source?.kind === "slack" &&
      session.source.bridgeId === bridgeId &&
      session.source.channelId === channelId &&
      session.source.threadTs === threadTs
  );
}

// Chat allowlist + explicit enrollment.
//
// Telegram bots are addressable by anyone who finds the @username, so
// without an allowlist a stranger can add the bot to their group and
// drive the runtime — burning the owner's provider tokens and
// potentially reaching workspace tools. The bridge stores a list of
// permitted chat_ids on `metadata.allowedChatIds`; the poller silently
// drops updates from anyone not on the list. There is NO trust-on-
// first-use: even the first DM from the bridge owner is denied until
// they explicitly approve their chat from the operator UI (or run
// `gini messaging allow <bridge> <chat-id>` on the host).
//
// Enrollment is a two-sided handshake. When a chat the bot doesn't
// recognize sends any message (including /start), the poller mints a
// short verification code in the `F971-8261` format, sends it back to
// the user via Telegram, and surfaces a matching pending-request
// entry to the operator. The operator confirms the code matches what
// the user sees and clicks Approve, at which point the chat lands on
// `allowedChatIds` and the bot greets the user to close the loop.
// `metadata.recentDeniedChats` holds the pending entries (bounded at
// MAX_RECENT_DENIED_CHATS so a flood of stranger pings can't bloat
// the state record). Codes are private-chat only: groups still get
// recorded as pending but no code or bot reply, and the operator
// approves them by chat_id alone.

const MAX_RECENT_DENIED_CHATS = 10;

// Per-chat verification code parameters. Format is "F971-8261" — two
// uppercase 4-hex-digit groups separated by a single dash — chosen for
// easy over-the-phone confirmation. 32 bits of entropy (4.29B combos)
// is overkill against the 10-minute window; readability matters more
// here than collision resistance. The code lives in the matching
// `recentDeniedChats` entry; a DM after expiry mints a fresh one.
const VERIFICATION_CODE_BYTES = 4;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

export interface DeniedChatAttempt {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel" | string;
  // Telegram @handle when available, otherwise first_name. Omitted if
  // the update carried no `from` field (rare — typically channel posts).
  sender?: string;
  // Last time we saw an attempt from this chat. Newer attempts from
  // the same chat just bump the timestamp instead of stacking entries.
  lastAttemptAt: string;
  // Verification code surfaced to both the user (in the bot's reply
  // to their DM) and the operator (in the pending-request UI). The
  // operator confirms the codes match before clicking Approve so a
  // TOFU enrollment can't race a legitimate user. Only set for
  // private chats — groups stay code-less and the operator approves
  // them by chat_id alone. A DM after `verificationCodeExpiresAt`
  // mints a fresh code; repeated DMs inside the window reuse the
  // existing one so we don't spam the user with new codes.
  verificationCode?: string;
  verificationCodeExpiresAt?: string;
}

export interface ChatAllowlistView {
  allowedChatIds: number[];
  ownerChatId?: number;
  recentDeniedChats: DeniedChatAttempt[];
}

function readAllowedChatIds(bridge: MessagingBridgeRecord): number[] {
  const raw = bridge.metadata?.allowedChatIds;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => Number(value)).filter((n) => Number.isFinite(n));
}

function readOwnerChatId(bridge: MessagingBridgeRecord): number | undefined {
  const raw = bridge.metadata?.ownerChatId;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function isChatAllowed(bridge: MessagingBridgeRecord, chatId: number): boolean {
  return readAllowedChatIds(bridge).includes(chatId);
}

// Atomically check whether an inbound chat is on the bridge's
// allowlist. Returns `true` when the message should be processed,
// `false` when the poller should drop it silently. No trust-on-first-
// use: every chat (including the owner's first DM) starts denied,
// and the owner enrolls themselves via `gini messaging allow` after
// finding their chat_id in the recent-denied list.
export async function authorizeTelegramChat(
  config: RuntimeConfig,
  bridgeId: string,
  chatId: number
): Promise<boolean> {
  const bridge = readState(config.instance).messagingBridges.find((b) => b.id === bridgeId);
  if (!bridge) return false;
  return isChatAllowed(bridge, chatId);
}

// Record a denied chat attempt on the bridge and mint (or reuse) a
// verification code for the user-side reply. The bot DMs the same
// code back to the chat so the operator can confirm the codes match
// before clicking Approve. Dedupes by chatId — repeated attempts
// from the same stranger refresh the timestamp instead of stacking
// entries, and keep the existing code as long as it hasn't expired
// so the user doesn't get a new code on every retry. Codes only
// generated for private chats; groups get a code-less pending entry
// (the operator approves them by chat_id alone since there's no
// safe per-user channel to deliver a code through). Bounded at
// MAX_RECENT_DENIED_CHATS so a flood of stranger pings can't bloat
// the state record. Returns the resulting entry so the poller can
// drive the user-side bot reply; returns undefined if the chat was
// already allowed (a race against an operator Approve) or the bridge
// disappeared.
export async function recordDeniedChatAttempt(
  config: RuntimeConfig,
  bridgeId: string,
  attempt: { chatId: number; chatType: string; sender?: string }
): Promise<(DeniedChatAttempt & { mintedFreshCode: boolean }) | undefined> {
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === bridgeId);
    if (!live) return undefined;
    // Re-check the allowlist inside the lock. The poller's authorize call
    // happens outside mutateState, so if the operator clicks Approve in the
    // window between that read and us getting here the chat is already
    // allowed — silently skipping the deny write keeps the pending list from
    // re-appearing after a successful approval.
    if (isChatAllowed(live, attempt.chatId)) return undefined;
    const meta = { ...(live.metadata ?? {}) };
    const existing = readRecentDeniedChats(live);
    const prior = existing.find((entry) => entry.chatId === attempt.chatId);
    const isPrivate = attempt.chatType === "private";
    const priorExpiresAt = prior?.verificationCodeExpiresAt
      ? Date.parse(prior.verificationCodeExpiresAt)
      : Number.NaN;
    const canReuse = isPrivate
      && typeof prior?.verificationCode === "string"
      && Number.isFinite(priorExpiresAt)
      && priorExpiresAt > Date.now();
    const verificationCode = isPrivate
      ? (canReuse ? prior!.verificationCode! : generateVerificationCode())
      : undefined;
    const verificationCodeExpiresAt = isPrivate
      ? (canReuse
          ? prior!.verificationCodeExpiresAt!
          : new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString())
      : undefined;
    const entry: DeniedChatAttempt = {
      chatId: attempt.chatId,
      chatType: attempt.chatType,
      ...(attempt.sender ? { sender: attempt.sender } : {}),
      lastAttemptAt: now(),
      ...(verificationCode ? { verificationCode } : {}),
      ...(verificationCodeExpiresAt ? { verificationCodeExpiresAt } : {})
    };
    const filtered = existing.filter((existingEntry) => existingEntry.chatId !== attempt.chatId);
    // Newest first; cap at MAX so an attacker pinging in a loop can't
    // bloat the state record.
    meta.recentDeniedChats = [entry, ...filtered].slice(0, MAX_RECENT_DENIED_CHATS);
    live.metadata = meta;
    live.updatedAt = entry.lastAttemptAt;
    // Caller-side hint: the poller uses mintedFreshCode to gate the
    // outbound DM. True only for private DMs where we just generated a
    // new code — repeated DMs within the TTL window reuse the prior code
    // and skip the send so an attacker spamming the bot's @handle can't
    // burn Telegram outbound quota or inflate audit/message rows.
    // mintedFreshCode is NOT persisted (the cloned entry above is what
    // lives on recentDeniedChats).
    return { ...entry, mintedFreshCode: isPrivate && !canReuse };
  });
}

function readRecentDeniedChats(bridge: MessagingBridgeRecord): DeniedChatAttempt[] {
  const raw = bridge.metadata?.recentDeniedChats;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as DeniedChatAttempt)
    .filter((entry) => entry && typeof entry.chatId === "number");
}

function generateVerificationCode(): string {
  const hex = randomBytes(VERIFICATION_CODE_BYTES).toString("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

// Bounded retry for best-effort Telegram outbound sends — used to
// deliver verification codes and post-approve greetings, both of
// which are user-visible signals where a single transient Telegram
// hiccup shouldn't silently drop the message. Returns success or the
// final error so the caller can log with context. Backoffs are
// short (250ms + 750ms) because the operator is actively waiting on
// the UI side; if Telegram is still unreachable after one second
// we stop and surface the failure in the runtime log.
const OUTBOUND_RETRY_BACKOFFS_MS: ReadonlyArray<number> = [250, 750];

async function sendMessagingOutputWithRetries(
  config: RuntimeConfig,
  bridgeId: string,
  payload: { text: string; target: string },
  options: { signal?: AbortSignal } = {}
): Promise<{ ok: true } | { ok: false; error: Error }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= OUTBOUND_RETRY_BACKOFFS_MS.length; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, error: lastError ?? new Error("aborted before send") };
    }
    try {
      // parseMode "none" — these messages are short plain-text
      // operator-flow signals (verification codes, post-approve
      // greetings). MarkdownV2 escaping would turn the dash in
      // "F971-8261" into "F971\-8261" inside the chat client.
      // skipTargetFilter: enrollment-flow sends must reach the
      // recipient regardless of the active agent's messagingTargets
      // policy — the chatId for a brand-new pending user will never
      // be on a curated allowlist.
      // signal threads end-to-end into the underlying Telegram /
      // Discord client fetch so a hung outbound — TCP-accepted but
      // no response — gets cancelled at the timeout rather than
      // sitting in `await response.json()` for the OS-default window.
      const record = await sendMessagingOutput(
        config,
        bridgeId,
        { ...payload, parseMode: "none" },
        { skipTargetFilter: true, signal: options.signal }
      );
      // sendMessagingOutput swallows Telegram/Discord API errors and
      // records the outbound row with status:"failed" instead of
      // rethrowing, so a transient API error otherwise reaches us as
      // a successful return. Inspect the record and treat "failed"
      // as a retry-able outcome so the backoff loop actually fires.
      if (record.status === "failed") {
        lastError = new Error(record.error ?? "messaging send returned status=failed");
        if (attempt === OUTBOUND_RETRY_BACKOFFS_MS.length) break;
        try {
          await sleepUnlessAbortedThrow(OUTBOUND_RETRY_BACKOFFS_MS[attempt], options.signal);
        } catch {
          return { ok: false, error: lastError };
        }
        continue;
      }
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (options.signal?.aborted) return { ok: false, error: lastError };
      if (attempt === OUTBOUND_RETRY_BACKOFFS_MS.length) break;
      try {
        await sleepUnlessAbortedThrow(OUTBOUND_RETRY_BACKOFFS_MS[attempt], options.signal);
      } catch {
        return { ok: false, error: lastError };
      }
    }
  }
  return { ok: false, error: lastError ?? new Error("send failed") };
}

// Send the per-chat verification code to a Telegram user who DM'd
// the bot from a not-yet-allowlisted chat. The operator sees the
// same code on the pending-request row and confirms it matches what
// the user reports before clicking Approve. Wraps the bounded retry
// helper so a transient Telegram blip doesn't strand the operator
// staring at a code the user never got. The caller is expected to
// supply a bounded `signal` (e.g. AbortSignal.timeout(10_000)
// composed with the poller's lifecycle signal) so a hung Telegram
// API socket can't pin the poll loop or block shutdown.
export async function deliverVerificationCode(
  config: RuntimeConfig,
  bridgeId: string,
  payload: { chatId: number; code: string; expiresAt?: string; signal?: AbortSignal }
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const expiresAtRaw = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
  const minutesRemaining = Number.isFinite(expiresAtRaw)
    ? Math.max(1, Math.round((expiresAtRaw - Date.now()) / 60_000))
    : Math.round(VERIFICATION_CODE_TTL_MS / 60_000);
  const text = `Verification code: ${payload.code}\n\nUse this code to approve the bot for messaging. The code will expire in ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`;
  return sendMessagingOutputWithRetries(config, bridgeId, {
    text,
    target: String(payload.chatId)
  }, { signal: payload.signal });
}

export async function allowChat(
  config: RuntimeConfig,
  idOrName: string,
  chatId: number,
  options: { expectedCode?: string } = {}
) {
  if (!Number.isFinite(chatId)) throw new Error("chatId must be a finite number.");
  const result = await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      throw new Error(`Chat allowlist only applies to telegram bridges (got '${live.kind}').`);
    }
    // Server-enforced verification handshake. When the caller (the
    // operator UI) supplies the code it saw in the pending row, the
    // server confirms it matches the still-live `verificationCode`
    // on `recentDeniedChats` for this chat and hasn't expired. This
    // closes the stale-UI / racing-DM window where the operator
    // could approve based on a code that no longer reflects the
    // current pending entry. Callers that don't supply a code
    // (legacy CLI `gini messaging allow`) keep the prior trust
    // model — the explicit CLI call already proves operator intent.
    //
    // Idempotency check runs BEFORE the expectedCode validation: a
    // second allow call (UI double-click, refetch-then-click race)
    // would otherwise fail the pending-row lookup further down because
    // the first allow already cleared the pending entry. Returning
    // early on alreadyAllowed lets the second call succeed as a no-op
    // instead of surfacing as a confusing 400 to the operator who
    // already approved the chat.
    const allowedBefore = readAllowedChatIds(live);
    const alreadyAllowed = allowedBefore.includes(chatId);
    if (alreadyAllowed) {
      return { bridgeId: live.id, view: chatAllowlistView(live), alreadyAllowed };
    }
    if (options.expectedCode !== undefined) {
      const pending = readRecentDeniedChats(live).find((entry) => entry.chatId === chatId);
      if (!pending) {
        throw new Error(`Invalid input: No pending request for chat ${chatId} on bridge '${idOrName}'.`);
      }
      if (!pending.verificationCode) {
        throw new Error(`Invalid input: Pending request for chat ${chatId} has no verification code (group chats cannot be approved by code).`);
      }
      const expiresAt = pending.verificationCodeExpiresAt ? Date.parse(pending.verificationCodeExpiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error(`Verification code for chat ${chatId} has expired — have the user DM the bot again to mint a fresh code.`);
      }
      if (pending.verificationCode.toLowerCase() !== options.expectedCode.trim().toLowerCase()) {
        throw new Error(`Verification code mismatch — the pending request's code has rotated. Reload the page and confirm again before approving.`);
      }
    }
    const meta = { ...(live.metadata ?? {}) };
    const allowed = [...allowedBefore, chatId];
    meta.allowedChatIds = allowed;
    // First enrollment also becomes the recorded owner. After that the
    // field stays stable — `allow` of additional chats doesn't change
    // who originally claimed the bridge.
    if (readOwnerChatId(live) === undefined) {
      meta.ownerChatId = chatId;
    }
    // Drop the enrolled chat from the pending-attempts list so the
    // owner's view stays clean.
    meta.recentDeniedChats = readRecentDeniedChats(live).filter((entry) => entry.chatId !== chatId);
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.chat.allowed",
        target: live.id,
        risk: "medium",
        evidence: { chatId }
      },
      { system: true }
    );
    // Pre-create the Telegram chat session at enrollment time so it
    // shows up in the operator's sidebar immediately — before this
    // change, the session was only created lazily on the FIRST
    // inbound message AFTER enrollment (receiveMessagingInput's
    // findOrCreateTelegramChatSession call), so the operator had to
    // wait for the user to DM again to see any sign the pairing
    // worked. Bot-authored confirmation DMs land in this session
    // too once they're observed by the poller, so a fresh enrollment
    // immediately surfaces with the "Paired." greeting visible.
    findOrCreateTelegramChatSession(state, live.id, chatId);
    return { bridgeId: live.id, view: chatAllowlistView(live), alreadyAllowed };
  });
  // Best-effort greeting back to the chat so the user knows they
  // were approved without having to send another message and wait
  // for an agent reply. The mutation is already committed; a failed
  // send leaves the chat enrolled but quietly logs the error. The
  // 10-second AbortSignal caps how long an unresponsive Telegram API
  // can hold the operator's POST /allow request — without it a hung
  // socket would block the HTTP handler until the OS default tear-
  // down (many minutes) and stall the UI in a spinner.
  //
  // Skip the greeting when the chat was already enrolled; otherwise a
  // double-clicked Approve sends the user two "Paired" messages for
  // one logical enrollment.
  if (!result.alreadyAllowed) {
    const greeting = await sendMessagingOutputWithRetries(config, result.bridgeId, {
      text: "Paired. You can chat with the bot now.",
      target: String(chatId)
    }, { signal: AbortSignal.timeout(10_000) });
    if (!greeting.ok) {
      appendLog(config.instance, "messaging.telegram.greeting_send_error", {
        bridgeId: result.bridgeId,
        chatId,
        error: greeting.error.message
      });
    }
  }
  return result.view;
}

export async function denyChat(config: RuntimeConfig, idOrName: string, chatId: number) {
  if (!Number.isFinite(chatId)) throw new Error("chatId must be a finite number.");
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      throw new Error(`Chat allowlist only applies to telegram bridges (got '${live.kind}').`);
    }
    const meta = { ...(live.metadata ?? {}) };
    const allowed = readAllowedChatIds(live).filter((id) => id !== chatId);
    meta.allowedChatIds = allowed;
    // Removing the owner chat doesn't clear ownerChatId — keep the
    // historical record so an audit reader can see who originally
    // paired the bridge. The bridge stops responding to that chat
    // either way because it's no longer on the allowlist.
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.chat.denied",
        target: live.id,
        risk: "medium",
        evidence: { chatId }
      },
      { system: true }
    );
    return chatAllowlistView(live);
  });
}

// Drop a chat from `recentDeniedChats` without touching the allowlist.
// Backs the operator UI's "Reject" button on a pending pairing request —
// the chat stays denied (the bridge keeps dropping its messages), but the
// row is cleared from the pending list so it doesn't keep nagging the
// operator. If the same chat sends another message after this it'll
// re-appear in `recentDeniedChats` because there is no long-term denylist.
//
// Options:
//   expectedCode: refuse the reject if the live pending row's
//     verificationCode no longer matches. Without this, a stale Reject
//     click on an old card would clear a fresh pending row that the
//     user just minted by re-DMing the bot. The compare-and-delete
//     happens inside the same mutateState so a code rotation between
//     read and delete cannot slip through.
export async function rejectPendingChat(
  config: RuntimeConfig,
  idOrName: string,
  chatId: number,
  options: { expectedCode?: string } = {}
) {
  if (!Number.isFinite(chatId)) throw new Error("chatId must be a finite number.");
  return mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((b) => b.id === idOrName || b.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    if (live.kind !== "telegram") {
      // Reuse the existing allowlist-only prefix so statusFromErrorMessage
      // already maps this to a 400 the way it does for allowChat / denyChat.
      throw new Error(`Chat allowlist only applies to telegram bridges (got '${live.kind}').`);
    }
    const allowedChatIds = readAllowedChatIds(live);
    if (allowedChatIds.includes(chatId)) {
      // Pairing was already approved (likely by a parallel operator or
      // the CLI). Reporting "rejected" here would lie — the chat is
      // enrolled and posting will route through. Surface that explicitly
      // so the chat-task loop can tell the user what actually happened.
      throw new Error(`Cannot reject: chat ${chatId} is already enrolled on bridge '${live.name}'. Use the settings page to remove the enrollment if you meant to revoke it.`);
    }
    const pending = readRecentDeniedChats(live).find((entry) => entry.chatId === chatId);
    if (options.expectedCode !== undefined) {
      // Three stale-card cases the chat-side Reject must refuse so
      // it doesn't silently report success:
      //   1. pending row was already cleared (parallel operator
      //      Reject or settings-page click) — there's nothing to
      //      reject; the chat card is dead.
      //   2. pending row exists but has no verificationCode (group
      //      chat regrown from a different message after the
      //      original code-bearing row was approved) — the chat-side
      //      Reject doesn't apply to group rows.
      //   3. pending row exists, has a code, but the code doesn't
      //      match the approval's expectedCode — the user re-DM'd
      //      and the code rotated. Rejecting now would clear the
      //      fresh pending row.
      if (!pending) {
        throw new Error(`Pairing request for chat ${chatId} was already cleared (likely by a parallel Reject or a settings-page action). Nothing to do; the chat card is stale.`);
      }
      if (!pending.verificationCode) {
        throw new Error(`Pairing request for chat ${chatId} now has no verification code (a different message replaced the original pending row). This chat-card Reject no longer matches.`);
      }
      if (pending.verificationCode !== options.expectedCode) {
        // Code rotated between mint and click — the stale card would
        // otherwise clear the fresh pending row. Atomic check-and-delete
        // closes the TOCTOU window that a pre-mutateState lookup left
        // open.
        throw new Error(`Pairing request for chat ${chatId} was re-DM'd since this card was minted — its verification code rotated. Approve or Reject the current pending card instead; this stale card no longer matches.`);
      }
    }
    const meta = { ...(live.metadata ?? {}) };
    meta.recentDeniedChats = readRecentDeniedChats(live).filter((entry) => entry.chatId !== chatId);
    live.metadata = meta;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.pending.rejected",
        target: live.id,
        risk: "low",
        evidence: { chatId }
      },
      { system: true }
    );
    return chatAllowlistView(live);
  });
}

export function listAllowedChats(config: RuntimeConfig, idOrName: string): ChatAllowlistView {
  const bridge = readState(config.instance).messagingBridges.find(
    (b) => b.id === idOrName || b.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  if (bridge.kind !== "telegram") {
    throw new Error(`Chat allowlist only applies to telegram bridges (got '${bridge.kind}').`);
  }
  return chatAllowlistView(bridge);
}

function chatAllowlistView(bridge: MessagingBridgeRecord): ChatAllowlistView {
  const owner = readOwnerChatId(bridge);
  return {
    allowedChatIds: readAllowedChatIds(bridge),
    ...(owner !== undefined ? { ownerChatId: owner } : {}),
    recentDeniedChats: readRecentDeniedChats(bridge)
  };
}

function parseInboundMedia(raw: unknown): MessagingMessageMedia | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as MessagingMessageMedia;
  if (value.kind !== "photo") return undefined;
  return {
    kind: "photo",
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fileId === "string" ? { fileId: value.fileId } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {})
  };
}

// In-process options that don't travel over HTTP. HTTP callers (POST
// /api/messaging/:id/send) pass undefined; internal callers pass any
// of: the supervisor's stopAll signal (so an in-flight Discord POST
// can be cancelled instead of waited out), or `skipTargetFilter`
// (for system-driven sends like verification codes and post-approve
// greetings that must reach the user regardless of the active
// agent's messagingTargets policy).
export interface SendMessagingOptions {
  signal?: AbortSignal;
  skipTargetFilter?: boolean;
}

export async function sendMessagingOutput(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>,
  options: SendMessagingOptions = {}
) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  // Reject sends against disabled / errored bridges up front instead
  // of doing the photo-parse + agent-filter work and then hitting a
  // missing-secret failure (or worse: completing a send on the
  // already-disabled bridge's last cached token). This is the
  // outbound counterpart of the supervisor's shouldRun gate on the
  // poll loop; it closes most of the disable-vs-send race window
  // (the tiny gap between this check and the actual fetch is
  // unavoidable without bridge-level abort, but the check rejects
  // every case where disable has already landed by the time the
  // dispatcher fires).
  if (bridge.status !== "configured") {
    throw new Error(`Invalid input: Messaging bridge '${idOrName}' is not configured (status: ${bridge.status}).`);
  }

  // Photo input variants. Callers supply at most one of url/fileId/path
  // on `input.photo`. When present, `text` becomes the optional caption;
  // a caption-only send still requires non-empty text-or-photo somewhere.
  const photoSource = parsePhotoInput(input.photo);
  const text = String(input.text ?? "").trim();
  if (!text && !photoSource) throw new Error("Outbound message requires text or a photo.");

  // Active-agent messaging-target whitelist. When the caller supplies an
  // explicit target outside the filter we reject loudly so a misrouted
  // message can't sneak past the agent's policy. When the caller doesn't
  // specify a target we pick the first bridge.deliveryTarget that's
  // permitted; if none are permitted we fall back to the bridge's
  // first target so messaging never silently fails on a fresh instance
  // with no agent restriction.
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  // System-driven sends (verification codes, post-approve greetings)
  // bypass the active-agent target filter — they're enrollment-flow
  // signals the user MUST receive regardless of operator policy, and
  // the chatId for a brand-new pending user will never be on the
  // agent's curated messagingTargets list.
  const targetFilter = options.skipTargetFilter ? undefined : effective.messagingTargetFilter;
  const requested = typeof input.target === "string" && input.target.length > 0 ? input.target : undefined;
  let target: string;
  if (requested !== undefined) {
    if (targetFilter && !targetFilter.has(requested)) {
      const agentLabel = effective.agentId ?? "active agent";
      throw new Error(`Target '${requested}' not permitted by active agent '${agentLabel}'`);
    }
    target = requested;
  } else if (targetFilter) {
    const permitted = bridge.deliveryTargets.find((t) => targetFilter.has(t));
    target = permitted ?? bridge.deliveryTargets[0] ?? "local";
  } else {
    target = bridge.deliveryTargets[0] ?? "local";
  }

  let status: "sent" | "failed" = bridge.status === "configured" ? "sent" : "failed";
  let errorMessage: string | undefined =
    status === "failed" ? `Bridge is ${bridge.status}` : undefined;

  if (status === "sent" && bridge.kind === "telegram") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Telegram bot token is missing.";
    } else {
      // Default: render the body as MarkdownV2 so the common agent
      // outputs (bold, inline code, fenced blocks) survive instead of
      // arriving as plain text. Callers that already speak Telegram's
      // dialect (or want a literal payload) can pass `parseMode: "none"`
      // to skip the converter and send the raw string.
      const parseModeRaw = typeof input.parseMode === "string" ? input.parseMode : undefined;
      const useMdv2 = parseModeRaw !== "none";
      const formatted = useMdv2 ? formatTelegramMarkdownV2(text) : text;
      // Thread the reply onto a specific inbound message when supplied
      // (group chats use this so the bot's response visually attaches to
      // the user's question). The Telegram client pairs the field with
      // `allow_sending_without_reply: true` whenever it's set, so a
      // deleted-mid-task original silently falls back to an unthreaded
      // send instead of failing the whole call.
      const replyToMessageId =
        typeof input.replyToMessageId === "number" ? input.replyToMessageId : undefined;
      try {
        const client = telegramClientFor(token);
        if (photoSource) {
          await client.sendPhoto(target, photoSource, {
            caption: formatted || undefined,
            parseMode: useMdv2 && formatted ? "MarkdownV2" : undefined,
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
            ...(options.signal ? { signal: options.signal } : {})
          });
        } else {
          const sendOpts: import("./telegram").SendMessageOptions = {};
          if (useMdv2) sendOpts.parseMode = "MarkdownV2";
          if (replyToMessageId !== undefined) sendOpts.replyToMessageId = replyToMessageId;
          if (options.signal) sendOpts.signal = options.signal;
          await client.sendMessage(
            target,
            formatted,
            Object.keys(sendOpts).length > 0 ? sendOpts : undefined
          );
        }
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (status === "sent" && bridge.kind === "discord") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Discord bot token is missing.";
    } else if (photoSource) {
      // Photo uploads are a follow-up — Discord requires multipart
      // attachments with a different payload shape. Fail loudly so the
      // outbound record records the reason instead of silently dropping.
      status = "failed";
      errorMessage = "Discord bridge does not support photo sends yet.";
    } else if (!text) {
      // Discord rejects content-less messages with HTTP 400. We
      // intercept before the network call so the audit row carries a
      // useful reason.
      status = "failed";
      errorMessage = "Discord messages require non-empty text.";
    } else {
      try {
        // Discord uses snowflake strings for message ids. The poller
        // forwards the inbound message id via input.replyToMessageId so
        // the agent's reply threads onto the originating message
        // (`message_reference`); the client also pairs that with
        // `fail_if_not_exists: false` so a deleted-mid-task original
        // falls back to an unthreaded send instead of failing.
        const replyToMessageId =
          typeof input.replyToMessageId === "string" || typeof input.replyToMessageId === "number"
            ? String(input.replyToMessageId)
            : undefined;
        await discordClientFor(token).sendMessage(target, text, {
          signal: options.signal,
          ...(replyToMessageId ? { replyToMessageId } : {})
        });
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (status === "sent" && bridge.kind === "slack") {
    const token = readBridgeBotTokenQuiet(config, bridge);
    if (!token) {
      status = "failed";
      errorMessage = "Slack bot token is missing.";
    } else if (photoSource) {
      // Photo uploads are a follow-up — Slack requires the multi-step
      // files.getUploadURLExternal flow. Fail loudly so the outbound
      // record records the reason instead of silently dropping.
      status = "failed";
      errorMessage = "Slack bridge does not support photo sends yet.";
    } else if (!text) {
      status = "failed";
      errorMessage = "Slack messages require non-empty text.";
    } else {
      // Thread anchor: MUST be the thread ROOT ts (the session's
      // source.threadTs). Passing a reply's own ts here would make
      // Slack fork a broken second thread off that reply, so callers
      // never forward lastInboundMessageId as threadTs.
      const threadTs = typeof input.threadTs === "string" && input.threadTs.length > 0
        ? input.threadTs
        : undefined;
      // Default: convert the common agent Markdown (double-asterisk
      // bold, [text](url) links, # headings) to Slack mrkdwn. Callers
      // that want a literal payload pass `parseMode: "none"` — same
      // contract as the Telegram branch.
      const useMrkdwn = (typeof input.parseMode === "string" ? input.parseMode : undefined) !== "none";
      const formatted = useMrkdwn ? formatSlackMrkdwn(text) : text;
      try {
        await slackClientFor(token).postMessage(target, formatted, {
          ...(threadTs ? { threadTs } : {}),
          ...(options.signal ? { signal: options.signal } : {})
        });
      } catch (error) {
        status = "failed";
        errorMessage = sanitizeBridgeError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const media = mediaRecordForOutbound(photoSource);

  // When the caller threads a taskId on the input (e.g. the chat-sync
  // mirror in src/integrations/telegram-poller.ts) the outbound row and
  // its audit attribute to the originating task. Otherwise — pairing
  // confirmations, denial hints, ad-hoc operator pings — the send is
  // instance-level and unattributed.
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  return mutateState(config.instance, (live) => {
    const message = createMessagingMessageRecord(live, {
      bridgeId: bridge.id,
      direction: "outbound",
      status,
      target,
      text,
      taskId,
      notificationId: typeof input.notificationId === "string" ? input.notificationId : undefined,
      error: errorMessage,
      media
    });
    addAudit(
      live,
      {
        actor: "runtime",
        action: "messaging.sent",
        target: bridge.id,
        risk: "low",
        taskId,
        evidence: { messageId: message.id, status, target }
      },
      taskId ? { taskId } : { system: true }
    );
    return message;
  });
}

export async function disableMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === idOrName || item.name === idOrName);
    if (!live) throw new Error(`Messaging bridge not found: ${idOrName}`);
    live.status = "disabled";
    live.updatedAt = now();
    addAudit(
      state,
      { actor: "user", action: "messaging.disabled", target: live.id, risk: "medium" },
      { system: true }
    );
    return live;
  });
  // Drop the on-disk encrypted secret files. We do this after the state
  // mutation so a crash mid-disable leaves the bridge marked disabled even
  // if the file cleanup fails — the inbound poller skips disabled bridges
  // so a stranded token can't be used.
  deleteConnectorSecrets(config.instance, bridgeSecretNamespace(bridge.id));
  await mutateState(config.instance, (state) => {
    const live = state.messagingBridges.find((item) => item.id === bridge.id);
    if (live) live.secretRefs = [];
    return live;
  });
  return bridge;
}

// Hard-delete a messaging bridge: drop the record from
// state.messagingBridges entirely and erase its encrypted secret
// files on disk. Existing chat sessions and messages keep their
// `bridgeId` reference (the runtime treats those as historical, and
// the UI gates rendering on the bridge existing) — a cascade would
// also wipe useful audit history. The secret-file sweep runs before
// the state mutation so a crash mid-remove still erases the token;
// the orphaned bridge record can then be removed on retry.
export async function removeMessagingBridge(config: RuntimeConfig, idOrName: string) {
  const bridge = readState(config.instance).messagingBridges.find(
    (item) => item.id === idOrName || item.name === idOrName
  );
  if (!bridge) throw new Error(`Messaging bridge not found: ${idOrName}`);
  // Secret cleanup is idempotent (deleteConnectorSecrets silently skips
  // missing namespaces) so it stays outside the state lock.
  deleteConnectorSecrets(config.instance, bridgeSecretNamespace(bridge.id));
  return mutateState(config.instance, (state) => {
    const index = state.messagingBridges.findIndex((item) => item.id === bridge.id);
    if (index < 0) {
      // A concurrent caller landed inside the mutateState lock first and
      // already removed this bridge + wrote the audit row. Returning
      // removed:false here is what keeps the audit log from carrying a
      // duplicate `messaging.removed` entry for one logical removal.
      return { id: bridge.id, removed: false } as const;
    }
    const live = state.messagingBridges[index];
    state.messagingBridges.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "messaging.removed",
        target: live.id,
        risk: "medium",
        evidence: { kind: live.kind, name: live.name }
      },
      { system: true }
    );
    return { id: live.id, removed: true } as const;
  });
}
