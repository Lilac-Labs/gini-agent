---
name: google-sheets
description: "Google Sheets via gws: read/write cells, append rows, structured batch edits."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated with Sheets scopes."
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

# Google Sheets

Use `gws sheets` to create spreadsheets, read cell ranges, append rows, update values, and run structured batch updates against the Sheets v4 API. This is the **content** surface for Google Sheets — for the file as an object (sharing, copying, moving, trashing) use `google-drive` instead.

## Prerequisites

- If this deployment is managed/hosted, the Google credential is already provisioned at sign-in — `gws` is installed and authenticated, so skip the setup flow below and run `gws` directly. Scopes are fixed at sign-in on a managed deployment: when a call fails with `scope required` or HTTP 401, tell the user which action needs a scope their account wasn't granted, instead of trying to set anything up. (The scope list below still describes which verb needs which scope.)
- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws sheets ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read and write Sheets: `sheets` (maps to `https://www.googleapis.com/auth/spreadsheets`)
  - Read-only Sheets: pass `--scopes "https://www.googleapis.com/auth/spreadsheets.readonly"` at login
  - Find sheets by title (or list recent sheets) before reading: pair with `drive.readonly`
  - The Sheets API also accepts the broader `drive` scope, which covers finding sheets by title too — an account with a full `drive` grant needs no separate `sheets` scope

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws sheets spreadsheets create --json '{"properties":{"title":"Tracker"}}'
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`). On a managed/hosted deployment an account is always connected, so this case doesn't arise.

## When to Use

- The user asks Gini to read cell values, ranges, or whole sheets out of a Google Spreadsheet.
- Appending rows to a tracking sheet (CRM log, expense tracker, AI run log, etc.).
- Updating specific cells or ranges with computed values.
- Creating a new spreadsheet from scratch as a starting point.
- Running structured edits (insert sheets, freeze rows, format ranges, conditional formats) via `spreadsheets.batchUpdate`.

## When NOT to Use

- Sharing, moving, renaming, copying, trashing, or permission-managing a spreadsheet — use `google-drive` for the file-as-object surface.
- Long-form prose or formatted documents — use `google-docs`.
- Slide decks — use Slides (`gws slides ...`), not Sheets.
- Lightweight key-value state the agent owns internally — use the `memory` tool, not a sheet.
- Numeric analysis Gini can do in-process (sum, average, sort, filter) — fetch the data once with `+read`, compute locally, write the result back if needed. Don't round-trip every calculation through the Sheets API.

## Quick Reference

The Sheets surface splits into two layers: helper commands for the common cases (`+read`, `+append`) and the raw API (`spreadsheets.get`, `spreadsheets.values.*`, `spreadsheets.batchUpdate`) for everything else.

### Create a blank spreadsheet

```bash
gws sheets spreadsheets create --json '{"properties":{"title":"Weekly tracker"}}'
```

The response includes a `spreadsheetId` you will need for subsequent reads and writes. The `spreadsheetUrl` field is the user-facing URL — surface that, not the bare ID, when telling the user where the new sheet is.

### Read a range (helper)

```bash
gws sheets +read --spreadsheet <SHEET_ID> --range 'Sheet1!A1:D10'
gws sheets +read --spreadsheet <SHEET_ID> --range Sheet1
```

`+read` is read-only. The response is the matched `values` array (rows of cells), already unwrapped from the raw API envelope. Pass `--format csv` if the user wants to pipe the result somewhere; `--format table` for human review in chat.

### Append a row (helper)

```bash
# Simple single row, comma-separated
gws sheets +append --spreadsheet <SHEET_ID> --values 'Alice,100,true'

# Bulk multi-row insert as JSON
gws sheets +append --spreadsheet <SHEET_ID> --json-values '[["a","b"],["c","d"]]'
```

`+append` finds the first empty row at the bottom of the existing data range and writes there. To write to a specific range (overwriting), use `spreadsheets.values.update` instead.

### Read a range (raw API)

```bash
gws sheets spreadsheets values get \
  --params '{"spreadsheetId":"<SHEET_ID>","range":"Sheet1!A1:D10"}'
```

The raw response wraps the values in `{ "range": "...", "majorDimension": "ROWS", "values": [[…]] }`. Useful when you need the `range` echo or want to set `majorDimension=COLUMNS`.

### Update a specific range

```bash
gws sheets spreadsheets values update \
  --params '{"spreadsheetId":"<SHEET_ID>","range":"Sheet1!A1:B2","valueInputOption":"USER_ENTERED"}' \
  --json '{"values":[["Header1","Header2"],["Row1A","Row1B"]]}'
