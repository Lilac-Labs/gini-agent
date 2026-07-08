# ADR: Managed Deployment Mode

- **Status:** Accepted
- **See also:** [Web Onboarding Flow](web-onboarding-flow.md), [Web Search Connectors](web-search-connectors.md), [Tunnel Connectivity](tunnel-connectivity.md), [Runtime Update Surface](runtime-update-surface.md), [Owner-Token-Only Authentication](owner-token-auth.md)

## Context

Gini runs in two deployment shapes. **Self-hosted** (the default): one
operator installs the runtime on their own machine, brings their own model
provider, exposes the app through a tunnel when they want remote access, and
clicks the sidebar's Update button to pull new builds. **Managed**
(platform-hosted): a platform operates the runtime for the user — it
provisions the model provider, rolls updates, terminates ingress and
authentication at an edge proxy in front of the app, and never expects the
user to configure any of that.

The web control plane was built for the self-hosted shape, so it carries
self-serve surfaces that are wrong to show a managed user: the provider
sections on Settings (default-model picker, provider rows, Add provider), the
`/setup` first-run provider page and the proxy gate that bounces unconfigured
instances to it, the sidebar's tunnel menu, and the sidebar's self-update
row. A managed deployment that shows these invites the user to fight the
platform (swap the provisioned provider, "update" a platform-rolled build,
open a second ingress path) or strands them on pages that cannot work.

The runtime already carries a hosted marker: `GINI_HOSTED=1`, which flips
`googleAuthMode` to `"edge"` (ADR web-onboarding-flow.md's auth-mode seam,
defined in ADR google-multi-account.md), activates owner-token hot-reload
(ADR owner-token-auth.md), and gates hosted-only provider behavior (ADR
web-search-connectors.md, which already established that future hosted-only
behavior keys off this one marker rather than re-deriving "is this hosted?"
per site).

## Decision

**One flag drives both the runtime seams and the web's managed mode.**
`GINI_HOSTED=1` — no new environment variable, no per-surface toggles.

- **Runtime contract.** `GET /api/setup/status` gains `managed: boolean`,
  true iff the runtime carries `GINI_HOSTED=1` (`getSetupStatus` in
  `packages/runtime/src/runtime/setup-api.ts`). The endpoint is already
  BFF-proxied and already consumed by the web's setup gate and setup page,
  so the flag rides an existing probe — clients learn the deployment shape
  and the provider state in one fetch.
- **Web read.** `useManagedMode()` in `packages/web/src/lib/queries.ts`
  (the `useGoogleAuthMode()` pattern: `staleTime: Infinity`, the answer is
  fixed per deployment). Every consumer treats a missing/failed answer as
  unmanaged, so self-hosted rendering is byte-identical with or without the
  probe — managed mode is strictly subtractive.
- **Surfaces gated when managed:**
  - Sidebar: the tunnel menu (ingress is platform-terminated; ADR
    tunnel-connectivity.md) and the UpdateReminder row (updates are
    platform-rolled; ADR runtime-update-surface.md) are hidden.
  - Settings: `DefaultModelControl` and the `ProviderCard` list (which
    carries Add provider) are hidden; the rest of the page (browser,
    toolsets, MCP, messaging) stays.
  - `/setup` and `/settings/add-provider`: client-side redirect home, the
    same treatment `/setup` already gives an already-configured instance.
  - Next.js proxy setup gate (`packages/web/src/proxy.ts`): when the status
    probe reports `managed`, the gate never redirects to `/setup`, even if
    `providerConfigured` is false — the platform owns provider provisioning,
    so the self-serve funnel must not fire while it happens.
- **`/login` page** (`packages/web/src/app/login/page.tsx`): the managed
  sign-in landing. It renders only the sign-in affordance — a "Continue with
  Google" that navigates same-tab to the **relative** `/auth/google`, a route
  owned by whatever edge fronts the app. The edge terminates OAuth, mints the
  session, and enforces unauthenticated access; the app ships no auth
  middleware and no hosted hostnames. The page keys on the auth-mode seam:
  `"edge"` renders the card, `"loopback"` redirects home (a self-hosted app
  has nothing to sign in to). `AppShell` and the providers tree already
  render `/login` bare (no chrome, no gates, no authenticated queries).

The decision rule matches the open-core split: a surface stays public and
always-on if a self-hoster running one instance wants it; it hides behind
`managed` only when a platform demonstrably owns that concern for the user.

## Consequences

- The private hosted repository needs no web fork: the hosted removals it
  used to carry as deletions are now runtime-driven behavior in the public
  tree, keyed off the same marker the hosted provisioner already bakes into
  every guest.
- Self-hosted deployments are unaffected by construction: `managed` defaults
  false end-to-end (absent env var, absent field, failed probe), and the
  existing test suite runs unchanged against that default.
- The gating is client-side presentation, not authorization. The runtime's
  provider/tunnel/update APIs still answer on a managed deployment; the edge
  in front of it is the security boundary (ADR owner-token-auth.md). Hiding
  the surfaces prevents confusion, not attack.
- A managed deployment's first paint may briefly show a gated surface until
  the setup-status answer lands (the default is self-hosted posture). The
  probe is one BFF round-trip on a warm runtime, and the affected surfaces
  are below the fold of first-run flows, so this is accepted rather than
  inverting the default and flashing blank chrome at every self-hoster.

## Acceptance Checks

- `packages/runtime/src/runtime/setup-api.test.ts`: `managed` is false on a
  fresh instance, true iff `GINI_HOSTED === "1"` (exact-match, `"true"` does
  not count).
- `packages/web/src/proxy.test.ts`: a managed payload never redirects to
  `/setup` even with `providerConfigured: false`; a payload without the
  `managed` field keeps the pre-managed redirect behavior.
- `packages/web/src/components/Sidebar.test.tsx`: tunnel menu + update row
  render self-hosted, disappear when the probe reports managed.
- `packages/web/src/app/settings/page.test.tsx`: provider sections disappear
  when managed; browser/toolsets/MCP/messaging cards stay.
- `packages/web/src/app/login/page.test.tsx`: edge auth-mode renders the
  card with a relative same-tab `/auth/google` link; loopback redirects home;
  an unresolved probe renders neither.
