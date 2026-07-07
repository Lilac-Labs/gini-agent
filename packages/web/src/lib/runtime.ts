import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GATEWAY_RESTARTING_MESSAGE, GATEWAY_UNREACHABLE_CODE } from "./gateway-codes";
import { parseTrustedOriginUrls } from "./trusted-origins";

// Headers we forward verbatim from the browser to the runtime. Last-Event-ID
// is critical for SSE reconnect dedup (see src/http.ts:eventStream) — without
// it, every reconnect re-replays the entire event log. X-Device-Token is
// required for /api/badge + /api/chat/:id/read; the mobile app sends it on
// every authenticated call so the gateway can attribute the device.
const FORWARD_HEADERS = new Set([
  "content-type",
  "accept",
  "cache-control",
  "last-event-id",
  "x-device-token"
]);

// Cache the file-read values across requests but invalidate on mtime change,
// so a gateway respawn that picks a different port doesn't strand the BFF
// pointing at the old port. We cache for 2s minimum to avoid stat'ing on
// every single request when a SSE stream is open.
interface FileCache {
  // The mtimeMs we read at; null when the file was missing.
  mtime: number | null;
  value: string;
  readAt: number;
}
const fileCacheTtlMs = 2000;
const fileCache: Map<string, FileCache> = new Map();

/** Test-only seam: lets tests expire/inspect cache entries instead of
 * sleeping out the real TTL. */
export const __fileCacheTestHooks = {
  clear(): void {
    fileCache.clear();
  },
  entry(path: string): FileCache | undefined {
    return fileCache.get(path);
  }
};

function readFileWithMtimeCache(path: string): string | null {
  const now = Date.now();
  const cached = fileCache.get(path);
  if (cached && now - cached.readAt < fileCacheTtlMs) return cached.value || null;

  if (!existsSync(path)) {
    fileCache.set(path, { mtime: null, value: "", readAt: now });
    return null;
  }
  let mtime: number | null = null;
  try { mtime = statSync(path).mtimeMs; } catch { /* ignore */ }
  if (cached && cached.mtime !== null && mtime === cached.mtime) {
    cached.readAt = now;
    return cached.value || null;
  }
  try {
    const value = readFileSync(path, "utf8").trim();
    fileCache.set(path, { mtime, value, readAt: now });
    return value || null;
  } catch {
    fileCache.set(path, { mtime, value: "", readAt: now });
    return null;
  }
}

function stateRoot(): string {
  return process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(process.env.HOME ?? homedir(), ".gini");
}

export function runtimeInstance(): string {
  return process.env.GINI_INSTANCE ?? "default";
}

// Resolve the gateway URL with this precedence:
//   1. GINI_RUNTIME_URL (explicit override — `gini start` injects this).
//   2. ~/.gini/instances/<inst>/runtime.port (written by src/server.ts on
//      boot). This lets the BFF survive a gateway restart that picks a
//      different port without the user restarting the web process.
//   3. Hardcoded http://127.0.0.1:7778 fallback (production `default` instance).
export function runtimeUrl(): string {
  if (process.env.GINI_RUNTIME_URL) return process.env.GINI_RUNTIME_URL;
  const portFile = join(stateRoot(), "instances", runtimeInstance(), "runtime.port");
  const port = readFileWithMtimeCache(portFile);
  if (port) return `http://127.0.0.1:${port}`;
  return "http://127.0.0.1:7778";
}

