# ADR: Multiple Tagged Google Accounts For The Workspace Skills

## Decision

Gini supports **multiple tagged Google accounts** for the Google Workspace
skills (`google-gmail`, `google-calendar`, `google-drive`, `google-docs`,
`google-sheets`, `google-meet`, `google-forms`). The pieces:

- **Account identity == a per-account `gws` config dir.** The `gws` CLI honors
  `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (default `~/.config/gws`); each config dir
  holds exactly one account's tokens. After `gws auth login`, reads from that
  dir need no env vars. Selecting an account is therefore a path prefix, not a
  secret: `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws gmail …`.

- **One OAuth client, many accounts.** The single `google-workspace-oauth`
  connector keeps holding only the OAuth *client* id/secret (ADR
  typed-named-credentials.md). One client can authorize many accounts (each its
  own config dir / test user). The connector record is unchanged; skill
  credential resolution still keys on the single name `google-workspace-oauth`,
  so the seven Workspace skills keep activating exactly as before.

- **A registered account satisfies the credential for skill activity.** With
  ≥1 account in the registry, the Workspace skills are active even when no
  per-instance `google-workspace-oauth` connector exists: `isSkillActive`
  (`packages/runtime/src/integrations/connectors/index.ts`) consults the owning provider's
  `credentialExternallySatisfied` hook (`google-oauth-desktop.ts`, backed by
  `readGoogleAccounts()`) before declaring a required credential unmet. The
  hook applies only when no connector record with that name exists at all —
  an existing record of any status keeps the usability-only gate, so a
  `disabled` connector (explicit operator off) leaves the skills inactive
  regardless of registered accounts. For the read/operate Workspace skills,
  each account's config dir is self-contained (its own OAuth client + tokens),
  so no client env bindings are needed on that path; the exception is
  `google-account-login`'s fresh-login flow, which mints a new config dir and
  still needs the connector's `GOOGLE_WORKSPACE_CLI_CLIENT_ID`/`_SECRET`
  bindings. The check is presence-only; sign-in expiry is handled by the
  skill recipes at run time.

- **Accounts are tagged.** Each account carries a user label (`personal`,
  `work`, `school`, …). Tags are unique case-insensitively across accounts.

- **Machine-global registry.** Accounts live in
  `~/.gini/google-accounts/accounts.json`
  (`{ version: 1, accounts: GoogleAccount[] }`), with each gini-managed config
  dir under `~/.gini/google-accounts/<id>/`. The pre-existing `~/.config/gws`
  session is **adopted in place** (its account's `configDir` points at
  `~/.config/gws`), so no forced re-login of the user's existing session.

- **Surfaced as a transient sub-resource of the connector, not persisted to
  per-instance state.** `GET /api/connectors` attaches an `accounts` enrichment
  (each account joined with live `gws auth status`) to the
  `google-oauth-desktop` record at request time — mirroring the existing
  `session` enrichment (ADR connector-provider-spec-compliance.md, "Health vs.
  session liveness"). The accounts themselves are never written into
  `state.json`.

```ts
// packages/runtime/src/types.ts — the registry shape (persisted machine-globally)
export interface GoogleAccount {
  id: string;          // stable slug, e.g. "gacct_<rand>" (dir basename for managed dirs)
  tag: string;         // user label: "personal" | "work" | "school" | ...
  email: string;       // from `gws auth status` .user ("" until known)
  configDir: string;   // absolute path to this account's gws config dir
  addedAt: string;     // ISO
}

