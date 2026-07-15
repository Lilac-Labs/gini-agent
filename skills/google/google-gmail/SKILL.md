---
name: google-gmail
description: "Gmail via gws: send, read, search, label, draft, reply, forward."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Gmail scopes."
metadata:
  gini:
    version: 1.2.7
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

# Google Gmail

Use `gws gmail` to read, search, send, reply, forward, draft, label, and triage Gmail directly from the terminal. The CLI wraps the Gmail v1 API and produces structured JSON, so it composes cleanly with `jq` and other shell tooling.

## Parsing gws output

`gws` writes its JSON to **stdout** and a `Using keyring backend: keyring` preamble (plus any warnings) to **stderr**. `terminal_exec` already shows the two streams as separate blocks, so on its own the preamble is harmless — but the moment you pipe `gws` into a JSON parser you must strip stderr first, or the preamble lands on the JSON and the parse throws:

```bash
gws ... 2>/dev/null | jq ...                    # correct: stderr dropped before the pipe
gws ... 2>/dev/null | python3 -c 'import sys,json; json.load(sys.stdin)'
```

Never use `2>&1` when piping into a parser — it folds the preamble onto the JSON and breaks it. Do not pass `--format text` either; it is invalid (valid formats are `json`, `table`, `yaml`, `csv`), and the raw `users.*` API already defaults to JSON. When you just need the data and don't need to parse it yourself, prefer the curated `+helpers`, which print clean output. Note that `2>/dev/null` also discards gws's own error messages, so if a command returns empty or unexpected output, re-run it without the redirect (or check the exit code) to see the actual error.

## Prerequisites

- `gws` must be installed. If it is not on PATH, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- If `gws auth status` reports no authenticated user, or a `gws gmail ...` call fails with an auth error (HTTP 401, expired/revoked sign-in, or "no credentials"), call `request_google_account` to put a connect/reconnect button in the chat, then stop and wait for the user. Never drive a Google sign-in page with browser tools.
- If a call fails with `scope required`, tell the user which action needs the missing scope and call `request_google_account` so they can reconnect with the required access.
- The OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read-only triage: `gmail.readonly`
  - Send a new message: `gmail.send`
  - Reply, reply-all, forward: `gmail.modify` — upstream helpers fetch the original message to thread `In-Reply-To` / `References` headers, which `gmail.send` alone cannot do
  - Drafts and labels: `gmail.modify` (or `https://mail.google.com/` for full access including permanent delete)
  - Watch for new mail (`+watch`): `gmail.modify` AND `https://www.googleapis.com/auth/pubsub` — Cloud Pub/Sub is a separate Google API and its scope must be granted alongside the Gmail scope

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws gmail +triage
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`). On a managed/hosted deployment an account is always connected, so this case doesn't arise.

## When to Use

- The user asks Gini to send, draft, read, search, label, reply to, or forward email.
- Summarizing or triaging the inbox (latest unread, by-sender, by-label digests).
- Saving an attachment from a thread, or pulling a message body into another workflow.
- Watching for new messages and streaming them as NDJSON (`gws gmail +watch`).

## When NOT to Use

- Agent-internal scratch notes or transient state — use the `memory` tool, not email-to-self.
- Personal to-dos that should appear on the user's iPhone — use `apple-reminders`.
- Cross-device personal note-taking — use `apple-notes` or `obsidian`.
- Calendar invites and meeting scheduling — use `google-calendar` (a Gmail invite is still a Calendar event).
- Bulk outbound mail (newsletters, marketing) — personal Gmail has aggressive sending limits and Google will throttle or suspend the account. Tell the user to use a transactional provider.

## Quick Reference

The Gmail surface in `gws` is split into auto-generated API methods (`gws gmail users messages list`, `gws gmail users labels create`, …) plus a small set of curated helpers (`+send`, `+reply`, `+read`, `+triage`, …) that handle MIME encoding, threading, and base64 for you. Prefer the helpers for everyday tasks. The raw API is rooted at the `users` resource — every `--params` JSON must include `"userId": "me"` (or another delegated address).

### Send

```bash
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'

# CC, BCC, alias send-from
gws gmail +send --to alice@example.com --cc bob@example.com \
  --subject 'Status' --body 'See below.' --from alias@example.com

# Attachments (repeatable, 25 MB total)
gws gmail +send --to alice@example.com --subject 'Report' \
  --body 'See attached.' -a report.pdf -a notes.txt

# HTML body
gws gmail +send --to alice@example.com --subject 'Update' \
  --body '<b>Bold</b> text' --html