// Resolve the gateway bearer token with this precedence:
//   1. GINI_TOKEN (explicit override — `gini start` injects this).
//   2. ~/.gini/instances/<inst>/config.json (.token field). The token is
//      persisted in config and stable across restarts, but the bearer at
//      web-start time can become stale if the user runs `gini reset` or
//      reinstalls the instance — reading from disk picks up the new value.
//   3. Empty string (will produce 401s, surfaced to the user instead of
//      hanging requests).
export function runtimeToken(): string {
  if (process.env.GINI_TOKEN) return process.env.GINI_TOKEN;
  const configPath = join(stateRoot(), "instances", runtimeInstance(), "config.json");
  const raw = readFileWithMtimeCache(configPath);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

export interface ProxyOptions {
  runtimeUrl: string;
  token: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

// A gateway restart is routine (auto-update, watchdog kickstart), so the BFF
// answers for it with a retryable 503 + JSON body instead of letting the
// fetch rejection escape the route handler — which Next.js would turn into a
// bare empty-body 500 that crashes response.json() in every client.
export function gatewayUnreachableResponse(): Response {
  return Response.json(
    { error: GATEWAY_RESTARTING_MESSAGE, code: GATEWAY_UNREACHABLE_CODE },
    { status: 503, headers: { "retry-after": "2" } }
  );
}

// Server-side trail for the unreachable path. Catching the upstream
// rejection means Next.js no longer dumps a stack trace per failed proxy
// request — but those traces were the only record of WHICH address the BFF
// dialed and WHY it failed, the load-bearing datum when the cause is a
// persistent misconfig (stale port file, wrong instance) rather than a
// restart blip. Log one line with target + cause, deduplicated so a normal
// restart window (dozens of polls against the same dead port) emits one
// entry instead of a storm; a changed message (different port, different
// errno) logs immediately.
const UNREACHABLE_LOG_INTERVAL_MS = 10_000;
let lastUnreachableLog = { message: "", at: 0 };

function logGatewayUnreachable(target: string, err: unknown): void {
  const cause =
    err instanceof Error ? String((err.cause as Error | undefined)?.message ?? err.cause ?? err.message) : String(err);
  const message = `[bff] gateway unreachable: ${target} (${cause})`;
  const now = Date.now();
  if (message === lastUnreachableLog.message && now - lastUnreachableLog.at < UNREACHABLE_LOG_INTERVAL_MS) return;
  lastUnreachableLog = { message, at: now };
  console.error(message);
}

/** Test-only seam: reset the dedup latch between cases. */
export const __unreachableLogTestHooks = {
  reset(): void {
    lastUnreachableLog = { message: "", at: 0 };
  }
};

// Forward a small allowlist of response headers from the upstream runtime.
// The QR endpoints (and any future bearer-gated response that needs
// browser-caching control) set `Cache-Control: no-store`; without this
// passthrough the BFF would silently allow a browser to cache the QR
// pixels — which encode the bootstrap URL. Other entries are headers a
// BFF typically wants to forward (content-disposition + x-content-type-options
// to keep served uploads download-only and no-sniff, etag/last-modified for
// revalidation, vary for cache key correctness).
// NOTE: deliberately does NOT include `content-encoding` (or `content-length`).
// This BFF reads the upstream body via `upstream.text()` / streams
// `upstream.body`, and the underlying fetch (undici) auto-negotiates
// `Accept-Encoding` and TRANSPARENTLY DECOMPRESSES the body before we ever see
// it. Forwarding the upstream's `content-encoding` would therefore label an
// already-decompressed body as gzip/br, which the browser then fails to decode
// (`ERR_CONTENT_DECODING_FAILED`). Likewise the upstream `content-length` is
// the compressed length and no longer matches the decompressed bytes. Both are
// intentionally dropped so the platform recomputes/omit them for the body we
// actually emit.
const PASSTHROUGH_RESPONSE_HEADERS = [
  "cache-control",
  "etag",
  "last-modified",
  "vary",
  "content-disposition",
  "x-content-type-options",
  "content-language"
];

export async function proxyRequest(
  request: Request,
  pathSegments: string[],
  options: ProxyOptions
): Promise<Response> {
  // Canonicalize before guard + forward. Without this, a request to
  // /api/runtime/x/%252e%252e/messaging/<bridge>/allow reaches the BFF as
  // pathSegments ["x", "%2e%2e", "messaging", "<bridge>", "allow"] — the
  // guard regex misses (path doesn't start with "messaging"), the BFF
  // forwards via fetch(), which collapses the dot-segment in flight, and
  // the gateway happily executes allowChat under the operator's bearer.
  // Recursively decoding each segment and rejecting traversal/slash
  // markers closes the bypass before either the regex check or the
  // outbound URL construction.
  const canonical = canonicalizeSegments(pathSegments);
  if (!canonical) return Response.json({ error: "Invalid path" }, { status: 400 });

  const guard = guardCsrf(request, canonical);
  if (guard) return guard;

  const upstreamUrl = new URL(request.url);
  // Re-encode each canonicalized segment so URL-special characters that
  // survived canonicalization (`?`, `#`, `;`, raw `%`, etc.) cannot
  // re-acquire structural meaning when Bun's fetch parses the target. The
  // BFF's view of the path now matches the upstream's byte-for-byte: if
  // the guard didn't see "messaging/<bridge>/allow", the gateway won't
  // either.
  const encodedPath = canonical.map((segment) => encodeURIComponent(segment)).join("/");
  const target = `${options.runtimeUrl}/api/${encodedPath}${upstreamUrl.search}`;
  const headers = pickForwardHeaders(request.headers);
  headers.set("authorization", `Bearer ${options.token}`);
  // Ask the gateway NOT to compress this loopback hop. Without an explicit
  // value, the underlying fetch (undici) auto-injects `Accept-Encoding:
  // gzip, deflate, br`, so the gateway spends brotli/gzip CPU on a response
  // this BFF immediately decompresses and re-serves — pure waste over
  // loopback. `identity` makes the gateway's negotiator skip compression at
  // the source. This does NOT remove the need to strip content-encoding on
  // the way back (undici still transparently decompresses any upstream that
  // compresses regardless, leaving a stale header) — see
  // PASSTHROUGH_RESPONSE_HEADERS; the two work together.
  headers.set("accept-encoding", "identity");
  // Never follow gateway redirects server-side: the Google login round trip
  // (/api/google/login/*) answers browser top-level navigations with 302s —
  // out to accounts.google.com and back into the app — and a followed
  // redirect would fetch Google's consent HTML as the BFF instead of
  // navigating the user's tab. The 3xx passes through below.
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  const signal = options.signal ?? request.signal;
  if (signal) init.signal = signal;
  if (!["GET", "HEAD"].includes(request.method)) {
    // Bound the buffered body, but only for the uploads route — a low cap must
    // not 413 normal POSTs (e.g. /chat/:id/messages). Enforced both before
    // reading (content-length early-reject) and after (buffered length), so a
    // header-less/chunked over-cap upload is rejected rather than forwarded.
    // GINI_MAX_UPLOAD_BYTES overrides the default to mirror the gateway's cap.
    const isUpload = canonical[0] === "uploads";
    const cap = Number(process.env.GINI_MAX_UPLOAD_BYTES);
    const maxBytes = Number.isFinite(cap) && cap > 0 ? cap : 50 * 1024 * 1024;
    if (isUpload && Number(request.headers.get("content-length") ?? 0) > maxBytes) {
      return Response.json({ error: "Upload too large." }, { status: 413 });
    }
    const body = await request.arrayBuffer();
    if (isUpload && body.byteLength > maxBytes) {
      return Response.json({ error: "Upload too large." }, { status: 413 });
    }
    if (body.byteLength > 0) init.body = body;
  }
  const fetcher = options.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetcher(target, init);
  } catch (err) {
    // The client went away (navigation/unmount) — let the platform handle the
    // aborted request rather than fabricating a response for nobody.
    if (signal?.aborted) throw err;
    logGatewayUnreachable(target, err);
    return gatewayUnreachableResponse();
  }
  // Redirect passthrough (see the `redirect: "manual"` note above): forward
  // the status + Location and nothing else — a redirect's other headers are
  // hop-local. A relative Location resolves in the browser against the
  // BFF-visible URL, which is exactly where the app lives. Scoped to the
  // Google login round trip — the only gateway surface that legitimately
  // redirects the browser. Any other 3xx falls through to the generic
  // branches, whose header allowlist drops Location, so a future gateway
  // route reflecting a caller-influenced Location can't become an open
  // redirect through the BFF.
  if (upstream.status >= 300 && upstream.status < 400 && canonical[0] === "google" && canonical[1] === "login") {
    const location = upstream.headers.get("location");
    return new Response(null, {
      status: upstream.status,
      headers: location ? { location } : {}
    });
  }
  const isStream = upstream.headers.get("content-type")?.includes("text/event-stream");
  if (isStream) {
    // Return the upstream body directly without materializing — preserves chunking
    // and back-pressure. Client disconnect closes the upstream via request.signal.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }
  const upstreamContentType = upstream.headers.get("content-type") ?? "application/json";
  // Binary passthrough for non-text payloads (image uploads, file
  // downloads). Routing on text() would UTF-8-decode bytes and corrupt
  // them. Anything not obviously text streams the upstream body through
  // unbuffered, mirroring the SSE branch above. Served uploads carry
  // Content-Disposition: attachment and may have a text/* mime (csv, log,
  // code) holding non-UTF-8 bytes — stream those opaquely too so the
  // download is byte-identical rather than decode/re-encoded.
  const isText = /^(application\/(json|xml|.*\+json|.*\+xml)|text\/)/i.test(upstreamContentType);
  const isAttachment = (upstream.headers.get("content-disposition") ?? "").toLowerCase().includes("attachment");
  if (!isText || isAttachment) {
    const passthroughHeaders = new Headers();
    passthroughHeaders.set("content-type", upstreamContentType);
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const v = upstream.headers.get(name);
      if (v) passthroughHeaders.set(name, v);
    }
    // Content-Length is safe to forward ONLY when the upstream body was not
    // encoded. If upstream carried Content-Encoding, undici already
    // transparently decompressed upstream.body, so the upstream length (the
    // COMPRESSED size) no longer matches the bytes we stream — forwarding it
    // would truncate/over-read. With no Content-Encoding the length is exact,
    // and preserving it gives download managers / media players determinate
    // size + progress on this binary/attachment path. (The BFF sends
    // Accept-Encoding: identity, so the no-encoding case is the norm.)
    if (!upstream.headers.has("content-encoding")) {
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) passthroughHeaders.set("content-length", contentLength);
    }
    return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders });
  }
  const text = await upstream.text();
  const outHeaders: Record<string, string> = {
    "content-type": upstreamContentType
  };
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) outHeaders[name] = v;
  }
  return new Response(text, { status: upstream.status, headers: outHeaders });
}

