---
name: google-drive
description: "Google Drive via gws: search, list, upload, download, share."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Drive scopes."
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

# Google Drive

Use `gws drive` to search, list, upload, download, copy, and share files and folders, plus manage shared drives, permissions, and revisions. The CLI wraps the Drive v3 API.

## Prerequisites

- `gws` must be installed. If it is not on PATH, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- If `gws auth status` reports no authenticated user, or a Drive call fails with an auth error, call `request_google_account`, tell the user to use the connect/reconnect button, then stop and wait. For `scope required`, name the missing scope before offering the reconnect button.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - `drive.file` — see and modify only files the agent creates or that the user explicitly opens (narrowest, recommended for untrusted agents)
  - `drive.readonly` — read all of the user's files and metadata
  - `drive` — full read + write across the user's entire Drive

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws drive files list
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`).

## When to Use

- The user asks Gini to find, list, upload, download, share, copy, move, rename, or delete files in Drive.
- Pulling a file's metadata or share link to drop into another workflow.
- Creating or managing folders and shared drives.
- Adjusting permissions on a file or folder (`role: reader|commenter|writer|fileOrganizer|organizer`).

## When NOT to Use

- Reading or writing **the body** of a Google Doc, Sheet, or Slides deck — use `google-docs` (or the analogous Sheets/Slides skill) for content edits; Drive only handles files-as-objects (metadata, sharing, bytes).
- Personal cross-device notes — use `apple-notes` or `obsidian` instead of dropping a `.txt` in Drive.
- Agent-internal ephemeral state — use the `memory` tool, not a Drive file.
- Large bulk downloads where the user already has `rclone` or a sync client configured — Drive's native client is more reliable for multi-GB transfers.
- Project task tracking or structured data — Drive holds the files; the schema lives in Docs/Sheets/Forms or an issue tracker.

## Quick Reference

The Drive surface is the auto-generated v3 API (`gws drive files list`, `gws drive permissions create`, `gws drive drives list`, …) plus a `+upload` helper that handles multipart uploads with MIME-type detection.

### Search and list

Drive search uses the `q` parameter with operators like `name contains`, `mimeType =`, `'<FOLDER_ID>' in parents`, `modifiedTime >`, `sharedWithMe`, `trashed = false`. Quote string literals inside `q` with single quotes (and JSON-escape if needed).

```bash
# 10 most-recently-modified files
gws drive files list --params '{"pageSize":10,"orderBy":"modifiedTime desc"}'

# Files in a specific folder
gws drive files list --params '{"q":"'\''<FOLDER_ID>'\'' in parents and trashed = false"}'

# Spreadsheets only
gws drive files list \
  --params '{"q":"mimeType = '\''application/vnd.google-apps.spreadsheet'\''"}'

# By name fragment
gws drive files list --params '{"q":"name contains '\''Q1 budget'\''"}'

# Stream every page as NDJSON
gws drive files list --params '{"pageSize":100}' --page-all 2>/dev/null | jq -r '.files[].name'
```

When piping `gws` into `jq`, drop stderr first with `2>/dev/null` — `gws` prints a `Using keyring backend: keyring` preamble there that would otherwise contaminate the JSON (never `2>&1`).

Useful Workspace MIME types:

| Type | mimeType |
|------|----------|
| Folder | `application/vnd.google-apps.folder` |
| Doc | `application/vnd.google-apps.document` |
| Sheet | `application/vnd.google-apps.spreadsheet` |
| Slides | `application/vnd.google-apps.presentation` |
| Form | `application/vnd.google-apps.form` |

### Upload

```bash
# Helper: auto-detects MIME, defaults filename to local path
gws drive +upload ./report.pdf
gws drive +upload ./report.pdf --parent <FOLDER_ID>
gws drive +upload ./data.csv --name 'Sales Data.csv'

# Raw API equivalent
gws drive files create \
  --json '{"name":"report.pdf","parents":["<FOLDER_ID>"]}' \
  --upload ./report.pdf
