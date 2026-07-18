# ADR: Owner-Token-Only Authentication

- **Status:** Accepted
- **Supersedes:** [Device-Pairing Authentication](device-pairing-auth.md)
- **See also:** [Gateway Reverse Proxy](gateway-web-reverse-proxy.md), [BFF Trust Boundary](bff-trust-boundary.md), [Tunnel Connectivity](tunnel-connectivity.md), [Docker + Xvfb Deployment](docker-xvfb-deployment.md)

## Context

Gini's runtime is a single-user personal agent: one gateway instance has one
operator. The former device-pairing subsystem created per-device sessions,
approval handshakes, cookie gates, pairing state, and CLI commands, but every
credential it minted was owner-equivalent. It added surface area without
creating a meaningful isolation boundary.

## Decision

The runtime authorizes exactly one credential: the instance owner token stored
in `config.json`. A bearer authorizes only when it equals `config.token`; the
resolved credential id is always `owner`.

- Native `/api/*` callers send `Authorization: Bearer <config.token>` (or the
  supported query token on streaming endpoints).
- The Next.js BFF reads the token server-side and injects it only after its
  Host/Origin and CSRF checks pass. Browser JavaScript never receives it.
- The mobile client stores the operator-provided runtime URL and owner token,
  sends the bearer on every request, and clears both locally on disconnect.
- A signed upload URL is a narrow exception: its HMAC uses `config.token`, is
  scoped to one upload id and method, and expires.
- Push-device rows track notification endpoints, not credentials. They all use
  the literal owner credential id.

The pairing subsystem is removed: there are no pairing routes, device session
tokens, pairing cookies, approval codes, paired-device records, or pairing CLI
commands. Legacy pairing collections are discarded while normalizing older
state files.

### Web-front trust

The gateway validates every web-bound request before proxying it to the BFF.
Accepted fronts are loopback, the configured relay domain, a runtime-managed
tunnel, or an explicit `GINI_TRUSTED_ORIGINS` entry. These lanes grant access
to the browser surface, whose BFF then injects the owner token.

A loopback Host is trusted only when the socket peer is also loopback. This
prevents a remote peer on a non-loopback/container bind from forging
`Host: localhost`. Such requests receive 401 on `/api/*` or 404 on pages.

A trusted non-loopback browser front is owner-equivalent. Operators must expose
one only to networks and devices they fully trust or put their own
authentication proxy in front of it. Gini does not implement multi-user
sessions inside a runtime instance.

## Consequences

- One token and one credential id match the runtime's single-user model.
- Revocation is coarse: rotate `config.token` and update clients.
- Audit records distinguish surfaces, tasks, and agents, not operator devices.
- Browser safety depends on the gateway/BFF origin checks and on limiting
  trusted remote fronts.
- Mobile and other native clients may hold the owner token; browser clients do
  not.

## Acceptance Checks

- Owner-only native API authorization:
  `packages/runtime/src/http.part1.test.ts`.
- Forged loopback Host rejection and genuine loopback admission:
  `packages/runtime/src/http-nonloopback-bind.test.ts`.
- BFF origin and CSRF enforcement: web proxy tests.
- Signed upload capability scope and expiry:
  `packages/runtime/src/http.part4.test.ts`.
- Mobile bearer requests: `packages/mobile/src/api.test.ts`.