// Decode each segment until stable and reject anything that would let the
// upstream see a different path than the BFF guard does — empty segments,
// `.` / `..`, embedded `/`, or any non-printable byte. Returns null when the
// request must be refused outright. Used by proxyRequest to keep the regex
// match honest about what the gateway will execute.
const MAX_DECODE_DEPTH = 5;
export function canonicalizeSegments(segments: string[]): string[] | null {
  const out: string[] = [];
  for (let segment of segments) {
    let stabilized = false;
    for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (next === segment) {
        stabilized = true;
        break;
      }
      segment = next;
    }
    // A segment that is still decoding after MAX_DECODE_DEPTH iterations is
    // adversarially encoded and we refuse to guess the canonical form.
    if (!stabilized) return null;
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
    if (/[\x00-\x1f\x7f]/.test(segment)) return null;
    out.push(segment);
  }
  return out;
}

// Parse GINI_TRUSTED_ORIGINS into a Set of normalized origin strings
// (scheme://host[:port], no trailing slash, no path). Each entry must be a
// complete origin; bare hostnames are rejected. See ADR bff-trust-boundary.md
// for the trust-boundary decision and DNS-rebinding threat model.
//
// Tri-state return:
//   null  → env var is unset; loopback-only Host-equality fallback applies.
//   Set   → at least one valid origin parsed; the Set is the allowlist.
//   empty → operator set the env var but every entry was malformed; the guard
//           fails closed (refuses every privileged POST). This is the
//           defense-in-depth posture for a typo in a control that exists
//           specifically to lock down the trust boundary.
function parseTrustedOrigins(raw: string | undefined): ReadonlySet<string> | null {
  const urls = parseTrustedOriginUrls(raw);
  if (urls === null) return null;
  const out = new Set<string>();
  for (const parsed of urls) {
    out.add(`${parsed.protocol}//${parsed.host}`);
  }
  return out;
}

