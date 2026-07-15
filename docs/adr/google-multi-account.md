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
  `readGoogleAccounts()`) before declaring a required credential unmet. In the
  hosted product this is the steady state: the host bakes the guest's Google
  Workspace credential at provisioning and the gateway registers the primary
  account at boot (see "Hosted edge-provisioned accounts"), so
  `readGoogleAccounts()` is non-empty from the first turn and the Workspace API
  skills are active with no in-chat setup. The hook applies only when no
  connector record with that name exists at all — an existing record of any
  status keeps the usability-only gate, so a `disabled` connector (explicit
  operator off) leaves the skills inactive regardless of registered accounts.
  Each account's config dir is self-contained (its own OAuth client + tokens),
  so no client env bindings are needed to read or operate against it. The check
  is presence-only; sign-in expiry is handled by the skill recipes at run time.

- **Accounts are tagged.** Each account carries a user label (`personal`,
  `work`, `school`, …). Tags are unique case-insensitively across accounts.

- **Machine-global registry.** Accounts live in
  `~/.gini/google-accounts/accounts.json`
  (`{ version: 1, accounts: GoogleAccount[], primaryAccountId?: string }`),
  with each gini-managed config dir under `~/.gini/google-accounts/<id>/`. The
  hosted guest's baked primary credential is registered at boot with its
  `configDir` pointing at the baked credentials directory (see "Hosted
  edge-provisioned accounts"); additional accounts each get their own managed
  config dir.

- **One persisted primary account.** `primaryAccountId` is an optional,
  additive registry field naming the user's primary account (see "The primary
  account and OAuth intents" below). Reads are tolerant: a registry written
  before the field existed, or one whose id no longer names a row, resolves
  through the pre-field heuristic (first `provisioned` row, else the first
  row). The *effective* primary is resolved server-side
  (`effectivePrimaryAccountId`) and surfaced as `primary: true` on exactly one
  row of `GET /api/google/accounts`, so every client agrees. Deleting the
  primary account clears the field.

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
  primary?: boolean;                 // true on exactly the effective primary row
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

- **0 accounts** → fall back to setup (`google-workspace-setup`). On a hosted
  guest the account is baked at provision and registered at boot, so an empty
  registry there means provisioning hasn't finished — surface that the account
  isn't ready rather than attempting a local sign-in.
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

### The primary account and OAuth intents

"Primary" is a **display concept**: it labels the account the sign-in surfaces
speak for (the onboarding step-0 "Continue as …" card, the accounts list's
"Primary account" badge and ordering). It never scopes agent behavior — the
selection policy above still aggregates unscoped reads across every account.

The primary is **persisted** as the registry's `primaryAccountId` and driven
by an **intent** every OAuth flow carries:

- **`signin`** — the user is answering "who am I?" (onboarding step-0
  "Continue with Google" / "Use a different account", and the
  reconnect-revoked-primary relogin). On successful provisioning the
  provisioned/matched account becomes `primaryAccountId`. A failed
  exchange/provision never flips it.
- **`add`** (the default everywhere) — the user is attaching another mailbox
  (the accounts step). Never touches the primary.

How the intent travels per flow:

- **Loopback web login**: `GET /api/google/login/start?intent=signin|add`
  (absent → `add`; anything else is a 400, like a bad `origin`). The intent
  rides the in-memory pending-login record to the callback, which passes
  `makePrimary` to `provisionAccount`.
- **Hosted edge add flow**: `/auth/google/add?intent=signin` sanitizes the
  param (only the literal `signin` counts; anything else is `add`), carries it
  inside the signed add-mode OAuth `state`, and the callback POSTs
  `makePrimary: true` to the guest's provision endpoint only for signin
  intent. The web's reconnect-revoked-primary relogin is this same flow with
  `intent=signin`. Independently of the intent, the callback compares the
  OAuth'd Google sub with the session owner's stored sub and on a match
  upgrades the provision to a baked-dir heal (`primary: true`) — see "Hosted
  edge-provisioned accounts" below.
- **Guest provision endpoint**: `POST /api/google/accounts/provision` accepts
  an optional `makePrimary: boolean` — distinct from the existing `primary`
  flag, which only *routes where the credential lands* (the baked-file heal)
  and never touches `primaryAccountId`.
- **Hosted boot**: `ensureHostedPrimaryAccount` sets `primaryAccountId` only
  when unset (backfilling pre-field guests on their next boot), so a user's
  later sign-in choice survives reboots.

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

### How a Google account lands (hosted)

On a hosted guest, accounts arrive through the host, not through an in-chat or
local sign-in. The login skill above never runs there: the guest is headless,
so the Desktop-client loopback flow can't complete anyway (nothing opens the
consent URL and `localhost` resolves to the visitor's machine, not the
guest). Two mechanisms populate the
registry, both detailed in "Hosted edge-provisioned accounts" below:

