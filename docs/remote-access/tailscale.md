# Tailscale

Private to your tailnet — no public exposure, TLS terminates on your own machine (Tailscale never sees plaintext), and the URL is stable forever. The recommended option when every device that needs Gini can join your tailnet.

> **One instance per machine.** The serve config is machine-global (one `https://<machine>.ts.net` front), so only one Gini instance can be connected via Tailscale at a time. Connect refuses when the serve config already fronts a different local port — disconnect that instance (or your own manual serve) first.

## Set it up

1. Install Tailscale: `brew install tailscale` (or the Mac App Store app).
2. Sign in and join your tailnet: `tailscale up`.
3. That's it. Tap **Connect** — Gini runs `tailscale serve` for you.

Connect publishes:

```text
https://<machine>.<tailnet>.ts.net
```

…private to your tailnet. The URL **survives gateway restarts** — on boot Gini re-publishes the same address. Disconnect (and a clean gateway stop) turns the serve config off, so the name can never route to whatever binds the port next.

## What Connect runs

```bash
tailscale serve --bg http://127.0.0.1:<gateway-port>
```

The connected URL's origin is trusted by the gateway automatically for exactly as long as the tunnel is connected. A trusted front is **owner-equivalent** — anyone on your tailnet who can reach the URL gets the same access as loopback, with no per-device pairing gate (see ADR [owner-token-auth.md](../adr/owner-token-auth.md)) — so keep the tailnet limited to devices you fully trust or put an authentication proxy in front of it.

## Confirm it's live

- Sidebar pill: `Live / tailscale`.
- `tailscale serve status` shows the proxy to the gateway port.
- A page request to the `ts.net` URL serves the app.
- If the `ts.net` name doesn't resolve on some machine, MagicDNS is off for that resolver — enable it, or pin with `curl --resolve <name>:443:<tailscale-ip>`.

## Public exposure (optional)

`tailscale funnel` exposes the same serve config to the public internet; the origin string stays identical. Run it yourself, deliberately.

## Running it manually instead

If you front Gini with a serve config Gini doesn't manage (for example on a different tailnet node), the runtime won't know about it — trust the origin explicitly and confirm at the Tailscale layer:

```bash
tailscale serve --bg http://127.0.0.1:<gateway-port>
# then launch the gateway with:
GINI_TRUSTED_ORIGINS=https://<machine>.<tailnet>.ts.net gini start
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Connect says it requires `Tailscale network` | Not logged into a tailnet (or `tailscaled` not running) | `tailscale up`, then Connect again |
| `ts.net` URL doesn't resolve | MagicDNS off for that resolver | Enable MagicDNS, or `curl --resolve <name>:443:<tailscale-ip>` |
| Another device can't reach the URL | It isn't on your tailnet | Join it to the tailnet, or use ngrok / Cloudflare / the relay for public access |
