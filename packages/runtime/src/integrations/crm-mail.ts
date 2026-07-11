// Mail access for the CRM extraction pipeline. Two sources behind one
// interface: Gmail over REST (credentials from the registered account's
// config dir, same authorized_user shape the onboarding scan uses) and a
// fixture directory of normalized messages for tests and local dogfooding.
//
// SECURITY: refresh credentials and minted access tokens live in function
// locals only — never logged, never persisted, never included in errors.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import type { CrmMail, CrmAddress } from "../jobs/crm-extraction-pipeline";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 30_000;
const LIST_PAGE_SIZE = 500;
const FETCH_CONCURRENCY = 8;
// Per-message body cap. Threads are budgeted again at stitch time; this cap
// only bounds pathological single messages.
const MAX_BODY_CHARS = 20_000;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface CrmMailRef {
  id: string;
  threadId: string;
  internalDate: number;
}

export interface CrmMailSource {
  kind: "gmail" | "fixture";
  // Every message (optionally only those after `afterMs`), with real
  // internalDates so the queue's grew-since-done reopen logic works.
  listMessages(afterMs?: number): Promise<CrmMailRef[]>;
  // All messages of one thread, full content, normalized.
  fetchThread(threadId: string): Promise<CrmMail[]>;
}

// ---------------------------------------------------------------------------
// Gmail source
// ---------------------------------------------------------------------------

interface ExportedCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function credentialsFromConfigDir(configDir: string | undefined): ExportedCredentials | undefined {
  if (!configDir) return undefined;
  const path = join(configDir, "credentials.json");
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const clientId = doc.client_id;
    const clientSecret = doc.client_secret;
    const refreshToken = doc.refresh_token;
    if (typeof clientId !== "string" || !clientId) return undefined;
    if (typeof clientSecret !== "string" || !clientSecret) return undefined;
    if (typeof refreshToken !== "string" || !refreshToken) return undefined;
    return { clientId, clientSecret, refreshToken };
  } catch {
    return undefined;
  }
}

// Parse `gws auth export --unmasked` output: skip any preamble up to the
// first `{`, then require all three credential fields as non-empty strings.
// Pure so the parse rules are testable without spawning anything.
export function parseGwsExportOutput(stdout: string): ExportedCredentials | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const doc = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    const clientId = doc.client_id;
    const clientSecret = doc.client_secret;
    const refreshToken = doc.refresh_token;
    if (typeof clientId !== "string" || !clientId) return undefined;
    if (typeof clientSecret !== "string" || !clientSecret) return undefined;
    if (typeof refreshToken !== "string" || !refreshToken) return undefined;
    return { clientId, clientSecret, refreshToken };
  } catch {
    return undefined;
  }
}

