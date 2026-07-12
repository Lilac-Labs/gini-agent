// `default` is the production end-user install (set by ~/.local/bin/gini).
// Anything else is a developer worktree (auto-derived from the repo dir
// basename) or a named test/smoke instance.
export type Instance = "default" | string;

export type TaskStatus = "queued" | "running" | "waiting_approval" | "needs_input" | "completed" | "failed" | "cancelled";

// Authorization (agent-actor): user approves/denies, runtime then performs
// the action. SetupRequest (user-actor): user performs a setup step in the
// browser or with credentials, runtime resumes once they signal complete.
// See docs/adr/authorization-vs-setup-request.md.
export type AuthorizationStatus = "pending" | "approved" | "denied";
export type SetupRequestStatus = "pending" | "completed" | "cancelled";

// Deprecated alias retained so legacy code paths (and any external consumer
// that imported the enum) keep type-checking during the split. New code
// should use AuthorizationStatus directly.
export type ApprovalStatus = AuthorizationStatus;

export type RiskLevel = "low" | "medium" | "high";

export type SkillStatus = "enabled" | "disabled" | "archived";

export type JobStatus = "active" | "paused" | "failed";

export type ProviderName = "echo" | "openai" | "codex" | "openrouter" | "local" | "deepseek" | "anthropic" | "bedrock" | "azure";

export type ImprovementStatus = "proposed" | "approved" | "rejected" | "applied";

export type ImprovementKind = "skill" | "job";

export type PromotionStatus = "proposed" | "approved" | "rejected";

export type ToolStatus = "available" | "disabled" | "error";

export type ToolsetStatus = "enabled" | "disabled";

export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type McpServerStatus = "configured" | "disabled" | "error";

export type MessagingBridgeStatus = "configured" | "disabled" | "error";

export type ImportSource = "hermes" | "openclaw";

export type AgentStatus = "active" | "inactive";

// Headed-browser connection mode. `cdp` is the only persisted mode: the user
// pointed the runtime at an existing external Chrome's CDP endpoint (e.g. their
// own already-running Chrome) and we never spawn or signal that process. (The
// old `managed` visible-window mode was removed — see issue #420; the default
// no-record path is the runtime's own spawned Chrome.)
export type BrowserConnectionMode = "cdp";

export interface BrowserConnectionRecord {
  mode: BrowserConnectionMode;
  // ws:// CDP debugger URL the user supplied. Stored normalized (no
  // credentials in the path).
  cdpUrl: string;
  // ISO timestamp of when the connection record was created/updated.
  startedAt: string;
}

export type RelayStatus = "disabled" | "configured" | "degraded" | "error";

// Tunnel connectivity (see ADR tunnel-connectivity.md). The tunnel gateway
// exposes a remote URL for this instance through one of several providers.
// "gini-relay" is always enabled; tailscale/ngrok/cloudflare are
// detection-gated native drivers (a disabled row carries a `requires`
// reason).
export type TunnelProviderId = "gini-relay" | "tailscale" | "ngrok" | "cloudflare";

// One row in the provider catalog. Drives the selection panel: disabled
// rows render their `requires` string as the reason they can't connect yet.
// The long-form setup guidance lives in docs/remote-access/<id>.md — the web
// UI opens it when a connect is rejected with `provider_unavailable`.
export interface TunnelProvider {
  id: TunnelProviderId;
  name: string;
  enabled: boolean;
  requires?: string;
}

// The connection lifecycle status surfaced to clients.
//   idle       — no active tunnel; selection may or may not be set.
//   connecting — a connect is pending (the relay's OAuth consent, or a manual
//                driver bringing its tunnel up); the panel shows "Connecting…".
//   connected  — the tunnel is live; `url` is present.
//   error      — the last connect failed; `message` carries the reason.
export type TunnelStatus = "idle" | "connecting" | "connected" | "error";

// The full state object EVERY /api/tunnel route returns — one fetch drives
// the whole panel. `providers` is the catalog, `selectedProvider`/`status`
// derive the view, `url` is present only when connected, `message` only on
// error.
export interface TunnelState {
  providers: TunnelProvider[];
  selectedProvider: TunnelProviderId | null;
  status: TunnelStatus;
  url?: string;
  message?: string;
}

