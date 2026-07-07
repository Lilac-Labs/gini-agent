---
name: google-docs
description: "Google Docs via gws: read, append text, structured batch edits."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated with Docs scopes."
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

# Google Docs

Use `gws docs` to create blank documents, read existing document content, append text, and run structured batch updates against the Docs v1 API. This is the **content** surface for Google Docs — for the file as an object (sharing, copying, moving, trashing) use `google-drive` instead.

## Prerequisites

- If this deployment is managed/hosted, the Google credential is already provisioned at sign-in — `gws` is installed and authenticated, so skip the setup flow below and run `gws` directly. Scopes are fixed at sign-in on a managed deployment: when a call fails with `scope required` or HTTP 401, tell the user which action needs a scope their account wasn't granted, instead of trying to set anything up. (The scope list below still describes which verb needs which scope.)
- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws docs ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read and edit Docs: `docs`
  - Find docs by title (or list recent docs) before reading: pair with `drive.readonly`
  - The Docs API also accepts the broader `drive` scope, which covers finding docs by title too — an account with a full `drive` grant needs no separate `docs` scope

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws docs documents create --json '{"title":"Notes"}'
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`). On a managed/hosted deployment an account is always connected, so this case doesn't arise.

## When to Use

- The user asks Gini to read, draft, or edit the **body** of a Google Doc.
- Appending notes, meeting summaries, or AI-generated content to an existing doc.
- Creating a new blank doc as a starting point (then editing it with `+write` or `batchUpdate`).
- Running structured edits (insert text at index, replace all of a string, apply heading styles) via the `batchUpdate` API.

## When NOT to Use

- Sharing, moving, renaming, copying, trashing, or permission-managing a doc — use `google-drive` for the file-as-object surface.
- Spreadsheets — use Sheets (`gws sheets ...`), not Docs.
- Slide decks — use Slides (`gws slides ...`), not Docs.
- Personal cross-device notes — use `apple-notes` or `obsidian`; a Google Doc is overkill and slower to sync.
- Agent-internal scratch state — use the `memory` tool.
- Long-form Markdown the user maintains locally — keep it in the repo or vault. Docs is for content that needs collaborative editing or live sharing.

## Quick Reference

The Docs surface has only three top-level methods (`documents.get`, `documents.create`, `documents.batchUpdate`) plus a `+write` helper for the common "append text" case.

### Create a blank doc

```bash
gws docs documents create --json '{"title":"Weekly notes"}'
```

The response includes a `documentId` you will need for subsequent reads and writes. Other fields in the request (body, settings, …) are ignored by `documents.create` — set them with a follow-up `batchUpdate` call.

### Read a doc

```bash
gws docs documents get --params '{"documentId":"<DOC_ID>"}'
```

The response is the full structured Docs JSON tree (`body.content[]` of paragraph, table, sectionBreak, etc. elements). For a plain-text dump, pipe through `jq` — and strip stderr first with `2>/dev/null`, since `gws` prints a `Using keyring backend: keyring` preamble there that would otherwise contaminate the JSON (never use `2>&1`):

```bash
gws docs documents get --params '{"documentId":"<DOC_ID>"}' 2>/dev/null \
  | jq -r '.body.content[].paragraph?.elements[]?.textRun?.content // empty'
```

### Append text (helper)

```bash
gws docs +write --document <DOC_ID> --text 'Hello, world!'
gws docs +write --document <DOC_ID> --text "$(cat ./notes.md)"
```

`+write` inserts the given text at the end of the document body. For anything richer (bold, headings, bullet lists, replace-all, table insert) drop to `documents.batchUpdate`.

### Structured edits (`batchUpdate`)

The Docs API edits a doc as an ordered list of `requests`. Each request is one mutation. The whole batch is atomic — if any request is invalid, nothing is applied.

```bash
# Insert text at a specific index
gws docs documents batchUpdate \
  --params '{"documentId":"<DOC_ID>"}' \
  --json '{
    "requests": [
      {"insertText": {"location": {"index": 1}, "text": "Heading\n"}}
    ]
  }'

# Replace every occurrence of a placeholder
gws docs documents batchUpdate \
  --params '{"documentId":"<DOC_ID>"}' \
  --json '{
    "requests": [
      {"replaceAllText": {
         "containsText": {"text": "{{NAME}}", "matchCase": true},
         "replaceText": "Alice"
      }}
    ]
  }'

# Apply heading style to a range
gws docs documents batchUpdate \
  --params '{"documentId":"<DOC_ID>"}' \
  --json '{
    "requests": [
      {"updateParagraphStyle": {
         "range": {"startIndex": 1, "endIndex": 8},
         "paragraphStyle": {"namedStyleType": "HEADING_1"},
         "fields": "namedStyleType"
      }}
    ]
  }'
```

For schema details on each request type, inspect the method:

```bash
gws schema docs.documents.batchUpdate
```

### Find a doc by title before reading

Use `google-drive` to locate the doc, then hand the ID to `gws docs`:

```bash
gws drive files list \
  --params '{"q":"mimeType = '\''application/vnd.google-apps.document'\'' and name contains '\''Weekly notes'\''"}'
```

## Rules

1. Don't add a redundant text confirmation before `documents.create`, `documents.batchUpdate`, or `+write`. The runtime's `terminal_exec` approval gate is the user's safety net. When the user's command is clear ("append today's meeting notes to the Weekly notes doc"), execute. Do ask one clarifying question when the command is ambiguous — multiple docs match a name, the user didn't specify whether to insert vs replace existing content, or a `batchUpdate` request list would overwrite a large range the user didn't explicitly call out.
2. `documents.create` only accepts `title` — body content, settings, and permissions are ignored. To populate a new doc, follow create with `+write` or `batchUpdate`.
3. `batchUpdate` is atomic across all requests in the array. Build the full request list, send it once, and check the reply rather than retrying mid-batch on partial failure.
4. Index math on `batchUpdate` is brittle — every text insertion shifts the indices of subsequent content. When making multiple inserts, either order requests from highest index to lowest, or use `replaceAllText` (which is index-agnostic) when possible.
5. For sharing, copying, moving, renaming, or trashing a doc — switch to `google-drive`. Docs only owns the body; Drive owns the file.
6. For personal note-taking that should sync across the user's devices outside Google's ecosystem, prefer `apple-notes` or `obsidian` over creating a Google Doc. Use Docs when the user needs collaborative editing or live sharing.
7. When dumping body text via `jq`, the path above only catches paragraph-level `textRun` content. Tables, footnotes, headers/footers, and embedded objects live in other branches of the tree — for a faithful export, use Drive's `files.export` with `mimeType: text/plain` instead.

For flags not shown here, run `gws docs --help` or `gws schema docs.<resource>.<method>` to inspect a specific API method.
