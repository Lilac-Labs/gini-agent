# Gateway And Control Plane

Gini's runtime is the gateway: one Bun process per instance owns state, execution, tools, memory, jobs, approvals, audit, traces, and events. Every other surface is a client.

## Process Shape

```text
                 GATEWAY (Bun runtime, one per instance)
                 /api/* HTTP + /api/events/stream SSE
                 + reverse proxy → Next.js (UI, /api/runtime/*, HMR WS)
                              ^
          --------------------+--------------------
          |                    |                   |
      Next.js BFF          CLI / scripts       future clients
      browser UI           bearer token        mobile, MCP, messaging
      no browser token
      (also reachable through the gateway as a single origin)
```

The gateway starts from `packages/runtime/src/server.ts`. `gini start` launches it as a daemon. `gini run` launches it in the foreground and ties its lifecycle to the terminal.

## Next.js BFF

The web app in `packages/web/` is both a browser UI and a backend-for-frontend:

- browser requests go to `/api/runtime/*`
- `packages/web/src/app/api/runtime/[...path]/route.ts` forwards to the gateway
- the gateway bearer token stays server-side in the Next.js process
- the browser never receives the token

The web app is stateless. Restarting it does not lose runtime data because all state lives in the gateway.

## Single-origin reverse proxy

The gateway can also front the web app so the whole product is reachable on **one origin** (the gateway port) instead of two. `packages/runtime/src/http.ts` routes by path:

- `/api/*` (except `/api/runtime/*`) — handled natively by the gateway, bearer-gated.
- `/api/runtime/*` — proxied to the Next.js BFF so its server-side token injection still runs.
- everything else (HTML, `/_next/*` assets) — proxied to the Next.js server.
- WebSocket upgrades (Next HMR at `/_next/webpack-hmr`) — bridged socket-to-socket (`packages/runtime/src/server.ts` wires `proxyWebSocketUpgrade` + `webSocketProxyHandler`).

When the web server is down (or a `--no-web` instance) the proxy falls back to the runtime banner. The upstream port is resolved through `packages/runtime/src/web-target.ts`, which validates the recorded `web.port` against the BFF `/api/runtime/__healthz` (`service: "gini-web"` + matching `instance`) before forwarding — a reused/stale port can't route to a foreign instance. This single origin is what lets a tunnel expose UI + API over one public URL. The gateway is the single operator front (`gini run`/`start` advertise the gateway origin): direct access to the inner Next.js port still serves the proxied UI and the `/api/runtime/*` BFF, but the gateway-native `/api/*` surface is not served there. The inner port binds loopback (`-H 127.0.0.1`, reachable only from the local machine, never the LAN); a non-loopback front is refused (404) and must use the gateway.

## CLI

The CLI entrypoint is `packages/runtime/src/cli.ts`, which delegates to the modular command tree under `packages/runtime/src/cli/`. CLI commands read the selected instance config, attach the bearer token, and call the same gateway API used by other clients.

Some local harness operations, such as smoke setup and evidence bundle generation, can use domain helpers directly when they need to manage a runtime process or local files. The `gini import apply openclaw` command is the load-bearing exception: it requires the gateway stopped for the target instance and mutates `state.json`, `secrets.env`, workspace files, skills, and `memory.db` in-process. See [Openclaw Migration](./adr/openclaw-migration.md) for the lock model.

## Instances

Instances isolate state, logs, ports, tokens, workspaces, and web build directories. The installed end-user CLI uses the `default` instance; `bun run gini` from a repo checkout auto-derives the instance from the repo directory basename so each worktree is isolated.

```sh
bun run gini run --instance feature-x
bun run gini start --instance personal
```

The `default` instance is pinned to memorable ports — web `7777`, runtime `7778` — so end-users always know what URL to hit. Other instances derive deterministic hash-based ports in a 100-port window (runtime base 7337, web base 3000) and walk forward if a port is busy. Explicit `--port`, `--web-port`, `GINI_PORT`, and `GINI_WEB_PORT` stay strict: if the pinned port is busy, startup fails instead of silently moving.

## Disk Layout

```text
~/.gini/
├── instances/
│   └── <instance>/
│       ├── config.json
│       ├── state.json
│       ├── memory.db
│       ├── runtime.pid
│       ├── runtime.port
│       ├── web.pid
│       ├── web.port
│       ├── traces/
│       ├── snapshots/
│       ├── skills/
│       ├── workspace/
│       ├── imports/
│       └── logs/
└── models/
```

`~/.gini/models/` is shared across instances for local embedding and reranker model caches.

## Auth