// The enrichment shape attached on read (never persisted)
export interface GoogleAccountStatus extends GoogleAccount {
  signedIn: boolean;
  services: Record<string, boolean>; // keyed by google-* skill suffix
  message: string;
}
// ConnectorRecord.accounts?: GoogleAccountStatus[]  // transient, like `session`
```

## Context

The Workspace skills resolve credentials by the single name
`google-workspace-oauth` (ADR-locked in typed-named-credentials.md). That name
maps the OAuth **client** creds into the spawn env; it says nothing about *which
Google account* a given command runs as. With one config dir there was nothing
to choose. Once a user wants their personal mailbox *and* their work mailbox,
the runtime needs an account dimension that:

1. doesn't disturb the single-credential-name resolution the skills depend on, and
2. lets the model pick the right account per command, asking the user when the
   request is ambiguous.

The `gws` model already makes this clean: account state *is* a config dir, fully
isolated. So accounts are modeled as config dirs under one OAuth client, kept in
a registry, and surfaced on the connector at read time.

### Why machine-global (a deliberate exception to instance isolation)

Gini instances are otherwise isolated: state, ports, logs, and secrets are
per-instance. The accounts registry and the per-account config dirs are
deliberately **machine-global** instead — "log in once, available in every
instance." This matches the substrate: `gws`'s own session
(`~/.config/gws`) is already a machine-local property of the host's `gws`
install, and the sign-in liveness signal (`gwsSessionStatus`) is already cached
machine-globally, not per-instance. Scoping accounts per-instance would force a
re-login per worktree and diverge from where `gws` actually keeps its tokens.

The exception is safe because the registry is treated as a shared on-disk
resource, not as instance state:

- **Read-through.** `readGoogleAccounts()` reads the file on each call; the
  system-prompt path and every API read see whatever is currently on disk. No
  in-process cache of the account *list* can go stale across instances.
- **Atomic writes.** `writeGoogleAccounts` writes a temp file in the registry
  dir and `rename`s it over the target (mode `0600`), so a concurrent reader in
  another instance never sees a half-written file. `readGoogleAccounts` never
  throws — a missing or corrupt file degrades to `[]` rather than crashing
  turn assembly.
- **No per-instance secrets leak in.** The connector creds stay per-instance
  encrypted; only the config-dir *paths* and tags are machine-global. The
  tokens in each config dir are `gws`'s, exactly as before.
- **Lockless last-writer-wins.** Registry mutations read-modify-write without a
  lock (matching `packages/runtime/src/state/secrets-env.ts`); a concurrent add/remove across
  instances can drop the loser's change. This is acceptable for the low-frequency,
  operator-driven account churn here, and the atomic temp+rename guarantees no
  reader ever sees a corrupt file.

### Selection / "ask when unclear" policy

The intelligence lives in the prompt and skill text, not in heuristic code:

- **0 accounts** → fall back to setup (`google-workspace-setup`).
- **exactly 1 account** → use it (still passing its config dir).
- **2+ accounts** → choose by the operation:
  - The user **named or clearly implied** one account (an explicit tag, an
    email address, or unambiguous context) → use only that account.
  - An **unscoped read / lookup / search** the user did not tie to an account
    ("what's on my calendar", "find the budget doc", "search my email") → run
    it against **every** connected account (one `gws` call per config dir) and
    **aggregate** the results, labeled by each account's tag and email. Don't
    pick one, and don't ask — the user wants the whole picture across accounts.
  - A **write** (send, create, edit, delete) with no account named → **ASK
    before running** — never guess. There is no silent default account.

This is surfaced two ways, both byte-stable so they don't churn the prompt
cache:

- A **"Connected Google accounts"** block in the system prompt
  (`buildConnectedAccountsBlock` in `packages/runtime/src/execution/chat-task.ts`, fed by
  `readGoogleAccounts()`), listing each account's tag, email, and config dir,
  plus the selection rule. Emitted only when ≥1 account is connected; preserves
  registry order and carries no timestamps.
- A **"Selecting a Google account"** section in each of the seven Workspace
  SKILL.md files, restating the same rule and the
  `GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws …` prefix.

### Login path: a separate `google-account-login` skill

Credentialed login ships as a `skill_run` script,
`skills/google/google-account-login/scripts/account-login.ts`, **not** folded
into `google-workspace-setup`. The script gets the OAuth client id/secret
through `resolveSkillEnv` because the skill declares
`requires.credentials: [google-workspace-oauth]` and
`prerequisites.env: [GOOGLE_WORKSPACE_CLI_CLIENT_ID, GOOGLE_WORKSPACE_CLI_CLIENT_SECRET]`.

It is a separate skill because the two skill-loading paths gate differently:

- `read_skill` **throws** when a skill is not active (a skill is active only
  once its required credentials exist and are healthy). If
  `google-workspace-setup` declared `requires.credentials`, it would be
  *inactive* before the connector exists — exactly the first-time-setup moment
  when the model must `read_skill` it. That deadlocks onboarding. So
  `google-workspace-setup` stays **credential-free and always-active**.
- `skill_run` does **not** gate on active-ness — it resolves the script by name
  and `resolveSkillEnv` injects the named skill's credential env whenever the
  connector is usable, regardless of the skill's active state.

So the always-needed setup skill carries no credentials, and the credentialed
login is a small dedicated skill that `google-workspace-setup` (and the "add
another account" flow) call via
`skill_run({ skill: "google-account-login", script: "account-login", args })`
**after** the connector exists.

This is the implementation of the login env-injection follow-up previously
deferred in ADR skill-env-containment.md: a fresh `gws auth login` needs
`GOOGLE_WORKSPACE_CLI_CLIENT_ID` / `_SECRET` in its spawn env, which
`terminal_exec` deliberately never injects; shipping it as a named
`skill_run` script is the prescribed scoped-env path.

The script reads stdin JSON
`{ tag, services?, readonly?, scopes?, configDir?, loginHint?, expectedEmail?, adopt? }`:

- `adopt: true` → configDir is `~/.config/gws`; it requires an
  already-signed-in session there (no browser, no re-login) and registers it.
- otherwise → mint a gini-managed config dir under `~/.gini/google-accounts/`
  (or re-use `configDir` when re-authing an existing account), run
  `gws auth login` (scrape the consent URL from gws's output, `open` it in the
  user's browser, wait for the user to finish OAuth), then confirm the session
  and capture the granted email/scopes. The scraped consent URL is always opened
  with `prompt=select_account` forced (merged into any prompt gws already set),
  so Google shows the account chooser instead of silently authorizing whichever
  account the browser is already signed into — the multi-account hazard that
  otherwise mints a token for the wrong identity and overwrites the target dir's
  tag. `loginHint` pre-highlights the intended account; `expectedEmail` makes the
  login **fail before registering** if a different (or unconfirmable) account
  signs in, so the wrong identity is never bound to the tag.

The 5-minute default skill-script timeout bounds the human OAuth wait.

### Trust boundary / security

- **No secrets in chat.** The script never writes the client id/secret or any
  token to chat or logs; it returns only `{ ok, id, tag, email, configDir,
  scopes }`. OAuth consent is a human-in-the-loop browser step.
- **Loopback registration with the instance bearer token.** After login, the
  script reads the instance's `~/.gini/instances/<instance>/config.json` for the
  API port + bearer token and `POST`s `/api/google/accounts` over loopback. The
  gateway derives the canonical account id (the dir basename for gini-managed
  dirs) so `configDirForAccount(id) === account.configDir` holds and removal can
  clean the dir up.
- **`terminal_exec` still carries no connector env** (ADR
  skill-env-containment.md). Account selection is a config-dir *path* prefix,
  not a secret, so the model targeting an account in an arbitrary `gws` command
  injects no credential — the clean-env guarantee is intact. Credentialed work
  (login) stays on the named `skill_run` path.

## API surface

- `GET /api/google/accounts` → `listAccountsWithStatus()` (registry joined with
  live per-dir `gws auth status`, fetched in parallel, best-effort).
- `POST /api/google/accounts` → body `{ tag, configDir, adopt? }` →
  `registerAccount(...)` (201). Rejects with 400 when `tag`/`configDir` are
  missing, or `"No signed-in Google session in <dir>"` when the dir has no live
  session — so an empty dir is never registered.
- `PATCH /api/google/accounts/:id` → `{ tag }` → retag (404 unknown id; 400 on
  a tag collision).
- `DELETE /api/google/accounts/:id` → remove from the registry; best-effort
  delete the gini-managed config dir; **never** touch `~/.config/gws`.
- `GET /api/connectors` enriches the `google-oauth-desktop` record with
  `accounts` (alongside `session`). The registry is machine-global, so it is
  resolved once and attached to the record.

These `/api/google/accounts` routes are **not** instance-scoped (the registry is
machine-global). The CLI (`gini connector accounts [list|retag|remove]`) and the
Skills-page `GoogleAccountsCard` are thin clients of these routes; `add` from the
CLI routes the user into chat, since only the agent can drive the browser OAuth
flow.

## Consequences

### Required

- Account selection is always a `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` prefix on a
  `gws` command. No tool change is needed for per-command selection, and no
  credential is paired with the arbitrary command.
- Credentialed Google login ships as the `google-account-login` skill's
  `account-login.ts`, invoked via `skill_run`. The setup skill must stay
  credential-free so `read_skill` can load it during first-time setup.
- New persistence belongs in `packages/runtime/src/state/google-accounts.ts` (low-level
  registry) and orchestration in `packages/runtime/src/integrations/connectors/google-accounts.ts`
  (registry ∪ live status, register/remove/retag). Status fetching is injectable
  so it unit-tests without a real `gws` binary.

### Trust boundary

The account dimension never widens the credential surface. The OAuth *client*
creds reach a process only through the named `skill_run` login path
(`resolveSkillEnv`); selecting *which account* a query runs as is a path, so it
flows through `terminal_exec`'s clean env unchanged. Removing a gini-managed
account deletes its config dir (its tokens) but never the user's
`~/.config/gws`.

Registration normally gates the registry write on a live `gws auth status`
probe, so an empty or signed-out dir is never registered. The relay-provisioned
grant path (`defaultPersistWorkspaceGrant` in `packages/runtime/src/integrations/tunnel.ts`) is
the one exception: it calls `registerAccount` with `trusted: true`, which skips
the probe. This is sound because the credential is trustworthy *by
construction* — the relay only issues a refresh token after a completed OAuth
consent — and the probe is unusable at tunnel-connect time, when the `gws`
binary may not yet be installed, so gating on it would strand a valid credential
unregistered (invisible to every readiness surface). The trusted account is
written with `email: ""`; `listAccountsWithStatus` back-fills the live email and
sign-in liveness on the next read. `trusted` is reachable only from this
internal path: the public `POST /api/google/accounts` route forwards only
`{ tag, configDir, adopt }` and never sets it, so the probe stays mandatory for
all caller-supplied dirs.

A trusted account carries two extra fields on the registry row (`GoogleAccount`
in `packages/runtime/src/types.ts`), both set only on this path and never by a user/manual
account:

- `provisioned: true` — immutable provenance. The grant path re-finds *its own*
  account by this flag, NOT by the mutable display `tag`, so re-persisting on a
  reconnect upserts the same dir/row (no duplicate account per reconnect) while a
  user retagging it — or independently tagging another account `workspace` —
  never redirects or clobbers the provisioned credential. The flag is sticky: a
  later non-trusted re-register of the same dir cannot strip it.
- `principal` — the relay/Google subject id (relay `Session.account`) the grant
  belongs to. Re-find matches on this, so two *different* identities provisioned
  on the same machine (the registry is machine-global, but each instance has its
  own relay session) each keep their own managed dir instead of one overwriting
  the other's credential. Reuse also preserves the account's current `tag`, so a
  reconnect never reverts a user's retag.

Re-find matches *only* on `provisioned`/`principal`, never on the `tag`. A relay
account registered before these fields existed therefore isn't recognized, and
the first reconnect after upgrading mints a fresh provisioned row beside it — a
one-time, non-destructive duplicate (the old row still works) for the narrow set
of machines that provisioned successfully on the prior build. This is a
deliberate trade: adopting a pre-flag row would have to key off the mutable
`tag` (its credential's `client_id` is the public, baked relay id, not a secret),
which could misclassify and overwrite a user account that merely shares the tag.
The duplicate is cleaned up by removing the stale row; correctness is never at
risk.

## Acceptance checks

- `bun test packages/runtime/src/state/google-accounts.test.ts` — registry round-trips
  (atomic write + read-back), missing/corrupt file → `[]`, case-insensitive tag
  uniqueness rejects a colliding add/retag, remove is a no-op for an unknown id.
- `bun test packages/runtime/src/integrations/connectors/google-accounts.test.ts` —
  `registerAccount` derives the id from the dir basename for a gini-managed dir
  (so `removeAccount` cleans that dir) and reuses/mints for an adopted dir;
  `registerAccount` throws for a not-signed-in dir **on the default (probed)
  path**, and registers without probing when called with `trusted: true` (the
  relay-provisioned path below); `removeAccount` deletes a gini-managed dir but
  never `~/.config/gws`; `listAccountsWithStatus` degrades a failing per-dir
  status fetch to `signedIn: false`.
- `bun test packages/runtime/src/integrations/connectors/gws-session.test.ts` —
  `gwsSessionStatusForDir` passes `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` and caches
  per dir (each dir spawns at most one `gws auth status` per TTL window);
  `parseGwsAuthStatus` extracts `.user` (email) and `.scopes`.
- `bun test packages/runtime/src/execution/chat-task.test.ts` — `buildConnectedAccountsBlock`
  emits nothing for 0 accounts, the single-account rule for 1, and the
  aggregate-on-unscoped-read / ask-on-write rule for 2+; the block is
  byte-stable for a given registry.
- `bun test skills/google/google-account-login/scripts/__tests__/account-login.test.ts`
  — the pure URL-scrape / arg-build / account-chooser helpers
  (`extractConsentUrl`, `buildLoginArgs`, `forceAccountChooser` — merges
  `select_account` into any existing prompt, adds `login_hint`, no-ops an
  unparseable URL).
- E2E in a real chat turn: with two accounts connected, an unscoped read
  ("what's on my calendar") runs against every account's config dir and
  aggregates the results; a write that doesn't name an account makes the agent
  ask which one first; a request that names a tag/email runs against that
  account's config dir.

## Related

- ADR `typed-named-credentials.md` — the single `google-workspace-oauth`
  credential name the skills resolve by; unchanged here (one client, many
  accounts).
- ADR `skill-env-containment.md` — the single-surface env containment the login
  script sits on; this ADR implements that ADR's deferred `gws auth login`
  env-injection follow-up.
- ADR `connector-provider-spec-compliance.md` — the transient `session`
  enrichment and "Health vs. session liveness" pattern the `accounts`
  enrichment mirrors.
- ADR `skill-connector-consent.md` — bundled skills (including
  `google-account-login`) are auto-granted their declared credentials.
- ADR `connector-secret-storage.md` — how the OAuth client creds are encrypted
  before `resolveSkillEnv` injects them into the login script.
