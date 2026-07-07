# ADR: User Choice Prompt (ask_user / chat.choice)

## Decision

Give the agent a general "ask the user to pick" primitive: an always-on
`ask_user` tool that pauses the chat turn on a `chat.choice` SetupRequest and
resumes the loop with the user's answer.

- **Tool contract**: `ask_user(question, options)` where `options` is
  REQUIRED — 2–6 entries of `{ label, description? }`. Single-select only —
  no multi-select, no extra flags. The tool exists only to present a
  concrete choice: an option-less call (omitted field or empty array) is
  rejected with a graceful error that steers the model to ask open-ended
  questions in its plain message text instead (the user's reply arrives as
  the next message) — no park, no SetupRequest. That is the shape for asks
  whose answer only the user can author (above all content that speaks in
  their voice, e.g. what a message should say), where fabricated options
  would misrepresent the user. The tool validates synchronously (non-empty
  question; 2–6 options with non-empty distinct trimmed labels) and returns
  a recoverable error result on bad input; a valid call mints the
  SetupRequest and returns `{ kind: "pending" }` so the task parks.
  Historical option-less rows (minted before options became required) stay
  answerable through the freeform `/complete` shape and the plain-message
  answer path.
- **Rendered as the agent speaking**: the web chat renders a pending
  chat.choice as a normal assistant-style message (the question) with the
  option choices beneath — not a bordered "Question" card, and the
  `ask_user` tool call itself never renders as a tool-group row; the
  chat.choice block is the sole representation.
- **UI-owned Other / Skip**: the web chat renders an "Other (type your
  answer)" freeform input alongside the options, plus a subtle Skip. These
  are UI-owned, not tool params — the model must not include "Other"/"skip"
  entries in `options`.
- **Rides the SetupRequest rails** (see ADR
  [authorization-vs-setup-request.md](authorization-vs-setup-request.md)):
  the user is the actor, there is no risk pill, and the row resolves through
  the `/api/setup-requests/:id/{complete,cancel}` family. The payload carries
  `{ question, options, toolCallId }`; `reason` and `target` are the question
  so the `setup_requested` block summary (and transcripts) read as the
  question itself. Unlike `connector.request`, no `approval_reason` assistant
  bubble is persisted — the setup_requested block already renders the
  question as the agent's own message.

## Resolution contract

`POST /api/setup-requests/:id/complete` body, validated against the options
stored in the trusted setup payload BEFORE the claim (a bad body 400s and the
row stays pending):

- `{ choice: { label } }` — must match a stored option label. Resumes the
  loop with `User selected: "<label>"` (` — <description>` appended when the
  option carries one).
- `{ choice: { other } }` — non-empty freeform text. Resumes with
  `User answered: "<text>"`.

On the winning claim the handler persists a human-readable `connectOutcome`
(`You selected: X` / `You answered: ...`) so the settled row's muted outcome
line under the question reads truthfully after reload, then resumes the chat
task detached (safeResume).

`POST /api/setup-requests/:id/cancel` is the Skip affordance. Skipping a
question must never kill the turn: like the `connector.request` cancel
contract, the cancel resumes the loop with
`User skipped the question. Continue with your best judgment, or explain what
you need if you cannot proceed without an answer.` rather than failing the
task.

## When the model should reach for it

The tool description steers the model to call `ask_user` when multiple viable
paths exist and the user's preference matters — especially BEFORE requesting
connector setup, offering setup-vs-alternative choices (e.g. for missing web
search: connect a provider / fetch likely sites with `web_fetch` / browse with
the browser), and for general mid-task preference or clarification questions.
Every offered option must be a capability-backed action the agent can actually
take or a setup it can request; "answer from general knowledge" is not offered
as an option for research or current-information tasks — the user can type
that under Other if they want it. When the answer is something only the user
can author — above all content that speaks in their voice, like what a message
should say — the model does NOT call the tool: it asks directly in its message
text and the user's reply arrives as the next message; fabricated options
would misrepresent them. It is NOT for permission confirmations: risk-gated
actions stay on the authorization flow.

## Surfaces

The web chat renders the question as the agent's message with option chips;
the mobile app renders its own actionable single-select card (options plus
its own Other input and Skip). The dispatcher carries the same surface guard
as the sibling `request_*` tools: a task with no answerable chat surface
(subagent child, headless container, Telegram/Discord bridge) gets a
synchronous error telling the agent to ask the question as a regular message
instead of stranding in `waiting_approval`. Surfaced (non-headless)
containers pass the guard even when scheduled — their thread is answerable
in the web chat. Other clients (/permissions) render the generic
setup-request fallback ("resolve in chat").

## Consequences

- `SetupRequestAction` gains `"chat.choice"` (user-actor, no risk pill).
- `ask_user` is always-on in the tool catalog (like `request_connector`):
  the setup-vs-alternative steer must work on a fresh instance with no
  toolsets toggled.
- Future multi-select or richer answer shapes would extend the payload and
  the `/complete` body — not add tool flags — so the single-select contract
  stays the default.
