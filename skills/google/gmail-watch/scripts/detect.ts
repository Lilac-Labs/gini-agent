#!/usr/bin/env bun
// gmail-watch detection engine — the deterministic email-watch detection floor,
// as a STATELESS, headless skill script (ADR email-watch.md).
//
// Provisioned + trusted: this script is shipped in-tree and run by the generic
// `skill-script` hook handler with no agent turn and no approval. It is the hook
// BODY for the ONE shared email-watch scheduled job (one job + one thread for all
// of an agent's watched senders).
//
// Contract:
//   stdin:  JSON { watches: [{ watcherId, routeKey?, query, account?, configDir? }, ...],
//                  state: { [routeKey]: DetectState } | { byWatcher? } | null }
//   stdout: JSON { kind, buckets?, summary?, state: { [routeKey]: DetectState } }
//   exit:   0 always (a gws/transport / signed-out condition is reported PER WATCH
//           as a status in that watch's state, never a non-zero exit, so the
//           backing job stays alive and the email read path can derive each
//           watcher's displayed status)
//
// Fan-out: each watch carries a `routeKey` (default = watcherId). The result is no
// longer a flat items[] — it's ROUTED buckets keyed by routeKey (only non-empty
// ones), so the generic scheduler spawns one drafting worker per concern into that
// route's own channel. The returned STATE is keyed by routeKey at the TOP LEVEL
// (NOT nested under byWatcher) so the generic per-bucket at-least-once commit can
// partition each concern's cursor independently. A legacy `{ byWatcher }` INPUT is
// still read transparently (the first tick rewrites it flat).
//
// It iterates the watches and, for each, polls `gws` for new matching message ids,
// dedups against that watch's caller-supplied state (cursor + a tiny boundary
// `seen` set), applies a deterministic safety floor (drop automated senders +
// self), and emits the raw metadata (From/Subject/Date/snippet) of each surviving
// NEW match as an untrusted item — and, for the FINAL surviving matches only, the
// extracted message body (so the drafting turn works from the email's content,
// not a re-fetch); seeding/short-circuit ticks and dropped messages stay
// metadata-only. It emits NO fence (the trusted hook runner fences untrusted items). Each watch
// is wrapped in its OWN try/catch so one sender's gws fault marks only that
// watch's status and the others still run. The script is a PURE function of
// {watches, state}: it never touches files or a DB; the new per-watch cursor +
// seen set ride back on the result keyed by watcherId and the caller persists them.

import { spawn } from "bun";

// ── Tunables (ported verbatim from the original delta engine) ────────────────

// Bound the gws spawn. A `messages list` / `messages get` is a single Gmail API
// round-trip — sub-second in practice. Cap it so a wedged child, a slow
// `zsh -lc` profile, or a token-refresh network stall can't pin the tick.
const SPAWN_TIMEOUT_MS = 15_000;

// Cap the draft items collected per tick. A fully-enumerated (non-truncated)
// window is drained oldest-first, but only up to this many matches in a single
// tick; the rest drain over successive ticks as the cursor advances.
const MAX_MESSAGES_PER_TICK = 25;

// Cap the extracted message body included in a match item (chars). Long enough
// to carry a real email's content to the drafting turn without bloating the
// untrusted fence; a truncated body still grounds the reply, and the worker can
// fetch the full thread by id for the rest. Bodies are fetched ONLY for the
// final surviving matches that will be drafted, so this rides the items the
// worker acts on, never the metadata-only detection path.
const MAX_BODY_CHARS = 4000;

// Per-page result size for the paginated window list. Combined with
// WINDOW_PAGE_LIMIT this bounds how much of the window a single tick enumerates.
const WINDOW_PAGE_SIZE = 100;

// Max pages `--page-all` walks per tick. When this cap is hit the window can't be
// enumerated oldest-first (the older tail isn't listed), so detect baselines past
// it rather than draining.
const WINDOW_PAGE_LIMIT = 10;

// ── Types ────────────────────────────────────────────────────────────────────

interface DetectState {
  // Watermark: internalDate (epoch ms, as a string) of the newest processed
  // message. Undefined => seeding (first run).
  cursor?: string;
  // Tiny dedup set: the message ids sharing the cursor's exact epoch second.
  // Gmail's `after:` is second-granular and inclusive, so those ids get
  // re-listed every tick; this set drops them. The `after:` watermark keeps it
  // bounded to one second's worth of mail.
  seen?: string[];
  // Watcher health, carried IN the opaque state blob so the job persists it onto
  // hookState and the email read path can derive the watcher's displayed status
  // from it (the generic skill-script handler can't write watcher state). "ok" =
  // last tick polled cleanly; "needs_auth" = the gws session is signed out;
  // "error" = a gws/transport fault on the last tick.
  status?: "ok" | "needs_auth" | "error";
  // Scrubbed last-error message when status === "error" (cleared on "ok").
  lastError?: string;
  // Thread mode, follow-up-on-silence: the id of OUR last outbound message
  // that has already been nudged — exactly one nudge per outbound message (a
  // newer last message changes the id and resets the cycle naturally).
  lastNudgedForMessageId?: string;
}

interface DetectArgs {
  query: string;
  account?: string;
  // The explicitly watched sender address. Mail from EXACTLY this address
  // bypasses the automated-sender heuristic (the user asked for it by name);
  // self is still always dropped.
  sender?: string;
  // The user's standing instructions for this watch. Validated config from
  // the trusted tool/API channel (same trust level as the job prompt) —
  // emitted as ONE TRUSTED item on ticks where this watch matches, NEVER
  // inside the untrusted fence, and never sourced from email content.
  objective?: string;
  // Thread mode: watch this Gmail conversation by thread id (authoritative
  // for detection; `query` is a display label there). No automated-sender
  // heuristic in thread mode — ticket-bot replies are exactly what's watched;
  // self-drop stays mandatory.
  threadId?: string;
  // Thread mode: nudge a follow-up draft when the thread's last message is
  // our own and older than this many hours (once per outbound message).
  followUpAfterHours?: number;
  state?: DetectState | null;
}

// One declarative watch in the shared job's hook config: a stable watcher id +
// the Gmail query (and an optional account, recorded for the multi-account
// future, plus the explicitly watched sender when one drove the query). The
// shared job carries a LIST of these, rebuilt from the enabled watchers on
// every add/remove/enable/disable.
interface Watch {
  watcherId: string;
  // Fan-out routing key: where this concern's detection bucket is dispatched.
  // Defaults to watcherId when omitted, so a 1:1 watcher↔route mapping needs no
  // extra config; the email layer sets it = watcher.id.
  routeKey?: string;
  query: string;
  account?: string;
  // The gws config dir of the account this watch targets (resolved runtime-side
  // from `account` via Gini's google-accounts registry). When set, every gws
  // call for this watch runs with GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<configDir> so
  // detection polls exactly that account's inbox. Absent => default gws config
  // dir (back-compat: a single-account install with no registered account).
  configDir?: string;
  sender?: string;
  objective?: string;
  threadId?: string;
  followUpAfterHours?: number;
}

// The shared job's multi-watch input: the list of enabled watches + the opaque
// per-watch state. State is keyed by routeKey at the TOP LEVEL; a legacy
// `{ byWatcher }` blob is still accepted and read transparently for one
// transition tick (the first new tick rewrites it flat).
interface DetectArgsMulti {
  watches?: Watch[];
  // Flat per-route state (the current shape) OR a legacy `{ byWatcher }` blob
  // (read transparently for one transition tick). readWatchState handles both.
  state?: Record<string, DetectState | undefined> | { byWatcher?: Record<string, DetectState> } | null;
}

