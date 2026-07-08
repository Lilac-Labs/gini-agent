# ADR: Tunnel Connectivity

## Decision

Gini exposes a remote URL for an instance through a **tunnel provider**, selected and managed by the user through a uniform RPC contract. The gateway owns a small persisted singleton (the user's provider selection + connection status) and rebuilds the provider catalog from code on every read. Every tunnel route returns the **full `TunnelState`** so a single fetch drives the whole selection / connect / connected UI without follow-up requests.

The catalog carries four drivable providers. `gini-relay` is always enabled; `tailscale`, `ngrok`, and `cloudflare` are **detection-gated**: a driver probe (tailscale backend running with a MagicDNS name, `ngrok config check`, `cloudflared --version`) flips each row enabled, and a missing prerequisite surfaces as `requires`. A select/connect of an unavailable provider is rejected with HTTP 400 carrying the machine-readable `code: "provider_unavailable"` — Connect is the single UI affordance, and on that code the web UI opens the provider's self-contained guide (`docs/remote-access/<id>.md`, served inline through the gateway's docs endpoint) instead of dead-ending on the error. Detection refreshes at boot, on `GET /api/tunnel?detect=1` (panel open / CLI status, bypassing the cache TTL), and lazily before rejecting a select/connect — a freshly-installed CLI connects on the next attempt without any restart; plain polling GETs never spawn probes. The gini-relay connect flow is wired through the [`gini-relay`](https://github.com/Open-Curiosity/gini-relay) client package: `connectTunnel` flips status to `connecting` and returns immediately, then a background handshake mints an OAuth-loopback consent URL (`loginUrl`), opens it in the host browser, awaits the session, builds + starts a native `frpc` tunnel (`buildTunnel`) that exposes the instance's gateway port (the single origin fronting UI + API; see *Exposed port*), and records the public `https://<subdomain>.<relayDomain>` url. The UI/CLI polls `GET /api/tunnel` until status flips to `connected` (with `url`) or `error` (with `message`).

## Context

An instance runs on the user's machine bound to loopback. To reach it from a phone or a remote device, the gateway needs a publicly reachable URL fronted by a tunnel. Users pick among several tunnel providers (the hosted Gini Relay, their own Tailscale network, ngrok, Cloudflare); the hosted relay shipped first, and the Tailscale/ngrok/Cloudflare drivers followed as detection-gated catalog rows. The UI needs the full provider catalog up front — including the disabled ones and why they're disabled — so it can render the selection panel in one pass, and it needs the live connection status to decide which view to show.

The tunnel surface is self-serve remote access, so a managed (platform-hosted) deployment — whose ingress an edge proxy terminates — hides the web's tunnel menu entirely (see ADR managed-deployment-mode.md); the backend contract below is unchanged.

Tunnel connectivity follows the established capability pattern: an opt-in singleton on `RuntimeState` (`state.tunnel`), a behavior module exposing thin functions, HTTP routes that delegate to it, and a CLI shim that goes through the gateway. The browser-connect capability carries a parallel `state.browser` singleton — null by default (the runtime drives its own spawned Chrome), non-null only when the user attaches their own external Chrome over CDP (issue #420 removed the third, managed/visible-window, mode).

## Trust boundary

- The tunnel selection + status are **instance-level** transport state, not per-agent — every agent in the instance shares the one tunnel. Audit rows for select/connect/cancel/disconnect are attributed `{ system: true }`, matching relays and the browser connection.
- The catalog is code, not state: it is never persisted and never accepted from a client. A client can only ask to **select** or **connect** a provider id; the gateway validates that id against the code-defined catalog and rejects unknown or disabled providers before any state mutation. This keeps a client from enabling a provider the runtime isn't ready to drive.
- The HTTP layer maps the user-input rejections (`Unknown tunnel provider…`, `No tunnel provider selected…`, `Tunnel provider … is not available…`) to `400` so the panel surfaces the real reason rather than a generic 500.
- Browser clients never receive the gateway bearer; the Next.js BFF injects it server-side (repo-wide rule). This ADR's backend is independent of any UI — the UI track wires to it in a later step.

## The `TunnelState` contract

Every route returns:

```ts
type TunnelProvider = {
  id: "gini-relay" | "tailscale" | "ngrok" | "cloudflare";
  name: string;
  enabled: boolean;
  requires?: string;   // why an unavailable row can't connect yet
};

type TunnelState = {
  providers: TunnelProvider[];                                   // catalog, drives the panel
  selectedProvider: "gini-relay" | "tailscale" | "ngrok" | "cloudflare" | null;
  status: "idle" | "connecting" | "connected" | "error";
  url?: string;        // present only when status === "connected"
  message?: string;    // present only when status === "error"
};
```

View derivation from state:

- `selectedProvider === null` & status `idle` → Selection panel.
- status `idle` with a selection → Selection panel (Connect available on the selected provider).
- status `connecting` → Selection panel with the selected provider's row showing "Connecting…" + Cancel (the relay's OAuth consent tab is open in the host browser, or a manual driver is bringing its tunnel up).
- status `connected` → Connected popover (QR + url + disconnect + edit).
- status `error` → error shown in the panel (`message`).

## Provider catalog

| id | name | enabled | requires (when disabled) | driver |
|----|------|---------|--------------------------|--------|
| `gini-relay` | Gini Relay | always | — | gini-relay client (OAuth + frpc) |
| `tailscale` | Tailscale | detected | `Tailscale network` | `tailscale serve` (childless; lives in tailscaled; the boot resume re-publishes the same stable ts.net URL) |
| `ngrok` | ngrok | detected | `ngrok account` | `ngrok http <port>` supervised child; URL scanned from agent output |
| `cloudflare` | Cloudflare | detected | `cloudflared CLI` | named tunnel from `~/.cloudflared/config.yml` (run with the gateway as origin, publishing the config's stable ingress hostname — SSE-capable) when one exists; quick-tunnel fallback otherwise. `--config /dev/null` in both modes (loaded ingress rules would override `--url`); supervised child |

Host-side install/auth steps are deliberately NOT part of the catalog: each provider's setup guidance lives in its self-contained doc (`docs/remote-access/<id>.md`), which clients open on `provider_unavailable` and the sidebar links per provider.

The manual connect flow mirrors the relay's supervision contract: `connecting` → background driver → `connected` (with the public url) or `error`; a supervised child's unexpected exit auto-reconnects (`connected → connecting`, rebuilding the tunnel — see *Supervision*), settling `error` only when the retry budget is exhausted or auto-reconnect is disabled; cancel/disconnect/supersede tear down the child **or** the provider-side state (tailscale serve config) — including on a provider *switch*, where `selectProvider` tears down the live manual tunnel before flipping to idle. Reconcile resumes a `connected` manual record after a restart when its prerequisite still detects (tailscale re-publishes the same URL; ngrok/cloudflared mint a fresh one).

**Runtime-tunnel origin trust.** Every tunnel-record write syncs a per-instance entry in `packages/runtime/src/lib/origin-trust.ts` (`setRuntimeTunnelTrust`): while a record is `connected`, its url's host is admitted by the gateway's web-bound guard exactly like a relay subdomain (the runtime established the front; the provider owns the DNS), and any transition away from connected revokes it atomically with the state write. Unsafe methods still require Origin==Host on the tunnel front. A trusted tunnel front is owner-equivalent — there is no per-device gate beyond the origin trust (see [owner-token-auth.md](owner-token-auth.md)) — so connect a tunnel only when everyone who can reach its URL is trusted.

A *manually*-run front (a tool the runtime isn't driving — reverse proxy, named Cloudflare tunnel, remote tailnet node) is still supported via a `GINI_TRUSTED_ORIGINS` entry, and is intentionally invisible to `state.tunnel` — the record describes only runtime-managed tunnels. The user-facing per-provider instructions and the verification matrix live in [Remote Access](../remote-access.md).

## Endpoints

RPC action style, matching `/api/browser/*` and `/api/relays/*`. Every route returns the full `TunnelState`.

- `GET  /api/tunnel` — state + providers catalog (one fetch drives the whole UI).
- `POST /api/tunnel/select  {provider}` — save selection without connecting (status stays `idle`).
- `POST /api/tunnel/connect {provider?}` — begin connect; the optional `provider` overrides the saved selection.
- `POST /api/tunnel/cancel` — abort a pending login → status `idle` (keeps the selection).
- `POST /api/tunnel/disconnect` — tear down the tunnel, keep `selectedProvider` → status `idle`.

## Persistence

The singleton `TunnelSelectionRecord` lives at `state.tunnel` in the atomic JSON `state.json` (not `jsc:serialize`):

```ts
interface TunnelSelectionRecord {
  instance: Instance;
  selectedProvider: TunnelProviderId | null;
  status: TunnelStatus;
  url?: string;
  subdomain?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}
```

It is defaulted to `null` in `createEmptyState` and backfilled with `state.tunnel ??= null` in `normalizeState`, so legacy and hand-edited state files present a consistent shape. The catalog is rebuilt from code on every read, so adding a provider needs no state migration.

## The gini-relay connect flow (OAuth loopback + frpc)

`connectTunnel` validates the target provider is enabled, flips the record to `connecting`, and returns immediately. A **background** handshake (`runConnect`) then drives the gini-relay client library.

**Session reuse first.** `runConnect` reuses an existing session from the credential store (`store.readSession()`) and goes straight to `buildTunnel` — gini-relay sessions don't expire, so one login serves indefinitely and a reconnect needs **no browser and no re-login** (a reconnect with a stored session settled to `connected` in 1 second in a live test). The OAuth steps below run **only** when there is no stored session, or when a reused session is rejected by the relay (e.g. it was revoked) and `child.start()` throws — in that case `runConnect` discards the stored session and falls back to a fresh login so connect self-heals. When a login is needed:

1. `loginUrl({ store, relayUrl, loopbackPorts })` binds a `127.0.0.1` callback server, asks the relay for a Google consent URL, and hands back `{ url, waitForSession, cancel }`. The URL is **machine-bound** — the auth code returns to this host's loopback, so it must be approved in a browser on this same machine (RFC 8252 loopback redirect + PKCE).
2. The consent URL is opened in the **host browser** via `Bun.spawn(["open", url])` (the `openBrowser` seam).
3. `waitForSession()` resolves once the user approves: the relay exchanges the code and returns `{ token, subdomain, account }`, persisted by the store to the **instance-scoped** relay home (`~/.gini/instances/<inst>/relay`, via `relayHome(instance)`) so concurrent instances never share a device/session or stomp each other's tunnel. The manual providers do NOT have that per-instance isolation: tailscale serve and a named Cloudflare tunnel are **machine-global** resources (one serve config, one hostname), so they support at most one connected instance per machine — the tailscale driver refuses to connect when the serve config already fronts a different local port, and the per-provider guides carry the caveat.
4. `buildTunnel({ session, deviceId, port, defaults })` builds a supervised native `frpc` child for the **gateway port** (see *Exposed port*), and `child.start()` resolves when the proxy is actually up.
5. The record flips to `connected` with `url: https://<subdomain>.<relayDomain>` and the `subdomain` persisted.

On any failure — relay error, login rejection, frpc start failure — the record flips to `error` with the thrown message; `url` is cleared. If the connect was cancelled mid-flight (the supervisor was torn down by `cancel`/`disconnect` before the background flow settled), the flow logs `tunnel.connect.aborted` and leaves the cancel-written `idle` record intact rather than clobbering it with a spurious error.

### Exposed port

The tunnel exposes the instance's **gateway port** (`config.port`). The gateway is the single origin that serves its native `/api/*` directly AND reverse-proxies the web app — UI, assets, the `/api/runtime/*` BFF namespace, and HMR — to the Next.js web child (see ADR [gateway-web-reverse-proxy.md](gateway-web-reverse-proxy.md)). Exposing the gateway therefore makes one relay URL serve both the API (e.g. a mobile client's direct `/api/*` calls) and the web UI. Resolution order (`resolveLocalPort`), most-authoritative first:

1. `GINI_TUNNEL_PORT` env override (operator escape hatch / tests).
2. The gateway port (`config.port`), which the CLI pins to the actually-bound port before launch.

Before advertising a public URL, a **fresh, user-initiated connect** verifies the web app is actually serving via the shared identity probe (`isSupervisedWebChild` → `{ service: "gini-web", instance }` on `/api/runtime/__healthz`). Because that path is web-bound, the probe transits the gateway's reverse-proxy to the web child, so a green probe means the gateway is up AND the web child is reachable through it — a stale port or a down web child can't be published to a brand-new relay URL. A restart **resume** skips this gate (see *Reconcile + resume on startup*): it fronts the same already-published URL a remote client is actively watching, so it restores reachability immediately rather than waiting on the web child.

The gateway owns the host/origin trust decision for every web-bound request (loopback / relay-subdomain / `GINI_TRUSTED_ORIGINS`, fail-closed, plus a `Sec-Fetch-Site` check) and rewrites `Host`/`Origin` to loopback before proxying, so the inner web child is purely internal and needs no relay awareness. See ADR [bff-trust-boundary.md](bff-trust-boundary.md).

### Supervision

Each instance owns at most one in-flight login + one running `frpc` child, tracked in a module-level supervisor registry in `packages/runtime/src/integrations/tunnel.ts`:

- `disconnectTunnel` stops the `frpc` child (best-effort — a stop failure is swallowed) and resets to `idle`, keeping the selection. Its idle write skips if a newer connect claimed the instance during the (awaited) local logout, so it never clobbers a live reconnect.
- `cancelTunnel` aborts a pending login via the handle's `cancel()` (best-effort) and resets to `idle`. `selectProvider` likewise tears down any live child before flipping to `idle`, so changing the selection never orphans a running tunnel.
- A fresh `connectTunnel` tears down any prior in-flight login / live child and claims a fresh supervisor entry synchronously, so two concurrent connects get distinct entries: the superseded run aborts (before opening the OAuth browser, and stopping any child it spawned) instead of double-spawning or clobbering the winner.
- A live child that exits on its own **auto-reconnects**. frp's own client loop already recovers a transient control-plane drop *without exiting the process* (the relay config sets `loginFailExit: false`), so an exit that actually reaches the watcher is a real one (crash, OOM, `SIGKILL`, an unrecoverable relay rejection). Rather than dead-end at `error`, the exit watcher (`reconnectAfterExit`) flips `connected → connecting` and rebuilds the tunnel up to `GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS` times (default 5) with capped exponential backoff (`GINI_TUNNEL_RECONNECT_BASE_MS` default 1 s, doubling, capped at `GINI_TUNNEL_RECONNECT_MAX_MS` default 30 s), reusing the same session-reuse machinery the boot resume uses — **no browser**, and `gatewayReady` is already resolved because the process is running. A successful rebuild re-arms the watcher on the new child, so each later drop gets a fresh retry budget. A rebuild that settles `idle` (no usable session, or the local port isn't serving — a needs-user condition) stops the loop at `idle`; if every attempt errors, the budget is exhausted and the record flips to `error` naming the attempt count. Setting max attempts to `0` disables auto-reconnect — the watcher then flips straight to `error` (the pre-auto-reconnect behavior). Every state write is guarded by the same supervisor-identity + still-`connected` check as before, so an intentional cancel/disconnect/supersede is never clobbered. While a *manual* provider's rebuilds fail, the loop re-asserts `connecting` between attempts (a failed manual rebuild writes `error`) so a polling client sees recovery in progress rather than a transient `error`.

  The budget bounds **consecutive failures**, not a tunnel's lifetime: a successful rebuild re-arms a *fresh* budget, so a healthy link survives any number of separate drops over its lifetime. The deliberate consequence is that a tunnel that connects and then dies in a tight **flap** is retried indefinitely (no global flap ceiling) — but always paced by the capped backoff, so steady state is at worst one rebuild per `GINI_TUNNEL_RECONNECT_MAX_MS` (default 30 s). That is the intended behavior for a link meant to be up 24/7: a flap ceiling would strand the tunnel `error` after a burst of transient drops, which is strictly worse than retrying slowly. (A future flap detector could downgrade to a longer cool-off, but is not needed for correctness.)
- A relay (`frpc`) connect carries a **readiness timeout** (`GINI_TUNNEL_RELAY_READY_TIMEOUT_MS`, default 45 s, passed through `buildTunnel` to the gini-relay `Frpc`). Because `loginFailExit: false` keeps frpc alive retrying, a proxy that logs in but never *registers* (e.g. its subdomain is still held by a prior process's control connection during an overlapping restart) would otherwise leave `child.start()` pending forever and pin the record at `connecting`. The timeout makes `start()` reject (and kill the child), folding the stuck connect into `error` — and, under auto-reconnect, into a bounded retry instead of an infinite hang.
- Runtime shutdown stops every live child (`stopAllTunnels`, awaited in the SIGTERM drain) so `frpc` is torn down gracefully with the runtime rather than left forwarding past exit. The shutdown clears the supervisor registry first, so an in-flight auto-reconnect sees it was superseded and bails without rebuilding. If a reconnect was in flight (the record reads `connecting` but the entry was flagged `reconnecting`, descending from a tunnel that *was* `connected`), the drain **re-persists `connected`** before exit — otherwise the next boot's reconcile, which resets a stale `connecting` to `idle`, would silently leave the 24/7 link down across exactly the restart that interrupted its recovery. Re-persisting `connected` lets reconcile resume it like any cleanly-connected record. Both auto-reconnect (`reconnectAfterExit`) and the boot-resume itself flag their supervisor `reconnecting`, so a shutdown landing during *either* an exit-driven reconnect or a still-in-progress boot resume preserves the resumable record.

### Reconcile + resume on startup

The tunnel link is **long-lasting where the provider allows it**. The relay keys the public subdomain to a stable per-instance `deviceId` (persisted in the instance relay home, independent of the session token), so reconnecting — even after a re-login — reuses the **same** `https://<subdomain>.<relayDomain>` URL; tailscale's machine name and a named Cloudflare hostname are equally stable. ngrok's free tier and Cloudflare **quick** tunnels mint a fresh subdomain on every connect — including the boot resume — so only the stable providers can promise that a shared URL keeps reaching the agent 24/7 across restarts (the connected popover's copy makes the same per-provider distinction).

A persisted `connected` / `connecting` record describes an `frpc` child the runtime spawned **before it restarted** — that child is gone after a restart, so the live status is stale and a raw `connected` would make `GET /api/tunnel` falsely read connected. `reconcileTunnelOnStartup` (called from `packages/runtime/src/server.ts` boot, mirroring the `state.browser` stale-record clear) handles this:

- A record that was **`connected`** (for a still-enabled provider — manual providers re-detect their prerequisite first) is **resumed**: it flips to `connecting` (so the first `GET` never reads a stale `connected`) and kicks off a background reconnect that **reuses the stored relay session** — no browser login; manual drivers have no session and just reconnect (tailscale re-runs `serve --bg` to the same URL, ngrok/cloudflared mint a fresh quick URL while a named Cloudflare tunnel keeps its hostname) — and rebuilds the front **as soon as this process owns the gateway port**, without waiting on the web child. The tunnel fronts the **gateway** port, so its reachability does not depend on the web child finishing its (re)compile. This matters because the public URL is the **only channel** a remote client has to watch the restart finish: gating the rebuild on web-readiness would leave that client blind for the whole restart window — and, if the web child were slow, abandon the tunnel entirely (`idle`), so the client's update gate could never poll the restart to completion ("stuck on restarting"). Web-child readiness is the **client's** concern (its own polls) and the watchdog's, not the tunnel's. On success the stable providers (relay, tailscale, named Cloudflare) restore the same URL; ngrok/cloudflared-quick publish their fresh one.
  - **Port-ownership gate.** `reconcileTunnelOnStartup` runs *before* `Bun.serve` binds `config.port` (so the status flip lands before the gateway serves any `GET`). The status flip is synchronous and safe to run that early, but the background rebuild must not expose the port until **this** process owns it — otherwise the stable public URL could forward to a stale/foreign listener still holding `config.port` (and a returning browser would hand it its requests). So `packages/runtime/src/server.ts` passes a `gatewayReady` promise that it resolves the instant `Bun.serve` binds; the resume awaits it before building `frpc` (or running the manual driver). It is gated on the **gateway** bind alone — not the web child — so reachability still returns the moment the port is ours. A failed bind throws before `gatewayReady` resolves, so a doomed boot never publishes (and never builds an `frpc` child to leak).
  - **Override ports.** `gatewayReady` proves only `config.port`, so when a `GINI_TUNNEL_PORT` override points the tunnel at a port this process never binds, the resume can't use it. It falls back to the same identity check a fresh connect uses, but as a **bounded, cancellable poll** of the override port (the override target may still be coming up after a restart), settling `idle` if it never verifies within the budget — a stale override can never publish a foreign listener. The budget knobs `GINI_TUNNEL_RESUME_WAIT_MS` (default 60 s) and `GINI_TUNNEL_RESUME_POLL_MS` (default 1 s) apply to this override fallback only; the default gateway-port resume has no poll.
  - The resume is **non-interactive and best-effort**: if there is no usable stored session it settles back to `idle` rather than popping an OAuth tab on a headless server or surfacing a spurious `error`.
- A stale **`connecting`** record (an incomplete attempt with no guaranteed session) just resets to `idle`.
- `idle` / `error` records are left untouched.

The whole thing is best-effort — the boot site wraps it in a `.catch()` so a state-write failure can never crash startup, and the background reconnect captures its own errors into state.

**Clean shutdown vs. non-graceful exit.** On `SIGTERM` the drain awaits `stopAllTunnels()`, which terminates frpc/agent children cleanly AND turns childless provider-side state off (a tailscale serve config left live would route the public URL to whatever process binds the gateway port next); the record stays `connected` on disk so the next boot's reconcile re-publishes the same URL. A graceful shutdown therefore leaves no live front. A **non-graceful** exit (uncaught crash, `SIGKILL`, OOM, power loss) runs no drain: because `frpc` is spawned non-detached it is reparented rather than killed, so it can keep forwarding the public URL after the runtime dies, and the next boot's reconcile then marks state `idle` while that orphan is still live. The same applies to manual agent children (ngrok/cloudflared) on a non-graceful exit. Closing this residual window requires a persisted tunnel pidfile plus a signature-guarded reaper in reconcile (kill a matching live agent from a prior run) — deferred as a separate, higher-risk change since it kills processes by signature.

**Overlapping-restart subdomain collision.** A restart handoff (the autostart-refresh flow, or a launchd `KeepAlive` respawn) is gated only on the gateway **port** — `gini autostart enable` awaits `waitForPortFree(config.port)` before bootstrapping, and the successor's tunnel rebuild awaits only `gatewayReady` (the `Bun.serve` bind) — never on the relay **subdomain**. A same-instance restart reuses the same per-instance `deviceId`, hence the same subdomain, and the relay enforces one proxy per device with no evict hook (it drops a registration only when its frpc control connection closes). So if the successor's frpc `NewProxy` lands before the prior process's frpc has dropped server-side, frps rejects the duplicate `proxy_name` and the tunnel flaps. On the **graceful** path this is normally avoided: the old `SIGTERM` drain awaits `stopAllTunnels()` (which stops each frpc, severing its control connection) *before* the process exits and frees the port, so the successor — which can't bind the port until it's free — usually registers after the old registration is gone. The residual cases are a **non-graceful** old exit (no drain; the orphaned frpc keeps its registration) and a wedged stop within the bounded drain window. Both are **self-healing** via the readiness timeout (`relayReadyTimeoutMs`) + bounded auto-reconnect rather than a stuck state. For operators who want a deterministic lever, `GINI_TUNNEL_RELAY_SETTLE_MS` (default `0`, no delay) makes a gini-relay **resume** wait that long after the gateway bind before registering its frpc, giving the prior registration time to clear; it is applied only to the relay resume (manual providers mint fresh subdomains or are machine-global, so they never collide on a shared subdomain) and is kept at `0` by default because the relay URL is a remote client's only channel to watch a restart finish, so added latency would regress that.

### Injectable seams

Every gini-relay dependency is injectable through `setTunnelDeps` (the login primitive, tunnel builder, credential store, defaults resolver, host-browser opener, and local-port resolver), so unit tests exercise the full `connecting → connected / error / cancel / disconnect / reconcile` matrix without touching the network, OAuth, the host browser, or a spawned `frpc` child. `awaitTunnelSettled(instance)` lets a test await the background handshake deterministically.

## Components

- `packages/runtime/src/types.ts` — `TunnelProvider`, `TunnelProviderId`, `TunnelStatus`, `TunnelState`, `TunnelSelectionRecord`; optional `tunnel?: TunnelSelectionRecord | null` on `RuntimeState`.
- `packages/runtime/src/state/store.ts` — default in `createEmptyState`; backfill in `normalizeState`.
- `packages/runtime/src/state/records.ts` — `createTunnelRecord` (exported from the `packages/runtime/src/state` barrel).
- `packages/runtime/src/integrations/tunnel.ts` — behavior module (`getTunnel`, `selectProvider`, `connectTunnel`, `cancelTunnel`, `disconnectTunnel`, `reconcileTunnelOnStartup`), the supervisor registry, and the `setTunnelDeps` / `awaitTunnelSettled` test seams.
- `packages/runtime/src/server.ts` — calls `reconcileTunnelOnStartup` on boot (best-effort).
- `packages/runtime/src/http.ts` — the five thin routes + the `statusFromErrorMessage` 400 mappings.
- `packages/runtime/src/cli/commands/tunnel.ts` — `gini tunnel [select <provider> | connect [provider] | cancel | disconnect]`, registered in `packages/runtime/src/cli/index.ts`.
- `gini-relay` (npm/git dependency) — the client library: `loginUrl`, `buildTunnel`, `createStore`, `resolveDefaults`.

## Acceptance checks

- `GET /api/tunnel` on a fresh instance returns the four-provider catalog (gini-relay enabled, the rest disabled with their `requires` strings), `selectedProvider: null`, `status: "idle"`.
- `POST /api/tunnel/select {provider:"gini-relay"}` saves the selection and stays `idle`; selecting a disabled (`ngrok`) or unknown provider returns `400`.
- `POST /api/tunnel/connect` returns `status: "connecting"` immediately; the background handshake then flips `GET /api/tunnel` to `connected` (with `url: https://<subdomain>.<relayDomain>`) or `error` (with `message`). An explicit `provider` in the body overrides the saved selection.
- `POST /api/tunnel/cancel` aborts a pending login and `POST /api/tunnel/disconnect` stops the live `frpc` child; both return to `status: "idle"` keeping `selectedProvider`.
- A restart with a persisted `connected` record **resumes** on boot: it flips to `connecting` and the background reconnect restores the front immediately (the relay reuses its stored session with no browser login, and the rebuild waits only on the gateway bind — never the web child; stable providers re-publish the same URL, ngrok/cloudflared-quick a fresh one). With no stored session it settles to `idle`. A stale `connecting` record resets to `idle`; `idle`/`error` records are left untouched.
- A live child that exits unexpectedly while the runtime keeps running **auto-reconnects**: the record flips `connected → connecting → connected` with no user action (session reused, no browser), supervising the rebuilt child too. Repeated rebuild failures exhaust the bounded budget and settle `error` naming the attempt count; a rebuild with no usable session stops at `idle`. `GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS=0` disables it (flips straight to `error`). An intentional disconnect during the backoff bails the loop without rebuilding.
- A relay `frpc` child built by `makeDefaultDeps` carries a positive `readyTimeoutMs` (`GINI_TUNNEL_RELAY_READY_TIMEOUT_MS`, default 45 s), so a proxy that never registers can't hang `start()` — and thus the record — at `connecting` forever.
- Every route returns the full `TunnelState`.
- The CLI commands go through the gateway routes (verified by the CLI unit tests pinning URL + method + body).
- 100% line and function coverage on `packages/runtime/src/integrations/tunnel.ts` (every gini-relay seam injected via `setTunnelDeps`, so tests never hit the network/OAuth/browser/frpc) and `packages/runtime/src/cli/commands/tunnel.ts`; the additions to `records.ts`/`store.ts`/`http.ts` are covered by the integration, http, and CLI tests.