// Read process.env each call rather than caching at module import. The
// allowlist is short and the parse is trivial — re-running it per
// privileged POST costs a few microseconds, the requests aren't a hot
// path, and tests can now drive the guard's behavior by setting or
// deleting GINI_TRUSTED_ORIGINS in the test process without restarting
// the module loader. Without this, integration tests that exercise the
// BFF guard via proxyRequest would behave differently depending on
// whether the operator's dev shell had the env var exported — a real
// test-environment dependency, not just a theoretical one.
function trustedOrigins(): ReadonlySet<string> | null {
  return parseTrustedOrigins(process.env.GINI_TRUSTED_ORIGINS);
}

// Loopback hostnames the guard's local-dev fallback accepts when no
// allowlist is configured. Anything else is DNS-rebindable from a public
// origin and must be locked down with GINI_TRUSTED_ORIGINS.
export function isLoopbackHost(host: string): boolean {
  // Strip the optional :port suffix. IPv6 literals are wrapped in brackets,
  // so look at everything up to the last ":" only when no closing bracket
  // follows. URL.host normalizes IPv6 to "[::1]:port" form.
  const closeBracket = host.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? host.slice(0, closeBracket + 1)
    : host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  return hostnameOnly === "localhost" || hostnameOnly === "127.0.0.1" || hostnameOnly === "[::1]";
}

