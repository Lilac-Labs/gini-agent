# ADR: In-App Log Viewing

- **Status:** Accepted
- **Date:** 2026-06-07
- **See also:** [Crash Reporting And Issue Filing](crash-reporting-and-issue-filing.md), [Owner-Token-Only Authentication](owner-token-auth.md), [Local Runtime Architecture](local-runtime-architecture.md)

## Decision

The operator can read this instance's logs in the app at `/logs`, served by a
bearer-gated `GET /api/logs` on the gateway. Three streams are exposed — the
structured `runtime.jsonl`, the raw `runtime-stdout.log`, and the raw `web.log`
under `logDir(instance)`. The viewer is **raw by default**: the runtime
`runtime.jsonl` `data` payload (which is not redacted at write time) is returned
verbatim, and stdout/web lines are returned as-is. A **"Redact for sharing"**
toggle (default off) requests a redacted copy that is safe to attach to a bug
report.

The reader (`packages/runtime/src/state/logs.ts`) is pure: `readLogTail(instance, stream, limit)`
parses the JSONL stream into structured entries (skipping any unparseable line
rather than throwing), returns the raw streams line-for-line, treats a missing
file as an empty tail, and flags `truncated` when the file held more than
`limit` lines. The endpoint composes that reader with the redaction layer and
returns `{ ...tail, redacted }`.

### Raw by default is safe here

The gateway binds `127.0.0.1` only and every `/api/*` route — including
`/api/logs` — sits behind the global owner-bearer gate, so the un-redacted tail
is reachable only by a caller that already holds the gateway token. That caller
is the operator, who already has filesystem read access to the same files under
`~/.gini/instances/<instance>/logs/`. Exposing the raw bytes in the app adds no
trust boundary the operator didn't already cross; it just saves them a `tail`.

A **trusted remote front mirrors loopback** (see
[owner-token-auth.md](owner-token-auth.md)): a relay/tunnel/allowlisted front
is owner-equivalent and reaches the same bearer-gated `/api/*` surface through
the BFF. This is called out explicitly because the raw tail is **un-redacted**
— a remote operator on a trusted front can therefore read raw logs (including
the un-redacted `data` payload) exactly like the local operator. That is
consistent with the deliberate owner-equivalence model in that ADR, not a new
exposure: the trust anchor is the front's host/origin trust lane, and a
visitor on an untrusted front never reaches the route.

### Redaction reuses the crash-report definition

Share mode (`packages/runtime/src/runtime/log-redaction.ts`) reuses `redactReportText` from
[crash-reporting-and-issue-filing.md](crash-reporting-and-issue-filing.md) — the
same `REPORT_SECRET_PATTERNS` plus literal `secrets.env` scrubbing that gates
crash-report bodies before they reach a published GitHub issue. There is no
second secret-regex implementation to drift. A redacted runtime entry mirrors a
crash report's `logTail`: it keeps only `{ at, message }` with the message
scrubbed and **drops `data` entirely** (the highest-risk field, never carried
into a shareable copy); raw lines each pass through `redactReportText`. So
"safe to share" has exactly one definition across crash reports and the log
viewer.

## Relation to GitHub issue #232

The bug/crash-report flow embeds a *redacted* log tail inline in the filed issue
body; there is no externally-hosted "view the full logs" link, so #232's failure
mode — a generated logs link that the report recipient can't open — has no
mechanism to occur. The local-first answer is this page: the operator reads
their own logs in-app and exports a redacted copy to attach to a report, instead
of relying on any externally-hosted link. This page is the resolution of #232.

## Consequences

- A new read-only surface for the operator with no new trust boundary: it is
  loopback + bearer-gated like every other `/api/*` route.
- One redaction definition. A change to the secret patterns in the crash-report
  module updates both the crash issue body and the log share-export at once.
- The viewer is a tail, not a live stream: it fetches the last `limit` lines
  (default 500, clamped to 5000) per request and refreshes on demand. No SSE
  live-tail and no pagination beyond `limit` — deliberately out of scope.
- A remote operator on a trusted front can read raw logs; this is the intended
  mirror of loopback and must not be "hardened" into a remote-only redaction,
  which would make a trusted front less capable than `127.0.0.1`.

## Acceptance Checks

- `GET /api/logs` without a bearer → 401; an unknown `stream` → 400; `limit`
  clamps to the most recent lines and flags `truncated`.
- Default (`redact` unset) returns runtime entries with the `data` payload
  intact; `redact=true` drops `data` and scrubs a planted `Bearer <token>` and a
  literal `secrets.env` value from messages/lines while leaving benign text.
- The reader, redaction layer, and endpoint are pinned by `packages/runtime/src/state/logs.test.ts`,
  `packages/runtime/src/runtime/log-redaction.test.ts`, and the `/api/logs` cases in
  `packages/runtime/src/http.test.ts`.
