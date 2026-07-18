# ADR: Google Multi-Account Credentials

- **Status:** Accepted
- **See also:** [Connector Registry](connector-registry.md), [Per-Agent Memory Isolation](agent-memory-isolation.md), [Owner-Token Authentication](owner-token-auth.md)

## Context

One Gini installation can serve several runtime instances, and one person may
use several Google Workspace identities. A single process-wide `gws` login is
not enough: selecting a work account must not overwrite a personal account,
and one instance must not expose credentials attached only to another.

Google Workspace CLI already supports isolated configuration directories. Gini
needs a small durable registry around those directories, plus per-instance
bindings and a browser flow that works on a local machine without asking the
agent to handle OAuth secrets in chat.

## Decision

### Machine-global credential registry

Google credentials are reusable machine state under
`~/.gini/google-accounts/`. Each managed account owns a directory named by its
stable `gacct_*` id. `accounts.json` stores only account metadata:

- stable id and user-editable tag;
- verified email when known;
- configuration directory;
- creation time; and
- immutable Google principal when the OAuth flow supplied one.

OAuth tokens remain in the account's gws credential files. They are never
copied into runtime state, logs, traces, browser responses, or chat context.
Gini may also adopt the user's existing `~/.config/gws` directory. Removing an
adopted registry row never deletes that external directory.

### Per-instance bindings

Each runtime instance stores `google-account-bindings.json` beneath its own
instance state. It records the ids attached to that instance and one selected
primary account. API listings filter through these bindings; credentials that
belong only to another instance do not appear in the response.

Existing completed instances are migrated lazily: their former effective
primary account is attached on first access. New instances receive bindings
only through an explicit account connection or selection.

### Credential activation

Every gws subprocess receives `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` for the account
chosen by the current runtime context. The primary account is the default.
Account-aware jobs and routines can select another attached account explicitly.
This environment selection is scoped to the child process and must not mutate
the gateway's process-wide environment.

Tags are convenience aliases, not identity. Credential matching uses the
immutable Google subject first, then verified email, and finally a best-effort
live status probe for older rows whose email was not stored.

### Local browser OAuth

The web app connects accounts with a same-tab Desktop-client OAuth flow owned
by the runtime:

1. `GET /api/google/login/start` validates the browser-facing origin is
   loopback, creates a PKCE verifier and state nonce, and redirects to Google.
2. Google returns to the web BFF at
   `/api/runtime/google/login/callback`; the BFF forwards the request to the
   owner-token-protected runtime callback.
3. The runtime validates the one-time state, exchanges the code, fetches OIDC
   userinfo, and atomically writes a 0600 `credentials.json` in the matched or
   newly allocated account directory.
4. The account is attached to the active instance. A `signin` intent selects
   it as primary; an `add` intent preserves the existing primary.

The pending verifier lives in process memory for ten minutes and is consumed
once. Authorization codes, access tokens, refresh tokens, and client secrets
are never logged or returned in errors. A configured
`google-workspace-oauth` connector supplies the Desktop OAuth client when
present; otherwise the bundled distributable Desktop client is used.

The loopback restriction is intentional. Desktop OAuth redirects to the
browser's own localhost, so a browser opened on another machine cannot safely
complete this flow against the runtime host.

### Runtime API

The owner-token-protected API exposes:

- `GET /api/google/accounts` — attached accounts joined with live gws status;
- `POST /api/google/accounts` — adopt/register an already signed-in allowed
  config directory;
- `POST /api/google/accounts/:id/use` — verify and select an account as primary;
- `PATCH /api/google/accounts/:id` — change its tag;
- `DELETE /api/google/accounts/:id/instance` — detach a non-primary account
  from this instance;
- `DELETE /api/google/accounts/:id` — remove the registry row and a managed
  credential directory;
- `POST /api/google/session/signout` — clear this instance's bindings; and
- the two loopback login routes described above.

There is no public API that accepts raw OAuth client secrets or refresh tokens.
Credential persistence is an internal step of the local callback.

### Product behavior

Onboarding and Integrations use the same loopback flow. Revoked credentials
show a reconnect action. Reconnecting rewrites the matching account in place,
preserves its tag and id, and selects it only when the flow carries `signin`
intent. The primary cannot be detached until another live account is selected.

Connector and skill activation treat an attached Google account as satisfying
the Google Workspace credential requirement even when no conventional
connector record exists.

## Consequences

- Credentials can be reused locally without becoming visible across instance
  boundaries.
- Account selection is deterministic for web requests, jobs, terminal tools,
  and connector probes.
- Local browser OAuth has no dependency on an external control plane.
- Remote browsers must connect Google on the runtime host or import/adopt a gws
  credential through the documented local setup flow.
- Deleting a managed account deletes its credential directory; disconnecting
  it from one instance does not.

## Acceptance Checks

- Registry, matching, permissions, deletion, and instance isolation:
  `packages/runtime/src/integrations/connectors/google-accounts.test.ts`.
- PKCE, redirect validation, identity matching, and secret handling:
  `packages/runtime/src/integrations/connectors/google-login-web.test.ts`.
- Runtime routes: `packages/runtime/src/http.part4.test.ts`.
- Onboarding URL and primary-account behavior:
  `packages/web/src/app/onboarding/_components/lib.test.ts`.