// Tier the guard by method:
// - Unsafe methods (POST/PUT/PATCH/DELETE): require Origin. Modern browsers
//   always send it; absence indicates a non-browser client (curl/scripts/
//   misconfigured proxies) and those should talk to the gateway directly
//   with their own token, not the BFF's bearer-injection surface.
// - Safe methods (GET/HEAD): allow missing Origin. Non-browser clients
//   doing read-only inspection via the BFF (legacy callers) keep working.
//   When Origin IS present (browser fetch), it's still checked — a DNS-
//   rebinding page sends Origin honestly to the attacker-controlled host,
//   so the allowlist/loopback check still catches it.
//
// The guard runs on every request, not just the prior PRIVILEGED_POST_ROUTES
// list — readable surfaces like /state were previously un-guarded and
// DNS-rebindable.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function guardCsrf(request: Request, pathSegments: string[]): Response | null {
  const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });
  const origin = request.headers.get("origin");
  const isUnsafe = UNSAFE_METHODS.has(request.method);
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
  // Host/Origin trust decision. The Sec-Fetch-Site check below runs regardless,
  // so this resolves a `trusted` flag rather than returning early.
  //
  // Loopback short-circuit: this BFF is an internal service — in production it is
  // reached only through the gateway's reverse-proxy, which validates the real
  // Host/Origin at the single front and rewrites BOTH to loopback before
  // forwarding (see src/http.ts proxyWeb + src/lib/origin-trust.ts). A loopback
  // Host is therefore trusted regardless of GINI_TRUSTED_ORIGINS: a DNS-rebinding
  // page cannot forge a loopback Host (the browser sends the real visited host),
  // and direct local-dev access lands on this same lane. This is what lets the
  // BFF stay relay-agnostic — it never sees a relay host of its own.
  let trusted = false;
  if (isLoopbackHost(expectedHost)) {
    if (!origin) {
      // Safe methods (top-level GET/HEAD) pass; an unsafe method without Origin
      // must use the gateway's native /api/* with its own token.
      trusted = !isUnsafe;
    } else {
      try {
        trusted = isLoopbackHost(new URL(origin).host);
      } catch {
        return forbidden();
      }
    }
  }
  if (!trusted) {
    if (!origin) return forbidden();
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return forbidden();
    }
    // GINI_TRUSTED_ORIGINS is the production-shape defense against DNS rebinding.
    // When set, only requests whose Origin exactly matches one of the listed
    // scheme+host[+port] entries pass; an env var set with only malformed
    // entries yields an empty Set and fails closed.
    const allowlist = trustedOrigins();
    if (allowlist) {
      if (!allowlist.has(`${originUrl.protocol}//${originUrl.host}`)) return forbidden();
    } else {
      // Local-dev fallback when GINI_TRUSTED_ORIGINS is unset: the Origin host
      // must equal a loopback Host (a non-loopback exposure requires the
      // allowlist, closing the rebindable path).
      if (!isLoopbackHost(expectedHost)) return forbidden();
      if (originUrl.host !== expectedHost) return forbidden();
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    // The Google login callback is the one legitimately cross-site request on
    // this surface: the browser reaches it by top-level 302 FROM
    // accounts.google.com, so Fetch Metadata stamps the navigation
    // `cross-site` (the redirect chain contains Google's origin). Its side
    // effect is guarded by the gateway's single-use state nonce — minted
    // per-flow, matched against module memory, TTL-bounded — which is the
    // per-endpoint CSRF defense this header check exists to approximate, so
    // the exemption reopens nothing. GET-only and exact-path so no other
    // route inherits it.
    const isGoogleLoginCallback =
      request.method === "GET" && pathSegments.join("/") === "google/login/callback";
    if (!isGoogleLoginCallback) return forbidden();
  }

  return null;
}

export function pickForwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (FORWARD_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
