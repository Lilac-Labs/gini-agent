# Cloudflare

Two modes, picked automatically when you tap **Connect**:

- **Named tunnel (best)** — when `~/.cloudflared/config.yml` declares a tunnel, Gini runs **your** tunnel pointed at the gateway and publishes its stable hostname on your own domain. Live updates (SSE) work.
- **Quick tunnel (fallback)** — with no named config, Gini mints a random `https://<words>.trycloudflare.com` URL. No account needed, but it's testing-grade: quick tunnels **don't proxy SSE**, so the UI loads but live updates need a manual reload, and the URL changes on every connect.

Both modes terminate TLS at Cloudflare's edge, so Cloudflare can observe everything proxied — cookies, device tokens, and chat/task content.

> **Named tunnels: one instance per machine.** `~/.cloudflared/config.yml` names one tunnel/hostname, and Cloudflare load-balances across every running connector — two Gini instances both running it would split the hostname's traffic between two different gateways. Connect the named tunnel from at most one instance; quick tunnels mint distinct URLs and don't collide.

## Set it up

1. Install cloudflared: `brew install cloudflared`.
2. For the **named tunnel** (recommended, needs a Cloudflare account + your own domain):

   ```bash
   cloudflared tunnel login                       # browser consent, writes cert.pem
   cloudflared tunnel create <name>               # writes <id>.json credentials
   cloudflared tunnel route dns <name> gini.your-domain.com
   ```

   …and a `~/.cloudflared/config.yml` declaring the tunnel (the ingress `service` value doesn't matter to Gini — it overrides the origin at connect time; see the dedicated-tunnel note below):

   ```yaml
   tunnel: <id>
   credentials-file: /Users/you/.cloudflared/<id>.json
   ingress:
     - hostname: gini.your-domain.com
       service: http://localhost:3000
     - service: http_status:404
   ```

3. Tap **Connect**. With the config present, Gini publishes `https://gini.your-domain.com`; without it, a quick tunnel.

> Use a tunnel dedicated to Gini: while connected, Gini serves as the tunnel's only origin, so **every** hostname whose DNS routes to that tunnel id reaches Gini — not just the first ingress hostname. If the tunnel carries other hostnames for other apps, give Gini its own `cloudflared tunnel create` + `route dns` instead.

## What Connect runs

Named mode:

```bash
cloudflared --config /dev/null tunnel --cred-file <config's credentials> run --url http://127.0.0.1:<gateway-port> <tunnel-id>
```

Quick mode:

```bash
cloudflared --config /dev/null tunnel --url http://127.0.0.1:<gateway-port>
```

`--config /dev/null` is deliberate in **both** modes: when cloudflared loads ingress rules, it ignores the `--url` origin override (the named run would route your hostname at the config's own service instead of the gateway), and a present `config.yml` silently breaks quick tunnels (they register but the edge serves 404s). Your `config.yml` is never modified — while Gini's tunnel is connected, the hostname serves Gini; after disconnect, your own `cloudflared` runs serve it again as before.

Either way the agent runs as a supervised child; the published URL's origin is trusted automatically for exactly as long as the tunnel is connected. A trusted front is **owner-equivalent** — any browser reaching the URL gets the same access as loopback, with no per-device pairing gate (see ADR [owner-token-auth.md](../adr/owner-token-auth.md)) — so share the URL only with devices you fully trust or put an authentication proxy in front of it.

## Confirm it's live

- Sidebar pill: `Live / cloudflare`.
- `gini tunnel` shows `connected` plus the URL (your hostname, or a `trycloudflare.com` one).
- A page request to the URL serves the app.
- Named mode: live updates stream (watch the dashboard tick); quick mode: they don't — reload to refresh.

## Running it manually instead

To front Gini with a cloudflared process Gini doesn't manage, point your ingress `service` at `http://127.0.0.1:<gateway-port>`, run `cloudflared tunnel run <name>` yourself, and trust the origin explicitly:

```bash
GINI_TRUSTED_ORIGINS=https://gini.your-domain.com gini start
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Connect says it requires `cloudflared CLI` | Binary not installed / not on the gateway's PATH | `brew install cloudflared`, then Connect again |
| Quick tunnel: edge `404`s, headers only `server: cloudflare` | A `config.yml` exists (quick tunnels break with it) — Gini's own runs already pass `--config /dev/null`, so this only bites manual runs | Pass `--config /dev/null`, or use the named mode |
| UI loads but never updates live | Quick tunnels don't proxy SSE | Set up the named tunnel (steps above) |
| Named connect publishes the wrong hostname | The config's **first** ingress hostname is what Gini publishes | Put the hostname you want Gini on first in `ingress:` |