# Save as draft instead of sending
gws gmail +send --to alice@example.com --subject 'Draft' --body 'WIP' --draft
```

### Show a saved draft to the user

After you save a draft (`--draft`), show it to the user inline so they can read it right in the chat — never tell them to open Gmail and search for it. Lead with one short sentence, then render the draft as a fenced `email-draft` block: optional `To:` / `Cc:` / `Subject:` header lines, a blank line, then the exact body you saved.

````text
I drafted this reply for you:

```email-draft
To: support@plaud.ai
Subject: Follow-up on your Request #527545
DraftId: r5210160734100018781
Account: you@example.com

Hi there,

I still haven't received the package, and the delivery photo shows it was left
inside a publicly accessible gate. Could you reopen the case and coordinate a
replacement or refund?

Thanks
```
````

Use the same recipient, subject, and body you passed to `gws gmail +send … --draft` so the card matches the saved draft. The app renders the `email-draft` block as a draft card; any non-rendering client degrades it to a readable code block.

The `DraftId` and `Account` lines let the user send the draft straight from the card (its **Send** button), with no extra chat turn: use the exact draft id `gws gmail +send … --draft` returned at `.id`, and the account you saved the draft under. They are metadata, not recipients — the card extracts them and never shows them as `To`/`Cc` rows. Always save the draft first and include both lines — the card is always sendable.

### Preview a meeting change inline

When the draft proposes, confirms, reschedules, or cancels a meeting at a specific time, show a `calendar` preview so the user can see the proposed slot against their existing schedule and catch a conflict. The app renders the `calendar` block as **its own full-width card placed ABOVE your message** (like the standalone Question cards), so do NOT narrate it — don't write "here's where it lands"; the card's header speaks for itself. Lead with a short line about the **draft** (what you saved), emit the calendar block, then the draft block. The preview is a **full-week view**, so pull the WHOLE week's agenda (the Sunday–Saturday week containing the meeting) — `gws calendar +agenda --week`, or `gws calendar events list` for that week's range — and include **every** event across the week (each line carries its own date), not just the meeting day. Every day the user has something should be populated; only the proposed/changed slot gets `proposed` (or `cancel`).

````text
I saved the draft in your work account.

```calendar
date: 2026-07-02
tz: PT

2026-07-02 15:00-16:00 | Team sync | proposed
2026-06-30 09:30-10:00 | Monday standup
2026-07-01 13:00-14:00 | Design review
2026-07-02 12:00-12:30 | Lunch
2026-07-03 10:00-11:00 | 1:1 with Dana
2026-07-04 18:00-19:00 | Dinner
```

Here's the draft:

```email-draft
To: dana@example.com
Subject: 30-minute sync this Thursday
DraftId: r5210160734100018781
Account: you@example.com

Hi Dana,

Would 3:00 PM this Thursday work for a 30-minute sync?

Best,
```
````

One calendar event per line: `YYYY-MM-DD HH:MM-HH:MM | title | status` (24-hour times). Use `proposed` for the slot you're proposing, `cancel` for one going away, and omit the status for the user's existing events. Add a `view: week` header line for multi-day context. The calendar is a read-only preview — the real calendar create/update still goes through `gws calendar +insert` / `events.patch`. See "Preview a calendar change inline" in the `google-calendar` skill for the full grammar.

### Read

```bash
gws gmail +read --id <MESSAGE_ID>                # plain-text body
gws gmail +read --id <MESSAGE_ID> --headers      # include From/To/Subject/Date
gws gmail +read --id <MESSAGE_ID> --format json 2>/dev/null | jq '.body'
gws gmail +read --id <MESSAGE_ID> --html         # HTML body instead of text
```

### Search and list

`gws gmail users messages list` accepts standard Gmail search operators via the `q` param (`from:`, `to:`, `subject:`, `label:`, `is:unread`, `has:attachment`, `newer_than:7d`, etc.).

```bash
gws gmail users messages list --params '{"userId":"me","q":"from:alice@example.com is:unread","maxResults":20}'
gws gmail users messages list --params '{"userId":"me","q":"label:invoices newer_than:30d"}' --page-all
gws gmail +triage                                 # curated unread inbox digest
```

### Reply and forward

```bash
gws gmail +reply --message-id <MESSAGE_ID> --body 'Thanks — will follow up.'
gws gmail +reply-all --message-id <MESSAGE_ID> --body 'Looping in the team.'
gws gmail +forward --message-id <MESSAGE_ID> --to charlie@example.com \
  --body 'FYI from the thread below.'