- **Boot registration of the baked primary.** The host bakes the guest's
  Google Workspace credential at provisioning (a `credentials.json` pointed at
  by `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`); at gateway boot
  `ensureHostedPrimaryAccount` registers `dirname(credentials file)` as the
  trusted `primary` account. This is why the Workspace skills are active from
  the first turn with no user action.
- **Adding another account.** The edge runs the web-application OAuth consent
  + server-side code exchange and `POST`s the resulting refresh token to the
  guest's `/api/google/accounts/provision`; `provisionAccount` writes an
  `authorized_user` `credentials.json` into a managed config dir and registers
  it `trusted: true`. The guest never runs `gws auth login` and never sees the
  authorization code — only the already-exchanged refresh token.

Both paths register `trusted: true` (skipping the live `gws auth status` probe)
because the credential is trustworthy by construction: Google issues a refresh
token only after a completed OAuth consent, and the probe is unusable at
provisioning/boot time. `provisionAccount` is idempotent per identity (matched
by Google `sub`, then verified email, then a live-email probe of empty-email
rows), so re-adding the same account never mints a duplicate row.

### Reconnect and add from chat: the `request_google_account` CTA

Google auth still needs the user mid-conversation: a token gets revoked while
the agent is working, or the user asks in chat to add another account. The
no-agent-driven-OAuth decision stands — the sanctioned handling is a **hand-off
button**, not a login:

