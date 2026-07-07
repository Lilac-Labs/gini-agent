---
name: google-forms
description: "Google Forms via gws: create forms, add items, read responses."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated with Forms scopes."
metadata:
  gini:
    version: 1.1.2
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

# Google Forms

Use `gws forms` to create new forms, add questions to them, change publish settings, and read submitted responses. Wraps the Forms v1 API.

## Prerequisites

- If this deployment is managed/hosted, the Google credential is already provisioned at sign-in — `gws` is installed and authenticated, so skip the setup flow below and run `gws` directly. Scopes are fixed at sign-in on a managed deployment: when a call fails with `scope required` or HTTP 401, tell the user which action needs a scope their account wasn't granted, instead of trying to set anything up. (The scope list below still describes which verb needs which scope.)
- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws forms ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Create / edit forms (read + write structure): `forms.body`
  - Read form structure only (e.g. mapping `questionId → title` for summaries): `forms.body.readonly`
  - Read submitted responses: `forms.responses.readonly`
  - Summarize responses by question text: `forms.responses.readonly` AND `forms.body.readonly` (or `forms.body`). `forms.responses.readonly` is NOT on `forms.get`'s authorized scope list — you need a body scope to fetch the structure separately.
  - The Forms API also accepts the broader `drive` scope for create, get, and responses — an account with a full `drive` grant can edit form structure and read responses without the separate Forms scopes.

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws forms forms create --json '{"info":{"title":"Survey"}}'
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`). On a managed/hosted deployment an account is always connected, so this case doesn't arise.

## When to Use

- The user asks Gini to create a Google Form (survey, signup, feedback, RSVP).
- Reading responses to an existing form and summarizing them.
- Updating publish settings on an existing form (accepting responses on/off, etc.).
- Watching for new responses on an existing form.

## When NOT to Use

- Structured data the user maintains themselves — use Sheets (`gws sheets ...`), not Forms.
- Free-form notes — use `apple-notes`, `obsidian`, or `google-docs` instead.
- Agent-internal state — use the `memory` tool.
- Long, branching surveys with complex logic — Forms supports basic section navigation but real survey tooling (Typeform, Qualtrics) is more appropriate.

## Quick Reference

The Forms surface is small: `forms.create`, `forms.get`, `forms.batchUpdate`, `forms.setPublishSettings`, and the `forms.responses` subresource for reading submissions.

### Create a form (two-step)

`forms.create` only honors `info.title` and `info.documentTitle`. Body items must be added with a follow-up `batchUpdate`. This is by design — Google rejects body content in the create call.

```bash
# Step 1: create the empty form
gws forms forms create --json '{
  "info": {
    "title": "Team feedback",
    "documentTitle": "Team feedback (internal)"
  }
}'

# Capture the response's "formId" — you'll need it for step 2.

# Step 2: add items (questions) with batchUpdate
gws forms forms batchUpdate \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{
    "requests": [
      {
        "createItem": {
          "item": {
            "title": "How are things going?",
            "questionItem": {
              "question": {
                "required": true,
                "textQuestion": {"paragraph": true}
              }
            }
          },
          "location": {"index": 0}
        }
      },
      {
        "createItem": {
          "item": {
            "title": "How satisfied are you?",
            "questionItem": {
              "question": {
                "required": true,
                "scaleQuestion": {
                  "low": 1, "high": 5,
                  "lowLabel": "Not at all", "highLabel": "Extremely"
                }
              }
            }
          },
          "location": {"index": 1}
        }
      }
    ]
  }'
```

### Read a form's structure

```bash
gws forms forms get --params '{"formId":"<FORM_ID>"}'
```

The response contains the title, items, and the `responderUri` (the public URL to share with respondents).

### Read responses

```bash
# All responses on a form
gws forms forms responses list --params '{"formId":"<FORM_ID>"}' --page-all

# A specific response
gws forms forms responses get \
  --params '{"formId":"<FORM_ID>","responseId":"<RESPONSE_ID>"}'

# Filter by submission time (server-side filter)
gws forms forms responses list \
  --params '{"formId":"<FORM_ID>","filter":"timestamp > 2026-06-01T00:00:00Z"}' \
  --page-all
```

Each response has an `answers` map keyed by `questionId`. Cross-reference against `forms.get` to map question IDs back to titles when summarizing. `forms.get` reads form structure and requires `forms.body.readonly` (or `forms.body`) — `forms.responses.readonly` alone is not on its authorized scope list, so summary workflows need both.

### Publish settings

When piping `gws` into `jq`, drop stderr first with `2>/dev/null` — `gws` prints a `Using keyring backend: keyring` preamble there that would otherwise contaminate the JSON (never `2>&1`).

```bash
# Inspect
gws forms forms get --params '{"formId":"<FORM_ID>"}' 2>/dev/null | jq '.publishSettings'

# Update (legacy forms not supported)
gws forms forms setPublishSettings \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{"publishSettings":{"publishState":{"isPublished":true,"isAcceptingResponses":true}}}'
```

### Watch for new responses

```bash
gws forms forms watches create \
  --params '{"formId":"<FORM_ID>"}' \
  --json '{"watch":{"target":{"topic":{"topicName":"projects/<PROJECT>/topics/<TOPIC>"}},"eventType":"RESPONSES"}}'
```

Watches deliver to Pub/Sub. For most agent workflows, polling `responses.list` on a schedule is simpler.

## Rules

1. `forms.create` is two-step by design: create the empty shell, then `batchUpdate` to add items. Trying to embed `items[]` in the create call is silently dropped.
2. Don't add a redundant text confirmation before `forms.create`, `forms.batchUpdate`, or `forms.setPublishSettings`. The runtime's `terminal_exec` approval gate is the user's safety net. When the user's command is clear ("create a feedback form with these three questions"), execute. Do ask one clarifying question when the command is ambiguous — the user named items but no title, multiple forms match a name they want to edit, or `setPublishSettings` would flip a form from draft to public.
3. `batchUpdate` is atomic across all `requests`. Build the full sequence (createItem, updateItem, deleteItem, …) and send once; do not loop one-request-at-a-time, which doubles round trips and risks half-applied state.
4. The `responderUri` returned by `forms.get` is a public URL. Anyone with the link who is allowed by the form's access settings can submit. Be explicit when sharing it.
5. To map answers back to question text, fetch the form structure once with `forms.get` and keep the `questionId → title` map locally — do not refetch the structure on every response. This requires `forms.body.readonly` (or `forms.body`) in addition to `forms.responses.readonly`; `forms.get` rejects a responses-only scope.
6. For structured data the user already owns (existing CSV or sheet), Forms is the wrong tool — keep the data in Sheets and use `gws sheets`. Forms is for **collecting** new input, not storing existing data.
7. Long, branching surveys are better served by dedicated survey tools (Typeform, Qualtrics). Forms supports basic page navigation and required questions but no advanced logic.

For flags not shown here, run `gws forms --help` or `gws schema forms.<resource>.<method>` to inspect a specific API method.