```

The helpers preserve `In-Reply-To` and `References` headers so the reply lands inside the original thread.

### Labels and drafts

```bash
gws gmail users labels list --params '{"userId":"me"}'
gws gmail users labels create --params '{"userId":"me"}' \
  --json '{"name":"Receipts","labelListVisibility":"labelShow"}'
gws gmail users messages modify --params '{"userId":"me","id":"<MESSAGE_ID>"}' \
  --json '{"addLabelIds":["Label_123"],"removeLabelIds":["INBOX"]}'

gws gmail users drafts list --params '{"userId":"me"}'
gws gmail users drafts get --params '{"userId":"me","id":"<DRAFT_ID>"}'
```

### Watch for new mail

```bash
gws gmail +watch        # streams new messages as NDJSON (one JSON object per line)
```

## Rules

1. `+send`, `+reply`, `+reply-all`, `+forward`, `messages.send`, and `drafts.send` put a message in the user's voice in front of someone else — an irreversible, third-party-facing action, so the global `request_confirmation` rule governs and the `terminal_exec` approval gate is NOT the safety net here (it doesn't fire when `gws` is auto-approved). When the user dictated this message and told you to send it ("email alice@acme.com that I'll be 10 min late"), execute directly. When you composed the reply yourself or the user only delegated the outcome ("get back to her," "handle this thread"), call `request_confirmation` with the drafted message and send only on a confirm — even when auto-approved. Don't add a redundant prose "shall I send?"; use `request_confirmation`. Ask one clarifying question when the command is ambiguous — multiple "alice" matches in the address book, more than one thread could be the reply target, or the user named a verb but no recipient. The message body is the user's voice to someone else, not a parameter you fill in: write it only from what they told you to say or what's unmistakable from the thread. When you'd be inventing the substance — they named a recipient or thread but not what to say — ask what they want to convey before drafting; don't compose a position and present it as theirs.
2. Prefer the curated helpers (`+send`, `+reply`, `+read`, `+triage`) over the raw `gws gmail <resource> <method>` surface — they handle MIME, base64, threading, and HTML-to-text conversion automatically.
3. When replying, use `+reply` / `+reply-all` so the thread stays intact. Building a new message with `+send` and pasting in the prior subject does not thread correctly.
4. Treat the Gmail scopes as four separate trust boundaries: `gmail.readonly` covers `+read` / `+triage` and any `messages.list`/`get` call; `gmail.send` covers a brand-new `+send` only; `gmail.modify` is required for `+reply`, `+reply-all`, `+forward`, labels, and drafts because those helpers must fetch the original message or mutate its state; `+watch` requires `gmail.modify` AND `https://www.googleapis.com/auth/pubsub` because the upstream helper requests both tokens (Pub/Sub is a separate Google API). If the user only granted a narrower scope at setup, never silently call a verb that needs a wider one — direct them back to `google-workspace-setup` to widen scopes (on a managed/hosted deployment scopes are fixed at sign-in, so tell the user which scope the action needs instead).
5. Do not bulk-send from a personal `@gmail.com` account. Google throttles or suspends accounts that look like bulk senders. Use a transactional provider for newsletters or anything addressed to more than a handful of recipients.
6. Attachment cap is 25 MB total. For larger files, upload via `google-drive` and send the share link instead.
7. Never paste raw message bodies that contain secrets (API keys, passwords, MFA codes) back into the chat transcript. Summarize, redact, or write to a file the user controls.
8. When you save a draft, surface it to the user with an `email-draft` fenced block (see "Show a saved draft to the user") instead of pointing them at Gmail. The user should be able to read the draft without leaving the app.
9. When that draft proposes, confirms, reschedules, or cancels a meeting at a specific time, you are not done with just the `email-draft` block: pull the **whole week's** agenda (the Sunday–Saturday week containing the meeting — `gws calendar +agenda --week`, or `events list` over that week's range) and render a `calendar` preview **before** the draft card — calendar first, draft last (see "Preview a meeting change inline") — with the proposed slot marked `proposed`. **Embed EVERY event the week query returned, on every day — not just the meeting day.** The preview is a full-week view; if the query returns 17 events across the week, the block has 17 event lines (each carrying its own date), so the user sees their whole week with the proposed slot in context. Dropping the other days is wrong. This is part of the deliverable for a meeting email, not an optional extra — do it without being asked.

For flags not shown here, run `gws gmail --help` or `gws gmail <verb> --help` (e.g. `gws gmail +send --help`).