- The agent calls the always-on `request_google_account` tool (toolset
  `connectors`; dispatch in `packages/runtime/src/execution/tool-dispatch.ts`). It reads
  `listAccountsWithStatus()` and emits ONE `system_note` chat block carrying
  the generic `cta?: { href, label }` field (`SystemNoteCta` in
  `packages/runtime/src/types.ts`): label "Reconnect Google account" when any registered
  account's grant is revoked, else "Connect Google account"; href is always
  `/integrations?view=google` — the Integrations page's Google drill-down
  (the page's in-page view is deep-linkable via the `view` search param), so
  the button lands the user on the per-account Reconnect rows rather than the
  tiles grid. The href is app-relative — chat and the Integrations page are routes of the one web app served
  from a single origin (ADR gateway-web-reverse-proxy.md).
- The web chat renders the note text plus an inline button
  (`packages/web/src/components/chat/BlockSystemNote.tsx`). On the Integrations page the
  user runs the existing loopback PKCE browser OAuth flow. The tool is
  fire-and-forget — no SetupRequest gate —
  because the user navigates away, completes OAuth in their own browser, and
  tells the agent when they're done; the agent's tool result instructs it to
  stop and wait.
- `cta` is deliberately generic to system notes and distinct from `authError`,
  which stays model-provider-specific (ADR provider-reauth-guidance.md). A
  note carries one or the other, never both.
- The steering that routes the agent here lives in the system-prompt
  registered-accounts block (`buildConnectedAccountsBlock`), the auth
  preflight's gws branches (`packages/runtime/src/execution/auth-preflight.ts`), and the
  google skills' prerequisite notes — each names `request_google_account` and
  forbids `gws auth login` and browser-driven sign-in, so an auth failure has
  exactly one mechanism instead of an act-with-no-how directive.
- The Integrations card composes with this instead of looping back into chat:
  "Add account" navigates directly into the same-tab OAuth round trip
  onboarding uses (`connectGoogleUrl`), and a non-primary revoked row gets a
  Reconnect button through that same add flow. The login callback matches the
  existing registry row by email and rewrites its local credential in place. The
  primary row keeps its dedicated relogin path (`reloginPrimaryUrl`, signin
  intent) so the healed account is re-persisted as the primary. All three
  flows pass `returnTo=/integrations?view=google`, so completing OAuth lands
  back in the Google drill-down.
### Trust boundary / security

- **No secrets in chat.** The login script never writes the client id/secret
  or any token to chat or logs; it returns only `{ ok, id, tag, email,
  configDir, scopes }`, and OAuth consent is a human-in-the-loop browser step.
  On a hosted guest the OAuth authorization-code exchange happens server-side
  on the edge instead, and only the resulting refresh token crosses to the
  guest over its bearer-authenticated `/api/google/accounts/provision` call.
- **Trusted registration writes a 0600 credential.** `provisionAccount` writes
  the standard `authorized_user` `credentials.json` (mode 0600, atomic
  temp+rename) into a gini-managed config dir and registers it, deriving the
  canonical account id from the dir basename so `configDirForAccount(id) ===
  account.configDir` holds and removal can clean the dir up.
- **`terminal_exec` still carries no connector env** (ADR
  skill-env-containment.md). Account selection is a config-dir *path* prefix,
  not a secret, so the model targeting an account in an arbitrary `gws` command
  injects no credential — the clean-env guarantee is intact.

## API surface

- `GET /api/google/accounts` → `listAccountsWithStatus()` (registry joined with
  live per-dir `gws auth status`, fetched in parallel, best-effort; exactly the
  effective primary row carries `primary: true`).
- `POST /api/google/accounts` → body `{ tag?, configDir, adopt? }` →
  `registerAccount(...)` (201). Rejects with 400 when `configDir` is missing,
  or `"No signed-in Google session in <dir>"` when the dir has no live
  session — so an empty dir is never registered. A missing `tag` defaults from
  the live session: a re-register keeps the existing row's tag, a fresh
  registration derives the email local-part via `uniqueAccountTag`
  (uniquified case-insensitively, so a defaulted tag never throws on a
  collision — an explicit tag keeps its collision error).
- `POST /api/google/accounts/provision` → body
  `{ clientId, clientSecret, refreshToken, email?, principal?, tag?, primary?,
  makePrimary? }` → `provisionAccount(...)` (201; 400 when any of the three
  credential fields is missing/empty). The hosted-edge provisioning path — see
  "Hosted edge-provisioned accounts" below. `makePrimary: true` persists the
  provisioned account as `primaryAccountId` (sign-in intent — see "The primary
  account and OAuth intents").
- `GET /api/google/login/start?returnTo=&origin=&intent=` → 302 to Google
  consent (the runtime-owned same-tab web login in `google-login-web.ts`, used
  by non-hosted/loopback deployments); 400 in edge auth mode, on a
  non-loopback `origin`, or on an `intent` other than `signin`/`add` (absent
  defaults to `add`).
- `GET /api/google/login/callback?code&state` → always a 302 back into the
  app: `returnTo` on success, `returnTo` + `googleAddError=1` on any failure
  (state mismatch/expiry, exchange failure, missing refresh token/sub).
- `GET /api/google/auth-mode` → `{ mode: "edge" | "loopback" }` — which
  add-account flow the web should offer. `"edge"` iff `GINI_HOSTED=1` (the
  unconditional hosted-guest marker baked by the hosted provisioner) — the hosted
  product's steady state, where the edge drives the OAuth exchange and provision
  call; everywhere else `"loopback"` (the runtime-owned web login above).
- `PATCH /api/google/accounts/:id` → `{ tag }` → retag (404 unknown id; 400 on
  a tag collision).
- `DELETE /api/google/accounts/:id` → remove from the registry; best-effort
  delete the gini-managed config dir; **never** touch `~/.config/gws`.
- `GET /api/connectors` enriches the `google-oauth-desktop` record with
  `accounts` (alongside `session`). The registry is machine-global, so it is
  resolved once and attached to the record.

These `/api/google/accounts` routes are **not** instance-scoped (the registry is
machine-global). The CLI (`gini connector accounts [list|retag|remove]`) and the
Skills-page `GoogleAccountsCard` are thin clients of these routes. Adding an
account is a host-driven flow (the edge's server-side OAuth exchange →
`/api/google/accounts/provision`); the CLI has no `add` and points the user at
the host sign-in instead.

## Consequences

### Required

- Account selection is always a `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` prefix on a
  `gws` command. No tool change is needed for per-command selection, and no
  credential is paired with the arbitrary command.
- Credentialed Google login ships as the `google-account-login` skill's
  `account-login.ts`, invoked via `skill_run`. The setup skill must stay
  credential-free so `read_skill` can load it during first-time setup. On a
  hosted guest login is host-driven instead: the edge runs the OAuth
  authorization-code exchange server-side and hands the guest a refresh token
  via `/api/google/accounts/provision`.
- New persistence belongs in `packages/runtime/src/state/google-accounts.ts` (low-level
  registry) and orchestration in `packages/runtime/src/integrations/connectors/google-accounts.ts`
  (registry ∪ live status, register/remove/retag). Status fetching is injectable
  so it unit-tests without a real `gws` binary.

### Trust boundary

The account dimension never widens the credential surface. The OAuth *client*
creds reach a process only through the named `skill_run` login path
(`resolveSkillEnv`); on a hosted guest even that never happens — the exchange
runs server-side on the edge and the guest receives only the already-exchanged
refresh token over its bearer-authenticated
`/api/google/accounts/provision` call and writes it into a config dir. Selecting
*which account* a query runs as is a path, so it flows through `terminal_exec`'s
clean env unchanged. Removing a gini-managed account deletes its config dir
(its tokens) but never the baked primary's credentials directory.

Registration normally gates the registry write on a live `gws auth status`
probe, so an empty or signed-out dir is never registered. The provisioned
paths — the relay grant (`defaultPersistWorkspaceGrant` in
`packages/runtime/src/integrations/tunnel.ts`) and the hosted-edge paths below
— are the exceptions: they call `registerAccount` with `trusted: true`, which
skips the probe. This is sound because the credential is trustworthy *by
construction* — Google (via the relay or the edge's server-side code exchange)
only issues a refresh token after a completed OAuth consent — and the probe is
unusable at tunnel-connect time, when the `gws` binary may not yet be
installed, so gating on it would strand a valid credential unregistered
(invisible to every readiness surface). A trusted account is written with
the caller's Google-verified email when it has one (the provision path below)
and `email: ""` otherwise (the relay grant and the boot-registered primary);
`listAccountsWithStatus` back-fills the live email and sign-in liveness on
the next read. The general-purpose `POST /api/google/accounts`
route forwards only `{ tag, configDir, adopt }` and never sets `trusted`, so
the probe stays mandatory for all caller-supplied dirs; the provision route
sets it only after building the credential itself from the posted refresh
token.

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

### Hosted edge-provisioned accounts

A hosted guest is headless: the gws
Desktop-client loopback OAuth cannot complete there — nothing opens the
consent URL, and the `localhost` redirect resolves to the visitor's machine,
not the guest. Account adds therefore go through the edge's web-application
OAuth client, the same client sign-in uses (gws does not care which client
minted a refresh token; the hosted primary already runs off this client's
token). Three pieces make that work:

- **`GET /api/google/auth-mode`** tells the web which flow to offer. Keyed on
  `GINI_HOSTED=1` — the marker the hosted provisioner bakes into every guest's
  environment unconditionally — rather than
  `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, which is only present when the
  sign-in granted Workspace scopes (a guest without it still can't do
  loopback).
- **`POST /api/google/accounts/provision`** (`provisionAccount` in the
  connector module) is how a new credential lands: the edge runs the consent
  redirect + server-side code exchange (`/auth/google/add`, whose
  `intent=signin` rides the add-mode OAuth state and becomes
  `makePrimary: true` in the POST — see "The primary account and OAuth
  intents"), then POSTs
  `{ clientId, clientSecret, refreshToken, email?, principal?, tag?,
  makePrimary? }` to the guest with the guest's bearer token. The runtime writes the standard
  `authorized_user` `credentials.json` (0600, atomic temp+rename) into a
  managed config dir and registers it `trusted: true`. Idempotent per
  identity, matched in order: (1) a provisioned row with the same immutable
  `principal` (the Google `sub`) — mirroring the relay grant's re-find; (2) a
  row whose stored email equals the posted email case-insensitively; (3)
  among rows with no stored email, a best-effort live `gws auth status` probe
  per row matched on the live email — this is what re-finds rows registered
  before their email was known, like the boot-registered primary. The posted
  email is trustworthy for matching: both callers (the edge add callback and
  the loopback web callback) take it from Google userinfo fetched with the
  same exchange's access token, so the user just proved ownership of that
  mailbox. On a match the credential is rewritten into that row's config dir,
  the principal is stamped, `provisioned` stays sticky, the stored email is
  backfilled, and the row's (possibly user-retagged) tag and id are kept.
  Only a genuinely new identity mints a row, defaulting its tag to the email
  local-part, uniquified case-insensitively so registration never throws on a
  collision. **Owner-match upgrade:** when the OAuth'd Google sub equals the
  session owner's stored sub (subs are immutable; emails are never compared),
  the edge's add callback additionally sends `primary: true` — the baked-dir
  heal flag — regardless of intent, and persists the freshly-minted refresh
  token/scopes onto its own accounts row the way the sign-in callback does.
  This is what lets the web's reconnect relogin heal a REVOKED owner
  credential through the add flow: a revoked credential has no live email or
  principal for the identity matching above, so without the flag the heal
  would mint a duplicate row instead of rewriting the baked file gws reads.
- **Boot-time primary registration** (`ensureHostedPrimaryAccount`, called
  best-effort at gateway boot in `server.ts`): the sign-in grant is baked into
  the guest as a credentials file pointed at by
  `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, which gws reads via env — it never
  passes through the provision endpoint, so the registry wouldn't know about
  it. Boot registers `dirname(credentials file)` as the trusted `primary`
  account when no registry row points at that dir yet. It requires BOTH
  hosted markers (`GINI_HOSTED=1` and the credentials env) so a local machine
  exporting the gws env var for its own use never grows a surprise registry
  row; errors are logged and never block boot. The boot-registered primary
  carries no `principal` (the guest doesn't know its Google `sub`) and no
  stored email, so a user re-adding the same identity through the edge
  re-finds it via the owner-match upgrade above (`primary: true` routes the
  credential straight into the baked dir, with the live-email probe as the
  identity-matched fallback): the primary row keeps its tag and id, gets the
  fresh credential and the `principal` stamped, and its email backfilled — no
  duplicate row.

OAuth scopes are deliberately unchanged by this path: the edge add flow
requests the same `gmail.modify` + calendar set sign-in does. Widening the
scope set is a separate decision.

## Acceptance checks

- `bun test packages/runtime/src/state/google-accounts.test.ts` — registry round-trips
  (atomic write + read-back), missing/corrupt file → `[]`, case-insensitive tag
  uniqueness rejects a colliding add/retag, remove is a no-op for an unknown id;
  `primaryAccountId` set/read/clear round-trips, survives account writes, is
  cleared by removing the primary account, and reads tolerantly (absent/corrupt
  → undefined).
- `bun test packages/runtime/src/integrations/connectors/google-accounts.test.ts` —
  `registerAccount` derives the id from the dir basename for a gini-managed dir
  (so `removeAccount` cleans that dir) and reuses/mints for an adopted dir;
  `registerAccount` throws for a not-signed-in dir **on the default (probed)
  path**, and registers without probing when called with `trusted: true` (the
  relay-provisioned path below); `removeAccount` deletes a gini-managed dir but
  never `~/.config/gws`; `listAccountsWithStatus` degrades a failing per-dir
  status fetch to `signedIn: false`; `provisionAccount` mints a 0600 credential
  with the caller's client, dedupes re-adds by principal, stored email, and
  live-probed email of empty-email rows (no duplicate rows; a matched row keeps
  its tag/id and gets the principal stamped and its email backfilled), and
  uniquifies a colliding default tag; `provisionAccount` with
  `makePrimary: true` persists the provisioned/matched account as the primary
  while a plain add never touches it; `listAccountsWithStatus` marks exactly
  the effective primary row `primary: true` (persisted id when live, else the
  first-provisioned/first fallback); `googleAuthMode` /
  `ensureHostedPrimaryAccount` key on the hosted markers (register once,
  no-op when already registered or unhosted; sets `primaryAccountId` only
  when unset).
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
- The connected-account prompt routes auth failures to
  `request_google_account` (never `gws auth login`).
- `bun test packages/runtime/src/execution/request-google-account-dispatch.test.ts` —
  `request_google_account` emits exactly one `system_note` with
  `cta.href === "/integrations?view=google"`, a Reconnect label (naming the revoked
  account) when any registered account is revoked and a Connect label
  otherwise, honors the agent's `message` override, and degrades a failing
  status probe to the Connect wording; the status provider is stubbed so no
  test spawns `gws`.
- `bun test packages/runtime/src/integrations/connectors/google-login-web.test.ts`
  — the runtime-owned same-tab web login with stubbed Google HTTP: edge-mode,
  non-loopback-origin, and unknown-intent 400s, the returnTo sanitizer, the
  consent-URL shape (PKCE S256 round trip, state, offline+consent, the gws
  scope set, the browser-facing redirect_uri), callback state
  mismatch/expiry/supersede, exchange-failure and missing-refresh-token/sub
  redirects with `googleAddError=1`, the 0600 provisioned credential,
  per-principal idempotent re-adds, and the intent semantics (signin flips the
  persisted primary only on success; add/default never does).
- E2E in a real chat turn: with two accounts connected, an unscoped read
  ("what's on my calendar") runs against every account's config dir and
  aggregates the results; a write that doesn't name an account makes the agent
  ask which one first; a request that names a tag/email runs against that
  account's config dir.

## Related

- ADR `typed-named-credentials.md` — the single `google-workspace-oauth`
  credential name the skills resolve by; unchanged here (one client, many
  accounts).
- ADR `skill-env-containment.md` — the single-surface env containment for
  connector-derived env; no Workspace login runs on the guest, so the guest
  never needs the `gws auth login` client-env injection.
- ADR `connector-provider-spec-compliance.md` — the transient `session`
  enrichment and "Health vs. session liveness" pattern the `accounts`
  enrichment mirrors.
- ADR `skill-connector-consent.md` — bundled skills are auto-granted their
  declared credentials.
- ADR `connector-secret-storage.md` — how the OAuth client creds are encrypted
  at rest.