// Persisted singleton on RuntimeState. Opt-in shape: absent/null until the
// user first selects a provider. The catalog itself is NOT persisted — it's
// rebuilt from code on every read so adding a provider doesn't require a state
// migration.
export interface TunnelSelectionRecord {
  instance: Instance;
  selectedProvider: TunnelProviderId | null;
  status: TunnelStatus;
  url?: string;
  subdomain?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export type NotificationStatus = "queued" | "sent" | "failed" | "acknowledged";
export type MessagingMessageStatus = "received" | "queued" | "sent" | "failed";

export type RuntimeEventKind =
  | "run"
  | "task"
  | "approval"
  | "job"
  | "memory"
  | "skill"
  | "connector"
  | "mcp"
  | "messaging"
  | "provider"
  | "runtime"
  | "notification"
  | "onboarding";

export type JobRunStatus = "running" | "completed" | "failed";

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type RunKind = "conversation_turn" | "task" | "job" | "subagent" | "direct";

export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ProviderConfig {
  name: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  // SigV4 signing region for the `bedrock` provider. normalizeProvider resolves
  // it from this field, else AWS_REGION, else AWS_DEFAULT_REGION, else a built-in
  // default (us-east-1); the Converse host is then derived from it. Ignored by
  // every other provider.
  awsRegion?: string;
  // Provider-specific request fields merged into chat-completions request
  // bodies (tool-calling, structured JSON, vision, and the chat-completions
  // branch of generateTaskSummary). The local, openrouter, deepseek, and azure
  // providers route every call through chat-completions, so extraBody applies
  // everywhere for them (including the summary call). The openai provider uses
  // /responses for generateTaskSummary, so extraBody only applies on its
  // tool-calling, structured, and vision calls. Codex uses /responses with its
  // own shape and ignores extraBody; echo bypasses HTTP entirely. The anthropic
  // provider merges extraBody into its native Messages request body too (and
  // extraBody.max_tokens overrides the runtime's default Messages max_tokens).
  //
  // Reserved keys are stripped at send time so extraBody can never override
  // runtime-controlled fields. The base denylist covers fields the runtime
  // unconditionally owns: model, messages, stream, tools, tool_choice,
  // response_format, functions, function_call, store, prompt_cache_retention
  // (pinned to "in_memory" by the runtime — extraBody can't promote a
  // request to the "24h" extended tier), plus prototype-pollution
  // payloads (__proto__, constructor, prototype) and the JSON.stringify
  // hijack vector (toJSON). Token-budget fields (max_tokens,
  // max_completion_tokens) are allowed in extraBody for
  // chat/structured/tool-calling calls — vision adds them to its own
  // per-call denylist so the runtime's vision budget always wins.
  //
  // Used to push fields like `chat_template_kwargs` for oMLX-served Gemma
  // models that need server-side reasoning toggles
  // (`{enable_thinking: true, preserve_thinking: false}`).
  //
  // extraBody flows through providerHealth/status/trace records — treat it
  // as non-secret transport config. Bearer tokens belong in env vars
  // referenced by `apiKeyEnv`, never in extraBody. Caller is responsible
  // for keeping values JSON-serializable.
  extraBody?: Record<string, unknown>;
  // Azure OpenAI transport fields — meaningful for the `azure` provider only;
  // normalizeProvider carries them through solely for `azure`, so a stray value
  // on any other provider is inert. Azure does not expose the flat
  // `${baseUrl}/chat/completions` surface every other OpenAI-compatible provider
  // speaks: it routes per deployment at
  // `${baseUrl}/openai/deployments/<deployment>/chat/completions?api-version=<v>`
  // and authenticates with an `api-key` header (or an Entra bearer token). The
  // provider NAME is what selects this routing — not the presence of any one
  // field — so these refine an already-Azure config rather than toggling it.
  //
  // Azure `api-version` query value (e.g. "2024-10-21"). Azure requires it on
  // every data-plane call; normalizeProvider defaults it for the azure provider
  // so a config that omits it still routes correctly.
  apiVersion?: string;
  // Azure deployment name — the path segment under /openai/deployments/. The
  // model id stays in `model` (modality/context detection key off it);
  // `deployment` defaults to `model` when omitted, matching the common case
  // where the Azure deployment is named after the model it serves.
  deployment?: string;
  // Auth header style. "api-key" (the azure default) sends Azure's
  // `api-key: <key>` header for a resource key; "bearer" sends
  // `Authorization: Bearer <key>` for an Entra access token. Both are valid
  // Azure auth modes, so the scheme is independent of the rest of the routing.
  authScheme?: "bearer" | "api-key";
}

// Approval policy mode for the per-instance runtime and per-job overlay.
//
// - "strict" — every approval-eligible action creates a pending approval
//   row and pauses the task for a human decision. Matches the legacy
//   pre-flip default.
// - "auto" — a safe-middle mode (no longer the default; operators can
//   switch to it). Auto-approve `file.write`, `file.patch`, and
//   `browser.upload_file` unconditionally. For `terminal.exec` and
//   `code_exec`, auto-approve unless the command (or, for `code_exec`,
//   either the shell wrapper OR the raw source — see
//   `matchDangerousSource`) matches a dangerous-pattern entry (see
//   `dangerousTerminalPatterns` + `DEFAULT_DANGEROUS_TERMINAL_PATTERNS`
//   in src/execution/auto-approve.ts). `autoApproveCommands` allowlist
//   always short-circuits any blocklist match — explicit operator opt-in
//   beats a heuristic blocklist hit.
// - "yolo" — full bypass for every approval-gated tool. Same audit
//   contract as the legacy `dangerouslyAutoApprove: true`: each call
//   still produces an approval row (status="approved") and matching
//   audit rows stamped `evidence.autoApproved=true` plus
//   `evidence.autoApprovedReason="approval-mode-yolo"`.
//
// See ADR approval-mode.md for the full audit contract and the
// migration shim that aliases legacy `dangerouslyAutoApprove: true` to
// `approvalMode: "yolo"` on load.
export type ApprovalMode = "strict" | "auto" | "yolo";

export interface RuntimeConfig {
  instance: Instance;
  port: number;
  token: string;
  provider: ProviderConfig;
  workspaceRoot: string;
  stateRoot: string;
  logRoot: string;
  // User-curated allowlist of shell-glob patterns that bypass the approval
  // gate for terminal_exec. Patterns match the full command string (e.g.
  // `memo *` matches any command starting with "memo "). Auto-approved
  // executions still write a `terminal.exec` audit row with
  // evidence.autoApproved=true plus the matched pattern, so the activity
  // trail stays intact. Empty / undefined means no auto-approval.
  // The allowlist always short-circuits the `auto`-mode dangerous-pattern
  // blocklist below — explicit operator opt-in wins over the heuristic.
  autoApproveCommands?: string[];
  // Approval-policy mode. Drives `resolveApprovalPolicy`. Fresh instances
  // default to "yolo" via `defaultConfig`; existing configs that predate
  // an explicit `approvalMode` backfill "auto" in `loadConfig` so the
  // default flip never silently escalates an already-created instance.
  // Legacy config files that carry `dangerouslyAutoApprove: true` without
  // an `approvalMode` set are migrated to "yolo" at load time and emit a
  // one-time `config.migrated` audit row. See ADR approval-mode.md.
  approvalMode?: ApprovalMode;
  // Optional operator-supplied list of substring patterns that should
  // GATE a `terminal.exec` call even under `approvalMode: "auto"`. Each
  // entry is matched as a literal substring against the full command
  // string (see `userDangerousPatterns` in
  // `src/execution/auto-approve.ts`). When omitted, only the built-in
  // `DEFAULT_DANGEROUS_TERMINAL_PATTERNS` apply. The
  // `autoApproveCommands` allowlist still short-circuits this list — an
  // explicit allow beats the blocklist.
  dangerousTerminalPatterns?: string[];
  // Deprecated alias for `approvalMode === "yolo"`. Kept on the config
  // shape because (a) older `config.json` files on disk reference it,
  // (b) tests and the `create_job` tool spec accept it, and (c) the
  // `/api/settings/auto-approve` GET response surfaces it as a derived
  // boolean so legacy clients still work. Writes via PATCH are accepted
  // as an alias for `approvalMode: "yolo"`. New code should read
  // `approvalMode` instead. Will be removed in a future release.
  dangerouslyAutoApprove?: boolean;
  // Power-user agent budget knobs. Lives under a nested `agent` namespace so
  // future budgets (token cap, wall-clock cap, etc.) can hang off the same
  // object without further config-shape churn. Validated leniently at the
  // call site — an invalid value falls back to that knob's default.
  agent?: {
    // Hard cap on chat-task loop iterations (model -> tool -> model cycles).
    // When the cap is hit the loop gracefully produces a tool-less final
    // summary instead of failing outright. Must be a positive integer; any
    // non-conforming value falls back to the built-in default.
    maxIterations?: number;
    // Soft cap for prior chat history replayed into a new chat-task prompt.
    // The full chat remains stored; this bounds only the provider-bound
    // transcript tail. Must be a positive integer; any non-conforming value
    // falls back to the provider-derived default.
    priorContextTokens?: number;
  };
  // Opt-in browser session trace recording, OFF by default (enabled only
  // when explicitly true; read at server boot). When enabled, browser
  // sessions record a Playwright trace that is saved under
  // <instanceRoot>/browser-traces/ when the session closes, with bounded
  // retention and a browser.trace_saved audit row per save. Trace archives
  // are raw page captures for local debugging/audit review — they never
  // enter the model context. See src/tools/browser.ts.
  browserRecording?: boolean;
  // Optional owner first name surfaced in GET /api/home's greeting. Set by
  // editing config.json directly (no UI in v1). When unset the response
  // omits `owner` and the web greeting falls back to a name-less line —
  // NEVER derived from an email local-part.
  ownerFirstName?: string;
}

// ChatBlock — semantic, typed conversation block emitted by the runtime so
// clients (web, mobile, CLI bridges) render a uniform stream instead of each
// rebuilding the same UI vocabulary by parsing ChatMessageRecord + Task
// state. See ADR chat-block-protocol.md.
//
// Blocks are ordered per chat session by `ordinal` (monotonically increasing
// integer, allocated under the SQLite transaction that inserts the row).
// Streaming `assistant_text` blocks carry the FULL accreted text on every
// delta; clients merge by `id` so reconnects/resumes are idempotent. All
// other block kinds are append-only.
//
// Persisted in SQLite (memory.db, table `chat_blocks`) by
// src/state/chat-blocks.ts. The runtime dual-publishes alongside the legacy
// ChatMessageRecord path during the migration window — phase 1 keeps both
// running, phases 2/3 migrate clients, phase 4 retires the legacy path.
export type ChatBlockKind =
  | "user_text"
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "phase"
  | "authorization_requested"
  | "setup_requested"
  | "system_note";

interface ChatBlockBase {
  id: string;
  sessionId: string;
  instance: Instance;
  ordinal: number;
  createdAt: string;
  taskId?: string;
  runId?: string;
  // Thread membership. Present on blocks that belong to a thread; absent
  // ⇒ main-chat block. Thread blocks interleave in the same session's
  // ordinal stream and are filtered out of the main chat by `threadId`.
  threadId?: string;
  // The main-chat `assistant_text` block the thread branched from. Only
  // meaningful on the thread's first block, but stamped on every thread
  // block for simplicity.
  parentBlockId?: string;
  // Set on a forwarded copy of a Topic's final answer that lands in the parent
  // Chat (kind:"agent") session. The replay-authoritative answer row lives in the
  // Topic session; this Chat-side copy is render-only and deep-links back to the Topic.
  forwardedFromTopicId?: string;
  forwardedFromTopicTitle?: string;
}

// Inline image attached to a user message. The runtime stores the bytes on
// disk under ~/.gini/instances/<instance>/uploads/<id>.<ext> and references
// them by id; clients fetch them via GET /api/uploads/:id. We never embed
// base64 in chat blocks or state.json — the upload id is the canonical
// reference, and the provider call inlines a data URL only at dispatch time.
export interface ImageAttachment {
  id: string;
  mimeType: string;
  size: number;
}

// Voice recording attached to a user message. Render-only: audio NEVER goes
// to the model/provider — it is transcribed to text at submit time and only
// the transcript reaches the agent. The bytes live on disk like images
// (upload id is the canonical reference; clients fetch via GET
// /api/uploads/:id for playback). `durationMs` is the client-measured clip
// length so the bubble can render m:ss without decoding the file.
export interface AudioAttachment {
  id: string;
  mimeType: string;
  size: number;
  durationMs?: number;
}

export interface UserTextBlock extends ChatBlockBase {
  kind: "user_text";
  text: string;
  images?: ImageAttachment[];
  audio?: AudioAttachment;
}

export interface AssistantTextBlock extends ChatBlockBase {
  kind: "assistant_text";
  updatedAt: string;
  // Full accreted text. On streaming deltas the same block id is upserted
  // with the running total so reconnecting clients always observe a
  // monotonically growing string and never need to splice deltas
  // themselves.
  text: string;
  streaming: boolean;
}

export type ToolCallStatus = "running" | "ok" | "error" | "denied";

export interface ToolCallBlock extends ChatBlockBase {
  kind: "tool_call";
  updatedAt: string;
  toolName: string;
  // Human-friendly label derived from the tool catalog (e.g. "Read file",
  // "Run shell command"). Clients render this in the bubble header so the
  // mapping lives in one place server-side.
  displayLabel: string;
  // Truncated headline of the args (e.g. the file path or the command),
  // suitable for inline rendering without expanding the full args object.
  argsPreview: string;
  // Full parsed args. Available for expanded views; never trimmed.
  argsFull: Record<string, unknown>;
  status: ToolCallStatus;
  errorMessage?: string;
  // How the client should style `errorMessage`. "error" (default) renders
  // red; "info" renders muted/gray for a calm needs-setup notice (e.g.
  // web_search with no provider connected) where the verbose steering goes
  // to the model only and the user sees a short neutral line.
  errorSeverity?: "info" | "error";
  // Provider-issued tool call id. Used by `tool_result` blocks to
  // associate result with call, and by resume paths to flip the
  // matching running block to `ok`/`error` after the approval lands.
  callId: string;
  // Optional context message a tool emits while parked in `running`,
  // describing why it's waiting and what (if anything) the user can do
  // to unblock it. Reserved for tools that block on an external event
  // the agent cannot drive — currently only `wait_for_messaging_pair`
  // (waiting on an inbound Telegram DM, up to 600s). Clients MAY render
  // a running tool_call more prominently when this field is set; the
  // wire contract is that the hint is advisory, not a separate kind.
  // The runtime clears it automatically when the tool's status leaves
  // `running`, so resolution/error/cancellation collapse the block back
  // to its default render.
  runningHint?: string;
  // Id of the scheduled job a successful `create_job` call created,
  // stamped when the dispatch settles `ok`. Structured so clients can
  // render the routine card and open its details panel without parsing
  // the 80-char-truncated tool_result preview. Absent on failed calls,
  // on every other tool, and on blocks predating the field.
  jobId?: string;
}

export interface ToolResultBlock extends ChatBlockBase {
  kind: "tool_result";
  // Provider-issued tool call id that this result belongs to.
  callId: string;
  // Truncated preview of the tool's result string. The full transcript
  // lives on the legacy ChatMessageRecord during the migration window
  // and on the task's audit chain; the block carries only what clients
  // need to render.
  preview: string;
  // True when `preview` was truncated. Clients can show an "expand" hint.
  truncated: boolean;
}

export interface PhaseBlock extends ChatBlockBase {
  kind: "phase";
  // Free-form short label (e.g. "Thinking", "Working: file_read",
  // "Completed"). Matches the existing Task.currentStep vocabulary so the
  // migration is a one-to-one rename rather than a UX overhaul.
  label: string;
}

// Agent-actor: user approves or denies; runtime then performs the action.
// Renders with a risk pill + Approve/Deny buttons. POSTs to
// /api/authorizations/<id>/{approve,deny}.
export interface AuthorizationRequestedBlock extends ChatBlockBase {
  kind: "authorization_requested";
  authorizationId: string;
  action: AuthorizationAction;
  risk: RiskLevel;
  summary: string;
}

// User-actor: user performs a setup step. No risk pill. Card layout is
// chosen by `action`:
//   - `browser.connect` → "Connect" button (POST /api/setup-requests/<id>/open-browser)
//     that opens a live sign-in screencast modal over the agent's headless
//     spawned Chrome (relaunching it headless and navigating to the target page
//     first if it isn't currently running), then signals complete.
//   - `connector.request` → credential dialog. Submit POSTs the credential
//     payload to /api/setup-requests/<id>/complete.
//   - `browser.fill_secret` → inline credential inputs with destination URL
//     prominent. Submit POSTs `{ secrets: { <slot>: <value> } }` to
//     /api/setup-requests/<id>/complete.
//   - `messaging.add_bridge` → inline form with name + password-masked
//     bot-token inputs (kind is pinned in payload). Submit POSTs
//     `{ secrets: { name, botToken } }` to /api/setup-requests/<id>/complete,
//     which routes into addMessagingBridge. Other surfaces (home page,
//     /permissions list) render a "resolve in chat" hint because they can't
//     display the form. See docs/adr/telegram-bridge.md and
//     chat-block-protocol.md.
//   - `messaging.approve_pairing` → confirmation card showing the pending
//     sender, chat type, verification code, expiry. Two buttons: Approve
//     (POSTs `{}` to /complete → server calls allowChat with expectedCode);
//     Reject (POSTs `{ reject: true }` to /complete → server calls
//     rejectPendingChat).
//   - `messaging.remove_bridge` → destructive confirmation card showing
//     bridge name + irreversibility warning. Submit POSTs `{}` to /complete
//     → server calls removeMessagingBridge.
//   - `chat.choice` → single-select question (ask_user tool), rendered as
//     the agent's own message with the options beneath. Options live in the
//     SetupRequest payload; the UI adds its own "Other (type your answer)"
//     freeform input and a Skip affordance.
//     Submit POSTs `{ choice: { label } }` or `{ choice: { other } }` to
//     /complete; Skip POSTs to /cancel, which resumes the loop with a skip
//     fallback instead of failing the task.
//   - `confirmation.request` → inline Confirm/Cancel card (request_confirmation
//     tool). The payload carries { summary, details?, confirmLabel, toolCallId }.
//     Confirm POSTs `{}` to /complete → resume with tool result
//     {confirmed:true}; Cancel POSTs to /cancel → resume with {confirmed:false}.
// Cancel always POSTs to /api/setup-requests/<id>/cancel.
export interface SetupRequestedBlock extends ChatBlockBase {
  kind: "setup_requested";
  setupRequestId: string;
  action: SetupRequestAction;
  summary: string;
}

// Provider-credential failure metadata attached to a terminal-failure
// system note when a chat turn dies because the provider's auth token
// expired / was rejected. Lets clients name which provider failed and
// render a "Re-authenticate <provider>" CTA instead of passing the raw
// provider line through verbatim. See issue #205.
export interface SystemNoteAuthError {
  // Provider whose credential failed (e.g. "codex").
  provider: ProviderName;
  // Short human label for the provider (e.g. "Codex").
  providerLabel: string;
  // The raw provider error message, preserved as secondary detail. For
  // API-key providers this carries the specific cause (the provider's own
  // 401/403 text — "incorrect key", "quota exceeded", "key disabled").
  detail: string;
  // Where the CTA sends the user to re-establish the credential. "docs" → the
  // hosted step-through (OAuth/CLI providers like codex, whose re-auth is a
  // non-obvious terminal flow); "settings" → the in-app Settings → Providers
  // key form (API-key providers); "aws" → Settings, worded for the AWS access
  // key + secret bedrock stores (no bearer API key). See ADR provider-reauth-guidance.md.
  reauthKind: "docs" | "settings" | "aws";
  reauthUrl: string;
}

export interface SystemNoteBlock extends ChatBlockBase {
  kind: "system_note";
  text: string;
  // Present only when this note marks a provider authentication failure
  // (see SystemNoteAuthError). Absent for ordinary notes (cancellation,
  // iteration-cap, approval-denied).
  authError?: SystemNoteAuthError;
}

// Persistent per-provider auth-failure record (issue #233). Written when a
// ProviderAuthError fails a task (failTask records for any task mode,
// including legacy imperative dispatch); cleared only at the seams that
// prove the credential works again: a successful provider call in the
// chat-task loop (main loop and the iteration-cap summary call), a
// provider-config write or successful setup Verify through the setup API,
// and provider removal. Successful provider calls outside the chat-task
// loop do not clear. Only FAILURES are stored — a provider with no record is OK.
// Lives on `RuntimeState.providerAuthFailures`, keyed by provider name, so
// persistent surfaces (Settings → Providers, /api/providers/catalog) can
// report "needs re-authentication" instead of presence-only "Connected".
// See ADR provider-reauth-guidance.md.
export interface ProviderAuthFailureRecord {
  // Provider whose credential failed (e.g. "codex").
  provider: ProviderName;
  // The provider's error message, redacted via redactSecrets by the writer —
  // some providers echo a partial key in their auth error.
  detail: string;
  // ISO timestamp when the failure was recorded.
  at: string;
  // Task whose provider call observed the failure, for the audit trail.
  taskId?: string;
}

// Per-provider auth status surfaced on the /api/providers/catalog payload.
// "ok" means no failure record exists; "needs_reauth" means a provider call
// failed on a credential error and nothing has cleared it since.
export type ProviderAuthStatus = "ok" | "needs_reauth";

// Re-auth payload accompanying `authStatus: "needs_reauth"` on the catalog.
// `reauthKind`/`reauthUrl` mirror SystemNoteAuthError so the Settings card and
// the chat note render the same CTA (derived via providerReauth at read time).
export interface ProviderReauthInfo {
  detail: string;
  at: string;
  reauthKind: "docs" | "settings" | "aws";
  reauthUrl: string;
}

export type ChatBlock =
  | UserTextBlock
  | AssistantTextBlock
  | ToolCallBlock
  | ToolResultBlock
  | PhaseBlock
  | AuthorizationRequestedBlock
  | SetupRequestedBlock
  | SystemNoteBlock;

// One row per distinct thread in a session, derived from the thread's
// `chat_blocks`. Drives the inline thread chips and the cross-agent
// Threads inbox without persisting a separate thread record.
export interface ThreadSummary {
  threadId: string;
  sessionId: string;
  agentId?: string;
  // The main-chat block the thread branched from: the human `user_text`
  // message for an agent-started thread, or the `assistant_text` block the
  // user clicked "Reply in thread" under.
  parentBlockId?: string;
  // Text of the parent block, truncated for chip/root previews.
  rootPreview?: string;
  // Author of the parent block, so surfaces that show the root preview can
  // attribute it correctly. `user_text` ⇒ "user" (agent-started thread,
  // rooted at the human message), otherwise "agent". Absent when no parent.
  rootAuthor?: "user" | "agent";
  // Count of blocks tagged with this thread_id.
  replyCount: number;
  lastReplyAt: string;
  // Truncated text of the most recent text-bearing block in the thread.
  lastReplyPreview?: string;
  // Author of the most recent text-bearing block in the thread, so the
  // inbox can label who replied last. `user_text` ⇒ "user", otherwise
  // "agent". Absent when the thread has no text-bearing block yet.
  lastReplyAuthor?: "user" | "agent";
  // Present while any of the thread's tasks is in flight; absent when idle.
  // Overlapping tasks can interleave blocks in one thread, so each task is
  // judged by its own newest decisive block (gate ⇒ waiting; non-terminal
  // phase or still-running tool call ⇒ running — the per-task backwards
  // scan in threadActivity, src/state/chat-blocks.ts), then the thread
  // aggregates: any task parked on a user gate ⇒ "waiting_approval" (the
  // actionable state wins), else any running task ⇒ "running". Drives
  // activity indicators on thread lists.
  activity?: "running" | "waiting_approval";
}

export interface RuntimeState {
  version: 1;
  instance: Instance;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  // Agent-actor gates: approved/denied by the user, then the runtime
  // performs the action.
  authorizations: Authorization[];
  // User-actor gates: the user performs a setup step (browser sign-in,
  // credential entry), then the runtime resumes.
  setupRequests: SetupRequest[];
  audit: AuditEvent[];
  skills: SkillRecord[];
  jobs: JobRecord[];
  connectors: ConnectorRecord[];
  improvements: ImprovementProposal[];
  // Skill-learning outcome rows (ADR skill-learning-from-outcomes.md). One row
  // per attributable run outcome (a skill script's success/failure, or an
  // unattributed task failure). Bounded ring, newest-first. Defaulted to [] by
  // normalizeState so older state files load.
  skillOutcomes: SkillOutcome[];
  // Non-skill-edit findings the daily review surfaces but never auto-actions
  // (environment / credential / model-ignored / bundled-skill). Bounded,
  // newest-first. Defaulted to [] by normalizeState.
  learningFindings: LearningFinding[];
  // ISO timestamp of the last posted "Skill review" digest. The next digest
  // only re-surfaces proposals/findings created AFTER this, so a standing
  // (still-unactioned) proposal isn't re-posted every run. Absent until the
  // first digest posts; normalizeState leaves it as-is (passthrough).
  lastSkillReviewDigestAt?: string;
  promotions: PromotionProposal[];
  snapshots: SnapshotRecord[];
  tools: ToolRecord[];
  toolsets: ToolsetRecord[];
  subagents: SubagentRecord[];
  mcpServers: McpServerRecord[];
  messagingBridges: MessagingBridgeRecord[];
  importReports: ImportReport[];
  agents: AgentRecord[];
  activeAgentId?: string;
  relays: RelayRecord[];
  notifications: NotificationRecord[];
  emailWatchers: EmailWatcherRecord[];
  // Run-once marker for the retired-query-shape heal (ISO timestamp of the
  // first heal pass). Once set, the heal returns early so it can never rewrite
  // a user's raw query that happens to match a retired auto-built shape on a
  // later boot. Legacy states omit it (treated as "not yet healed").
  emailWatcherQueryHealedAt?: string;
  // Run-once marker for the per-concern channel migration (ISO timestamp of the
  // first pass). Once set, the migration returns early so a watcher provisioned
  // its own channel exactly once; later boots leave an already-migrated install
  // alone. Legacy states omit it (treated as "not yet migrated").
  emailWatcherChannelsMigratedAt?: string;
  // Per-agent opt-in for whole-inbox triage (ADR email-watch.md). An agent id
  // appears here ONLY when the user explicitly asked to triage their entire
  // inbox ("respond-or-flag all my new mail"); the empty string is the sentinel
  // for legacy/hand-edited watchers with no agentId. Triage is opt-in: a normal
  // sender/thread watch never adds an entry, so it never provisions the broad
  // `in:inbox` triage concern. Absent/empty for installs that never opted in.
  emailTriageAgents?: string[];
  // Durable ids of Gmail drafts the user has SENT from the email-draft card's
  // Send button (POST /api/email/drafts/send). The card reads this on mount
  // (GET /api/email/drafts/sent?ids=…) to render a persistent "Sent" state that
  // survives a page refresh. Ids only; deduped. Absent for installs that never
  // sent a draft from the card.
  sentDrafts?: string[];
  events: RuntimeEvent[];
  jobRuns: JobRunRecord[];
  // Durable per-day token-usage rollup across every generative provider call
  // (chat, jobs, subagents, memory, titles, vision, …). Written by recordUsage
  // and read by the home usage chart, so the chart survives task pruning and
  // captures spend that never lands on a task. Legacy states omit it (healed
  // to []). See ADR usage-accounting.md.
  usageLedger: UsageLedgerEntry[];
  // Run-once marker (ISO timestamp) for the one-time backfill that seeds the
  // usage ledger from existing terminal task.cost rows on first boot after the
  // ledger shipped. Once set, the backfill is skipped so it never duplicates.
  // Legacy/new states omit it until the backfill runs. See ADR usage-accounting.md.
  usageLedgerBackfilledAt?: string;
  chatSessions: ChatSessionRecord[];
  chatMessages: ChatMessageRecord[];
  messagingMessages: MessagingMessageRecord[];
  runs: RunRecord[];
  planSteps: PlanStepRecord[];
  // Headed-browser connection slot. null (the default) means the runtime drives
  // its own spawned per-instance Chrome (src/tools/browser.ts). A non-null
  // record means the user attached the runtime to their OWN external Chrome
  // over CDP via /api/browser/connect — the only persisted connection mode.
  // (The old managed/visible-window mode was removed — see issue #420.)
  browser?: BrowserConnectionRecord | null;
  // Optional tunnel selection singleton (see ADR tunnel-connectivity.md).
  // Populated by the tunnel integration when the user selects/connects a
  // provider; null until then. Mirrors the `browser` opt-in field above.
  tunnel?: TunnelSelectionRecord | null;
  // Per-conversation snapshot of the runtime identity last shown to the
  // agent (instance, port, agent, provider, toolsets, namespace). Drives
  // tell-once-plus-delta system-prompt injection in runChatTask:
  // the first turn emits the full identity, subsequent turns emit only
  // changed fields, and every IDENTITY_FULL_REFRESH_INTERVAL turns the
  // full block is re-emitted to bound the delta-reconstruction depth.
  // Optional so legacy state files don't need a schema migration.
  identitySnapshots?: Record<string, IdentitySnapshotRecord>;
  // Per-provider needs-reauth records (issue #233). Absence of a key means
  // that provider's credential is OK as far as the runtime knows. Optional
  // so legacy state files don't need a schema migration; the helpers in
  // src/state/provider-auth.ts treat undefined as empty.
  providerAuthFailures?: Partial<Record<ProviderName, ProviderAuthFailureRecord>>;
}

// Captured agent-runtime identity surfaced into the system prompt so
// the model can answer self-introspection questions without a tool call.
// Stored on RuntimeState.identitySnapshots so subsequent turns can render
// just the diff instead of the full block on every turn.
export interface AgentIdentity {
  instance: string;
  runtimePort: number;
  agentName: string;
  agentId: string;
  provider: string;
  toolsets: string[];
  memoryNamespace: string;
}

// Per-conversation snapshot of the last-emitted identity plus the turn
// index when the full block was last sent. The full block re-emits when
// (currentTurn - lastFullTurn) >= IDENTITY_FULL_REFRESH_INTERVAL.
export interface IdentitySnapshotRecord {
  identity: AgentIdentity;
  lastFullTurn: number;
}

export type TaskMode = "chat" | "imperative";

// A pending tool call captured by the chat-task loop while waiting for an
// approval to resolve. Stored on the task so the loop can resume after the
// approval completes without re-running the model. `result` is filled in by
// the approval execution path (e.g. file write succeeded, command output).
export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  approvalId: string;
  result?: string;
}

