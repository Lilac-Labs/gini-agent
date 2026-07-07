---
name: google-calendar
description: "Google Calendar via gws: list events, create, accept, find free time."
license: MIT
compatibility: "macOS and Linux. Requires the `gws` CLI authenticated against a Google account with Calendar scopes."
metadata:
  gini:
    version: 1.2.1
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

# Google Calendar

Use `gws calendar` to list events, create and update events, look up free/busy windows, and manage calendar ACLs. The CLI wraps the Calendar v3 API and produces structured JSON.

## Prerequisites

- If this deployment is managed/hosted, the Google credential is already provisioned at sign-in — `gws` is installed and authenticated, so skip the setup flow below and run `gws` directly. Scopes are fixed at sign-in on a managed deployment: when a call fails with `scope required` or HTTP 401, tell the user which action needs a scope their account wasn't granted, instead of trying to set anything up. (The scope list below still describes which verb needs which scope.)
- `gws` installed and authenticated. If `gws` is not on PATH OR `gws auth status` reports no authenticated user, do NOT silently call setup. Instead, in a single short reply to the user:
  1. State plainly what's missing — e.g. "Google Workspace access isn't set up on this machine yet" or "your Google sign-in has expired."
  2. Ask one sentence: "Want me to walk you through setting it up?" Wait for the user's answer.
  3. If they say yes, call `read_skill` with name `google-workspace-setup` and run that skill's onboarding flow turn-by-turn. If they say no or ask to defer, acknowledge briefly and stop — do not retry the original request.
- Apply the same flow when any `gws calendar ...` call fails mid-task with `command not found` / ENOENT, HTTP 401, "no credentials", or "scope required". Don't report the failure as a dead end — surface the missing prerequisite and ask if the user wants to set it up before moving on.
- OAuth scopes the user picked at login must cover the verbs the agent will use:
  - Read-only agenda / free-busy: `calendar.readonly`
  - Create, update, delete events: `calendar.events` (or full `calendar`)
  - Manage calendar lists, ACLs, and secondary calendars: full `calendar`

## Selecting a Google account

The connected Google accounts (each with its tag, email, and config dir) are listed in your system context under **"Connected Google accounts"**. To target a specific account, prefix the command with its config dir:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR="<configDir>" gws calendar events list
```

Selection rule: one account connected → just use it. Two or more:

- The user named or clearly implied one account (a tag, an email, or unambiguous context) → use only that account.
- A read/lookup/search the user didn't tie to an account (e.g. listing events, searching mail, finding a doc) → run it against **every** connected account (one `gws` call per config dir) and aggregate, labeling each result by its tag and email. Don't pick just one, and don't ask — the user wants the whole picture across accounts.
- A write (send, create, edit, delete) with no account named → ASK which account first; never guess.

If no accounts are connected yet, fall back to the setup flow in Prerequisites (`read_skill` with `google-workspace-setup`). On a managed/hosted deployment an account is always connected, so this case doesn't arise.

## When to Use

- The user asks Gini to look at, summarize, or modify their calendar.
- Scheduling a one-off meeting or a recurring event.
- Finding a free slot across the user's own calendars or comparing free/busy with another attendee.
- Adding a Google Meet link to an invite.
- Pulling today's, tomorrow's, or this-week's agenda.

## When NOT to Use

- Personal to-dos the user wants to see on their iPhone — use `apple-reminders` for time-bound to-dos, not Calendar events.
- One-off agent alerts ("ping me in an hour") — use the cronjob tool, not a self-invite.
- Cross-device personal note-taking — use `apple-notes` or `obsidian`.
- Meeting *content* (agenda doc, shared notes) — use `google-docs` for the doc and attach it to the event with a Drive link.
- Project task tracking — use the project's issue tracker; Calendar is for time-bound events, not durable to-dos.

## Quick Reference

The Calendar surface is the auto-generated v3 API (`gws calendar events list`, `gws calendar events insert`, `gws calendar freebusy query`, …) plus two curated helpers: `+agenda` for digests and `+insert` for creating events without hand-rolling the JSON body.

### Agenda

```bash
gws calendar +agenda                              # next ~7 days, all calendars
gws calendar +agenda --today
gws calendar +agenda --tomorrow
gws calendar +agenda --week --format table
gws calendar +agenda --days 14
gws calendar +agenda --today --calendar 'Work'
gws calendar +agenda --today --timezone America/New_York
```

`+agenda` is read-only and uses the user's Google account timezone by default. Override with `--timezone <IANA>` when the user is travelling.

### Create an event

```bash
gws calendar +insert \
  --summary 'Standup' \
  --start '2026-06-17T09:00:00-07:00' \
  --end   '2026-06-17T09:30:00-07:00'