```

`valueInputOption` matters:
- `RAW` — strings are stored verbatim, no formula or number parsing.
- `USER_ENTERED` — Sheets parses input as if the user typed it: `=SUM(A1:A5)` becomes a formula, `1,000` becomes a number. This is almost always what you want.

### Batch read or batch update values

```bash
# Read several disjoint ranges in one call
gws sheets spreadsheets values batchGet \
  --params '{"spreadsheetId":"<SHEET_ID>","ranges":["Sheet1!A1:B2","Sheet1!D1:D5"]}'

# Write several disjoint ranges in one call (atomic)
gws sheets spreadsheets values batchUpdate \
  --params '{"spreadsheetId":"<SHEET_ID>"}' \
  --json '{
    "valueInputOption":"USER_ENTERED",
    "data":[
      {"range":"Sheet1!A1","values":[["Top-left"]]},
      {"range":"Sheet2!Z99","values":[["Far corner"]]}
    ]
  }'
```

### Structured edits (`spreadsheets.batchUpdate`)

Different from `values.batchUpdate` (which writes cell values). `spreadsheets.batchUpdate` mutates the **structure**: add sheets, freeze rows, set tab colors, apply conditional formats, insert charts. Each entry in `requests` is one mutation; the whole batch is atomic — if any request is invalid, nothing applies.

```bash
# Add a new tab
gws sheets spreadsheets batchUpdate \
  --params '{"spreadsheetId":"<SHEET_ID>"}' \
  --json '{
    "requests":[
      {"addSheet":{"properties":{"title":"Q1 Results"}}}
    ]
  }'

# Freeze the header row and set a tab color
gws sheets spreadsheets batchUpdate \
  --params '{"spreadsheetId":"<SHEET_ID>"}' \
  --json '{
    "requests":[
      {"updateSheetProperties":{
        "properties":{
          "sheetId":0,
          "gridProperties":{"frozenRowCount":1},
          "tabColor":{"red":0.2,"green":0.6,"blue":1.0}
        },
        "fields":"gridProperties.frozenRowCount,tabColor"
      }}
    ]
  }'
```

For the schema of each request type:

```bash
gws schema sheets.spreadsheets.batchUpdate
```

### Clear a range

```bash
gws sheets spreadsheets values clear \
  --params '{"spreadsheetId":"<SHEET_ID>","range":"Sheet1!A2:D"}'
```

Wipes cell values but leaves formatting in place. To also strip formatting, use `spreadsheets.batchUpdate` with an `updateCells` request.

### Find a sheet by title before reading

Use `google-drive` to locate the spreadsheet, then hand the ID to `gws sheets`:

```bash
gws drive files list \
  --params '{"q":"mimeType = '\''application/vnd.google-apps.spreadsheet'\'' and name contains '\''Weekly tracker'\''"}'
```

## Rules

1. Don't add a redundant text confirmation before `spreadsheets.create`, `values.update`, `values.append`, `values.clear`, `values.batchUpdate`, `spreadsheets.batchUpdate`, or `+append`. The runtime's `terminal_exec` approval gate is the user's safety net. When the user's command is clear ("append a row 'Alice, 100' to my tracker"), execute. Do ask one clarifying question when the command is ambiguous — multiple spreadsheets match a name, the user didn't specify which tab to write to, or `clear` would wipe a range larger than what they named.
2. `valueInputOption` is required for any values write. Default to `USER_ENTERED` unless the user specifically asks to skip formula/number parsing; only use `RAW` for opaque strings the user wants stored verbatim.
3. `spreadsheets.batchUpdate` and `values.batchUpdate` are atomic across the whole `requests` / `data` array. Build the full list, send once, and check the reply rather than retrying mid-batch on partial failure.
4. A1 notation is sheet-name-then-range — `'Sheet1!A1:D10'`. Range-only (e.g. `A1:D10`) implicitly uses the first sheet. When the user's spreadsheet has multiple tabs, always qualify the sheet name to avoid silently writing to the wrong tab.
5. For sharing, copying, moving, renaming, or trashing a spreadsheet — switch to `google-drive`. Sheets only owns the cells; Drive owns the file.
6. Reading large ranges is expensive on both the network and the model's context. Bound `--range` to what you actually need; for whole-sheet scans, prefer `spreadsheets.get` with `includeGridData:false` to inspect structure first and pull cell ranges narrowly afterward.
7. When the user wants numeric analysis Gini can do in-process (sum, average, sort, filter, dedupe), `+read` the values once and compute locally — don't round-trip every reduction through the Sheets API.
8. Mutating a sheet someone else owns silently fails with `PERMISSION_DENIED`. If the user asks for an edit and gets that error, ask whether the spreadsheet is theirs to edit before retrying — re-running the same call won't help.

For flags not shown here, run `gws sheets --help` or `gws schema sheets.<resource>.<method>` to inspect a specific API method.