// Fallback for accounts signed in via `gws auth login` (keyring store, no
// credentials.json): one export spawn.
async function credentialsFromGwsExport(configDir: string | undefined): Promise<ExportedCredentials | undefined> {
  try {
    // The command is env-overridable so tests can exercise this path without
    // spawning the real gws (which would read real keyring credentials).
    const command = process.env.GINI_GWS_EXPORT_COMMAND ?? "gws auth export --unmasked";
    const timeoutMs = Number(process.env.GINI_GWS_EXPORT_TIMEOUT_MS ?? "20000");
    const proc = spawn(["zsh", "-lc", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: configDir ? { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir } : process.env,
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    return parseGwsExportOutput(stdout);
  } catch {
    return undefined;
  }
}

async function mintAccessToken(fetchImpl: FetchImpl, credentials: ExportedCredentials): Promise<string | undefined> {
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const doc = (await response.json()) as { access_token?: unknown } | null;
    const token = doc?.access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

// Injectable backoff base so tests exercise the retry ladder in
// milliseconds instead of minutes.
function gmailBackoffBaseMs(): number {
  return Number(process.env.GINI_GMAIL_BACKOFF_MS ?? "1000");
}
const GMAIL_MAX_ATTEMPTS = 6;

// Gmail throttles bursts with 403 (rate limit) as well as 429 — a full
// mailbox ingest at 8-way reliably trips it. Retry those, transient 5xx,
// and transport failures (network rejections, the 30s request timeout)
// with exponential backoff before surfacing; a definitive HTTP status
// (401, 404) throws immediately.
async function gmailGet(fetchImpl: FetchImpl, accessToken: string, path: string): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(`${GMAIL_BASE}/${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= GMAIL_MAX_ATTEMPTS - 1) throw error;
      await Bun.sleep(gmailBackoffBaseMs() * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      const doc = (await response.json()) as unknown;
      return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : undefined;
    }
    const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= GMAIL_MAX_ATTEMPTS - 1) {
      throw new Error(`Gmail request failed (HTTP ${response.status}).`);
    }
    await Bun.sleep(gmailBackoffBaseMs() * 2 ** attempt);
  }
}

function decodeBodyData(data: unknown): string {
  if (typeof data !== "string" || data.length === 0) return "";
  // Buffer.from with a string never throws for base64url — invalid characters
  // are skipped — so the string guard above is the only gate needed.
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function extractBody(doc: Record<string, unknown>): string {
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

// Parse an RFC 5322 address-list header ("A <a@x>, b@y") into CrmAddresses.
// Commas inside display names are rare in practice; a missed split only
// costs a display name, never an address (addresses are regex-extracted).
export function parseAddressList(header: string | undefined): CrmAddress[] {
  if (!header) return [];
  const out: CrmAddress[] = [];
  for (const part of header.split(/,(?![^<]*>)/)) {
    const m = part.match(/<([^<>\s]+@[^<>\s]+)>/) ?? part.match(/([^\s<>",;]+@[^\s<>",;]+)/);
    if (!m) continue;
    const address = m[1]!.toLowerCase().replace(/^mailto:/, "");
    const name = part.replace(m[0]!, "").replace(/["<>]/g, "").trim() || undefined;
    out.push(name ? { name, address } : { address });
  }
  return out;
}

function headerValue(doc: Record<string, unknown>, name: string): string | undefined {
  const payload = doc.payload as { headers?: { name?: string; value?: string }[] } | undefined;
  const row = payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return row?.value;
}

export function gmailMessageToCrmMail(doc: Record<string, unknown>): CrmMail {
  const from = parseAddressList(headerValue(doc, "From"))[0];
  return {
    id: String(doc.id ?? ""),
    threadId: String(doc.threadId ?? doc.id ?? ""),
    date: Number(doc.internalDate ?? 0),
    ...(from ? { from } : {}),
    to: parseAddressList(headerValue(doc, "To")),
    cc: parseAddressList(headerValue(doc, "Cc")),
    subject: headerValue(doc, "Subject") ?? "",
    body: extractBody(doc),
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function gmailCrmMailSource(options: { configDir?: string; fetchImpl?: FetchImpl }): CrmMailSource {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let token: { value: string; mintedAt: number } | undefined;
  const accessToken = async (): Promise<string> => {
    // Tokens live ~60 min; re-mint after 45.
    if (token && Date.now() - token.mintedAt < 45 * 60_000) return token.value;
    const credentials =
      credentialsFromConfigDir(options.configDir) ?? (await credentialsFromGwsExport(options.configDir));
    if (!credentials) throw new Error("No Google credentials available for CRM extraction.");
    const minted = await mintAccessToken(fetchImpl, credentials);
    if (!minted) throw new Error("Could not mint a Gmail access token for CRM extraction.");
    token = { value: minted, mintedAt: Date.now() };
    return minted;
  };
  return {
    kind: "gmail",
    async listMessages(afterMs?: number): Promise<CrmMailRef[]> {
      const t = await accessToken();
      const q = afterMs ? `&q=${encodeURIComponent(`after:${Math.floor(afterMs / 1000)}`)}` : "";
      const ids: { id: string; threadId: string }[] = [];
      let pageToken: string | undefined;
      do {
        const page = await gmailGet(
          fetchImpl,
          t,
          `messages?maxResults=${LIST_PAGE_SIZE}${q}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        const messages = (page?.messages as { id?: unknown; threadId?: unknown }[] | undefined) ?? [];
        for (const m of messages) {
          if (typeof m.id === "string") ids.push({ id: m.id, threadId: typeof m.threadId === "string" ? m.threadId : m.id });
        }
        pageToken = typeof page?.nextPageToken === "string" ? page.nextPageToken : undefined;
      } while (pageToken);
      // The list surface carries no dates; fetch minimal per message for
      // internalDate (cheap — no payload). A failed date fetch (after
      // gmailGet's own backoff ladder) THROWS rather than degrading to
      // internalDate 0: a zero date can never satisfy the queue's
      // grew-since-done reopen predicate, and the cursor would advance past
      // the real message via its poll-mates — silently dropping that mail
      // forever. Failing the whole poll leaves the cursor untouched, so the
      // next interval retries everything.
      const refs = await mapWithConcurrency(ids, FETCH_CONCURRENCY, async (m) => {
        const doc = await gmailGet(fetchImpl, t, `messages/${m.id}?format=minimal`);
        return { id: m.id, threadId: m.threadId, internalDate: Number(doc?.internalDate ?? 0) };
      });
      return refs;
    },
    async fetchThread(threadId: string): Promise<CrmMail[]> {
      const t = await accessToken();
      const doc = await gmailGet(fetchImpl, t, `threads/${threadId}?format=full`);
      const messages = (doc?.messages as Record<string, unknown>[] | undefined) ?? [];
      return messages.map(gmailMessageToCrmMail);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture source — a directory with messages.json holding normalized
// CrmMail[] rows. Used by tests and local dogfooding against captured
// mailboxes; produces exactly what the Gmail source produces.
// ---------------------------------------------------------------------------

export function fixtureCrmMailSource(dir: string): CrmMailSource {
  // Reload only when the file actually changed (mtime + size key): the
  // watcher's per-call reload semantics survive, but a large captured
  // mailbox isn't re-parsed for each of thousands of thread fetches.
  let cache: { key: string; messages: CrmMail[] } | undefined;
  const load = (): CrmMail[] => {
    const path = join(dir, "messages.json");
    const stat = statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache?.key !== key) {
      cache = { key, messages: JSON.parse(readFileSync(path, "utf8")) as CrmMail[] };
    }
    return cache.messages;
  };
  return {
    kind: "fixture",
    async listMessages(afterMs?: number): Promise<CrmMailRef[]> {
      return load()
        .filter((m) => !afterMs || m.date > afterMs)
        .map((m) => ({ id: m.id, threadId: m.threadId, internalDate: m.date }));
    },
    async fetchThread(threadId: string): Promise<CrmMail[]> {
      return load().filter((m) => m.threadId === threadId);
    },
  };
}
