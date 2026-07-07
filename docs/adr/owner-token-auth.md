# ADR: Owner-Token-Only Authentication

- **Status:** Accepted
- **Supersedes:** [Device-Pairing Authentication](device-pairing-auth.md)
- **See also:** [Gateway Reverse Proxy](gateway-web-reverse-proxy.md), [BFF Trust Boundary](bff-trust-boundary.md), [Tunnel Connectivity](tunnel-connectivity.md), [Docker + Xvfb Deployment](docker-xvfb-deployment.md)

## Context

Gini's runtime is a single-user personal agent: one gateway per instance, one
operator. The former device-pairing subsystem (per-device session tokens,
operator-approved handshakes, a `gini_session` cookie gate on non-loopback web
fronts, `/api/pairing/*` routes, a `/pair` redirect, `PairedDevice` /
`PairingCode` / `PairingRequest` state, `gini pairing` / `gini devices` CLI
commands) implemented a multi-credential model on top of that single-user
runtime. It carried real complexity — its own claim flows, rate limits,
binding cookies, an apple-app-site-association route, a relay cookie gate,
a bootstrap allowlist — while every credential it minted was owner-equivalent
anyway: a paired session could approve further devices exactly like loopback.

The real multi-user boundary is a hosted edge in front of the runtime:
Google OAuth, per-user sessions, and per-instance isolation. Inside a single runtime, a second
credential class bought no isolation, only surface area.

## Decision

**The runtime authorizes exactly one credential: the owner token.** A bearer
authorizes iff it equals the singleton `config.token`; the resolved credential
id is always `"owner"`. The helpers live in `packages/runtime/src/http.ts`
(`resolveCredentialFromBearer` / `authorizedBearer`, alongside
`edgeTrustedRequest`).

- **The pairing subsystem is deleted**: `governance/pairing.ts`, the
  `/api/pairing/*` routes, `/api/devices` (+revoke), the relay
  `gini_session`/`gini_pair`/`gini_client` cookie gate, the `/pair` redirect,
  the pairing bootstrap allowlist, the apple-app-site-association route, the
  `PairedDevice`/`PairingCode`/`PairingRequest` state (and the `"pairing"`
  event kind), and the `gini pairing`/`gini devices` CLI commands.
  `normalizeState` sheds the legacy `pairingCodes`/`pairingRequests`/`devices`
  keys from old `state.json` files.
- **Non-loopback web fronts rely on host/origin trust alone.** The four trust
  lanes (loopback, relay-domain, runtime-managed tunnel, `GINI_TRUSTED_ORIGINS`)
  remain, plus a **forged-loopback peer guard**: a `Host: localhost` request
  arriving from a non-loopback socket peer is refused (401 for `/api/*`, 404
  for pages) unless edge-trusted. A trusted non-loopback front gets the same
  access as loopback — no pairing cookie gate. Remote multi-user access is the
  hosted edge's job.
- **A hosted deployment authenticates at the edge.** Google OAuth runs at
  the edge; the browser carries an edge session cookie and mobile carries the
  same session token as a Bearer. The edge proxy injects `X-Gini-Edge` **and**
  replaces `Authorization` with the runtime's own `config.token` upstream, so
  every proxied request resolves as owner. `GINI_EDGE_SECRET` grants
  owner-equivalence.
- **Mobile signs in with Google via the edge** (`/auth/google?mode=mobile` →
  `gini://auth?token=…` redirect), stores `{baseUrl, token}` (AsyncStorage
  `gini.auth.v1`), and sends the Bearer on every call; sign-out POSTs
  `/auth/mobile/logout` then clears locally. No QR/relay/pairing; the Google
  login renders only when the build sets `EXPO_PUBLIC_EDGE_BASE_URL`, and the
  manual `/setup` connect screen (owner bearer paste) remains for self-hosted
  gateways.
- **The push-device registry is kept** (`/api/push/devices`, `X-Device-Token`,
  APNs) — it tracks notification endpoints, not credentials; its credential id
  is always `"owner"`. `/api/mobile/bootstrap` remains, owner-bearer-gated.

## Consequences

- Remote self-host fronts rely on the host/origin trust lanes plus the
  forged-loopback peer guard; anyone a trusted front admits is
  owner-equivalent. Expose a front only to devices you fully trust, or use
  the hosted edge for multi-user access.
- Revocation is coarse: rotate the `config.token` (self-host) or delete the
  edge session row (hosted). There is no per-device revocation inside the
  runtime.
- All operator devices share one credential pool — audit rows distinguish
  surfaces, not devices.
- The runtime sheds an entire subsystem (routes, state records, CLI commands,
  cookie plumbing, web pairing UI) with no isolation loss, because every
  pairing credential was already owner-equivalent.

## Acceptance Checks

- Owner-only 401 pin: `packages/runtime/src/http-nonloopback-bind.test.ts`
  ("gini_device_-shaped token is 401") and `packages/runtime/src/http.test.ts`
  ("only the owner bearer authorizes the mobile contracts").
- Edge-secret owner-equivalence: `packages/runtime/src/http-edge-secret.test.ts`.
- Mobile OAuth login/logout: `packages/mobile/src/oauth-login.test.ts`.