// Lightweight per-tool-call record surfaced to the chat UI so the user sees
// what the agent is doing while a task is in-flight. This is purely a
// display payload — execution truth still lives in audit/trace/messages.
// Capped on the producing side (~20) so long-running loops don't bloat
// state. Cleared/ignored once the task reaches a terminal status.
export interface ToolCallSummary {
  id: string;          // tool_call_id
  name: string;        // tool name as known to the model
  argsPreview: string; // single-line, truncated args
  status: "running" | "done" | "error";
  startedAt: string;
  completedAt?: string;
}

// Snapshot of the tool-calling conversation needed to resume the loop after
// an approval gates a tool. We persist enough context that the runtime can
// pick up where it left off when the user approves/denies.
export interface TaskToolCallState {
  // OpenAI-shaped messages array (system, user, assistant w/ tool_calls,
  // tool result messages). We keep `unknown[]` to avoid pulling provider
  // shape into the central type module.
  messages: unknown[];
  // Stable identifier for the tool catalog used during this loop. If it
  // changes between iterations (toolset toggled, skill loaded), we don't
  // assume the prior catalog still applies.
  toolsHash: string;
  // Tool calls awaiting approval. When all of these have results filled in,
  // the loop resumes.
  pending: PendingToolCall[];
  // Iteration counter (capped to prevent runaway loops).
  iterations: number;
}

export interface Task {
  id: string;
  title: string;
  input: string;
  status: TaskStatus;
  instance: Instance;
  // Per-agent isolation key, mirroring MemoryRecord.agentId. Optional because
  // legacy state files predate this field; normalizeState backfills it by
  // stamping the active agent at migration time. Stays undefined for tasks
  // created with no active agent (system-driven flows).
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  currentStep?: string;
  summary?: string;
  // Live partial assistant text streamed from the provider while the task is
  // running. Cleared/ignored once `summary` is set on completion. Surfaced to
  // the chat UI as a synthesized streaming assistant message so the user sees
  // text mid-flight instead of waiting for the buffered final response.
  partialSummary?: string;
  error?: string;
  // Provider whose credential failed when the task died on a provider auth
  // error (expired/invalid/rejected token, 401). Captured at the model-call
  // site so every render surface — the chat system note and the legacy
  // assistant ChatMessageRecord — names the same provider and offers a re-auth
  // CTA, even if the active agent changed while the call was in flight. See
  // issue #205. Absent for non-auth failures.
  authErrorProvider?: ProviderName;
  tracePath: string;
  auditIds: string[];
  approvalIds: string[];
  skillIds: string[];
  jobId?: string;
  parentTaskId?: string;
  subagentId?: string;
  runId?: string;
  // Originating chat session, when the task was submitted from a chat
  // message (web UI or messaging bridge). Lets clients link a task back to
  // its conversation without fetching the unscoped chatMessages list to
  // resolve the join. Optional because imperative/CLI tasks don't have a
  // session. normalizeState backfills missing values from chatMessages
  // for state files predating this field.
  chatSessionId?: string;
  cost?: CostRecord;
  // Execution mode. "chat" routes through the tool-calling agent loop in
  // src/execution/chat-task.ts. "imperative" preserves the legacy CLI
  // prefix-dispatch behavior. Defaults to "imperative" for back-compat.
  mode?: TaskMode;
  // Resume state for the chat-task loop while waiting on an approval. Cleared
  // once the loop finishes (completed/failed) so completed tasks don't retain
  // long-lived conversation snapshots in state.
  toolCallState?: TaskToolCallState;
  // Names of deferred tools the model has loaded via load_tools during this
  // task. Persists for the life of the task (NOT in toolCallState, which is
  // cleared each resume) so resumeChatTask re-applies the loaded set when
  // runLoop rebuilds providerTools. Cleared only on terminal completion.
  loadedTools?: string[];
  // Recent tool calls dispatched by the chat-task loop, surfaced to the chat
  // UI as inline rows above the "Working…" indicator. Capped at ~20 entries
  // (oldest dropped). Not persisted as audit truth — these are a display
  // convenience only.
  recentToolCalls?: ToolCallSummary[];
  // Image attachments carried by the user message that spawned this task.
  // Stamped on submission so the agent loop can build vision content from a
  // single record instead of racing the chat-message write. The bytes live
  // under ~/.gini/instances/<inst>/uploads/<id>.<ext>; this array only
  // carries the refs.
  images?: ImageAttachment[];
  // Client surface of the user message that spawned this task. Stamped on
  // submission (same rationale as `images`: the agent loop reads a single
  // record instead of racing the chat-message write) so the per-turn prompt
  // can tell the model which surface the CURRENT message came from. Absent
  // when the surface is unknown. See ADR client-surface-context.md.
  clientSurface?: ChatClientSurface;
  // Thread membership for the task's emitted chat blocks. Set when a task is
  // spawned to reply inside a thread (the thread-reply endpoint), in which
  // case the whole response threads. Absent for ordinary main-chat tasks.
  threadId?: string;
  parentBlockId?: string;
  // Times this task has been re-dispatched after a gateway restart; capped to
  // break crash loops — see ADR task-resume-on-restart.md.
  bootResumeCount?: number;
  // Supersede provenance. Set when this task was parked at waiting_approval
  // on Authorization gates and a new user message cancelled it (cancelTask
  // reason "superseded") — the id of the fresh task that ran that message.
  // The gated side effect was NOT executed: user text never resolves a gate
  // as approval; the only path that executes one is the explicit approve
  // endpoint.
  supersededByTaskId?: string;
  // "Additional input needed" marker (ADR chat-topics-tasks-subagents.md).
  // Two producers:
  //   - The chat-task park: when EVERY gate the loop paused on is a pending
  //     `chat.choice` SetupRequest (ask_user), the park stamps the question
  //     payload here (question/options/setupRequestId/blockId) and the task's
  //     status becomes `needs_input` (unless GINI_NEEDS_INPUT_STATUS=0 keeps
  //     the exposed status `waiting_approval` for one release). Cleared when
  //     the resume flips the task back to running.
  //   - A subagent child whose ask_user call could not be answered in-band
  //     (no chat surface): question-only stamp (no setupRequestId), so the
  //     question bubbles up to the parent's spawn_subagent tool result via
  //     syncSubagentFromTask; the parent then re-asks via its own ask_user.
  needsInput?: { question: string; options?: string[]; setupRequestId?: string; blockId?: string };
}