// The shared job's multi-watch output: ROUTED buckets keyed by routeKey (only
// non-empty ones), each carrying that concern's surviving matches (untrusted) +
// its trusted context (objective / backlog notice / follow-up); an optional
// non-silent summary on a fully-silent tick; and the new per-watch state keyed by
// routeKey at the TOP LEVEL for the generic per-bucket commit to partition.
interface DetectResultMulti {
  kind: "shortCircuit" | "context";
  buckets?: Record<string, ResultItem[]>;
  summary?: string;
  state: Record<string, DetectState>;
}

interface EmailMetadata {
  id: string;
  threadId?: string;
  internalDate?: string; // epoch ms, as gws returns it
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  // The RFC 5322 `Message-ID` header: STABLE across accounts (the same email
  // delivered to two watched inboxes keeps this id but gets a DIFFERENT Gmail
  // message id per account). Cross-account dedup keys on it so two account-scoped
  // watches never both draft the one underlying email.
  messageId?: string;
  // The `To` header (raw, comma-separated). Used only for cross-account dedup
  // precedence: the watch whose account address appears in To is the actual
  // recipient and wins. Never emitted in the match item.
  to?: string;
  // The extracted readable body, fetched ONLY for a surviving matched item right
  // before it's drafted (never on the metadata-only detection path). Rides into
  // the SAME untrusted match item the runner fences — it's a longer snippet, not
  // a new trust surface.
  body?: string;
}

// A single injectable context item, matching the hook runner's HookContextItem.
interface ResultItem {
  text: string;
  untrusted: boolean;
}

interface DetectResult {
  kind: "shortCircuit" | "context";
  items?: ResultItem[];
  summary?: string;
  // Health rides in `state.status`/`state.lastError` (the opaque blob the job
  // persists), so the email read path can derive the watcher's displayed status.
  // A transport problem is a shortCircuit with status:"error", never a non-zero
  // exit, so the backing job keeps polling and recovers on the next clean tick.
  state: DetectState;
}

// ── gws subprocess boundary (injectable for the unit test) ───────────────────

// A gws spawn. The optional `configDir` targets a SPECIFIC Google account: gws
// reads its client config + token from GOOGLE_WORKSPACE_CLI_CONFIG_DIR when set,
// so a per-watch configDir makes that watch poll exactly the account Gini
// registered for it. Omitted => gws reads its DEFAULT config dir (~/.config/gws).
// The unit-test stub ignores the second arg, so existing tests are unaffected.
export type GwsSpawn = (args: string[], configDir?: string) => Promise<string>;

// Default gws spawn: `zsh -lc "gws ..."`, stdin ignored, kill-on-timeout,
// inheriting the env the skill-script runner provides (PATH/HOME + GINI_*). When
// `configDir` is set, GOOGLE_WORKSPACE_CLI_CONFIG_DIR is added to the env so gws
// reads THAT account's client config + token; when absent gws reads its default
// config dir (~/.config/gws). No other credentials are injected. stdout AND
// stderr are drained CONCURRENTLY: a piped stream that is never read can fill its
// OS buffer (~64KB) and deadlock the child until the kill timer fires; gws emits
// its keyring preamble to stderr.
export async function defaultGwsSpawn(args: string[], configDir?: string): Promise<string> {
  const proc = spawn(["zsh", "-lc", `gws ${args.join(" ")}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: configDir
      ? { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir }
      : { ...process.env }
  });
  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, SPAWN_TIMEOUT_MS);
  try {
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

// ── gws arg builders + parsers (ported verbatim) ─────────────────────────────

// Single-quote a JSON params object for the gws CLI. Fields like threadId and
// query can carry arbitrary text, so shell-escape every embedded single quote
// ('\'' closes, escapes a literal quote, reopens) — a bare close-quote here
// would let a crafted value break out and run an injected command.
function jsonParam(obj: Record<string, unknown>): string {
  return `'${JSON.stringify(obj).replace(/'/g, `'\\''`)}'`;
}

function buildAuthStatusArgs(): string[] {
  return ["auth", "status"];
}

// Gmail lists newest-first within and across pages; `--page-all` walks up to
// `--page-limit` pages and emits one JSON object PER PAGE (NDJSON). We enumerate
// the whole window so the oldest-first drain never advances the cursor past an
// un-listed match.
function buildListArgs(query: string): string[] {
  return [
    "gmail", "users", "messages", "list",
    "--params", jsonParam({ userId: "me", q: query, maxResults: WINDOW_PAGE_SIZE }),
    "--format", "json",
    "--page-all",
    "--page-limit", String(WINDOW_PAGE_LIMIT)
  ];
}

function buildGetArgs(messageId: string): string[] {
  return [
    "gmail", "users", "messages", "get",
    "--params", jsonParam({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date", "To", "Message-ID"]
    })
  ];
}

// Fetch ONE message in full (payload + part bodies) — used ONLY for a surviving
// matched item right before it's drafted, so the worker drafts from the email's
// real content rather than re-fetching it by a hand-typed id. Detection itself
// stays metadata-only (buildGetArgs); this is the heavier read reserved for the
// handful of items that actually wake a drafting turn.
function buildFullGetArgs(messageId: string): string[] {
  return [
    "gmail", "users", "messages", "get",
    "--params", jsonParam({ userId: "me", id: messageId, format: "full" })
  ];
}

function buildProfileArgs(): string[] {
  return ["gmail", "users", "getProfile", "--params", jsonParam({ userId: "me" })];
}

// Fetch a watched thread's message METADATA (never bodies) in one call — the
// same raw-API shape as `messages get`, rooted at the `threads` resource.
function buildThreadGetArgs(threadId: string): string[] {
  return [
    "gmail", "users", "threads", "get",
    "--params", jsonParam({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date", "To", "Message-ID"]
    })
  ];
}

// gws prints a "Using keyring backend: keyring" preamble to STDERR before the
// JSON. With the concurrent stdout/stderr drain stdout begins at the first `{`;
// the leading-`{` skip below is a defensive guard. Returns undefined on any parse
// failure (a garbled CLI is treated as "no data" rather than crashing the tick).
function parseGwsJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// gws returns a Google API error as a JSON BODY with exit 0 (e.g. a `threads
// get` for a missing thread yields `{"error":{"code":404,"message":"...","reason":
// "notFound"}}`). That is NOT an empty result — the parse helpers below would see
// no `messages` array and silently treat it as "no new mail", leaving a watch
// pointed at a bad id permanently, silently dead. Detect the error body at each
// detection entry point and THROW so the gws-fault path in run() handles it
// identically to a transport throw: status:"error" + scrubbed lastError, cursor/
// seen UNCHANGED (no baseline, no advance), recovering on the next clean tick.
// A normal result (even an empty thread / no-match list) has no `error` object
// and flows through untouched.
function gwsErrorBody(doc: Record<string, unknown> | undefined): { code?: unknown; message?: unknown; reason?: unknown } | undefined {
  const error = doc?.error;
  return error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
}

// Throw a scrubbed Error when `stdout` is a gws error BODY; a no-op otherwise.
// Called on the raw detection response (list / threads get) before any parse so
// an error body never reaches the "no messages => empty" path.
function throwOnGwsErrorBody(stdout: string): void {
  const error = gwsErrorBody(parseGwsJson(stdout));
  if (!error) return;
  const message = typeof error.message === "string" ? error.message : "gws returned an error";
  const code = typeof error.code === "number" || typeof error.code === "string" ? `${error.code} ` : "";
  throw new Error(scrubError(`gws error: ${code}${message}`));
}