# With attendees + Meet link
gws calendar +insert \
  --summary 'Design review' \
  --start '2026-06-17T14:00:00-07:00' \
  --end   '2026-06-17T15:00:00-07:00' \
  --attendee alice@example.com \
  --attendee bob@example.com \
  --meet \
  --location 'Room 4' \
  --description 'Walk through the v2 mocks.'
```

Times are RFC 3339 / ISO 8601. Always include the offset (`-07:00`, `+02:00`, `Z`) — naked local times round-trip incorrectly across DST.

For natural-language event creation, the API surface also offers `events.quickAdd`:

```bash
gws calendar events quickAdd \
  --params '{"calendarId":"primary","text":"Coffee with Pat tomorrow 3pm-3:30pm"}'
```

### List, get, update, delete events

```bash
gws calendar events list \
  --params '{"calendarId":"primary","timeMin":"2026-06-17T00:00:00Z","timeMax":"2026-06-18T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'

gws calendar events get \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'

gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}' \
  --json '{"location":"Room 5"}'

gws calendar events delete \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'
```

### Respond to an invite (RSVP)

Google does not expose a dedicated RSVP method — you respond by patching the event and updating the current user's entry in the `attendees` array. That means the agent needs three things first: the `eventId`, the user's own email address (so it can find its attendee entry), and the full existing `attendees` array (so the patch can preserve everyone else).

```bash
# 1. Look up the signed-in user's email — `gws auth status` returns
#    structured JSON; the email lives at the top-level `.user` key.
#    Strip stderr first (`2>/dev/null`) so the `Using keyring backend`
#    preamble doesn't contaminate the JSON; never use `2>&1`.
gws auth status 2>/dev/null | jq -r '.user'

# 2. Fetch the event to read the existing attendees array.
gws calendar events get \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>"}'

# 3. Patch the event with the full attendees array, flipping just the
#    current user's responseStatus to accepted | declined | tentative.
gws calendar events patch \
  --params '{"calendarId":"primary","eventId":"<EVENT_ID>","sendUpdates":"all"}' \
  --json '{
    "attendees": [
      {"email":"alice@example.com"},
      {"email":"bob@example.com"},
      {"email":"me@example.com","responseStatus":"accepted"}
    ]
  }'
```

Set `sendUpdates` to `"all"` (notify everyone), `"externalOnly"`, or `"none"` based on what the user wants. RSVP changes always notify the organizer when `sendUpdates` is `"all"`.

### Find free time

```bash
gws calendar freebusy query --json '{
  "timeMin": "2026-06-17T09:00:00-07:00",
  "timeMax": "2026-06-17T18:00:00-07:00",
  "items": [{"id":"primary"},{"id":"alice@example.com"}]
}'
```

The response lists busy windows per calendar; free time is the complement within `[timeMin, timeMax]`.

### Preview a calendar change inline

Whenever you propose, confirm, reschedule, or cancel a timed event in chat — most often while drafting or sending an email about a meeting — also render a fenced `calendar` block that previews that day (or week) so the user can SEE the proposed slot against their existing schedule and spot any conflict, instead of reading a wall of text. First pull the surrounding agenda (`gws calendar +agenda` for that day/week, or `events list`) and include the user's existing events as context; mark the change you're making as `proposed` (or `cancel`). This is a **read-only preview** — the real create/update still goes through `+insert` / `events.patch`; the block has no Apply affordance.

The block is plain text: optional `view:` / `date:` / `tz:` header lines up to the first blank line, then one event per line, pipe-delimited as `time-spec | title | status`:

- `view:` — `day` or `week` (optional; defaults to `day` when every event is on the anchor date, else `week`).
- `date:` — the anchor date `YYYY-MM-DD` (week view shows the Sunday-started week containing it).
- `tz:` — a short timezone label shown in the header (e.g. `PT`).
- time-spec — `YYYY-MM-DD HH:MM-HH:MM`, `YYYY-MM-DD all-day`, or just `HH:MM-HH:MM` / `all-day` (date then defaults to the anchor). Times are 24h. The bare (undated) forms need an anchor — a `date:` header or at least one fully-dated event line — or those undated lines are dropped and the card renders empty.
- status — `proposed` for the change you're making, `cancel` for an event going away; omit it for the user's existing events.

````text
Here's where that lands on your Thursday — your 9:30 standup is clear of it:

```calendar
date: 2026-07-02
tz: PT

