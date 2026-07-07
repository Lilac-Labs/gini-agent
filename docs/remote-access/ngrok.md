# ngrok

A public URL through ngrok's edge. Quick to set up; the free tier mints a **random URL on every connect** and shows visitors a one-time interstitial. ngrok terminates TLS at its edge, so ngrok can observe everything proxied — cookies, device tokens, and chat/task content.

## Set it up

1. Install ngrok: `brew install ngrok`.
2. Create a free account at <https://dashboard.ngrok.com> and copy your authtoken.
3. Authenticate the agent: `ngrok config add-authtoken <token>`.
4. Tap **Connect** — Gini runs the agent for you.

## What Connect runs

```bash
ngrok http <gateway-port>
```

…as a supervised child. The agent reports a URL like `https://<id>.ngrok-free.app`, which Gini publishes and trusts automatically for exactly as long as the tunnel is connected. If the agent dies, the record flips to `error` and the front's trust is revoked. Disconnect kills the agent.

The published front is **owner-equivalent**: any browser reaching the URL gets the same access as loopback, with no per-device pairing gate (see ADR [owner-token-auth.md](../adr/owner-token-auth.md)). The URL is public — treat it as an operator credential and share it only with devices you fully trust, or use the hosted edge for multi-user access.

## Free-tier caveats

- The URL is **random per connect** — reconnecting mints a new one (a paid reserved domain avoids the churn).
- A browser's first visit hits the one-time ngrok interstitial ("You are about to visit …") — click Visit Site. Non-browser clients can suppress it with a `ngrok-skip-browser-warning` request header.

## Confirm it's live

- Sidebar pill: `Live / ngrok`.
- `gini tunnel` shows `connected` plus the current URL.
- A page request to the URL (past the interstitial) serves the app.

## Running it manually instead

If you run the agent yourself (for example with a reserved domain), the runtime won't know about it — trust the origin explicitly:

```bash
ngrok http <gateway-port> --url https://you.ngrok.app
# then launch the gateway with:
GINI_TRUSTED_ORIGINS=https://you.ngrok.app gini start
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Connect says it requires `ngrok account` | No authtoken configured | `ngrok config add-authtoken <token>`, then Connect again |
| `error: … authtoken is invalid` after Connect | The token was revoked or mistyped | Re-copy it from the dashboard, `ngrok config add-authtoken` again |
| Visitors see an ngrok warning page | Free-tier interstitial (once per browser) | Click Visit Site, or send `ngrok-skip-browser-warning` from non-browser clients |
| The URL stopped working after a reconnect | Free-tier URLs are random per connect | Use the new URL from the popover, or pay for a reserved domain |
