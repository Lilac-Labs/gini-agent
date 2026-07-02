---
name: google-account-login
description: "Sign a Google account into its own gws config dir and register it (tagged). Used by google-workspace-setup; runs the OAuth login + records the account."
license: MIT
compatibility: "macOS and Linux. Requires the gws CLI and a provisioned google-workspace-oauth client."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
      env:
        - GOOGLE_WORKSPACE_CLI_CLIENT_ID
        - GOOGLE_WORKSPACE_CLI_CLIENT_SECRET
    requires:
      credentials: [google-workspace-oauth]
---

# Google Account Login

Signs **one** Google account into its own `gws` config dir and registers it as a tagged account. One OAuth client (held by the `google-workspace-oauth` connector) can authorize many accounts — each lives in its own config dir selected via `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`. This skill is the login step for that multi-account model.

This skill is **normally invoked by `google-workspace-setup`**, not called directly by users. Run it only **after** the `google-workspace-oauth` connector exists (so the client id/secret are injected into the script's env).

It ships one script, `scripts/account-login.ts`, invoked through `skill_run`:

```text
skill_run {
  skill: "google-account-login",
  script: "account-login",
  args: { tag: "personal", services: ["drive","gmail","calendar","docs","sheets","meet","forms"] }
}
```

The script mints a gini-managed config dir under `~/.gini/google-accounts/<id>`, runs `gws auth login` (it opens the user's browser to the Google consent screen and waits for them to finish), then confirms the session and registers the tagged account with the local gateway. The user's default browser pops automatically — sign-in is a human-in-the-loop step; never type the user's email or password. The consent URL always carries `prompt=select_account`, so Google shows the account chooser instead of silently auto-grabbing whatever account the browser is already signed into.

## Arguments (stdin JSON)

- `tag` (string, required) — short label for this account, e.g. `"personal"` or `"work"`. Tags are unique across accounts.
- `services` (string[], optional) — `gws` service names to request. Defaults to all seven: `["drive","gmail","calendar","docs","sheets","meet","forms"]`.
- `readonly` (boolean, optional) — request read-only scopes for the chosen services.
- `scopes` (string[], optional) — explicit full scope URLs; overrides `services`. Use only when the user names a specific scope shape `-s` can't express (e.g. full Gmail `https://mail.google.com/`).
- `configDir` (string, optional) — run the login into a **specific existing** config dir instead of minting a new one. Use it to **re-auth** an account whose session expired: pass that account's stored `configDir` (or `"~/.config/gws"` for the default-dir session) so the account keeps its id and tag. When omitted, a new gini-managed dir is minted. Ignored when `adopt: true`. When re-authing, also pass the account's known email as `loginHint` **and** `expectedEmail` so Google pre-selects the right account and a wrong-account grab fails fast.
- `loginHint` (string, optional) — the intended account's email; pre-highlights it in Google's account chooser. For re-auth, pass the account's known email.
- `expectedEmail` (string, optional) — the account this dir must end up as; the login **fails fast** (never registers) if a different account signs in, instead of silently overwriting the tag.
- `adopt` (boolean, optional) — register the **already-signed-in** session in the default config dir (`~/.config/gws`) without a fresh login. No browser opens; fails if that dir has no live session.

## Result (stdout JSON)

On success:

```json
{ "ok": true, "id": "gacct_ab12cd34", "tag": "personal", "email": "me@example.com",
  "configDir": "/Users/me/.gini/google-accounts/gacct_ab12cd34",
  "scopes": ["https://www.googleapis.com/auth/gmail.modify", "..."] }
```

On failure: `{ "ok": false, "error": "<reason>" }` (and a non-zero exit). Common reasons: `"gws never printed the consent URL"`, `"Login did not produce a valid session."`, `"No signed-in Google session in the default gws config dir to adopt."`, or the gateway's register error.