export interface RuntimeEvent {
  id: string;
  instance: Instance;
  at: string;
  kind: RuntimeEventKind;
  action: string;
  target: string;
  taskId?: string;
  jobId?: string;
  runId?: string;
  risk: RiskLevel;
  summary: string;
  data?: Record<string, unknown>;
  // Originating agent. Optional and meaningful: when undefined, the
  // event is "system-attributed" (instance boot, instance-level config,
  // legacy rows from before agent stamping). Events are never
  // back-filled — missing agentId is preserved as a first-class signal
  // that the row is system-attributed.
  agentId?: string;
  // When true, the writer drops `data` before persisting. Metadata
  // (action, target, actor via mirrored audit, timestamp, etc.) is still
  // recorded so the activity feed shows that something happened, but the
  // payload bytes never land on disk or stream out. Set by call sites
  // that route sensitive material (e.g. a co-browse handoff relaying
  // keystrokes) so even an accidental `data: { rawKey: ... }` is dropped
  // at the boundary.
  redacted?: boolean;
}

export interface RunRecord {
  id: string;
  instance: Instance;
  kind: RunKind;
  status: RunStatus;
  title: string;
  input: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  taskId?: string;
  jobId?: string;
  parentRunId?: string;
  subagentId?: string;
  planStepIds: string[];
  childRunIds: string[];
  approvalIds: string[];
  summary?: string;
  error?: string;
  cost?: CostRecord;
}

export interface PlanStepRecord {
  id: string;
  instance: Instance;
  runId: string;
  title: string;
  status: PlanStepStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  subagentId?: string;
  summary?: string;
  error?: string;
}

export interface ChatSessionRecord {
  id: string;
  instance: Instance;
  // Owning agent (same shape as MemoryRecord.agentId). Optional for legacy
  // sessions; normalizeState backfills with the migration-time active agent.
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
  taskIds: string[];
  runIds: string[];
  summary?: string;
  // Origin descriptor when the session was created by a non-UI surface.
  // The web chat omits this; messaging bridges (Telegram, Discord) set
  // `kind` to the bridge kind ("telegram" | "discord") with the
  // owning bridge id in a separate `bridgeId` field, so the runtime
  // can mirror assistant replies back out to the chat / channel the
  // user started in. `target` is the bridge-specific addressing
  // string passed back to sendMessagingOutput.
  //
  // `source` doubles as the routing key for inbound: the poller's
  // findOrCreate*ChatSession helpers match on (kind, bridgeId,
  // chatId|channelId), so setting `source` on a session that should
  // NOT receive inbound (e.g., a dedicated job-spawned session that
  // only mirrors OUTBOUND back to the originating chat) would cause
  // the live channel's next inbound to land in the job thread. Use
  // `outboundMirror` for the outbound-only case.
  source?: ChatSessionSource;
  // Outbound-only mirror descriptor. Populated on dedicated job
  // sessions so a scheduled "remind me in 20s" task can dispatch its
  // reply back through the originating bridge without competing with
  // the live channel session for inbound routing. finalize.ts reads
  // `outboundMirror ?? source` so live sessions (where the two are
  // the same) continue to work unchanged.
  outboundMirror?: ChatSessionSource;
  // Marks how the session was created. `"job"` indicates a dedicated
  // session spawned by a scheduled/cron job; the UI uses this to
  // render a job indicator and to keep these chats unread until a
  // human opens them.
  origin?: "job";
  // The session's role in the new chats IA. `"agent"` = the single
  // canonical chat for an agent (this is Chat — the always-present main
  // interface); `"channel"` = a recurring-job-derived channel (always also
  // carries `origin: "job"`); `"topic"` = a subject-scoped session with its
  // own isolated context window, spawned by Chat / a job / another topic
  // (ADR chat-topics-tasks-subagents.md). `"channel"` folds into `"topic"`
  // in a later phase. DISTINCT from `source?.kind` (the messaging-bridge
  // kind). Legacy/non-canonical sessions may leave this undefined; the new
  // UI treats undefined as hidden.
  kind?: "agent" | "channel" | "topic";
  // Short rolling summary of a `kind:"topic"` session, used later for
  // routing/retrieval (Chat picks a topic to dispatch into by recalling over
  // topic summaries). Absent until a topic accrues content.
  topicSummary?: string;
  // The session that spawned a `kind:"topic"` session — the Chat
  // (`kind:"agent"`) it was routed out of, used to forward a topic's final
  // answer back into Chat. Doubles as the parent edge for child containers:
  // a container spawned from inside another container records that parent
  // here. The topic's display name reuses the existing `title` field.
  parentChatSessionId?: string;
  // User pin gesture. `pinned === true` is the only thing the sidebar topics
  // section lists; nothing the agent or router creates is ever auto-pinned.
  // Legacy non-archived `kind:"topic"` sessions are backfilled to true once
  // (migrations.topicsPinnedBackfilled) so the pinned-based sidebar keeps
  // showing them.
  pinned?: boolean;
  // Never surfaced in chrome (home, sidebar, session lists, router
  // candidates) — e.g. a watch job's working thread. The container stays
  // directly addressable by id.
  headless?: boolean;
  // Home checkbox: stamped when the user acknowledges the container's latest
  // outcome. Attention is DERIVED, never stored — an acknowledgedAt at or
  // after the latest run outcome decays `done_unacknowledged` to `none`
  // (state/attention.ts). Seeded to now() on all pre-existing sessions once
  // (migrations.containersAckSeeded) so the first boot after upgrade doesn't
  // flood home.
  acknowledgedAt?: string;
  // Idempotent-spawn dedup key, scoped to `parentChatSessionId`. A spawner
  // that re-fires with the same key finds the existing child container
  // (findChildContainerByCorrelationKey) instead of minting a duplicate —
  // including after the child was acknowledged or archived.
  correlationKey?: string;
  // Provenance: the run (task) whose spawn created this container. Records
  // where the spawn was journaled, not agency — jobs never create containers;
  // the agent does, during a run.
  spawnedByTaskId?: string;
  // Agent-created container explicitly marked user-facing by its spawner
  // (e.g. a watch job's draft tasks). Drives the home inclusion predicate;
  // user-started containers don't need it.
  surfaced?: boolean;
  // Records the creation gesture: which composer mode the user started the
  // container from — "task" (a fire-and-forget work item that lives on home)
  // or "message" (a conversation the user stays in; the sidebar Messages
  // section lists these). Immutable presentation intent, not lifecycle —
  // nothing flips it later. Absent on containers minted before the field
  // existed and on router/agent/job-minted containers (unknown ≠ either).
  startedAs?: "task" | "message";
  // Archived marker. Absent = active. An archived session keeps its full
  // history and stays directly addressable (GET /api/chat/<id>, deep links),
  // but is excluded from session/channel lists. Set when a job's delivery
  // is rebound away from its dedicated channel (update_job deliverTo
  // "chat") so the orphaned channel stops cluttering the rails. Optional,
  // so legacy sessions just lack it — no normalizeState backfill.
  archivedAt?: string;
  // Stable marker identifying a channel as belonging to the email-watch
  // feature, used for PRECISE identity-based cleanup of orphan email-watch
  // channels — NOT title-based matching (which could catch an unrelated
  // channel that merely happens to be titled "Email watch: ..."). Set when
  // the shared email-watch session is created and backfilled by the
  // self-heal migration. DISTINCT from `source` (messaging-bridge routing).
  // Optional, so legacy sessions just lack it — no normalizeState backfill.
  // "skill-review" marks the dedicated channel the daily skill-learning review
  // posts its digest into (ADR skill-learning-from-outcomes.md).
  feature?: "email-watch" | "skill-review";
  // FIFO queue of messages submitted while a chat turn is already in flight
  // for this session. The gateway is the source of truth: a new POST while a
  // task runs is enqueued here instead of starting a concurrent task, and the
  // next entry auto-dispatches when the current turn ends (ADR
  // chat-message-queue.md). Optional, so existing persisted state stays valid.
  pendingMessages?: PendingChatMessage[];
}

// A chat message held in the per-session queue while a turn is in flight.
// Audio is intentionally absent: a voice message is transcribed to `content`
// at prepare time, so only the resulting text + image refs are queued.
export interface PendingChatMessage {
  id: string;
  content: string;
  images?: ImageAttachment[];
  clientSurface?: ChatClientSurface;
  // Set when the queued message is a thread reply, so auto-dispatch
  // re-dispatches it back into its thread (a popped reply that lost these
  // would drain as a main-chat turn). Optional so persisted state without
  // them stays valid.
  threadId?: string;
  parentBlockId?: string;
  // Carries the thread reply's "also show in main chat" flag so the mirror
  // block survives the queue (a popped reply that lost it would re-dispatch
  // without the main-chat mirror).
  alsoToMain?: boolean;
  // The user_text block inserted at accept time (echo-first ack). Auto-dispatch
  // attaches the task to this block instead of inserting a duplicate bubble,
  // and removing the queued message deletes it. Absent for thread replies and
  // topic-queue entries, whose blocks are created at dispatch time.
  echoBlockId?: string;
  createdAt: string;
}

// Derived attention state of a container (chat session), computed on read by
// deriveContainerAttention (src/state/attention.ts) — never stored. Only
// facts persist on the record (`pinned`, `headless`, `acknowledgedAt`,
// `correlationKey`, `spawnedByTaskId`, `surfaced`). Precedence:
// needs_input > review > working > done_unacknowledged > none.
export type ContainerAttention =
  | "needs_input"
  | "review"
  | "working"
  | "done_unacknowledged"
  | "none";

// One row of the home attention queue (GET /api/home). A lean read shape —
// deliberately NOT the full ChatSessionRecord (no message arrays). Web
// imports this via @runtime/types; never export a bare `Task` alias for it
// (the ops /tasks page owns that word).
export interface HomeTaskItem {
  // Container (chat session) id — the row deep-links to /chat?session=<id>.
  id: string;
  title: string;
  attention: ContainerAttention;
  // First line of the latest terminal run's summary/error. Present on
  // done_unacknowledged rows so home can render the outcome line.
  outcomeLine?: string;
  // Present when attention === "needs_input": the pending ask_user question.
  // `options` are the choice labels; answering goes through the existing
  // /api/setup-requests/:id/complete endpoint.
  needsInput?: { question: string; options?: string[]; setupRequestId?: string };
  // Present when attention === "review": the pending Authorization gate.
  // The home button deep-links to the thread; `authorizationId` is kept for
  // a later inline approve/deny affordance.
  review?: { label: string; kind: "email" | "document" | "generic"; authorizationId: string };
  // Present (true) only when the newest terminal outcome has status "failed"
  // — the row renders the destructive treatment plus a Retry affordance
  // instead of a normal done outcome line. Cancelled outcomes stay neutral
  // (a superseded container immediately has a new live run anyway). Retry
  // POSTs to /api/containers/:id/retry; the server looks up the failed run's
  // input, so the row never carries it.
  failed?: boolean;
  // The home checkbox. Served rows are always false (acknowledged containers
  // decay to attention "none" and are filtered server-side); the client flips
  // it optimistically after POST /api/containers/:id/acknowledge.
  acknowledged: boolean;
  // Present when a scheduled job was created from this conversation
  // (job.chatSessionId points here); the newest such job wins. Drives the
  // row's violet Routine chip, which opens the routine details panel.
  routineJobId?: string;
  startedBy: "user" | "agent" | "schedule";
  updatedAt: string;
}

// One row of the home Recents feed (GET /api/home): one entry per
// home-eligible container, carrying its newest completed run. Follow-up
// runs in the same container update the entry's recency instead of adding
// rows, and the title is the CONTAINER's title (never a follow-up's text).
export interface RecentItem {
  // Task (run) id of the container's newest completed run.
  id: string;
  // Owning container (chat session) id — the row deep-links there.
  containerId: string;
  icon: "draft" | "document";
  title: string;
  timestamp: string;
}

// `lastInboundMessageId` is the most recent originating-message id the
// chat session received from the bridge — Telegram's numeric
// `message_id` (the per-chat id used by `reply_to_message_id`, NOT
// the update id) or Discord's message snowflake string (used by
// `message_reference.message_id`). It's what scheduled-job replies
// use to thread their delayed dispatch onto the original user
// message. The field is updated by the poller every time a new
// inbound lands so a long-running session always threads onto the
// most recent prompt.
export type ChatSessionSource =
  | { kind: "telegram"; bridgeId: string; chatId: number; target: string; lastInboundMessageId?: number }
  | { kind: "discord"; bridgeId: string; channelId: string; target: string; lastInboundMessageId?: string }
  // Openclaw migration provenance. The poller-side
  // findOrCreate*ChatSession helpers only match on the telegram and
  // discord kinds, so an "openclaw"-sourced session never receives
  // live inbound — it just carries the original openclaw session id
  // so the openclaw migrator can dedup re-apply against the
  // structured field instead of string-matching the title (which the
  // operator can rename via `gini chat rename`).
  | { kind: "openclaw"; openclawSessionId: string; openclawAgentId: string };

