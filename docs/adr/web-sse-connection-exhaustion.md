# Web SSE Connection Exhaustion Starves Polled Queries (e.g. Chat Sessions)

Status: Proposed (known issue, fix pending)

## Context

The Next.js control plane keeps itself live two ways at once:

- A single long-lived **Server-Sent Events** stream per browser tab. `RuntimeStreamBridge`
  (`web/src/components/RuntimeStreamBridge.tsx`) opens an `EventSource` to
  `/api/runtime/events/stream` and maps runtime ticks to React Query
  invalidations (e.g. a `chat` tick invalidates `["chat"]`).
  It is mounted in `AppShell` (`web/src/components/AppShell.tsx`), so **every route in
  every tab holds one EventSource open for the lifetime of the tab.**
- Per-feature **polling** on top of that. The sidebar's chat list uses
  `useChatSessions()` (`web/src/lib/queries.ts`) — query key `["chat"]`,
  `refetchInterval: 3000` — to `GET /api/chat` (scoped to the active agent) as a safety
  net that picks up task completions even when an SSE tick is missed.

An `EventSource` over HTTP/1.1 is a normal persistent HTTP connection that is **never
released** while the tab is open. Browsers cap concurrent connections per host on
HTTP/1.1 at **6** (Chrome's default). The gateway's own Bun server
(`http://localhost:7351`) and the inner Next.js dev server are served over
**HTTP/1.1**. The gini-relay front (`https://<sub>.gini-relay.lilaclabs.ai`) is served
by Caddy over **HTTP/2**, which multiplexes many streams over one connection.

## Symptom

With multiple control-plane tabs open against the **localhost** origin, a later-opened tab's
sidebar shows a stale chat list — its read/unread indicators and newly-completed tasks never
update — even though the gateway has the fresh state. The operator concludes "this tab is
frozen," and keeps acting on data that no longer matches the runtime.

This is silent: there is no error, just a stale view and data that never refreshes.

## Reproduction

1. Have some chat activity pending on the gateway (a task completing, a new unread session).
   Confirm the fresh state exists: `curl -sS http://localhost:7351/api/chat` returns it.
2. Open 7 browser tabs to `http://localhost:7351/` (each mounts `RuntimeStreamBridge` and so
   opens one EventSource). 7 exceeds the HTTP/1.1 cap of 6 connections per host.
3. In a tab opened *after* the pool filled, watch the sidebar chat list.

Observed in a live run:

- The **1st** tab (opened before the pool saturated) reflected the latest chat state.
- A **later** tab showed a stale sidebar for the same sessions.
- That tab's network log showed the held-open `eventsource` to
  `/api/runtime/events/stream` plus a stack of polls (`/api/runtime/chat`,
  `/api/runtime/status`, …) stuck **pending**, never completing.
- Tabs 1 through 6 loaded; the **7th** tab failed to load the page at all (landed on
  `about:blank`) because its initial document request could not get a connection.

The same flow over the relay URL (HTTP/2) does **not** reproduce — the streams multiplex.

## Root cause

Per-tab persistent SSE multiplied against the HTTP/1.1 limit of 6 connections per host. Six
tabs, each holding one EventSource, fill the pool; every other fetch on that origin —
including the 3-second chat-list poll — then queues indefinitely. The chat query never
resolves, so the sidebar keeps its last-seen state. Nothing is wrong on the gateway: the
fresh state is present and the route returns it (verified via loopback and via the BFF
`/api/runtime/chat`).

It is not specific to the chat list — any polled query degrades the same way once the pool is
saturated. The chat list is just where it is most visible (the sidebar every route renders).

## Affected surfaces

- **localhost gateway origin and the inner Next.js dev server**: HTTP/1.1 → vulnerable.
- **gini-relay front**: HTTP/2 (Caddy) → not affected (multiplexed).

## Options (ranked)

1. **Share one SSE per origin across all tabs** via a `SharedWorker` (or a
   `BroadcastChannel` leader election where one tab owns the EventSource and rebroadcasts
   ticks). Collapses N tabs to one connection regardless of tab count. Most robust; removes
   the multiplication at the source. Most implementation effort.
2. **Tear down the SSE when the tab is hidden** (Page Visibility API: close on
   `visibilitychange` → `hidden`, reopen on `visible`) in `RuntimeStreamBridge`. Bounds live
   EventSources to foreground tabs (typically one). Small change, high impact. Trade-off:
   backgrounded tabs stop receiving live ticks and rely on a refetch when refocused — make
   the affected queries refetch on focus so they catch up.
3. **Serve the gateway/web over HTTP/2 (h2c or TLS)** so localhost multiplexes like the
   relay. Removes the per-host cap entirely, but is an infra change to the Bun server and the
   reverse proxy (see `gateway-web-reverse-proxy.md`).
4. **Make the operator never need many tabs** (UX nudge): a single-tab control plane. Not a
   real fix — operators legitimately keep tabs open.

Recommendation: ship Option 2 as the immediate mitigation, pursue Option 1 as the durable
fix. Option 3 helps everything but is heavier.

## Acceptance check

Open 8 tabs against the localhost origin (more than the 6-connection cap), produce one chat
state change (complete a task, mark a session unread), and confirm **every** tab's sidebar
chat list reflects it within the poll interval, and that the count of live EventSource
connections stays bounded (does not grow one-per-tab). Re-verify the relay path still works
(it already does).

## References

- `web/src/components/RuntimeStreamBridge.tsx` — per-tab EventSource → query invalidation.
- `web/src/components/AppShell.tsx` — mounts the bridge on every route.
- `web/src/lib/queries.ts` — `useChatSessions()` poll (`refetchInterval: 3000`).
- ADR [gateway-web-reverse-proxy.md](gateway-web-reverse-proxy.md) — single-origin proxy and
  the HTTP/1.1-vs-HTTP/2 distinction between localhost and the relay front.
- ADR [owner-token-auth.md](owner-token-auth.md) — the owner-token trust model for the relay
  front (a bearer equal to `config.token` resolves to the `owner` credential).
