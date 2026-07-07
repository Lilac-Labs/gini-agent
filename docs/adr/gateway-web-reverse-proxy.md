# ADR: Gateway reverse-proxies the web app as a single origin

## Decision

The gateway (`packages/runtime/src/http.ts` / `packages/runtime/src/server.ts`) reverse-proxies the Next.js web
app so the whole product — UI, BFF, and assets — is reachable on **one origin**
(the gateway port), in addition to the web server's own port. Routing is by
path in the request handler's fall-through:

- `/api/*` **except** `/api/runtime/*` — handled natively by the gateway and
  bearer-gated, exactly as before.
- `/api/runtime/*` — carved out of the native API branch and proxied to the
  Next.js BFF, so the BFF's server-side bearer injection and CSRF guard (ADR
  [bff-trust-boundary.md](./bff-trust-boundary.md)) still run.
- everything else (HTML, `/_next/*` assets) — proxied to the Next.js server.
- WebSocket upgrades (Next HMR at `/_next/webpack-hmr`) — bridged
  socket-to-socket; `fetch()` cannot carry an upgrade.

HTTP proxying uses Bun's `fetch` with `decompress: false`, so the upstream
`Content-Encoding`/`Content-Length` stay consistent and the browser decompresses
normally (without it, Bun decompresses the body but leaves stale headers →
`ERR_CONTENT_DECODING_FAILED`). The upstream `Response` is returned directly.

The upstream port is resolved through `packages/runtime/src/web-target.ts`, a runtime-safe module
(no `packages/runtime/src/cli/*` import) that reads the per-instance `web.port` and **validates**
it against the BFF `/api/runtime/__healthz` endpoint (`service: "gini-web"` +
matching `instance`) before forwarding, with a short per-instance cache. When the
port is unresolvable (web down, `--no-web`, or a reused/foreign port), the proxy
falls back to the runtime banner (`GET /`-style self-describe).

## Context

The relay tunnel binds a single local port to one public URL, so exposing the
full product remotely requires a single origin that serves both UI and API.
Fronting the durable Bun gateway — rather than the Next.js dev server — is the
right entry point: it is what `gini run` supervises and what every other client
already treats as the source of truth, and it keeps the BFF's automatic
server-side token injection from being exposed directly (a tunneled Next.js port
would hand every visitor a pre-authenticated session).

Mounting at root (not `/app`) keeps `/api/*` unambiguous and avoids a Next.js
`basePath` plus asset-URL rewrites.

The recorded `web.port` is not cleared when the web server dies, and the
watchdog can take up to a full restart interval to recover it. Every other dial
site in the codebase (`existingWebUrl`, `waitForWebHealthz`, the watchdog)
guards against a reused port with the same `gini-web` healthz check; the serving
proxy must do the same so a reused port can't route the browser's
bearer-injecting BFF calls to a foreign instance.

## Consequences

- The product is reachable on one origin (gateway port), enabling single-port
  tunnel exposure. Direct access to the inner Next.js port is unchanged: it
  binds loopback (`127.0.0.1`) and serves the proxied UI plus the
  `/api/runtime/*` BFF; the gateway-native `/api/*` surface is only served on
  the gateway origin.
- HMR works through the gateway via the WebSocket bridge. The bridge disables
  per-message deflate (the upstream client already decompresses; re-compressing
  on the browser leg risks RSV-bit mismatches), buffers frames that arrive
  before either side's handshake completes, and registers upstream failure
  handlers at dial time so an upstream that dies during the upgrade window
  cannot leak a half-open client socket.
- Web-down on any non-`/api` path returns the runtime banner. Because one
  Next.js process serves both the SPA and `/api/runtime/*`, a null port means
  the whole web surface is down, so a browser cannot be mid-session against a
  dead BFF — the banner is the correct self-describe.
- The gateway is the single trust front: it validates every web-bound request's
  `Host`/`Origin` (loopback / gini-relay subdomain / runtime-managed tunnel
  host / `GINI_TRUSTED_ORIGINS`, fail-closed on a malformed allowlist, plus a
  `Sec-Fetch-Site` check) and then
  rewrites `Host`/`Origin` to loopback before proxying, so the inner web child is
  purely internal and needs no relay awareness. External (non-relay,
  non-loopback) exposure still requires `GINI_TRUSTED_ORIGINS` to include the
  gateway's external origin (ADR bff-trust-boundary.md).
- `packages/runtime/src/http.ts` no longer imports from `packages/runtime/src/cli/*`; web-port discovery lives in
  the runtime-safe `packages/runtime/src/web-target.ts`.
- The healthz-validated port is cached briefly (`ttlMs`, default 5s) to keep the
  probe off the per-request hot path. This leaves a bounded window in which a
  port that dies and is immediately reused by another process could be trusted;
  it is an accepted tradeoff (per-request healthz would tax every asset fetch)
  and is narrowed by `redirect: "manual"` on the probe (a foreign squatter
  can't redirect its way to validation) and by dropping the cache entry on any
  upstream fetch failure.
- WebSocket upgrades are bridged only for web-bound paths (`isWebProxyPath`),
  the same split the HTTP router uses, so an upgrade aimed at the gateway's
  native `/api` surface is not proxied. Upstream close codes are normalized
  before being forwarded to the browser socket (reserved codes like 1006 throw
  if passed to `close()`).

## Acceptance Checks

- `GET /` through the gateway returns the proxied Next.js HTML when web is up
  (regardless of `Accept` — there is no content negotiation); when web is down
  it returns the `gini-runtime` banner.
- `GET /api/status` (no bearer) returns 401; `GET /api/runtime/status` is NOT
  bearer-gated by the gateway (routes to the proxy / BFF). When web is
  unreachable, API-shaped proxy paths return 502, while page/asset paths return
  the banner.
- A chat turn driven through the gateway origin (`/api/runtime/chat/*`) reaches
  the BFF, injects the token, and returns the assistant reply.
- HMR: editing a `packages/web/` source file hot-updates a page loaded through the
  gateway port, with no `ERR_CONTENT_DECODING_FAILED` or RSV-bit console errors.
- `resolveWebPort` returns null (→ banner/502) when healthz reports a different
  `instance` or a non-`gini-web` service. Pinned by `bun test
  packages/runtime/src/web-target.test.ts`; carve-out and WS-pump behavior by `bun test
  packages/runtime/src/http.test.ts packages/runtime/src/http-ws-proxy.test.ts`.