// Client surface an inbound chat message was sent from. Per-MESSAGE, not
// per-session — the same session can be used from phone and desktop
// alternately, so the surface is resolved on every submit. UI clients tag
// each POST with a `client` body field ("web" | "mobile" | "cli"); messaging
// bridges don't send the field — their surface derives from the session's
// `source.kind`. An absent/unrecognized value resolves to undefined
// (unknown), never an error, so older clients keep working. See ADR
// client-surface-context.md.
export type ChatClientSurface = "web" | "mobile" | "cli" | "telegram" | "discord" | "openclaw";

export interface ChatMessageRecord {
  id: string;
  instance: Instance;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
  // User-role messages carry images attached at submit time. Stored as upload
  // refs (id + mimeType + size) — bytes live on disk under
  // ~/.gini/instances/<inst>/uploads/. Mirrored on the user_text ChatBlock so
  // either persistence path can drive transcript rendering.
  images?: ImageAttachment[];
  // User-role messages may carry a voice recording. Render-only — the audio
  // is transcribed into `content` at submit time and never sent to the
  // provider. Mirrored on the user_text ChatBlock for playback rendering.
  audio?: AudioAttachment;
  // Optional tag used to distinguish multiple assistant messages emitted by
  // the same task. Today only "approval_reason" is set — when an approval
  // (e.g. connector.request) is created, the runtime persists its `reason`
  // as a durable assistant bubble before the task pauses, so the user can
  // scroll back and see what they were asked. Without this tag, the
  // single-assistant-message-per-task assumption in syncChatTaskResult and
  // getChatSession would either drop the reason or block the final summary
  // from landing. Untagged assistant messages (the default) are the
  // task's terminal summary.
  kind?: string;
  // Tool-calling transcript fields, set only on rows tagged
  // kind:"tool_transcript". The assistant row that emits tool calls carries
  // `toolCalls`; each paired result row uses role:"tool" with `toolCallId`
  // pointing back at the originating call. Stored in a provider-agnostic
  // inline shape (not the provider's ToolCall type) so the durable store has
  // no provider dependency; chat-task maps these back to the provider message
  // shape when replaying across turns. These rows are excluded from the
  // human-facing JSON views in chat.ts.
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  toolCallId?: string;
  // Monotonic per-store sequence stamped at create time. Gives a stable
  // tiebreaker when several transcript rows share a createdAt timestamp, so
  // replay can reconstruct exact assistant→tool ordering. Older rows lack it
  // and fall back to 0.
  seq?: number;
  // Thread membership for provider-replay rows. ChatBlock remains the UI
  // source of truth; these fields let prompt packing prefer the active thread
  // without losing the single-session durable history model. Legacy rows omit
  // them and are treated as main-chat context.
  threadId?: string;
  parentBlockId?: string;
}

export interface TraceRecord {
  id: string;
  taskId: string;
  instance: Instance;
  at: string;
  type: "task" | "model" | "tool" | "approval" | "memory" | "job" | "connector" | "error" | "warning";
  message: string;
  data?: Record<string, unknown>;
  // When true, the writer drops `data` before serializing to JSONL.
  // Same contract as RuntimeEvent.redacted — metadata still records
  // that the trace existed; the payload is suppressed at the boundary.
  redacted?: boolean;
}