2026-07-02 15:00-16:00 | Team sync | proposed
2026-07-02 09:30-10:00 | Standup
2026-07-02 12:00-13:00 | Lunch with Sam
```
````

The app renders the `calendar` block as a day/week grid with the proposed change highlighted; any non-rendering client degrades it to a readable code block.

### Calendar list and ACLs

```bash
gws calendar calendarList list
gws calendar calendars insert --json '{"summary":"Side project"}'
gws calendar acl list --params '{"calendarId":"primary"}'
gws calendar acl insert --params '{"calendarId":"primary"}' \
  --json '{"role":"reader","scope":{"type":"user","value":"alice@example.com"}}'
```

## Rules

1. Calendar events are **time-bound things on a schedule** — meetings, appointments, focus blocks. For personal to-dos that should appear on the user's iPhone, prefer `apple-reminders`. For agent-internal alerts ("remind me in 2 hours"), use the cronjob tool. Confirm intent before deciding which.
2. Don't add a redundant text confirmation before `events.insert`, `events.patch`, `events.delete`, or `+insert`. The runtime's `terminal_exec` approval gate is the user's safety net — if `gws *` isn't auto-approved they'll see the gate per-command; if it is, they've opted in to "just do it." When the user's command is clear ("remove dinner," "decline the 2pm"), execute. Do ask one clarifying question when the command is ambiguous — multiple events match the description, the user didn't specify which calendar, or `sendUpdates` would email attendees the user might not want notified.
3. When the user says "accept" / "decline" / "tentative" on a meeting, confirm **which event** and **which response status** before patching. Resolve the user's own email via `gws auth status 2>/dev/null | jq -r '.user'` (or read it from the event's `attendees` array) so the patch updates the right attendee, and re-send the full `attendees` array so other invitees aren't dropped. RSVP changes email-notify the organizer when `sendUpdates` is `"all"`.
4. Use RFC 3339 times with an explicit offset on `+insert` and `events.insert`. Naked local times silently drift across DST boundaries.
5. Prefer `+insert` over hand-rolling `events.insert --json` when the user just wants a normal event. The helper sets sane defaults (visibility, reminders) without forcing the agent to learn the full body schema.
6. Adding `--meet` to `+insert` creates a Google Meet space attached to the event — this is the simplest way to give the user a join link. Do not separately call `google-meet` to create a standalone space when an event will exist anyway.
7. When listing events, set `singleEvents:true` and `orderBy:"startTime"` so recurring events expand into individual instances and arrive in chronological order. Without those, the response is grouped by recurrence master and confusing to summarize.
8. Free/busy queries are read-only and cheap — prefer them over scraping multiple `events.list` calls when the user only needs availability, not event content.
9. Respect the calendar's timezone, not just the host's. `+agenda` defaults to the Google account timezone; only override with `--timezone` when the user is travelling.
10. When you propose, reschedule, or cancel a timed event in chat (especially while drafting an email about a meeting), preview it inline with a `calendar` block (see "Preview a calendar change inline") so the user sees the slot against their existing agenda. It is a read-only preview — still perform the actual change with `+insert` / `events.patch`.

For flags not shown here, run `gws calendar --help` or `gws calendar <verb> --help` (e.g. `gws calendar +insert --help`).
