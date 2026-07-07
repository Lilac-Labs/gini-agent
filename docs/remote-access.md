# Remote Access

An instance's gateway binds to loopback. To reach Gini from a phone or another machine you front the **gateway port** with a tunnel — one public origin then serves both the web UI and the `/api/*` surface (see [Gateway And Control Plane](gateway.md)).

All four tunnel providers are drivable from the web tunnel panel and `gini tunnel`, and each has its own self-contained guide — the same pages the app opens in a slide-over when a provider needs setting up (tap Connect on a provider that isn't ready and its guide opens; the sidebar's Remote access entries open them directly):

- [Gini Relay](remote-access/gini-relay.md) — managed, zero setup, stable subdomain.
- [Tailscale](remote-access/tailscale.md) — tailnet-private, stable URL, TLS on your own machine.
- [ngrok](remote-access/ngrok.md) — public URL, random per connect on the free tier.
- [Cloudflare](remote-access/cloudflare.md) — your own domain via a named tunnel (SSE works), quick-tunnel fallback.

The relay is always available; the other three enable when their host prerequisite is detected (`tailscale` logged into a tailnet, an ngrok authtoken, the `cloudflared` binary). Tapping **Connect** re-checks availability server-side and either connects or rejects with the reason — so a freshly-installed CLI works without restarting anything.

When the runtime drives a tunnel itself, the connected URL's origin is trusted **automatically** for as long as the record is connected (and revoked the moment it isn't) — no `GINI_TRUSTED_ORIGINS` needed. The env var remains the knob for manually-run fronts (below).

> Terminology: this page is about **tunnel providers**. The similarly-named `gini connectors` CLI and `/api/connectors` routes manage *service* connectors (Google, Linear, MCP-backed tools) and are unrelated to remote access.

## Selecting a mode — and confirming it

The runtime keeps one tunnel selection per instance: a `selectedProvider` plus a connection `status` (`idle`, `connecting`, `connected`, or `error`). Drive it with:

```bash
gini tunnel                      # status + provider catalog
gini tunnel select <provider>    # save a selection (stays idle)
gini tunnel connect [provider]   # connect (provider arg overrides the saved selection)
gini tunnel cancel               # abort a pending login, keep the selection
gini tunnel disconnect           # tear down the tunnel, keep the selection
```

Every command returns the full tunnel state, so any one call tells you whether a mode is selected and what it is. The same state is available to every client at `GET /api/tunnel` (bearer-gated). The contract and connect flow live in ADR [tunnel-connectivity.md](adr/tunnel-connectivity.md).

### The confirmation surfaces

| Surface | How | What it tells you |
| --- | --- | --- |
| CLI | `gini tunnel` | `selectedProvider: null` means **no mode is selected**; a provider id means that mode is selected. `status` + `url` tell you whether it is actually live. |
| HTTP | `curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/tunnel` | Same `TunnelState` JSON — the web UI polls this same state through the BFF (`/api/runtime/tunnel`, token injected server-side). |
| Web UI | Sidebar tunnel pill | `Off / no tunnel` when nothing is connected; `Live / <provider>` with a green dot when connected. Opening it shows the provider panel with the selected row marked `Selected` (or `Connected`). |
| Disk | `state.json` → `tunnel` | The persisted `TunnelSelectionRecord` (`selectedProvider`, `status`, `url`, `createdAt`/`updatedAt`). Survives restarts. |
| Audit | audit rows `tunnel.select`, `tunnel.connect`, `tunnel.connected`, `tunnel.error`, `tunnel.cancel`, `tunnel.disconnect`, `tunnel.reconcile` | Who changed the mode and when, with the provider id in `evidence`. |
| Logs | `~/.gini/instances/<instance>/logs/runtime.jsonl` | `tunnel.connected`, `tunnel.connect.error`, `tunnel.exited`, `tunnel.resume.*` events from the background connect/resume flows. |

A fresh instance reads:

```json
{ "providers": [ ... ], "selectedProvider": null, "status": "idle" }
```

After `gini tunnel select gini-relay`:

```json
{ "providers": [ ... ], "selectedProvider": "gini-relay", "status": "idle" }
```

`url` appears only when `status` is `connected`; `message` only on `error`. The selection persists across gateway restarts (a `connected` tunnel is resumed automatically on boot; see the reconcile section of ADR [tunnel-connectivity.md](adr/tunnel-connectivity.md)).