Runtime auth is **owner-token-only**: the gateway uses a per-instance owner bearer token stored in the instance `config.json`, and a bearer authorizes iff it equals that singleton token — the resolved credential id is always `owner` (`resolveCredentialFromBearer` / `authorizedBearer` in `packages/runtime/src/http.ts`). The Next.js BFF reads the token server-side and does not expose it to client JavaScript. There are no per-device session tokens; revocation means rotating the config token. See [ADR: Owner-token-only authentication](adr/owner-token-auth.md).

The trust boundary lives at the **gateway front**. Every web-bound request (non-`/api` traffic and the `/api/runtime/*` BFF namespace) is validated by the gateway before it is reverse-proxied — both read-only GETs (which would otherwise leak RuntimeState contents under DNS rebinding) and mutating POST/PUT/PATCH/DELETEs — and the gateway then rewrites `Host`/`Origin` to loopback so the inner Next.js child is purely internal and relay-agnostic. The gateway accepts a web-bound request when its `Host`/`Origin` is one of:

1. **Loopback** — `localhost` / `127.0.0.1` / `[::1]`. The operator's own machine; a DNS-rebinding page cannot forge a loopback `Host`.
2. **A `GINI_TRUSTED_ORIGINS` entry** — comma-separated full origins (scheme + host + port), e.g. `GINI_TRUSTED_ORIGINS=https://gini-server.tail-xyz.ts.net,http://localhost:3000`. The knob for *manually-run* fronts (a reverse proxy, a named Cloudflare tunnel, a serve the runtime isn't driving); see [Remote Access](remote-access.md) for the per-provider setup. If the var is set but every entry is malformed, the gate fails closed for every web-bound request on a front not covered by the other lanes until fixed — a typo bricks the exposure loudly rather than silently downgrading.
3. **A gini-relay subdomain** — independent of `GINI_TRUSTED_ORIGINS`. The relay domain (`GINI_RELAY_DOMAIN`, default `gini-relay.lilaclabs.ai`) or one of its per-device subdomains. Safe because the relay owns DNS for `*.<relayDomain>` and routes each random per-device subdomain only to its owner's `frpc` tunnel — an attacker cannot rebind a relay name to this machine.
4. **A runtime-managed tunnel's connected URL** — when the runtime itself drives a tunnel (`tailscale serve`, ngrok, a cloudflared quick tunnel via the tunnel panel/CLI), the connected record's host is trusted automatically for exactly as long as the record stays `connected`, and revoked atomically with any transition away from it. The runtime established the front and the provider owns the DNS for the name, so it is as un-rebindable as a relay subdomain. See [Tunnel Connectivity](adr/tunnel-connectivity.md).

A cross-site `Sec-Fetch-Site` value is rejected on every lane, and an unsafe method (POST/PUT/PATCH/DELETE) without an `Origin` is rejected — a non-browser client must use the native `/api/*` surface with the owner bearer. The inner BFF keeps its own loopback/allowlist guard as defense-in-depth for direct access to the Next.js port; because the gateway only ever forwards a loopback `Host`/`Origin`, the BFF trusts that internal traffic via a loopback short-circuit and carries no relay awareness of its own. See [ADR: BFF trust boundary](adr/bff-trust-boundary.md) and [ADR: Tunnel connectivity](adr/tunnel-connectivity.md).

Closing the non-loopback fallback path blocks the DNS-rebinding shape where an attacker page sets `Origin` to a hostname they control but rebinds DNS to the gateway's loopback / tailnet IP — the rebound host equals itself, so a Host-comparison alone would pass. The allowlist (or the loopback restriction) takes that codepath off the table.

The loopback lane is anchored to the **socket peer**, not the `Host` header: a `Host: localhost` request arriving from a non-loopback peer (possible on a non-loopback bind, e.g. a Docker published port) is refused — 401 for `/api/*`, 404 for pages. A trusted non-loopback front gets the same access as loopback; there is no per-request cookie or pairing gate beyond the lanes above, so expose a front only to devices you fully trust or place your own authentication proxy in front of it. See [ADR: Owner-token-only authentication](adr/owner-token-auth.md).

## Lifecycle Commands

| Command | Behavior |
| --- | --- |
| `gini start --instance X` | daemon; runtime and web keep running after the shell exits |
| `gini run --instance X` | foreground; runtime and web stop when the process receives Ctrl-C/HUP/TERM |
| `gini stop --instance X` | stops runtime and web for an instance |
| `gini update` | updates the installer-managed runtime and restarts a running instance when code changed |
| `gini uninstall --instance X` | removes one instance's local state |
| `gini uninstall` | full uninstall: stops every instance, removes installer-managed wrapper/runtime/PATH block, prompts before deleting instance state |

Use `gini run` for coding-agent worktrees and CI. Use `gini start` for a persistent personal runtime.