interface MessageListWindow {
  ids: string[];
  pageLimitHit: boolean;
}

// Parse a `messages list --page-all` response (NDJSON: one JSON object PER PAGE)
// into the ordered window (newest-first, as Gmail returns them) plus whether the
// page cap was hit. Falls back to single-object parsing so a non-paginated
// response still works; any stray non-JSON line (the preamble) is skipped.
function parseMessageWindow(stdout: string): MessageListWindow {
  const ids: string[] = [];
  let pages = 0;
  let lastPageHadToken = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let doc: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      doc = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      continue;
    }
    if (!doc) continue;
    pages += 1;
    lastPageHadToken = typeof doc.nextPageToken === "string" && doc.nextPageToken.length > 0;
    const messages = doc.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
        ids.push((m as { id: string }).id);
      }
    }
  }
  return { ids, pageLimitHit: pages >= WINDOW_PAGE_LIMIT && lastPageHadToken };
}

// Map one message document (a `messages get` response, or one entry of a
// thread's `messages[]`) onto EmailMetadata.
function metadataFromDoc(doc: Record<string, unknown>, id: string): EmailMetadata {
  const meta: EmailMetadata = { id };
  if (typeof doc.threadId === "string") meta.threadId = doc.threadId;
  if (typeof doc.internalDate === "string") meta.internalDate = doc.internalDate;
  if (typeof doc.snippet === "string") meta.snippet = doc.snippet;
  const payload = doc.payload as { headers?: unknown } | undefined;
  const headers = payload?.headers;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== "object") continue;
      const name = (h as { name?: unknown }).name;
      const value = (h as { value?: unknown }).value;
      if (typeof name !== "string" || typeof value !== "string") continue;
      const key = name.toLowerCase();
      if (key === "from") meta.from = value;
      else if (key === "subject") meta.subject = value;
      else if (key === "date") meta.date = value;
      else if (key === "to") meta.to = value;
      else if (key === "message-id") meta.messageId = value;
    }
  }
  return meta;
}

// Parse a `messages get format=metadata` response into EmailMetadata.
function parseMessageMetadata(stdout: string, id: string): EmailMetadata {
  const doc = parseGwsJson(stdout);
  return doc ? metadataFromDoc(doc, id) : { id };
}