```

### Download and export

```bash
# Download a binary file (PDF, image, etc.) by ID
gws drive files get --params '{"fileId":"<FILE_ID>","alt":"media"}' -o ./report.pdf

# Export a Google Doc to PDF / Word / plain text (10 MB limit per export)
gws drive files export \
  --params '{"fileId":"<DOC_ID>","mimeType":"application/pdf"}' \
  -o ./doc.pdf
```

### Create a folder

```bash
gws drive files create --json '{
  "name": "Quarterly reports",
  "mimeType": "application/vnd.google-apps.folder"
}'
```

### Share / permissions

```bash
# List existing permissions
gws drive permissions list --params '{"fileId":"<FILE_ID>"}'

# Grant a single user write access (no email notification)
gws drive permissions create \
  --params '{"fileId":"<FILE_ID>","sendNotificationEmail":false}' \
  --json '{"role":"writer","type":"user","emailAddress":"alice@example.com"}'

# Anyone with the link can view
gws drive permissions create \
  --params '{"fileId":"<FILE_ID>"}' \
  --json '{"role":"reader","type":"anyone"}'
```

### Copy, move, rename, delete

```bash
gws drive files copy --params '{"fileId":"<SRC_ID>"}' --json '{"name":"Copy of report"}'
gws drive files update --params '{"fileId":"<FILE_ID>","addParents":"<NEW_FOLDER>","removeParents":"<OLD_FOLDER>"}'
gws drive files update --params '{"fileId":"<FILE_ID>"}' --json '{"name":"New name.pdf"}'
gws drive files delete --params '{"fileId":"<FILE_ID>"}'
```

### Shared drives

Generate a fresh UUID per call, e.g. `uuidgen`. `drives.create` uses `requestId` as an idempotency token — reusing the same value collides.

```bash
gws drive drives list
gws drive drives create --params '{"requestId":"<REQUEST_ID>"}' --json '{"name":"Marketing"}'
```

## Rules

1. Drive **folder IDs and file IDs look identical** but behave differently. A folder is just a file with `mimeType: application/vnd.google-apps.folder`. Always confirm the mimeType before treating an ID as a container.
2. Don't add a redundant text confirmation before `files.create`, `+upload`, `files.update`, `files.delete`, `permissions.create`, or `permissions.delete`. The runtime's `terminal_exec` approval gate is the user's safety net. When the user's command is clear ("upload report.pdf to Drive," "share Q4-plan with alice@acme.com as editor"), execute. Do ask one clarifying question when the command is ambiguous — multiple files match a name, the user didn't specify a target folder, or the user didn't name a `reader`/`writer`/`owner` role.
3. Be conservative with permissions. `type: anyone` exposes a file to the public internet — always confirm with the user before creating an "anyone with the link" share, and prefer `type: user` with a specific `emailAddress` when possible.
4. To delete: prefer trashing first (`files.update` with `{"trashed": true}`) over `files.delete`, which is permanent and bypasses the trash. Only use `files.delete` if the user explicitly said "permanently delete".
5. For editing **the content** of a Google Doc, do not download-then-re-upload — that breaks revision history and concurrent editing. Use `google-docs` to call the Docs API directly. Drive is the file/permissions surface; Docs/Sheets/Slides own content edits.
6. For personal cross-device notes, prefer `apple-notes` or `obsidian` over creating throwaway Drive files. For agent-internal ephemeral state, use the `memory` tool.
7. When uploading, `+upload` infers MIME type from the file extension. For ambiguous content (e.g. CSV that should land as a Google Sheet), use the raw `files.create` API with explicit `mimeType` instead.
8. Drive search with `--page-all` can pull thousands of rows quickly. Cap with `--page-limit` when prototyping so the agent does not iterate forever on a user's full Drive.

For flags not shown here, run `gws drive --help` or `gws drive <verb> --help` (e.g. `gws drive +upload --help`).
