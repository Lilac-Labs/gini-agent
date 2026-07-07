# ADR: Device-Pairing Authentication (Loopback-Trusted, Relay-Gated)

- **Status:** Superseded by [Owner-Token-Only Authentication](owner-token-auth.md)

This ADR described the removed device-pairing subsystem: per-device session
tokens (`PairedDevice` rows) minted through an operator-approved handshake, a
`gini_session` cookie gate on non-loopback web fronts (with a `/pair`
redirect), the `/api/pairing/*` routes, and the mobile app's relay-link native
pairing client. The runtime is now owner-token-only — a bearer authorizes iff
it equals the singleton `config.token`, trusted non-loopback fronts are
owner-equivalent with no pairing cookie gate, and multi-user access is the
hosted edge's job (Google OAuth with owner-token injection). See
[owner-token-auth.md](owner-token-auth.md).
