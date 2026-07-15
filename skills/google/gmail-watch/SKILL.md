---
name: gmail-watch
description: "Detection engine for Gmail email watches: iterates the watch list, polls gws for new matching mail per watch, dedups, drops automated/self, and hands matches (labeled by sender) to the shared drafting turn. Provisioned and run automatically by the shared email-watch backing job."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Gmail scopes."
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    prerequisites:
      commands: [gws]
---

# Gmail Watch

This skill ships the **detection engine** behind your email watches. It is not
something you run by hand — when you create an email watch (`email_watch` tool,
`gini email add`, or the settings UI), Gini adds it to ONE shared background job
whose pre-run hook runs this skill's `detect` script on a schedule. All of your
watches share that one job and one "Email watch" chat thread; the script decides
which watches have new mail to draft a reply to.

## What it does

Each time the shared watch job fires, `detect` runs **headless** (no model turn,
no approval) and, for EACH of your watches:

1. Checks the Google sign-in (once for the session). If signed out, every watch
   reports `needs_auth` and nothing is drafted — the watches stay active and
   recover the moment you re-authenticate. Re-auth happens through the
   `request_google_account` reconnect button in chat, which leads to the
   Integrations page — never `gws auth login`, and never a browser-driven
   Google sign-in.
2. Lists new mail matching that watch's query via `gws`, bounded by a per-watch
   watermark so steady-state polling lists almost nothing.
3. Drops automated senders (no-reply, mailer-daemon, notifications, …) and your
   own address — only real, human, new mail survives.
4. Hands each surviving match (its sender / Subject / Date / snippet only — never
   the body), labeled by sender, to the drafting turn as quoted, untrusted data.

Each watch is independent: one sender's transient error marks only that watch and
the others keep working. When nothing new matches across all your watches, the
run ends with **no model turn at all** — the watches are silent until there is
something to act on.

## How a match becomes a reply

The detection floor reads only metadata. One drafting turn then handles all the
matches for that tick in the shared thread: it reads each full message and
composes a reply per email — each labeled by sender — through the **google-gmail**
skill, posts the proposed replies for you to review, and sends only when you
explicitly ask (which runs `gws gmail +reply` through the normal approval gate).

## Stateful but pure

`detect` is a pure function of your watch list and the small per-watch cursors it
is handed each run; it never writes to disk itself. Gini stores those cursors on
the shared watch job and advances each only after a drafting turn is dispatched,
so a match is never silently lost if delivery fails — it re-surfaces on the next
run.

## First run baselines

The first time each watch runs it records where your inbox currently is and
drafts nothing for pre-existing mail — only mail that arrives *after* the watch
was created triggers a reply. A newly added watch baselines on its own first tick,
independently of your existing watches.