`GET /api/tunnel` is cheap to poll: it reads the persisted record and rebuilds the static catalog in process — no network calls — so the web UI polling it (through the BFF) during `connecting` costs effectively nothing.

### Selecting a provider that isn't available

Only catalog-enabled providers can be selected. Selecting or connecting a provider whose prerequisite is genuinely missing is rejected **before any state changes** with HTTP 400 (CLI exit 1) and the machine-readable code `provider_unavailable` — the web UI uses that code to open the provider's guide instead of failing silently:

```text
$ gini tunnel select tailscale     # on a machine without a tailnet login
Tunnel provider Tailscale is not available (requires Tailscale network).

$ gini tunnel select wireguard
Unknown tunnel provider: wireguard
```

So: an unavailable provider can never be the selected mode. If you front Gini with a tool the runtime isn't driving (a manual front), `gini tunnel` intentionally keeps reporting its own selection — the runtime only reports tunnels *it* manages. Confirm a manual front at its own layer instead (each provider guide shows how).

Switching the selection away from a live provider tears the old tunnel down first (including the persistent tailscale serve config), and a connected front's origin trust always tracks the record — connected = admitted, anything else = revoked.

## Manual fronts

For anything the drivers don't cover — a reverse proxy, or any front you run yourself (each provider guide has its provider-specific variant of this) — the same recipe always works. The examples below use `<gateway-port>` for the instance's gateway port — find yours with `gini status`.

1. **Expose the gateway port** (not the web port) with your tunnel tool. One origin then serves UI + API. For a durable tunnel, pin the port first: non-default instances derive hash-based ports that **walk forward when busy** (see [Gateway And Control Plane](gateway.md)), so after a restart a long-lived tunnel can silently forward to whatever process now owns the old port. Launch with an explicit `--port`/`GINI_PORT` — pinned ports stay strict and fail instead of moving — and stop/recreate the tunnel whenever the port or instance changes.
2. **Trust the external origin.** The gateway fail-closes web-bound requests from hostnames it doesn't know (page navigations 404, `/api/runtime/*` 403). Set `GINI_TRUSTED_ORIGINS` to the comma-separated **full origins** of your tunnels, in the gateway process environment at launch:

   ```bash
   GINI_TRUSTED_ORIGINS=https://my-mac.tailnet-name.ts.net,https://gini.example.com gini start
   ```

   To make it durable, add the line `GINI_TRUSTED_ORIGINS=...` to `~/.gini/secrets.env` — the installed `gini` wrapper sources it on every launch, and `gini autostart enable` merges it into the launchd plist (re-run that after editing). If the variable is set but contains no parseable origin, the gateway refuses every web-bound request on a front not covered by the other trust lanes until it's fixed — the typo bricks exactly the manual front you were configuring, loudly rather than silently downgrading. See ADR [bff-trust-boundary.md](adr/bff-trust-boundary.md).
3. **Understand what trust grants.** A trusted origin is **owner-equivalent**: any browser arriving on it gets the same access as loopback — there is no per-device pairing gate (see ADR [owner-token-auth.md](adr/owner-token-auth.md)). Expose a manual front only to devices and networks you fully trust (a tailnet, a password-protected proxy), or use the hosted edge when multiple users need access. Non-browser clients use the native `/api/*` surface with the owner bearer from `config.json` — a singleton with no per-device revocation (revoke by rotating it), so treat any device holding it as the operator.

## Verifying any front

The full decision table — identical across every tunnel:

| Probe through the tunnel | Origin **not** trusted | Origin trusted |
| --- | --- | --- |
| Page navigation (`/`) | `404` | `200` (serves the app) |
| `GET /api/runtime/__healthz` (web-bound) | `403` | `200` |
| `GET /api/tunnel` with bearer (native API) | `200` | `200` |

The third row is the discriminator when something is wrong: the native bearer-gated API ignores the origin gate, so a `200` there means the tunnel and gateway are healthy and any `404` on pages is the origin gate (for a runtime-driven tunnel that means it is no longer `connected`; for a manual front, fix `GINI_TRUSTED_ORIGINS`). If even the bearer probe fails, the tunnel itself is broken. Provider-specific symptoms live in each provider's guide.