export interface ToolRecord {
  id: string;
  instance: Instance;
  name: string;
  description: string;
  toolset: string;
  status: ToolStatus;
  risk: RiskLevel;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolsetRecord {
  id: string;
  instance: Instance;
  name: string;
  description: string;
  status: ToolsetStatus;
  toolNames: string[];
  scopes: Array<"task" | "job" | "skill" | "subagent" | "mcp" | "messaging">;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRecord {
  id: string;
  instance: Instance;
  // Owning agent. Optional for legacy records; backfilled by normalizeState.
  agentId?: string;
  name: string;
  prompt: string;
  status: SubagentStatus;
  parentTaskId?: string;
  taskId?: string;
  toolsets: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  summary?: string;
  // Slice 4 extensions: subagents now run a real constrained agent loop.
  // The system prompt overrides the parent's default Gini preamble for the
  // child task so the subagent has its own narrower instructions.
  systemPrompt: string;
  // Restricted toolset whitelist (names matching state.toolsets[].name). When
  // omitted/empty, the child inherits the parent's toolset world. When set,
  // only tools belonging to one of these toolsets are exposed (skill catalog
  // tools like read_skill stay always-on).
  toolsetIds?: string[];
  // Enabled skill name whitelist. When omitted/empty, the child sees every
  // enabled skill the parent could see. When set, the "Available skills:"
  // block in the system prompt is filtered down to this subset.
  skillNames?: string[];
  // Convenience mirror of the populated child task's summary/error so the
  // parent (or UI) can read terminal results off the subagent record without
  // joining against the task table.
  resultSummary?: string;
  resultError?: string;
  // The "additional input needed" return variant (ADR
  // chat-topics-tasks-subagents.md). A subagent has no chat surface of its
  // own, so when its child task calls ask_user the question can't be answered
  // in-band; instead the question bubbles up here and surfaces in the parent's
  // spawn_subagent tool result so the PARENT (which does have a topic/chat
  // session) can re-ask. `options` carries the child's choice labels so the
  // parent re-asks with the same options instead of inventing its own. This
  // lives only on the return-value/marker types — it is NOT a persisted
  // SubagentStatus.
  resultNeedsInput?: { question: string; options?: string[] };
  // Optional framing the parent passes when delegating: a one-line objective and
  // any background the subagent needs. Rendered as `## Goal` / `## Context`
  // sections ahead of the subagent's prompt in its system context.
  goal?: string;
  context?: string;
}

// Cached `tools/list` entry from an HTTP MCP server. Populated on the
// health probe so the agent loop and the /mcp page can surface what tools
// each server exposes without re-querying on every call.
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerRecord {
  id: string;
  instance: Instance;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  status: McpServerStatus;
  exposedTools: string[];
  lastHealthAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
  // Transport selector. Defaults to "stdio" when omitted to keep the
  // pre-existing CLI-spawn behavior intact for older records. "http"
  // routes invocations through src/integrations/mcp-http.ts.
  transport?: "stdio" | "http";
  // Required when transport === "http". The server's MCP streamable-HTTP
  // endpoint (e.g. https://mcp.linear.app/mcp).
  url?: string;
  // Static or `${ENV}`-placeholder header map applied to each HTTP MCP
  // request. Placeholders are resolved at invoke time against the
  // active-skill env binding map so connector tokens stay encrypted at rest.
  headers?: Record<string, string>;
  // Cached tools/list result from the last successful health probe. Empty
  // until the server has been health-checked.
  tools?: McpToolSpec[];
}

export interface MessagingBridgeRecord {
  id: string;
  instance: Instance;
  name: string;
  kind: "telegram" | "discord" | "slack" | "email" | "imessage" | "demo" | string;
  status: MessagingBridgeStatus;
  deliveryTargets: string[];
  lastHealthAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
  // Per-bridge encrypted secret refs (Telegram + Discord both store
  // their bot token here). Stored via the same AES-GCM box as
  // connectorSecrets — the connectorId namespace we use is
  // `messaging.<bridgeId>` so a bridge delete cleans up its files.
  secretRefs?: ConnectorSecretRef[];
  // Bridge-kind-specific non-secret state. Kept as a free-form record
  // so each kind can evolve without forcing a schema migration on the
  // others. Current shapes:
  //   telegram: {
  //     botUsername, botId, lastOffset,
  //     allowedChatIds: number[],           // per-chat allowlist (no TOFU)
  //     ownerChatId?: number,               // first-enrolled chat for audit history
  //     recentDeniedChats?: DeniedChatAttempt[]  // pending enrollment requests; each
  //                                              // entry carries a verificationCode +
  //                                              // verificationCodeExpiresAt for the
  //                                              // operator-side handshake (see
  //                                              // src/integrations/messaging.ts)
  //   }
  //   discord: {
  //     botUsername, botId, globalName?,
  //     lastInboundExternalIds: Record<channelId, snowflake>  // per-channel watermark
  //   }
  metadata?: Record<string, unknown>;
}

export interface MessagingMessageRecord {
  id: string;
  instance: Instance;
  bridgeId: string;
  direction: "inbound" | "outbound";
  status: MessagingMessageStatus;
  target: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  notificationId?: string;
  error?: string;
  // Optional media attachment. For outbound: the user-supplied source
  // (url/fileId/path) the bridge dispatched. For inbound: the captured
  // file on disk plus the originating Telegram file_id so the caller can
  // re-download if needed. `text` carries the caption in both directions.
  media?: MessagingMessageMedia;
}

export interface MessagingMessageMedia {
  kind: "photo";
  url?: string;
  fileId?: string;
  path?: string;
}

export interface ImportReport {
  id: string;
  instance: Instance;
  source: ImportSource;
  path: string;
  // `inspect` reports walk a source path without touching it (the historical
  // `gini import inspect` surface). `applied` reports record a migration
  // that actually mutated gini state — produced by `gini import apply
  // openclaw`. The two share storage so the activity feed and audit trail
  // surface every import attempt uniformly.
  mode: "inspect" | "applied";
  status: "completed" | "failed";
  counts: Record<string, number>;
  findings: string[];
  createdAt: string;
  error?: string;
}

export interface SessionSearchResult {
  id: string;
  instance: Instance;
  kind: "task" | "trace" | "memory" | "skill" | "audit";
  score: number;
  title: string;
  excerpt: string;
  taskId?: string;
  traceId?: string;
  source: string;
  at: string;
}

export interface ProviderCatalogItem {
  id: string;
  name: ProviderName | "openrouter" | "local" | string;
  displayName: string;
  baseUrl?: string;
  auth: "none" | "env" | "codex-oauth" | "aws";
  models: string[];
  capabilities: string[];
  costHint: "free" | "external" | "unknown";
  // Hosted setup guide for this provider, rendered inline by the web client's
  // DocReference/DocSheet. Derived by convention from the docs base
  // (<base>/providers/<id>); absent for providers with no guide (echo).
  setupDocUrl?: string;
}

// One way to reach a model: the (provider, providerModelId) pair dispatch
// needs, plus a short user-facing route label ("OpenAI", "Amazon Bedrock ·
// eu"). `default` marks the route the picker selects when the user picks
// the model by name without choosing a provider. See ADR
// model-first-selection.md.
export interface ModelRoute {
  provider: ProviderCatalogItem["name"];
  providerModelId: string;
  label: string;
  default: boolean;
}

// A canonical model and every route currently serving it. `id` is the
// picker-facing model name (provider-specific ids like bedrock inference
// profiles are folded into it via the alias table in src/model-routes.ts).
export interface ModelCatalogEntry {
  id: string;
  routes: ModelRoute[];
}

// User-managed browsing boundary for one agent's browser tools. Entries
// are bare domains (no scheme, no wildcards); a URL's host matches an
// entry when it equals the entry or is a subdomain of it, case-insensitive
// (`example.com` matches `sub.example.com`). `deny` always blocks first; a
// non-empty `allow` additionally switches the agent to allow-only browsing.
// Enforced in src/tools/browser.ts at navigate pre-flight AND at the
// post-redirect / live-page origin boundary. The SSRF/loopback gate runs
// first and cannot be overridden by `allow`. See ADR
// browser-domain-policy.md.
export interface BrowserDomainPolicy {
  deny?: string[];
  allow?: string[];
}

export interface AgentRecord {
  id: string;
  instance: Instance;
  name: string;
  status: AgentStatus;
  providerName?: ProviderName | "openrouter" | "local";
  model?: string;
  toolsets: string[];
  messagingTargets: string[];
  // Optional browsing domain policy. Absent ⇒ no domain restrictions
  // beyond the always-on SSRF gate. User-managed by editing the agent
  // record (no CLI/UI surface yet — see ADR browser-domain-policy.md).
  browserDomainPolicy?: BrowserDomainPolicy;
  // ISO timestamp set when the agent is archived (soft delete). Orthogonal
  // to `status` — `activateAgent` flips `status`, so archive state lives in
  // its own field. Absent ⇒ not archived. An archived agent cannot be
  // activated (explicit unarchive required) and its scheduled jobs are
  // suppressed. See ADR agents-replace-profiles.md.
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParityCheck {
  id: string;
  label: string;
  status: "pass" | "partial" | "missing";
  evidence: string[];
  requiredForV1: boolean;
}

export interface RelayRecord {
  id: string;
  instance: Instance;
  name: string;
  endpoint: string;
  status: RelayStatus;
  mode: "local-only" | "lan" | "hosted";
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  message?: string;
}

export interface NotificationRecord {
  id: string;
  instance: Instance;
  kind: "approval" | "job" | "task" | "runtime" | "promotion";
  title: string;
  body: string;
  status: NotificationStatus;
  target: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  error?: string;
}

// Status of an email watcher. "ok" = polling normally; "error" = the last
// poll failed (lastError carries a scrubbed message); "needs_auth" = the
// `gws` session is signed out, so we skip polling until the user re-auths.
export type EmailWatcherStatus = "ok" | "error" | "needs_auth";

// A durable per-(account, sender-query) email watcher. Each watcher is driven by
// a backing scheduled job whose `skill-script` pre-run hook runs the gmail-watch
// detection script — it polls `gws` for new matching mail and, on a match, wakes
// an agent turn in the watcher's dedicated chat session. The detection cursor +
// dedup state live on the backing JobRecord.hookState (not here); this record is
// the durable config. The data model is multi-account-SHAPED (provider +
// accountEmail + credentialName) but v1 watches the single signed-in `gws`
// identity. See ADR email-watch.md.
export interface EmailWatcherRecord {
  id: string;
  instance: Instance;
  // Owning agent — the woken turn runs under this agent so its inbox and
  // memory attribution stay isolated. Optional only for legacy/hand-edited
  // rows; create always stamps it.
  agentId?: string;
  provider: "gmail";
  // The watched account's address. Resolved at rebuild to the account whose gws
  // config dir detection targets (the single registered+signed-in account when
  // unset). The detection script polls exactly this account's inbox via that
  // account's configDir; see ADR email-watch.md.
  accountEmail?: string;
  // A visible warning when the watcher's accountEmail can't be resolved to a
  // registered Google account at rebuild — detection then falls back to the
  // default gws config dir (it may be watching the wrong inbox), so the mismatch
  // is surfaced here instead of silently watching the wrong account. Cleared once
  // the account resolves. Not derived from the backing job's hookState (unlike
  // status/lastError), so a detection tick never clobbers it.
  accountWarning?: string;
  // Forward-looking per-account credential handle. Unused in v1 (gws holds
  // one identity); recorded so the multi-account phase has a stable key.
  credentialName?: string;
  // Gmail search query the worker polls (e.g. "from:alice@x.com").
  query: string;
  // The explicitly watched sender address (set when the watcher was created via
  // the `sender` input, not a raw query). The detection script bypasses the
  // automated-sender heuristic for mail from EXACTLY this address (the user
  // asked for it by name — e.g. noreply@ups.com must fire); self is still
  // always dropped. Raw-query watches have no single sender and keep the
  // heuristic.
  sender?: string;
  // The user's standing instructions for this watch ("get a refund or a
  // replacement", "keep responding until resolved"), distilled from the goal
  // the user stated at setup (revisable via update). Injected by the
  // detection script as a TRUSTED context item on ticks where this watch
  // matches, so the drafting turn knows what the reply should achieve.
  // Validated at write time (trimmed, capped); never sourced from email
  // content.
  objective?: string;
  // Gmail thread id for a THREAD-KEYED watch ("watch this conversation").
  // Ticket systems rotate sending addresses (support@x.com replies arrive
  // from case-123@x.zendesk.com), so the thread — not a sender query — is the
  // durable unit. Mode is derived: threadId set => thread watch (this field
  // is authoritative for detection; `query` holds a human-readable
  // `thread:<id>` label only); unset => query watch.
  threadId?: string;
  // Thread watches only: when the thread's last message is the user's own and
  // older than this many hours, the detection script nudges a turn to draft a
  // polite follow-up (exactly once per outbound message — the nudged message
  // id is pinned in the watch state). Validated: positive number, rejected on
  // query watches.
  followUpAfterHours?: number;
  // Optional Gmail label ids to scope the query. Unused in v1.
  labelIds?: string[];
  // Dedicated chat session the woken turn posts its proposed reply into.
  // Shared across an agent's watchers in the legacy single-channel model; kept
  // for back-compat (a watcher with no `channelId` falls back to this).
  chatSessionId?: string;
  // This concern's OWN channel — where the fan-out scheduler dispatches THIS
  // watcher's drafting turn (one routed worker per non-empty detection bucket).
  // Provisioned on add (and backfilled once by the channel migration); a watcher
  // without it routes to the shared `chatSessionId`. See ADR email-watch.md.
  channelId?: string;
  // Optional system-prompt persona for this concern's drafting worker, layered
  // over the shared playbook (e.g. a tone/role for one watch). Drives the routed
  // worker's systemPrompt; unset => the shared playbook only.
  persona?: string;
  // Optional toolset whitelist for this concern's drafting worker (constrains
  // the routed subagent). Unset => the worker's default toolset.
  toolsets?: string[];
  // Backing scheduled job that drives this watcher (interval-driven cron job
  // with a `skill-script` preRunHook bound to `chatSessionId`). The job is the
  // scheduler; the watcher is the durable detection identity. Optional only for
  // legacy/hand-edited rows; the startup backfill provisions a job for any
  // enabled watcher missing a resolvable jobId. See ADR job-pre-run-hooks.md.
  jobId?: string;
  enabled: boolean;
  status: EmailWatcherStatus;
  // Scrubbed last-error message when status === "error".
  lastError?: string;
  lastPolledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  instance: Instance;
  at: string;
  actor: "user" | "runtime" | "agent" | "system";
  action: string;
  target: string;
  risk: RiskLevel;
  taskId?: string;
  runId?: string;
  approvalId?: string;
  evidence?: Record<string, unknown>;
  // Originating agent. Optional and meaningful: when undefined, the
  // audit is "system-attributed" (instance-level config, integration
  // health, legacy entries). Audits are never back-filled — missing
  // agentId is preserved as a first-class signal that the row is
  // system-attributed.
  agentId?: string;
  // When true, `evidence` is dropped at the addAudit boundary and the
  // mirrored RuntimeEvent inherits the same redaction. The row remains
  // visible (action, target, actor, timestamp preserved) so reviewers
  // can see that the event happened; the payload bytes are not stored.
  // Use for any audit whose evidence would carry credentials, OAuth
  // tokens, raw keystrokes, or other material that must not land in
  // state.json or stream out through the activity feed.
  redacted?: boolean;
}

// Agent-actor gate: the user approves or denies; the runtime then performs
// the side-effecting action. See docs/adr/authorization-vs-setup-request.md.
export type AuthorizationAction =
  | "file.write"
  | "file.patch"
  | "terminal.exec"
  | "memory.activate"
  | "skill.enable"
  | "connector.enable"
  | "browser.upload_file"
  | "browser.download"
  | "messaging.send"
  // skill_run on a script the skill declares under
  // `metadata.gini.requires.approval` — ALWAYS gated, regardless of
  // approval mode. See ADR skill-script-approval-gating.md.
  | "skill.run"
  | "self.config";

export interface Authorization {
  id: string;
  instance: Instance;
  // Requesting agent. Optional — backfilled by normalizeState; system-driven
  // authorizations without an active agent leave it undefined.
  agentId?: string;
  status: AuthorizationStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  action: AuthorizationAction;
  target: string;
  risk: RiskLevel;
  reason: string;
  payload: Record<string, unknown>;
}

// User-actor gate: the user performs a setup step (sign in via browser,
// enter credentials, fill a form, or confirm a messaging side effect). The
// runtime resumes after the user signals completion via the
// /setup-requests/:id/complete endpoint.
//
// The messaging.* actions (add_bridge, approve_pairing, remove_bridge) are
// connect-only: their side effect (addMessagingBridge / allowChat /
// removeMessagingBridge) runs inside the /complete handler AFTER the row is
// atomically claimed pending → completed — the same claim-first ordering as
// connector.request's create+probe. browser.connect also claims first now:
// /complete claims the row, then writes the audit row / tears down the
// screencast bridge. See SETUP_COMPLETE_EMITS_WORKING_PHASE in src/agent.ts.
// They carry no approve/deny semantics, so they live here rather than on
// AuthorizationAction.
export type SetupRequestAction =
  | "browser.connect"
  | "connector.request"
  | "browser.fill_secret"
  | "skill.grant_connector"
  | "messaging.add_bridge"
  | "messaging.approve_pairing"
  | "messaging.remove_bridge"
  // chat.choice — the ask_user tool's question. The payload carries
  // { question, options: [{label, description?}], toolCallId }; every new
  // mint has 2-6 options (the dispatcher rejects option-less calls), but
  // historical rows may carry an empty array — those answer through the
  // freeform shape or a plain message post. /complete resolves with the
  // user's pick ({choice:{label}} for a listed option, {choice:{other}} for
  // the freeform answer) and /cancel is the Skip affordance, which resumes
  // the loop with a skip fallback rather than failing the task. See
  // docs/adr/user-choice-prompt.md.
  | "chat.choice"
  // confirmation.request — the request_confirmation tool's inline
  // Confirm/Cancel card. The agent calls it before an irreversible action
  // that goes to another person (send/reply a message, post a reply in a web
  // app, submit/purchase on the user's behalf). The payload carries
  // { summary, details?, confirmLabel, toolCallId }; /complete resumes the
  // loop with tool result {confirmed:true} and /cancel resumes with
  // {confirmed:false} — never a "skip" string, so the model gets an
  // unambiguous boolean. Like chat.choice it is a SetupRequest, so it pauses
  // the task even under approvalMode "yolo". See
  // docs/adr/user-confirmation-primitive.md.
  | "confirmation.request";

export interface SetupRequest {
  id: string;
  instance: Instance;
  // Requesting agent. Optional — backfilled by normalizeState; system-driven
  // setup requests without an active agent leave it undefined.
  agentId?: string;
  status: SetupRequestStatus;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  action: SetupRequestAction;
  // Trust anchor shown to the user before they complete the request: the
  // destination URL for browser.connect / browser.fill_secret, the provider
  // id for connector.request (or the credential `name` for a templateless
  // typed-credential request, which carries no registered provider), or the
  // bridge kind / id for the messaging.* actions.
  //
  // For connector.request the payload is one of two shapes. Known-provider:
  // {provider, providerLabel, providerDescription, fields, reason, toolCallId}.
  // Templateless typed credential (no registered provider): {credentialName,
  // credentialType ("api-key" only — templateless oauth2 is rejected because it
  // needs a provider module / setup skill), credentialLabel, mcpUrl?, reason,
  // toolCallId}. Either shape may also carry {skillId} — when set, completing
  // the request both stores the credential AND grants it to that skill — plus
  // {credentialSkillName}, the server-resolved name of that skill for the card
  // to display.
  target: string;
  // Human-language ask shown to the user in the chat card.
  reason: string;
  payload: Record<string, unknown>;
  // Set by the messaging.* /complete handlers (add_bridge, approve_pairing,
  // remove_bridge) after the post-completion side effect runs, AND by the
  // connector.request /complete handler on a terminal failure (probe failure
  // or a post-claim throw). `ok: true` means the side effect succeeded (bridge
  // created, pairing approved, etc.); `ok: false` plus `message` carries the
  // sanitized failure reason. connector.request persists this ONLY on failure
  // — a successful create + grant leaves the completed row with no outcome, so
  // a completed connector.request row with no outcome IS the success case.
  // The chat card reads this as the source of truth for the past-tense
  // summary after reload — React-component-local sticky state is cleared on
  // reload, so without a persisted outcome a failed side effect on a
  // status="completed" row would fall back to rendering as success.
  // browser.fill_secret could adopt the same field; today it only tracks
  // success via the request status because its failure modes bounce the
  // request pending state instead of completing + failing.
  connectOutcome?: { ok: boolean; message?: string };
}

export interface SkillRecord {
  id: string;
  instance: Instance;
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  requiredTools: string[];
  requiredPermissions: string[];
  status: SkillStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  sourceTaskId?: string;
  tests: string[];
  successCount: number;
  failureCount: number;
  previousVersions: SkillVersion[];
  // Filesystem-loaded skills carry their full markdown body (the part of the
  // SKILL.md file after the YAML frontmatter). Legacy CRUD-created skills
  // default to "" — present-but-empty so callers can rely on the field being
  // a string. The body is what gets fed back to the model when it asks to
  // "read" the skill via the read_skill tool.
  body: string;
  // Origin file path (absolute) for skills loaded from disk. Useful for
  // traceability and re-load detection. Optional because legacy
  // user-CRUD-authored skills don't have a source file.
  manifestPath?: string;
  // Parent directory name for filesystem-loaded skills (e.g. "apple" for
  // skills/apple/apple-notes/SKILL.md). Used as a UI grouping hint.
  category?: string;
  // Frontmatter `platforms` list (e.g. ["macos"]). Skills are skipped at
  // load time when the host platform isn't in this list.
  platforms?: string[];
  // Frontmatter `prerequisites`. We keep `commands` and `env` as strings —
  // strings the LLM can later inspect or check via terminal_exec.
  prerequisites?: { commands?: string[]; env?: string[] };
  // Frontmatter `metadata.gini.requires.connectors` — declares which provider
  // ids (and optionally scopes) the skill needs to function. The runtime
  // gates the skill out of the agent loop's available-skills set until every
  // entry matches a healthy ConnectorRecord. Defaults to [].
  // Migration source for `requiredCredentials`; kept one release.
  requiredConnectors?: Array<{ provider: string; scopes?: string[] }>;
  // Frontmatter `metadata.gini.requires.credentials` — credential NAMES the
  // skill needs to function (e.g. ["LINEAR_API_KEY"] or
  // ["google-workspace-oauth"]). The runtime gates the skill out of the agent
  // loop's available-skills set until every name matches a configured+healthy
  // ConnectorRecord with that `name`, and resolveSkillEnv resolves the skill's
  // prerequisites.env from those named credentials. Defaults to [].
  requiredCredentials?: string[];
  // Frontmatter `metadata.gini.requires.approval` — script names (the
  // skill_run `script` arg) that always pause for an explicit user
  // Approve/Deny before running, regardless of approval mode. Only the
  // skill_run dispatch path enforces this; internal invokeSkillScript
  // callers (pre-run hooks, the approved-action executor) are unaffected.
  // See ADR skill-script-approval-gating.md.
  requiresApprovalScripts?: string[];
  // Per-(skill, connector) consent: the credential NAMES the user has granted
  // this skill access to (the field name is kept for back-compat; the contents
  // are now names, not provider strings). `resolveSkillEnv` injects a named
  // credential's env only when that name is granted here (or the skill is
  // `source:"bundled"`, which is auto-granted by short-circuit). Cleared on
  // disable so re-enabling re-prompts. See docs/adr/skill-connector-consent.md.
  grantedConnectors?: string[];
  // Spec-compliant top-level `allowed-tools` declaration (space-separated in
  // the source frontmatter, normalized to the original string here). Stored
  // so the UI and install-skill flow can surface it; not enforced yet.
  allowedTools?: string;
  // Spec-compliant top-level `license` and `compatibility` fields.
  license?: string;
  compatibility?: string;
  // Author-declared semver from SKILL.md frontmatter (`metadata.gini.version`,
  // legacy top-level `version`). Distinct from `SkillRecord.version` which is
  // an internal monotonic counter incremented on every detected change. UIs
  // should display this field; the runtime counter is for change detection
  // and `previousVersions` history.
  manifestVersion?: string;
  // Set when the skill fails frontmatter or spec validation (unknown
  // provider, bad name format, etc.). When present, the skill never reaches
  // the activation gate.
  validationStatus?: "ok" | "unsupported";
  validationMessage?: string;
  // Origin of the loaded skill: "bundled" for vendored repo skills (under
  // <repo>/skills/), "user" for skills under ~/.gini/instances/<inst>/skills/.
  // Used by the loader to keep bundled and user records separate. Defaults
  // to "user" for legacy records via normalizeState so older state files keep
  // loading.
  source?: "bundled" | "user";
}

export interface SkillVersion {
  version: number;
  updatedAt: string;
  description: string;
  trigger: string;
  steps: string[];
  requiredTools: string[];
  requiredPermissions: string[];
}

// A fan-out destination for one routed hook bucket (see ADR job-pre-run-hooks.md
// and the concern fan-out design). When a pre-run hook returns ROUTED buckets
// (keyed by an opaque routeKey), the scheduler dispatches ONE worker turn per
// non-empty bucket into the route resolved from `JobRecord.routes[routeKey]`.
// Domain-agnostic: the routeKey -> destination mapping is trusted, typed config
// here, never derived from the (untrusted) handler output. All fields except
// `chatSessionId` are optional and constrain the spawned worker:
//   - `systemPrompt`/`toolsets`/`skills` constrain the per-route subagent worker
//     (objective + playbook + whitelist), exactly like a spawn_subagent call.
//   - `prompt`, when set, replaces `job.prompt` for this route's worker.
// Absent `routes` on a job ⇒ today's single-turn behavior.
export interface JobRoute {
  chatSessionId: string;
  systemPrompt?: string;
  toolsets?: string[];
  skills?: string[];
  prompt?: string;
}

// How a job's terminal-run reply fans out (finalizeJobRunFromTask,
// src/jobs/finalize.ts):
//   - "always": deliver every reply — the [SILENT] sentinel still suppresses
//     when the model emits it. This is the pre-policy behavior; existing jobs
//     are defaulted to it once (migrations.jobsDeliveryPolicyDefaulted).
//   - "on_findings": watch-style — the cron hint invites the model to reply
//     [SILENT] when there is nothing new, so only real findings deliver. The
//     hint is injected ONLY under this policy; the suppression machinery is
//     policy-independent.
//   - "silent": never deliver — the run's output stays in the job's working
//     thread (minted headless), and the job surfaces findings by spawning
//     keyed child tasks instead of reporting. Rejected on oneShot reminders
//     (a reminder that delivers nothing is a no-op).
export type JobDeliveryPolicy = "always" | "on_findings" | "silent";

export interface JobRecord {
  id: string;
  instance: Instance;
  // Owning agent. Optional — legacy state files predate this field;
  // normalizeState backfills it on load.
  agentId?: string;
  name: string;
  prompt: string;
  script?: string;
  // Pre-LLM hook. When set, runDueJobs/runJobNow run this BEFORE dispatching
  // the model turn. Its typed result either short-circuits the run (no model
  // turn), injects fenced untrusted context into the drafting turn, or fails
  // the run. The shape is the hooks primitive's HookConfig; an inline import
  // type keeps the dependency one-directional (the primitive imports
  // RuntimeConfig from here, never the reverse). See ADR job-pre-run-hooks.md.
  preRunHook?: import("./hooks").HookConfig;
  // Job-owned hook state. A pure hook handler (the skill-script handler running a
  // pure detection script) is a function of {config, hookState} -> {result,
  // newState}; the scheduler threads this blob in as the run's input and persists
  // the handler's newState back here at the at-least-once commit boundary (a
  // shortCircuit persists immediately; a context result persists only AFTER the
  // drafting turn dispatches). Opaque to the runtime — its shape is owned by the
  // handler/script (e.g. the gmail-watch cursor + a small boundary dedup set).
  // See ADR job-pre-run-hooks.md.
  hookState?: Record<string, unknown>;
  // Fan-out routing table for a routed pre-run hook. Maps each hook routeKey to a
  // JobRoute (where/how to dispatch that bucket's worker). When a pre-run hook
  // returns ROUTED buckets, the scheduler spawns one worker per non-empty bucket
  // into `routes[routeKey]`. Absent ⇒ today's single-turn behavior (one turn into
  // `chatSessionId`). Domain-agnostic; the email layer populates this from its
  // per-concern channels. See ADR job-pre-run-hooks.md.
  routes?: Record<string, JobRoute>;
  // Interval-driven schedule. Optional — cron-driven jobs (cronExpression
  // set) carry no intervalSeconds at all. Exactly one of (intervalSeconds,
  // cronExpression) is the active driver per job. The pair is validated
  // at create/update time; the scheduler picks the appropriate advance
  // helper based on which field is set.
  intervalSeconds?: number;
  status: JobStatus;
  deliveryTargets: string[];
  context: string[];
  // Skill attachments: names of enabled skills whose full bodies are inlined
  // into every fire's dispatched prompt, so each run follows the skill's
  // recipe deterministically instead of relying on the model calling
  // read_skill. Validated at create/update time (every name must resolve to
  // an enabled skill); a skill that has gone missing/disabled/inactive by
  // fire time is skipped with a trace event — never fails the fire. See ADR
  // job-skill-attachments.md.
  skillNames?: string[];
  // Routine-template provenance: the catalog id this job was installed from
  // (the /routines gallery or the onboarding starter routines, both via
  // src/runtime/routine-templates.ts). The gallery keys installed state and
  // per-template replace/remove on it. Optional — ordinary jobs carry no
  // templateId, so no state migration. See ADR routine-templates-gallery.md.
  templateId?: string;
  // Resolved option state the template was installed with (template defaults
  // merged with the caller's overrides), stamped by the catalog's buildSpec
  // alongside templateId so the gallery's Settings view can render the
  // current selection. Absent on ordinary jobs and on templates without
  // options; optional, so no state migration.
  templateOptions?: Record<string, boolean>;
  retryLimit: number;
  timeoutSeconds: number;
  costBudget?: number;
  // Optional originating chat session for jobs scheduled by the agent via
  // the `create_job` tool. When set, each scheduled task is linked back to
  // this session (session.taskIds/runIds) and its final summary is synced
  // as an assistant chat message. Backwards-compatible: legacy jobs without
  // this field keep their existing imperative delivery semantics.
  chatSessionId?: string;
  // Forward-to-Chat flag (ADR chat-topics-tasks-subagents.md, "Jobs →
  // Topics"). A job ALWAYS runs in its own dedicated Topic (the
  // `kind:"channel"`, `origin:"job"` session pointed at by `chatSessionId`).
  // When `forwardToChat` is true, each fire additionally FORWARDS its final
  // answer into the owning agent's Chat (the `kind:"agent"` session) as a
  // render-only block tagged with the job's Topic — instead of burying the
  // job's reports inside the user's conversation. This is the new shape of
  // "deliver to chat": the originating `deliverTo:"chat"` choice flips this
  // flag rather than re-pointing `chatSessionId` at the user's conversation.
  // Absent/false ⇒ channel-only delivery (the Topic is the only surface).
  forwardToChat?: boolean;
  // One-shot reminder semantics: when true the job is auto-paused after its
  // first terminal run (success or fail). The user can resume manually
  // through /jobs. Defaults to undefined/false (recurring behavior).
  oneShot?: boolean;
  // Terminal-run delivery fan-out policy (see JobDeliveryPolicy). Optional —
  // absent reads as "always" (records predating the field, or a hand-edited
  // state file restored after the one-time default migration ran).
  deliveryPolicy?: JobDeliveryPolicy;
  // Per-job auto-approve envelope (see ADR approval-mode.md, "Per-job
  // scope"). When the agent's `create_job` tool schedules an unattended
  // job, it can opt into approval-bypass for just that job's spawned
  // tasks without touching the operator's global RuntimeConfig. All
  // three fields are optional; absent means the job inherits the
  // per-instance RuntimeConfig behavior at fire-time.
  //
  // - `autoApproveCommands` are merged onto the cloned RuntimeConfig at
  //   job-fire time and matched against terminal commands via the same
  //   `matchAutoApprove` allowlist path. Each match produces an audit
  //   row with `evidence.autoApproved=true, autoApprovedReason=<matched
  //   pattern>`.
  // - `approvalMode`, when set, replaces the cloned config's mode for
  //   this job's spawned task only. `"yolo"` is the equivalent of the
  //   legacy `dangerouslyAutoApprove: true`.
  // - `dangerouslyAutoApprove`, when true, is a deprecated alias for
  //   `approvalMode: "yolo"`. Accepted on both create and at fire-time
  //   for back-compat with persisted job records and the `create_job`
  //   tool spec.
  // - `dangerousTerminalPatterns`, when set, overlays onto the cloned
  //   config's blocklist for this job's spawned task only.
  autoApproveCommands?: string[];
  approvalMode?: ApprovalMode;
  dangerousTerminalPatterns?: string[];
  dangerouslyAutoApprove?: boolean;
  // Wall-clock scheduling: when set, this 5-field Unix cron expression
  // drives the job's nextRunAt instead of `intervalSeconds`. Exactly one
  // of (intervalSeconds, cronExpression) is the active driver per job;
  // `createScheduledJob` rejects payloads that supply both explicitly.
  // Cron-driven jobs leave `intervalSeconds` undefined (no sentinel).
  // Legacy state files with `{intervalSeconds: 0, cronExpression: "..."}`
  // are normalized on load (see store.ts normalizer).
  cronExpression?: string;
  // IANA timezone identifier (e.g. "America/Los_Angeles", "Europe/Berlin").
  // Resolved at create time — defaults to "UTC" when `cronExpression` is
  // set but `cronTimezone` is omitted. Croner validates the identifier on
  // construction; an unknown TZ surfaces as `Invalid input: cronTimezone …`.
  cronTimezone?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  runCount: number;
  missedRuns: number;
  taskIds: string[];
  runIds: string[];
}

export interface JobRunRecord {
  id: string;
  instance: Instance;
  // Owning agent. Optional — inherits from the parent job at creation time;
  // backfilled by normalizeState for legacy state files.
  agentId?: string;
  jobId: string;
  status: JobRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  attempt: number;
  trigger: "schedule" | "manual" | "replay";
  summary?: string;
  error?: string;
  cost?: CostRecord;
  // Skill attachments that were SKIPPED at fire time (a name that resolved at
  // create time but had gone missing/disabled/inactive by the time the run
  // dispatched). Durable + structured so /api/job-runs surfaces the
  // degradation, the model is told (in-prompt directive) not to fabricate
  // results that need the missing recipe, and the delivery surfaces (chat
  // system_note + bridge note) name it. Absent when nothing was skipped. See
  // ADR job-skill-attachments.md ("Surfacing skips").
  skillSkips?: Array<{ name: string; reason: string }>;
}

export interface CostRecord {
  provider: ProviderName | string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
}

// What kind of work spent the tokens. Kept deliberately small so the usage
// chart can segment by it; finer-grained call sites (memory retain vs reflect,
// vision_query vs browser_vision) collapse into one bucket here.
export type UsageSource =
  | "chat"
  | "job"
  | "subagent"
  | "memory"
  | "chat-title"
  | "chat-route"
  | "vision"
  | "aux"
  | "imperative"
  | "other";

// Attribution passed by a caller into a generative provider entry point so the
// usage ledger can tag the recorded spend. Only `source` is required; the ids
// enable per-agent/-task/-job breakdowns. A call site that passes no context at
// all is simply not recorded (keeps existing callers/tests side-effect free).
export interface UsageContext {
  source: UsageSource;
  agentId?: string;
  taskId?: string;
  jobId?: string;
  subagentId?: string;
}

// One durable, append-rolled-up usage bucket. Keyed by (day, source, agentId,
// provider, model); recordUsage sums token counts, USD, and call count into the
// matching bucket. `day` is a local-calendar YYYY-MM-DD so the home chart reads
// pre-bucketed server-authoritative daily totals that survive task pruning.
export interface UsageLedgerEntry {
  day: string;
  source: UsageSource;
  agentId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  calls: number;
}

export interface ConnectorSecretRef {
  purpose: string;
  path: string;
}

export interface ConnectorRecord {
  id: string;
  instance: Instance;
  name: string;
  // Discriminator: identifies which provider module handles this connector
  // ("demo", "linear", "claude-code", "codex", "generic", or any module id
  // in the registry). Renamed from `kind` in ADR connector-provider-spec-compliance.md.
  provider: string;
  // Credential type. Skills and MCP rows reference credentials BY NAME, and
  // `type` says how the name resolves to env vars:
  //   - "api-key": a single secret whose env var IS the credential `name`
  //     (uppercase env-token, e.g. LINEAR_API_KEY). Optional
  //     `metadata.mcp` powers MCP registration with
  //     `Authorization: Bearer ${<name>}`.
  //   - "oauth2": a named handle (may be kebab, e.g. google-workspace-oauth)
  //     whose fields materialize as env vars via `metadata.envMap`
  //     (purpose → ENV_NAME).
  // Optional: presence-only providers (demo/claude-code/codex) carry no env
  // and stay untyped. The state migration stamps a type on every legacy
  // provider-keyed record at boot, so all credentialed records are typed.
  type?: "api-key" | "oauth2";
  status: "configured" | "disabled" | "error";
  scopes: string[];
  secretRefs: ConnectorSecretRef[];
  createdAt: string;
  updatedAt: string;
  lastHealthAt?: string;
  health: "unknown" | "healthy" | "unhealthy";
  message?: string;
  // Free-form per-record metadata. The `generic` provider uses this to
  // persist non-secret dynamic fields (base URLs, account ids, …) that the
  // user supplies in the Add Connector dialog. Provider-specific keys live
  // under a nested namespace (e.g. `metadata.fields`) by convention.
  //
  // Two typed-credential keys live here by convention:
  //   - `mcp`: present on api-key credentials that back an HTTP MCP server.
  //     Drives MCP registration and the header
  //     `{[headerName ?? "Authorization"]: "<scheme ?? Bearer> ${<name>}"}`.
  //     The server row is named by `mcp.name` when set, else the credential
  //     name. `mcp.name` lets a credential own a differently-named row — e.g.
  //     the LINEAR_API_KEY credential drives the "linear" MCP server that
  //     skills reference as `server: "linear"`.
  //   - `envMap`: present on oauth2 credentials, mapping each secret purpose
  //     to the ENV_NAME the runtime injects for it (e.g.
  //     `{ client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID" }`).
  metadata?: Record<string, unknown> & {
    mcp?: { url: string; name?: string; headerName?: string; scheme?: string };
    envMap?: Record<string, string>;
  };
  // Origin marker: "auto" for connectors materialized by the startup
  // detection job (claude-code, codex on PATH); "user" for connectors
  // created via the Add Connector dialog or `gini connector add`. Drives
  // delete semantics — auto records tombstone (status: "disabled") so the
  // detection job won't immediately re-create them, while user records
  // physically delete. Defaults to "user" via normalizeState for legacy
  // records that pre-date this field.
  source?: "auto" | "user";
  // Transient, API-enrichment-only. Never persisted to state — GET
  // /api/connectors attaches it to google-oauth-desktop records from
  // `gws auth status` so clients can show Google sign-in liveness
  // separately from the connector's provisioning `health`. See
  // src/integrations/connectors/gws-session.ts.
  session?: {
    installed: boolean;
    clientConfigured: boolean;
    signedIn: boolean;
    // Per-service grant derived from the session's OAuth scopes, keyed by the
    // google-* skill suffix (calendar, gmail, drive, docs, sheets, forms,
    // meet). A user who consents to only some services on Google's screen is
    // signedIn:true but has only those keys true — so dependent rows reflect
    // their own scope instead of all lighting up.
    services?: Record<string, boolean>;
    message: string;
  };
  // Transient, API-enrichment-only. Never persisted to state — GET
  // /api/connectors attaches the machine-global tagged Google accounts
  // (each with live `gws auth status` per its config dir) to
  // google-oauth-desktop records, alongside `session`, so clients can
  // show the connected accounts. The accounts registry itself lives
  // machine-globally under ~/.gini/google-accounts (src/state/google-accounts.ts);
  // the connector keeps holding only the OAuth *client* creds.
  accounts?: GoogleAccountStatus[];
}

// A tagged Google account in the machine-global registry. Account identity ==
// its `gws` config dir (GOOGLE_WORKSPACE_CLI_CONFIG_DIR); one OAuth client can
// authorize many accounts (each its own config dir). Persisted under
// ~/.gini/google-accounts/accounts.json. See src/state/google-accounts.ts.
export interface GoogleAccount {
  id: string;          // stable slug, e.g. "gacct_<rand>"
  tag: string;         // user label: "personal" | "work" | "school" | ... (mutable; retaggable)
  email: string;       // signed-in email from `gws auth status` .user ("" until known)
  configDir: string;   // absolute path to this account's gws config dir
  addedAt: string;     // ISO
  // Immutable provenance: true only for an account minted by the relay-provisioned
  // grant path (registerAccount with trusted:true). Lets that path re-find ITS
  // account idempotently without keying off the mutable display tag — so a user
  // retagging it, or independently tagging another account "workspace", never
  // redirects or clobbers the provisioned credential. Absent ⇒ user/manual account.
  provisioned?: boolean;
  // The relay/Google principal (the OAuth subject id, relay Session.account) the
  // provisioned credential belongs to. Set only alongside `provisioned`. Re-find
  // matches on this, so two different identities provisioned on one machine
  // (e.g. distinct instances) each keep their OWN dir instead of one clobbering
  // the other's credential. Absent ⇒ user/manual account.
  principal?: string;
}

// A registry account enriched with its live `gws auth status` (per config dir).
// `services` mirrors the connector `session.services` shape — keyed by the
// google-* skill suffix (calendar, gmail, drive, docs, sheets, forms, meet) —
// and is typed as Record<string, boolean> rather than importing GwsService from
// the connectors layer so this foundational types module stays import-free.
export interface GoogleAccountStatus extends GoogleAccount {
  signedIn: boolean;
  // True when the account's gws token was actively revoked (reauth required),
  // carried from the live `gws auth status` probe. Consumers check
  // `x.tokenRevoked === true`.
  tokenRevoked?: boolean;
  services: Record<string, boolean>;
  message: string;
  // True on exactly one row: the effective primary account (the persisted
  // primaryAccountId when it still names a registered account, else the
  // first provisioned row, else the first row). Server-resolved so every
  // client agrees on which account is "the" account.
  primary?: boolean;
}

// Web onboarding record (ADR web-onboarding-flow.md). Persisted per-instance
// at ~/.gini/instances/<instance>/onboarding.json (src/state/onboarding.ts) —
// deliberately NOT part of state.json. The profile is what the Gmail scan
// task distills from the user's recent inbox; the web renders it verbatim.

export interface OnboardingProfileSection {
  title: string;        // e.g. "Professional Identity", "Key Contacts Sample"
  bullets?: string[];   // bullet lines
  note?: string;        // muted paragraph (used by e.g. Key Contacts Sample)
}

export interface OnboardingProfile {
  displayName: string;  // e.g. "Alex Chen (legal name: Alexander Chen)"
  sections: OnboardingProfileSection[];
}

export type OnboardingScanStatus = "idle" | "running" | "ready" | "failed" | "no_account";

// The Gmail profile scan's lifecycle. The deterministic in-runtime pipeline
// (src/runtime/onboarding-scan.ts) runs in the background while `status ===
// "running"`; on completion it writes `profile`/`suggestedTasks` (ready) or
// `error` (failed) and pushes an `onboarding` event so the browser refetches.
export interface OnboardingScan {
  status: OnboardingScanStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  profile?: OnboardingProfile;
  suggestedTasks?: string[];
}

export interface OnboardingRecord {
  version: 1;
  completed: boolean;
  completedAt?: string;
  timezone?: string;              // IANA
  theme?: "light" | "dark";
  scan: OnboardingScan;
  routineJobIds: string[];        // jobs created by the routines step (for idempotent replace)
}

export interface ImprovementProposal {
  id: string;
  instance: Instance;
  kind: ImprovementKind;
  status: ImprovementStatus;
  title: string;
  rationale: string;
  sourceTaskId?: string;
  sourceTraceIds: string[];
  payload: Record<string, unknown>;
  appliedTargetId?: string;
  // Set when this proposal has been surfaced in a skill-review digest, so it is
  // never re-posted. A per-item flag (not a timestamp watermark) is collision-free.
  digestedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Skill-learning signal & finding types (ADR skill-learning-from-outcomes.md).

export type OutcomeSignal = "success" | "failure";
// Where the row came from: "objective" rows are harvested from already-
// persisted audit/trace at task terminal (free, high-confidence-negative);
// "user_feedback" rows carry a human verdict captured via record_skill_feedback.
export type OutcomeSource = "objective" | "user_feedback";
// How the reflection pass classifies a failure batch. Only `skill_defect`
// routes to a skill edit; the rest become findings or are dropped.
export type DefectClass =
  | "skill_defect"
  | "environment"
  | "credential"
  | "model_ignored"
  | "transient"
  | "unknown";

// One row per attributable run outcome. Attribution is via the
// `skill.script.invoked` audit row (`target: skill.id`); a `failed` task with
// no script invocation yields one unattributed (`skillId` unset) failure row
// for the digest's "what didn't work" summary only.
export interface SkillOutcome {
  id: string;
  instance: Instance;
  taskId: string;
  agentId?: string;
  skillId?: string;
  skillName?: string;
  scriptName?: string;
  signal: OutcomeSignal;
  source: OutcomeSource;
  exitCode?: number;
  // Scrubbed (redactSecrets) and capped failure detail. Absent for successes.
  errorDetail?: string;
  // True when the attributed skill declares requiredPermissions or the task
  // carried an approval/side-effecting audit row — i.e. the action mattered.
  consequential: boolean;
  // True when an objective signal existed (a script ok/exit, a terminal
  // status) so the outcome could be judged without asking the human.
  selfVerifiable: boolean;
  defectClass?: DefectClass;
  // Whether the reflection judged the failure attributable to the skill itself
  // (vs an environment/credential/model cause). Stamped alongside defectClass
  // when the batch is reviewed; absent until a reflection pass has classified it.
  attributable?: boolean;
  // Set once the reflection pass has consumed this row into a proposal/finding.
  reviewed: boolean;
  // Set once the daily review has asked the user about this (success) outcome.
  feedbackPrompted: boolean;
  createdAt: string;
}

// A non-skill-edit finding surfaced in the digest and via a read-only
// endpoint; never auto-actioned.
export interface LearningFinding {
  id: string;
  instance: Instance;
  agentId?: string;
  skillId?: string;
  skillName?: string;
  kind: "environment" | "credential" | "model_ignored" | "bundled_skill";
  summary: string;
  sourceTaskIds: string[];
  status: "open" | "dismissed";
  // Set when this finding has been surfaced in a skill-review digest, so it is
  // never re-posted (collision-free per-item flag, not a timestamp watermark).
  digestedAt?: string;
  createdAt: string;
}

// A bounded edit to a skill's markdown body (SkillOpt-style). Anchors/targets
// match as EXACT substrings; a no-match is recorded as skipped, never thrown.
export type SkillEditOp =
  | { op: "append"; content: string }
  | { op: "insert_after"; anchor: string; content: string }
  | { op: "replace"; target: string; content: string }
  | { op: "delete"; target: string };

export interface PromotionProposal {
  id: string;
  instance: Instance;
  status: PromotionStatus;
  candidateRef: string;
  evidencePath?: string;
  summary: string;
  rollbackPlan: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface SnapshotRecord {
  id: string;
  instance: Instance;
  path: string;
  reason: string;
  createdAt: string;
  taskCount: number;
  auditCount: number;
}

export interface ProviderHealth {
  ok: boolean;
  provider: ProviderConfig;
  configured: boolean;
  authPath?: string;
  credentialType?: string;
  message?: string;
}

export interface ActiveAgentSnapshot {
  id: string;
  name: string;
  resolvedProvider: { name: string; model: string };
  providerSource: "agent" | "instance";
  toolsetFilter?: string[];
  messagingTargetFilter?: string[];
  // Phase C: the per-agent memory isolation key. Same as `id` today, but
  // surfaced explicitly so clients can see the namespace without
  // re-deriving the bank id or guessing how memory is scoped.
  memoryNamespace: string;
  warnings: string[];
}

export interface RuntimeStatus {
  ok: boolean;
  instance: Instance;
  port: number;
  stateRoot: string;
  workspaceRoot?: string;
  pid?: number;
  taskCounts: Record<TaskStatus, number>;
  pendingApprovals: number;
  activeJobs: number;
  missedJobs: number;
  connectors: number;
  memoryUnits?: number;
  version?: GiniVersionInfo;
  provider?: ProviderHealth;
  // Set when the selected provider is unconfigured but a configured fallback is
  // transiently serving turns. `selected` is the user's unconfigured choice;
  // `using` is the fallback. The web reads this to show a "finish setup" banner;
  // config.provider is never mutated, so it persists until setup completes.
  providerFallback?: { selected: ProviderName; using: ProviderName };
  activeAgent?: ActiveAgentSnapshot;
}

export interface GiniVersionInfo {
  packageVersion: string;
  runtimeDir: string;
  git: {
    sha: string | null;
    shortSha: string | null;
    branch: string | null;
    origin: string | null;
    upstreamSha: string | null;
    updateAvailable: boolean;
  };
  installedRuntimePresent: boolean;
  update: {
    supported: boolean;
    reason?: string;
  };
}

export interface GiniUpdateResult {
  beforeSha: string;
  afterSha: string;
  commitCount: string;
  upToDate: boolean;
  runtimeDir: string;
  version: GiniVersionInfo;
  restart?: {
    requested: boolean;
  };
}

export interface ProviderResult {
  provider: ProviderConfig;
  text: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}