// Parse a `threads get format=metadata` response into the thread's message
// metadata list, skipping malformed entries. Order is normalized by the
// caller (sorted by internalDate).
function parseThreadMessages(stdout: string): EmailMetadata[] {
  const doc = parseGwsJson(stdout);
  const messages = doc?.messages;
  if (!Array.isArray(messages)) return [];
  const out: EmailMetadata[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const id = (m as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    out.push(metadataFromDoc(m as Record<string, unknown>, id));
  }
  return out;
}

// ── Body extraction (final matched items only) ───────────────────────────────

// Decode a Gmail part `body.data` (base64url) to utf8, or "" on any failure.
function decodeBodyData(data: unknown): string {
  if (typeof data !== "string" || data.length === 0) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

// Strip HTML to plain-ish text: drop <style>/<script> blocks, replace tags with
// spaces, decode the handful of common entities, and collapse whitespace. A
// minimal best-effort strip (not a parser) — the body is untrusted context for
// the drafting turn, not rendered.
function stripHtml(html: string): string {
  return html
    .replace(/<(?:style|script)[^>]*>[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Find the first part with the given MIME type by walking the payload tree
// (multipart messages nest parts), returning its decoded data or "".
function firstPartText(payload: Record<string, unknown> | undefined, mimeType: string): string {
  if (!payload || typeof payload !== "object") return "";
  if (payload.mimeType === mimeType) {
    const body = payload.body as { data?: unknown } | undefined;
    const decoded = decodeBodyData(body?.data);
    if (decoded) return decoded;
  }
  const parts = payload.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const found = firstPartText(part as Record<string, unknown>, mimeType);
      if (found) return found;
    }
  }
  return "";
}

// Extract a readable body from a `messages get format=full` document: prefer
// text/plain, fall back to tag-stripped text/html, then the snippet. Truncate to
// MAX_BODY_CHARS. Returns "" when nothing usable is present.
function extractBody(doc: Record<string, unknown> | undefined): string {
  if (!doc) return "";
  const payload = doc.payload as Record<string, unknown> | undefined;
  let text = firstPartText(payload, "text/plain").trim();
  if (!text) {
    const html = firstPartText(payload, "text/html");
    if (html) text = stripHtml(html);
  }
  if (!text && typeof doc.snippet === "string") text = doc.snippet.trim();
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS)}…[truncated]`;
  return text;
}

// Fetch + extract ONE matched message's readable body, for a surviving matched
// item right before it's drafted. Self-contained and BEST-EFFORT: the entire
// fetch+parse is wrapped so a body-fetch fault (transport, error body, garbled
// JSON) falls back to the snippet and NEVER fails the tick — detection degrades
// to today's metadata-only behavior rather than worse. A gws error BODY (exit 0)
// is treated the same: parseGwsJson sees the `error` object and extractBody
// finds no payload/snippet, yielding the snippet fallback. Called ONLY for final
// matched items (query + thread mode), never during seeding/short-circuit/silent
// ticks or for dropped (automated/self) messages.
export async function fetchMessageBody(gwsSpawn: GwsSpawn, id: string, snippet: string): Promise<string> {
  try {
    const body = extractBody(parseGwsJson(await gwsSpawn(buildFullGetArgs(id))));
    return body || snippet;
  } catch {
    return snippet;
  }
}

// ── Error scrub (ported verbatim) ────────────────────────────────────────────

// Scrub a gws/transport error message before it rides back in state.lastError
// and surfaces in the watcher status. Redact credential-bearing file paths
// (config/keyring/token files) and any home-rooted path so a leaked stack frame
// or CLI diagnostic can't expose the operator's filesystem layout. Two passes:
//   - explicit .json/.enc secret files;
//   - any /Users/<u>, /home/<u>, or /root path (anchored so /root doesn't eat
//     /rootcause). Over-redaction is the safe direction for an error string.
export function scrubError(message: string): string {
  return message
    .replace(/[^\s'"]*\.(?:json|enc)/g, "<path>")
    .replace(/(?:\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|\/root(?=\/|$|[\s'"]))(?:\/[^\s'"]*)?/g, "<path>");
}

// ── Safety floor (ported verbatim) ───────────────────────────────────────────

// Drop automated senders or the user's own address. Bodies aren't available, so
// the heuristic is From-based (drop automated + self at the trigger).
const AUTOMATED_FROM = /no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?@|noreply/i;

// Extract the bare address from a From header — the `<addr@host>` form when
// present, else the first bare `addr@host` token, lowercased.
export function parseFromAddress(from: string): string | undefined {
  const angle = from.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angle) return angle[1]!.toLowerCase();
  const bare = from.match(/[^<>@\s]+@[^<>@\s]+/);
  return bare ? bare[0].toLowerCase() : undefined;
}

export function shouldDropMessage(meta: EmailMetadata, selfEmail?: string, watchedSender?: string): boolean {
  // Compare the parsed sender address by EQUALITY, not substring: a substring
  // match false-drops humans whose address contains self's (self j@gmail.com
  // would drop aj@gmail.com). Self-drop is checked FIRST and is mandatory —
  // even an explicitly watched address never triggers on our own mail.
  const sender = parseFromAddress(meta.from ?? "");
  if (selfEmail && sender && sender === selfEmail.toLowerCase()) return true;
  // An explicitly watched sender bypasses the automated-sender heuristic: the
  // user asked for this exact address by name (e.g. noreply@ups.com), so the
  // heuristic must not silently swallow it. Exact address equality only.
  if (watchedSender && sender && sender === watchedSender.toLowerCase()) return false;
  const from = (meta.from ?? "").toLowerCase();
  if (AUTOMATED_FROM.test(from)) return true;
  return false;
}

// ── Item builders (RAW metadata; the runner fences) ──────────────────────────

// The raw matched-email metadata as a single JSON object, prefixed with a
// sender label so the shared thread's drafting turn can attribute each match to
// its sender (one thread carries matches across all watched senders). The hook
// runner is the prompt-injection boundary: it fences this untrusted text. The
// script emits the raw fields only.
export function buildMatchItem(meta: EmailMetadata): ResultItem {
  const from = meta.from ?? "(unknown)";
  const payload = JSON.stringify({
    from,
    subject: meta.subject ?? "(none)",
    date: meta.date ?? "(unknown)",
    id: meta.id,
    // The containing thread, when known — the drafting turn reads the FULL
    // thread (the ground truth of the conversation), not just this message.
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
    // The RFC Message-ID + To header ride the item so the cross-watch pass in
    // runWatches can dedup the same underlying email across accounts (Message-ID
    // is stable across inboxes) and pick the To-recipient account as the drafter.
    ...(meta.messageId ? { messageId: meta.messageId } : {}),
    ...(meta.to ? { to: meta.to } : {}),
    snippet: meta.snippet ?? "",
    // The extracted email body, fetched for this surviving match — the drafting
    // turn drafts from it directly instead of re-fetching by a hand-typed id.
    // Omitted when no body was fetched (the metadata-only path is unchanged).
    ...(meta.body ? { body: meta.body } : {})
  });
  return { text: `New email from ${from} — ${payload}`, untrusted: true };
}

// The dedup-relevant fields embedded in a match item, for cross-watch precedence.
// Only untrusted match items carry the `{...,"id":...}` payload buildMatchItem
// emits; trusted items (objective / backlog notice / follow-up) have none and
// return an empty object (they're never deduped — they're per-concern context,
// not mail). `id` is the per-account Gmail message id (within-account dedup);
// `messageId` is the RFC Message-ID stable across accounts (cross-account dedup);
// `to` is the recipient header (precedence: the To-recipient account drafts).
export function matchItemFields(item: ResultItem): { id?: string; messageId?: string; to?: string } {
  if (!item.untrusted) return {};
  const start = item.text.indexOf("{");
  if (start < 0) return {};
  try {
    const doc = JSON.parse(item.text.slice(start));
    if (!doc || typeof doc !== "object") return {};
    const d = doc as { id?: unknown; messageId?: unknown; to?: unknown };
    return {
      id: typeof d.id === "string" ? d.id : undefined,
      messageId: typeof d.messageId === "string" ? d.messageId : undefined,
      to: typeof d.to === "string" ? d.to : undefined
    };
  } catch {
    return {};
  }
}

// The Gmail message id embedded in a match item, for the within-account
// targeted-vs-broad precedence dedup. Thin wrapper over matchItemFields.
export function matchItemId(item: ResultItem): string | undefined {
  return matchItemFields(item).id;
}

// The user's standing objective for a watch, as ONE TRUSTED item
// (untrusted:false — the runner renders it unfenced). The objective is
// validated config from the trusted tool/API channel, the same trust level as
// the job prompt; it must NEVER ride inside the untrusted fence, and untrusted
// email content never flows into it. Emitted only on ticks where the watch
// actually matched, so the drafting turn knows what its replies should achieve.
export function buildObjectiveItem(label: string, objective: string): ResultItem {
  return { text: `Objective for this watch (${label}): ${objective}`, untrusted: false };
}

// ── Self-email resolution (ported verbatim) ──────────────────────────────────

async function resolveSelfEmail(gwsSpawn: GwsSpawn): Promise<string | undefined> {
  try {
    const out = await gwsSpawn(buildProfileArgs());
    const doc = parseGwsJson(out);
    const email = doc?.emailAddress;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

// Fetch one message's internalDate (epoch ms), 0 when unavailable. Used to
// baseline the cursor from the newest listed message without enumerating the
// window.
async function fetchInternalDate(gwsSpawn: GwsSpawn, id: string): Promise<number> {
  const meta = parseMessageMetadata(await gwsSpawn(buildGetArgs(id)), id);
  const internalDate = meta.internalDate ? Number(meta.internalDate) : 0;
  return Number.isFinite(internalDate) && internalDate > 0 ? internalDate : 0;
}

// ── The engine (stateless) ───────────────────────────────────────────────────

// Run detection for ONE watch given its query + opaque state. Returns the typed
// result + the NEW state — pure: it makes the gws calls (the only side effect is
// the read-only subprocess) but never persists anything. The caller persists the
// returned state at the at-least-once commit boundary (a shortCircuit
// immediately; a context result only after the drafting turn dispatches).
//
// Three regimes, all governed by the fact that the `after:` watermark only ever
// moves FORWARD (to newer mail): you can never reach an older, un-listed tail by
// advancing it, so a path that needs the tail is wrong.
//
//  1. SEEDING (no cursor): BASELINE + drain the RECENT matching backlog HEAD.
//     Consider the newest up to MAX_MESSAGES_PER_TICK listed ids (Gmail lists
//     newest-first, so window.ids[0..cap] is the most-recent window), baseline the
//     cursor at the NEWEST listed id's internalDate, and record the boundary-second
//     ids in `seen` (Gmail's `after:` is inclusive of the boundary second). Each
//     head id that passes the SAME drop filter as steady state (non-self,
//     non-automated unless explicitly watched) is drafted, oldest-first — so
//     creating a watch on an inbox with pending mail replies to the recent head
//     immediately; a self/automated head id is dropped but STILL advances the
//     baseline (a watch whose newest is an automated notice still drafts the older
//     real mail in the head). Mail OLDER than the considered head is excluded by
//     `after:` forever — never a backlog draft, regardless of inbox size.
//
//  2. STEADY-STATE, window NOT truncated: drain OLDEST-FIRST, cap the matches at
//     MAX_MESSAGES_PER_TICK, advance the cursor ONCE to the LAST CONSUMED item's
//     internalDate. A >cap backlog drains over successive ticks. The `seen` set
//     is recomputed to the ids sharing the new cursor's exact second so the
//     inclusive `after:` doesn't re-draft them next tick.
//
//  3. STEADY-STATE, window TRUNCATED (pageLimitHit: > the page cap of
//     genuinely-new matches, only reachable after downtime + high volume): the
//     older tail isn't listed, so oldest-first draining would silently skip it.
//     Don't draft the backlog and don't skip it silently — jump the cursor to
//     the NEWEST, record it in `seen`, and short-circuit with a non-silent
//     summary telling the user a backlog accumulated. The advanced state persists
//     immediately, so the notice fires at most once per episode.
export async function detect(
  args: DetectArgs,
  gwsSpawn: GwsSpawn,
  selfEmail: string | undefined
): Promise<DetectResult> {
  // Thread mode keys detection on the thread itself, not a Gmail query.
  if (args.threadId) return detectThread(args, gwsSpawn, selfEmail);
  const stateIn: DetectState = args.state ?? {};
  const cursorIn = stateIn.cursor;
  const seenIn = new Set(stateIn.seen ?? []);
  const isSeeding = !cursorIn;

  // Bound the query with `after:<epochSec>` once a watermark exists (Gmail's
  // `after:` takes epoch seconds), so steady-state polling lists almost nothing.
  let query = args.query;
  if (!isSeeding) {
    const afterSec = Math.floor(Number(cursorIn) / 1000);
    if (Number.isFinite(afterSec) && afterSec > 0) {
      query = `${args.query} after:${afterSec}`;
    }
  }

  const listOut = await gwsSpawn(buildListArgs(query));
  // A gws error body (exit 0) is a fault, not an empty window — surface it via
  // the throw path so the cursor/seen are preserved and the watch reports error.
  throwOnGwsErrorBody(listOut);
  const window = parseMessageWindow(listOut);

  // Regime 1: SEEDING — drain the RECENT matching backlog HEAD. Consider the
  // newest up to MAX_MESSAGES_PER_TICK listed messages (Gmail lists newest-first,
  // so the head is the most-recent window), fetch each, drop self/automated, and
  // draft the survivors. The cursor baselines at the NEWEST listed message so the
  // entire considered head — drafted or not — and everything OLDER than it is
  // excluded by `after:` forever: only the recent head ever seeds, never an
  // ancient backlog, regardless of inbox size. A self/automated message in the
  // head is dropped by the SAME safety floor as steady state but STILL advances
  // the baseline, so a watch whose newest is an automated notice still drafts the
  // older real mail in the head.
  if (isSeeding) {
    const newest = window.ids[0];
    if (!newest) {
      // Empty matching window: baseline at now, nothing to draft.
      return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor: String(Date.now()), seen: [], status: "ok" } };
    }
    // Truncation is irrelevant on seed: the newest page is always listed and we
    // never reach for the older tail, so there's no pageLimitHit special-case here.
    const headIds = window.ids.slice(0, MAX_MESSAGES_PER_TICK);
    const collected: EmailMetadata[] = [];
    let newestInternalDate = 0;
    for (const id of headIds) {
      const meta = parseMessageMetadata(await gwsSpawn(buildGetArgs(id)), id);
      const internalDate = meta.internalDate ? Number(meta.internalDate) : 0;
      if (Number.isFinite(internalDate) && internalDate > newestInternalDate) newestInternalDate = internalDate;
      // A self/automated head message drops (no pending reply to draft) but still
      // counts toward the baseline above.
      if (shouldDropMessage(meta, selfEmail, args.sender)) continue;
      // A surviving head match WILL be drafted: fetch its body now (best-effort,
      // falls back to the snippet), exactly as the steady path does.
      meta.body = await fetchMessageBody(gwsSpawn, id, meta.snippet ?? "");
      collected.push(meta);
    }
    const cursor = String(newestInternalDate > 0 ? newestInternalDate : Date.now());
    // Boundary dedup set: the listed ids sharing the cursor's exact epoch second
    // (Gmail's inclusive `after:` would otherwise re-list them next tick).
    const seen = await boundarySeen(gwsSpawn, window.ids, cursor, new Set());
    if (collected.length === 0) {
      return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor, seen, status: "ok" } };
    }
    // Deliver oldest-first so the drafting turn reads the backlog chronologically
    // (mirrors the steady-state drain order).
    collected.reverse();
    const items: ResultItem[] = collected.map(buildMatchItem);
    // The seeded drafts carry the watch's standing objective just like a steady
    // match (one trusted item alongside the untrusted matches).
    if (args.objective) items.push(buildObjectiveItem(args.sender ?? args.query, args.objective));
    return { kind: "context", items, state: { cursor, seen, status: "ok" } };
  }

  // Regime 3: TRUNCATED steady-state window — the older tail isn't listed, so a
  // forward-only watermark can never reach it. Jump past the whole backlog to the
  // newest and short-circuit with a backlog notice. Bounded + non-silent.
  if (window.pageLimitHit) {
    const newest = window.ids[0];
    let cursor = cursorIn;
    if (newest) {
      const internalDate = await fetchInternalDate(gwsSpawn, newest);
      // Always advance the cursor (mirror seeding's fallback): a transient bad
      // metadata-get falls back to now() so the cursor can't get stuck.
      cursor = String(internalDate > 0 ? internalDate : Date.now());
    }
    const summary = [
      `A large backlog of emails matching this watch (query: ${args.query}) accumulated, likely while offline.`,
      "Not drafting replies to all of them. Ask me to triage this inbox if you want me to work through them."
    ].join(" ");
    return {
      kind: "shortCircuit",
      summary,
      state: { cursor, seen: newest ? [newest] : [], status: "ok" }
    };
  }

  // Regime 2: fully-enumerated steady-state window. Gmail returns newest-first;
  // drain oldest-first so a turn-cap never advances the cursor past an older,
  // un-consumed match.
  const ids = window.ids.slice().reverse();

  // The internalDate of the LAST item we consumed (collected an item for, or
  // dropped). The cursor advances to exactly this at the end.
  let lastConsumedInternalDate = Number(cursorIn) || 0;
  const items: ResultItem[] = [];
  let collected = 0;

  for (const id of ids) {
    // Already handled at the boundary second in a prior tick — skip. It's at the
    // current watermark, so it doesn't move lastConsumedInternalDate.
    if (seenIn.has(id)) continue;

    // Match cap reached: STOP consuming. Leave the remaining matches for the next
    // tick — the cursor will sit at the last consumed item, so `after:` re-lists.
    if (collected >= MAX_MESSAGES_PER_TICK) break;

    const meta = parseMessageMetadata(await gwsSpawn(buildGetArgs(id)), id);
    const internalDate = meta.internalDate ? Number(meta.internalDate) : 0;

    if (shouldDropMessage(meta, selfEmail, args.sender)) {
      // Safety floor dropped it — an intentional skip. Re-dropping it on a retry
      // is harmless (the floor is deterministic), so no separate dedup is needed.
      if (Number.isFinite(internalDate) && internalDate > lastConsumedInternalDate) {
        lastConsumedInternalDate = internalDate;
      }
      continue;
    }

    // A surviving match WILL be drafted: fetch its body now (best-effort, falls
    // back to the snippet) so the drafting turn works from the email's content.
    meta.body = await fetchMessageBody(gwsSpawn, id, meta.snippet ?? "");
    items.push(buildMatchItem(meta));
    collected += 1;
    if (Number.isFinite(internalDate) && internalDate > lastConsumedInternalDate) {
      lastConsumedInternalDate = internalDate;
    }
  }

  // A matched tick carries the watch's standing objective as ONE trusted item
  // alongside the untrusted matches (never on a no-match tick).
  if (collected > 0 && args.objective) {
    items.push(buildObjectiveItem(args.sender ?? args.query, args.objective));
  }

  const newCursor = lastConsumedInternalDate > 0 ? String(lastConsumedInternalDate) : cursorIn;

  // Recompute the boundary `seen` set: the ids sharing the new cursor's exact
  // epoch second (so the inclusive `after:` doesn't re-draft them next tick). We
  // already have their internalDates from the gets above for consumed items;
  // recompute from the listed window for correctness across the boundary.
  const seenOut = await boundarySeen(gwsSpawn, window.ids, newCursor, seenIn);

  if (items.length === 0) {
    // No delivery this tick (only dropped items, or nothing new): persist the
    // advanced cursor immediately (the caller treats shortCircuit as immediate).
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor: newCursor, seen: seenOut, status: "ok" } };
  }

  // Surviving matches: the caller persists this state ONLY after the drafting
  // turn dispatches (the context => deferred timing), so a dispatch failure
  // leaves the old cursor and the matches re-trigger next tick (at-least-once).
  return { kind: "context", items, state: { cursor: newCursor, seen: seenOut, status: "ok" } };
}

// Run detection for ONE thread-keyed watch. Ticket systems rotate sending
// addresses (support@x.com replies arrive from case-123@x.zendesk.com), so the
// Gmail THREAD — not a sender query — is the durable unit of "watch this
// conversation". One metadata-level `threads get` lists the whole conversation;
// a NEW match is a message with internalDate > cursor, id not in `seen`, and
// parsed From ≠ self. There is NO automated-sender heuristic here (replies
// from ticket bots are exactly what's watched); self-drop stays mandatory (we
// must never trigger on our own replies — they advance the cursor silently).
// Seeding mirrors the query regime: baseline the cursor at the newest message
// and, when that newest is from the counterparty (not self), draft THAT ONE
// message so a watch added to a thread with a pending reply drafts immediately;
// `seen` records the ids at the cursor's epoch second so an equal-timestamp
// message isn't re-drafted. Same purity + at-least-once contract: the new state
// rides back for the caller to persist.
async function detectThread(
  args: DetectArgs,
  gwsSpawn: GwsSpawn,
  selfEmail: string | undefined
): Promise<DetectResult> {
  const stateIn: DetectState = args.state ?? {};
  const seenIn = new Set(stateIn.seen ?? []);
  const threadOut = await gwsSpawn(buildThreadGetArgs(args.threadId!));
  // A `threads get` for a missing/inaccessible thread returns an error body (exit
  // 0), NOT an empty thread — surface it via the throw path so a bad thread id
  // reports error (no baseline-to-now on seeding, no advance) instead of looking
  // healthy forever.
  throwOnGwsErrorBody(threadOut);
  const messages = parseThreadMessages(threadOut)
    .sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0));
  const newest = messages[messages.length - 1];

  // Seeding: baseline at the newest message in the thread. If that newest
  // message is from the counterparty (not self), draft THAT ONE message so
  // creating a watch on a thread with a pending reply produces a draft
  // immediately; a self newest (the ball is in their court) stays silent. Older
  // messages in the thread are never drafted as a backlog.
  if (!stateIn.cursor) {
    const baseline = newest?.internalDate ? Number(newest.internalDate) : 0;
    const cursor = String(baseline > 0 ? baseline : Date.now());
    const baselineSec = Math.floor(Number(cursor) / 1000);
    const seen = messages
      .filter((m) => Math.floor((Number(m.internalDate) || 0) / 1000) === baselineSec)
      .map((m) => m.id);
    const seedItems: ResultItem[] = [];
    if (newest) {
      const newestFrom = parseFromAddress(newest.from ?? "");
      const newestIsSelf = Boolean(selfEmail && newestFrom && newestFrom === selfEmail.toLowerCase());
      if (!newestIsSelf) {
        // The pending counterparty reply WILL be drafted: fetch its body now
        // (best-effort, falls back to the snippet), exactly as the steady path.
        newest.body = await fetchMessageBody(gwsSpawn, newest.id, newest.snippet ?? "");
        seedItems.push(buildMatchItem(newest));
        if (args.objective) seedItems.push(buildObjectiveItem(`thread:${args.threadId}`, args.objective));
      }
    }
    if (seedItems.length > 0) {
      return { kind: "context", items: seedItems, state: { cursor, seen, status: "ok" } };
    }
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor, seen, status: "ok" } };
  }

  // Gmail internalDate is second-granular in practice, so compare on epoch
  // seconds (mirroring the query regime): a same-second message that becomes
  // visible on a later tick must still be drafted, not dropped as <= the cursor.
  const cursorMs = Number(stateIn.cursor) || 0;
  const cursorSec = Math.floor(cursorMs / 1000);
  let lastConsumed = cursorMs;
  const items: ResultItem[] = [];
  for (const m of messages) {
    const internalDate = Number(m.internalDate) || 0;
    if (internalDate <= 0 || Math.floor(internalDate / 1000) < cursorSec || seenIn.has(m.id)) continue;
    const from = parseFromAddress(m.from ?? "");
    // Our own reply advances the cursor but never triggers.
    const isSelf = Boolean(selfEmail && from && from === selfEmail.toLowerCase());
    if (!isSelf) {
      // A surviving thread match WILL be drafted: fetch its body now (best-effort,
      // falls back to the snippet) so the drafting turn works from its content.
      m.body = await fetchMessageBody(gwsSpawn, m.id, m.snippet ?? "");
      items.push(buildMatchItem(m));
    }
    if (internalDate > lastConsumed) lastConsumed = internalDate;
  }

  const newCursor = String(lastConsumed);
  // The ids sharing the new cursor's epoch second (so an equal-timestamp sibling
  // re-listed next tick isn't re-drafted). The full thread is re-fetched every
  // tick, so any prior-seen id still at this second is already in `messages`.
  const newCursorSec = Math.floor(lastConsumed / 1000);
  const seenOut = messages
    .filter((m) => Math.floor((Number(m.internalDate) || 0) / 1000) === newCursorSec)
    .map((m) => m.id);

  // Follow-up on silence: NO new matches this tick, the thread's last message
  // is OUR OWN, and it has sat unanswered past the threshold — nudge a turn to
  // draft a polite follow-up. Exactly once per outbound message:
  // lastNudgedForMessageId pins the nudged id, and a fresh reply or a newer
  // self-message changes the last-message id, resetting the cycle naturally.
  // The nudge is a TRUSTED item (a deterministic notice over thread metadata,
  // not email content).
  let lastNudgedForMessageId = stateIn.lastNudgedForMessageId;
  if (items.length === 0 && args.followUpAfterHours && newest) {
    const lastMs = Number(newest.internalDate) || 0;
    const lastFrom = parseFromAddress(newest.from ?? "");
    const lastIsSelf = Boolean(selfEmail && lastFrom && lastFrom === selfEmail.toLowerCase());
    if (
      lastIsSelf &&
      lastMs > 0 &&
      Date.now() - lastMs > args.followUpAfterHours * 3_600_000 &&
      stateIn.lastNudgedForMessageId !== newest.id
    ) {
      items.push({
        text: `No reply on this watched thread since ${new Date(lastMs).toISOString()} (over ${args.followUpAfterHours} hours). Draft a polite follow-up that advances the objective.`,
        untrusted: false
      });
      lastNudgedForMessageId = newest.id;
    }
  }

  // A matched (or nudged) tick carries the watch's standing objective as ONE
  // trusted item.
  if (items.length > 0 && args.objective) {
    items.push(buildObjectiveItem(`thread:${args.threadId}`, args.objective));
  }

  const stateOut: DetectState = {
    cursor: newCursor,
    seen: seenOut,
    status: "ok",
    ...(lastNudgedForMessageId !== undefined ? { lastNudgedForMessageId } : {})
  };
  if (items.length === 0) {
    return { kind: "shortCircuit", summary: "[SILENT]", state: stateOut };
  }
  return { kind: "context", items, state: stateOut };
}

// Compute the small boundary dedup set: the listed ids whose internalDate floors
// to the same epoch second as the new cursor, unioned with any prior-seen ids
// still at that second. Bounded to one second's worth of mail by the `after:`
// watermark.
async function boundarySeen(
  gwsSpawn: GwsSpawn,
  listedIds: string[],
  cursor: string | undefined,
  priorSeen: Set<string>
): Promise<string[]> {
  const cursorMs = Number(cursor) || 0;
  if (cursorMs <= 0) return [];
  const cursorSec = Math.floor(cursorMs / 1000);
  const out = new Set<string>();
  // Carry forward any prior-seen id (cheap; the set is already tiny) — it stays
  // relevant only while it's still at the boundary second, and a stale id is
  // harmless (it just won't be re-listed once the cursor moves past its second).
  for (const id of priorSeen) out.add(id);
  // Listed window is newest-first; the boundary-second ids are at the front.
  for (const id of listedIds) {
    const d = await fetchInternalDate(gwsSpawn, id);
    if (d <= 0) continue;
    const sec = Math.floor(d / 1000);
    if (sec > cursorSec) continue; // newer than the cursor — not yet at boundary
    if (sec < cursorSec) break; // older than the cursor — past the boundary
    out.add(id);
  }
  // Drop carried-forward ids that are now older than the cursor second so the set
  // can't grow unbounded across cursor advances.
  return [...out];
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

// Run one detection tick for ONE watch given its args + an injected gws spawn.
// Maps auth state + transport faults onto the health-in-state contract:
// signed-out => status:"needs_auth" with the prior cursor/seen UNCHANGED;
// gws/transport throw => status:"error" + a SCRUBBED lastError, cursor/seen
// UNCHANGED (the next healthy tick re-detects); a clean poll returns detect()'s
// status:"ok" result. Never throws — the backing job must stay alive and recover
// the moment gws is healthy/re-authed. An optional pre-resolved `selfEmail` lets
// the multi-watch loop resolve it once and share it across watches.
export async function run(
  args: DetectArgs,
  gwsSpawn: GwsSpawn,
  selfEmail?: string
): Promise<DetectResult> {
  const stateIn: DetectState = args.state ?? {};
  try {
    const status = parseGwsAuthStatus(await gwsSpawn(buildAuthStatusArgs()));
    if (!status.signedIn) {
      return { kind: "shortCircuit", summary: "[SILENT]", state: { ...stateIn, status: "needs_auth", lastError: undefined } };
    }
    const self = selfEmail ?? (await resolveSelfEmail(gwsSpawn));
    return await detect(args, gwsSpawn, self);
  } catch (error) {
    return {
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: { ...stateIn, status: "error", lastError: scrubError(error instanceof Error ? error.message : String(error)) }
    };
  }
}

// Resolve a watch's in-state from the multi-watch input. State is keyed by
// routeKey at the top level; a legacy `{ byWatcher }` blob is still read for one
// transition tick (the first new tick rewrites it flat).
function watchRouteKey(watch: Watch): string {
  return watch.routeKey ?? watch.watcherId;
}
function readWatchState(
  input: DetectArgsMulti["state"],
  routeKey: string
): DetectState {
  if (!input) return {};
  const flat = (input as Record<string, DetectState | undefined>)[routeKey];
  if (flat) return flat;
  const legacy = (input as { byWatcher?: Record<string, DetectState> }).byWatcher;
  return legacy?.[routeKey] ?? {};
}
// Specificity tier for the one-owner-per-message claim order (lower = more
// specific, runs earlier): a thread watch (0) beats a sender watch (1) beats any
// other user query watch (2) beats the synthetic whole-inbox triage concern (3).
// Watches claim the message ids they keep in tier order, so an email matching
// several watches is owned by exactly one — the most specific — per tick.
function watchTier(watch: Watch): number {
  if (watch.threadId) return 0;
  if (watch.sender) return 1;
  if (watchRouteKey(watch) === "triage") return 3;
  return 2;
}

// Run one detection tick across ALL enabled watches of the shared email-watch job.
// The gws session is a single signed-in identity, so the auth check + self-address
// resolution are done ONCE and shared; each watch then runs its own hardened
// single-watch regime against its own per-watch state keyed by routeKey.
//
//   - Signed out: every watch is marked needs_auth with its cursor/seen unchanged
//     (a session-level condition, shared across watches), 0 model turns.
//   - Per-watch: each watch is wrapped in its own try/catch so one sender's
//     gws/transport fault marks ONLY that watch's status:"error" (cursor/seen
//     unchanged) and the other watches still run and can still draft.
//   - Fan-out: each watch's surviving matches + its trusted context (objective /
//     backlog notice / follow-up) land in ITS OWN routeKey bucket, so the generic
//     scheduler spawns one drafting worker per concern into that concern's channel.
//     Empty buckets are omitted (per-concern short-circuit; an idle concern costs
//     zero model turns). When EVERY bucket is empty the whole tick is a silent
//     shortCircuit (a joined non-silent backlog notice if any fired with no match).
//   - Precedence: every message id has exactly ONE owning watch per tick. Watches
//     run in specificity order — thread > sender > query > the synthetic triage
//     concern, watches-list (creation) order within a tier — and EVERY watch
//     claims the ids it keeps and drops ids already claimed earlier in the tick,
//     so an email matching several watches lands in the most-specific bucket only
//     (no double-draft). Per-watch newness/dedup (cursor+seen) is unchanged —
//     precedence only reassigns which bucket an item is delivered in; every
//     watch's cursor still advances over what IT consumed.
//
// Commit timing is preserved by the consumer: a context bucket's state is
// persisted only after THAT bucket's drafting worker dispatches (at-least-once
// per concern); a fully-silent tick's state persists immediately.
export async function runWatches(args: DetectArgsMulti, gwsSpawn: GwsSpawn): Promise<DetectResultMulti> {
  const watches = Array.isArray(args.watches) ? args.watches : [];
  const stateOut: Record<string, DetectState> = {};
  const buckets: Record<string, ResultItem[]> = {};
  const silentNotices: string[] = [];

  // Each watch now targets a SPECIFIC account (its configDir), so auth state and
  // the self-address are per-account, not per-tick. Bind each watch's gws spawn
  // to its configDir (a watch with no configDir binds to the default gws dir) and
  // resolve {signedIn, self} once per distinct configDir, cached so co-located
  // watches on the same account share a single auth probe + getProfile.
  const accountAuth = new Map<string, { signedIn: boolean; selfEmail?: string; error?: string }>();
  const boundSpawnFor = (configDir?: string): GwsSpawn => (a) => gwsSpawn(a, configDir);
  async function resolveAccount(configDir?: string): Promise<{ signedIn: boolean; selfEmail?: string; error?: string }> {
    const key = configDir ?? "";
    const cached = accountAuth.get(key);
    if (cached) return cached;
    const spawn = boundSpawnFor(configDir);
    let resolved: { signedIn: boolean; selfEmail?: string; error?: string };
    try {
      const signedIn = parseGwsAuthStatus(await spawn(buildAuthStatusArgs())).signedIn;
      resolved = signedIn ? { signedIn, selfEmail: await resolveSelfEmail(spawn) } : { signedIn };
    } catch (error) {
      resolved = { signedIn: false, error: scrubError(error instanceof Error ? error.message : String(error)) };
    }
    accountAuth.set(key, resolved);
    return resolved;
  }

  // Most-specific watches run first so they claim their matched ids before any
  // less specific watch is assigned; the stable sort keeps the watches-list
  // (creation) order as the within-tier tiebreak.
  const ordered = [...watches].sort((a, b) => watchTier(a) - watchTier(b));
  const claimedIds = new Set<string>();
  // The account identity per routeKey (the watch's resolved account, else its
  // self-address) — the key the cross-account Message-ID dedup groups on so two
  // watches on the SAME account aren't deduped against each other (within-account
  // dedup by Gmail id already handles that) and the To-recipient account wins.
  const accountByRoute = new Map<string, string | undefined>();

  for (const watch of ordered) {
    const routeKey = watchRouteKey(watch);
    const stateIn = readWatchState(args.state, routeKey);

    // Per-account auth gate. A signed-out or auth-faulted account marks ONLY its
    // own watches (cursor/seen unchanged) — accounts are independent, so a fault
    // on one never short-circuits a healthy other.
    const auth = await resolveAccount(watch.configDir);
    if (auth.error !== undefined) {
      stateOut[routeKey] = { ...stateIn, status: "error", lastError: auth.error };
      continue;
    }
    if (!auth.signedIn) {
      stateOut[routeKey] = { ...stateIn, status: "needs_auth", lastError: undefined };
      continue;
    }

    const boundSpawn = boundSpawnFor(watch.configDir);
    // run() never throws (it maps gws faults onto status in state). The extra
    // try/catch is belt-and-suspenders so a bug in one watch can never abort the
    // others — that watch is marked error and the rest still run.
    let result: DetectResult;
    try {
      result = await run(
        {
          query: watch.query,
          account: watch.account,
          sender: watch.sender,
          objective: watch.objective,
          threadId: watch.threadId,
          followUpAfterHours: watch.followUpAfterHours,
          state: stateIn
        },
        boundSpawn,
        auth.selfEmail
      );
    } catch (error) {
      stateOut[routeKey] = {
        ...stateIn,
        status: "error",
        lastError: scrubError(error instanceof Error ? error.message : String(error))
      };
      continue;
    }
    stateOut[routeKey] = result.state;
    // Record which account this route belongs to (resolved account, else the
    // signed-in self-address) for the cross-account Message-ID dedup below.
    accountByRoute.set(routeKey, (watch.account ?? auth.selfEmail)?.toLowerCase());
    if (result.kind === "context" && result.items) {
      // Precedence: every watch drops match items a more specific (or earlier-
      // created same-tier) watch already claimed this tick, and claims the ids
      // it keeps — one owning bucket per message id. Trusted items (objective /
      // follow-up) carry no id and always ride through.
      const kept: ResultItem[] = [];
      for (const item of result.items) {
        const id = matchItemId(item);
        if (id) {
          if (claimedIds.has(id)) continue;
          claimedIds.add(id);
        }
        kept.push(item);
      }
      // A watch can drop EVERY match to precedence, leaving only trusted items
      // (objective rides ONLY on a real match, so a fully-claimed watch yields
      // nothing). Only open a bucket when an actual match survives — an
      // empty/match-less bucket spawns no worker.
      if (kept.some((i) => i.untrusted)) buckets[routeKey] = kept;
    } else if (result.summary && result.summary.trim() !== "[SILENT]" && result.summary.trim().length > 0) {
      // A non-silent shortCircuit summary (a per-watch backlog notice). Route it
      // into THIS concern's bucket as a TRUSTED item so the concern's worker
      // surfaces it; collect for the joined silent-tick summary as a fallback.
      buckets[routeKey] = [{ text: result.summary, untrusted: false }];
      silentNotices.push(result.summary);
    }
  }

  // Cross-account thread dedup: the SAME underlying email delivered to two watched
  // inboxes has different Gmail ids but the same RFC Message-ID, so two
  // account-scoped watches would both draft → double reply. Collapse each shared
  // Message-ID to ONE drafting watch; the losing watches already advanced their own
  // cursor/seen over their copy (so they won't re-draft next tick), so dropping the
  // item is all that's needed. Within-account dedup (above) is untouched.
  dedupCrossAccountByMessageId(buckets, accountByRoute);

  const routeKeys = Object.keys(buckets);
  if (routeKeys.length === 0) {
    // Every bucket empty: a silent tick (zero idle turns). Surface any backlog
    // notice that fired without a sibling match as one non-silent summary.
    const summary = silentNotices.length > 0 ? silentNotices.join("\n\n") : "[SILENT]";
    return { kind: "shortCircuit", summary, state: stateOut };
  }
  return { kind: "context", buckets, state: stateOut };
}

// Whether the message's `To` header addresses the given account (case-insensitive
// substring of the bare address into the raw To header — To can be a display-name
// + comma-separated list, so an address-token containment is the robust check).
function toRecipientIs(toHeader: string | undefined, account: string | undefined): boolean {
  if (!toHeader || !account) return false;
  return toHeader.toLowerCase().includes(account.toLowerCase());
}

// Across ALL buckets in the tick, dedup the same underlying email (same RFC
// Message-ID, different per-account Gmail ids) so only ONE account-scoped watch
// drafts it. Groups untrusted match items by Message-ID; a group spanning 2+
// DISTINCT accounts is a cross-account duplicate. The winner is deterministic:
// prefer the watch whose account is the message's To-recipient, then tie-break by
// account email ascending, then routeKey ascending. Every other item with that
// Message-ID is removed from its bucket (and a bucket left with no surviving match
// is dropped). Mutates `buckets` in place. A Message-ID seen on only one account
// (or absent) is left untouched, so single-account behavior is unchanged.
function dedupCrossAccountByMessageId(
  buckets: Record<string, ResultItem[]>,
  accountByRoute: Map<string, string | undefined>
): void {
  // messageId -> the candidate items carrying it, each with its route + account.
  interface Candidate { routeKey: string; account: string | undefined; to: string | undefined; item: ResultItem }
  const groups = new Map<string, Candidate[]>();
  for (const [routeKey, items] of Object.entries(buckets)) {
    const account = accountByRoute.get(routeKey);
    for (const item of items) {
      const { messageId, to } = matchItemFields(item);
      if (!messageId) continue;
      const list = groups.get(messageId) ?? [];
      list.push({ routeKey, account, to, item });
      groups.set(messageId, list);
    }
  }

  // The items to drop: the losers of every cross-account-duplicate group.
  const losers = new Set<ResultItem>();
  for (const candidates of groups.values()) {
    const accounts = new Set(candidates.map((c) => c.account ?? ""));
    // Only a Message-ID matched across 2+ DISTINCT accounts is a cross-account
    // duplicate; a single account's copies are already within-account-deduped.
    if (accounts.size < 2) continue;
    const winner = [...candidates].sort((a, b) => {
      const aTo = toRecipientIs(a.to, a.account);
      const bTo = toRecipientIs(b.to, b.account);
      if (aTo !== bTo) return aTo ? -1 : 1; // To-recipient account wins
      const byAccount = (a.account ?? "").localeCompare(b.account ?? "");
      if (byAccount !== 0) return byAccount; // account email ascending
      return a.routeKey.localeCompare(b.routeKey); // then routeKey ascending
    })[0]!;
    for (const c of candidates) {
      if (c.item !== winner.item) losers.add(c.item);
    }
  }
  if (losers.size === 0) return;

  for (const routeKey of Object.keys(buckets)) {
    const kept = buckets[routeKey]!.filter((i) => !losers.has(i));
    // A bucket reduced to no surviving MATCH spawns no worker — drop it (mirrors
    // the within-account precedence rule that only opens a bucket on a real match).
    if (kept.some((i) => i.untrusted)) buckets[routeKey] = kept;
    else delete buckets[routeKey];
  }
}

async function main(): Promise<void> {
  let args: DetectArgsMulti;
  try {
    args = await readStdinJson<DetectArgsMulti>();
  } catch (error) {
    // Bad stdin is reported as a shortCircuit with empty per-route state, not a
    // non-zero exit, so the backing job stays alive. No prior state to preserve.
    process.stdout.write(JSON.stringify({
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: {}
    } satisfies DetectResultMulti));
    return;
  }
  process.stdout.write(JSON.stringify(await runWatches(args, defaultGwsSpawn)));
}

// Parse the JSON `gws auth status` emits. signedIn := token_valid === true.
// Any parse failure / non-object output yields signedIn:false (a garbled CLI is
// treated as not-signed-in).
export function parseGwsAuthStatus(stdout: string): { signedIn: boolean } {
  const doc = parseGwsJson(stdout);
  return { signedIn: doc?.token_valid === true };
}

// Only run main when executed directly (the unit test imports the helpers).
if (import.meta.main) {
  await main();
}
