# Operations

This document covers local install, runtime lifecycle, parallel smoke testing, and diagnostics.

## Install

One-line install:

```sh
curl -fsSL https://raw.githubusercontent.com/Open-Curiosity/gini-agent/main/scripts/install.sh | bash
```

The installer detects OS and arch, installs Bun if missing, ensures git is available (on macOS, where `/usr/bin/git` is an Xcode Command Line Tools stub until those tools are installed, it launches Apple's installer and waits for you to click Install — the install aborts cleanly if you Cancel, if no dialog appears, or after a timeout), clones the runtime into `~/.gini/runtime`, installs dependencies, drops a `gini` wrapper at `~/.local/bin/gini`, ensures `~/.local/bin` is on `PATH`, and initializes the `default` instance under `~/.gini/instances/default/`. The wrapper defaults `GINI_INSTANCE=default` (override via `--instance` or the `GINI_INSTANCE` env var) so installed users land on `default`. Repo-clone developers running `bun run gini` get an instance auto-derived from the repo directory basename so each worktree is isolated by default.

On macOS, the installer also enables autostart for the `main` instance (LaunchAgents at `~/Library/LaunchAgents/ai.lilaclabs.gini.main.gateway.plist` and `…main.web.plist`) and opens the Gini webapp's `/setup` page in your default browser. The browser form offers the full provider catalog — OpenAI, Codex, Anthropic, Amazon Bedrock, Azure OpenAI, OpenRouter, DeepSeek, and Local — and collects whatever the one you choose needs (an API key, the AWS access key pair for Bedrock, the resource endpoint and deployment for Azure, the base URL for Local, or your existing `codex login` auth); submit, and the runtime starts using it on the next request. Pass `--no-autostart` to skip the LaunchAgent step (you'll need to run `gini start` manually and visit `/setup` to configure a provider).

Why the browser flow: piped `curl … | bash` has no controlling terminal, so the legacy `gini setup` prompt would never run. The new flow makes the same UX work for both interactive and piped installs — the runtime comes up, the browser opens, and the user fills a form. For OpenAI, the setup endpoint writes your API key to `~/.gini/secrets.env` with mode 0600; the running gateway picks it up immediately (no restart), and the autostart plist's `EnvironmentVariables` is refreshed in the background so future launchd respawns retain the key. The key is never written to `config.json` and never leaves your machine except in API calls to OpenAI. For Codex, no token values are stored by gini — the runtime reads `~/.codex/auth.json` on demand.

The terminal-driven `gini setup` command remains available for interactive shells that prefer it.

LaunchAgent `PATH` and version managers: at `gini autostart enable` time, the plist's `PATH` is the base macOS set (bun's dir, `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, …) extended with the entries reported by your interactive `$SHELL`. This is what lets a launchd-supervised gateway see CLIs installed under per-user version managers — `~/.nvm/versions/node/<v>/bin`, `~/.asdf/shims`, `~/.volta/bin`, pyenv, rbenv, etc. — the same way your terminal does. If you later switch node versions, install a new path manager, or move a CLI to a different bin dir, re-run `gini autostart enable` to refresh the plist.

From source (for developers):

```sh
bun install
bun run gini install
```

Use Codex OAuth as the preferred interactive provider:

```sh
codex login
bun run gini provider set codex gpt-5.5
bun run gini doctor
```

Gini reads Codex credentials from `CODEX_AUTH_JSON` or `~/.codex/auth.json` and does not write token values into Gini config.

OpenAI API keys are supported as a fallback:

```sh
export OPENAI_API_KEY=...
bun run gini provider set openai gpt-5.4-mini
bun run gini doctor
```

## Start And Stop

Persistent runtime:

```sh
bun run gini start
bun run gini status
bun run gini stop
```

Foreground runtime for development:

```sh
bun run gini run --instance feature-x
```

`start` and `run` print the runtime gateway URL and the Next.js web URL.

The production `default` instance (installed via `curl|bash`) is pinned to memorable ports:

- web: `http://127.0.0.1:7777`
- runtime: `http://127.0.0.1:7778`

Developer worktree instances (auto-derived from the repo directory basename when running `bun run gini`) get deterministic hash-derived ports within a 100-port window starting at 7337 (runtime) / 3000 (web), so parallel worktrees coexist without manual `--port` wrangling. `gini status` prints the live URLs.

## Docker Deployment

To run an instance headless in a container — with the agent's browser driven as a real Chromium under a virtual X display (Xvfb) — use the bundled `Dockerfile` and `docker-compose.yml`:

```sh
docker compose up --build
open http://localhost:7777
```

State persists in a named volume, so chats, sign-ins, memory, and the model cache survive restarts. The container binds the gateway on `0.0.0.0` (so published ports reach it) without weakening the Host/Origin trust gate. See [Docker Deployment](deployment-docker.md) for provider configuration, the container-mode env knobs, logs, and image-trimming options, and [ADR: Docker + Xvfb Deployment](adr/docker-xvfb-deployment.md) for the design.

## Parallel Smoke Tests

Smoke tests are isolated by default:

```sh
bun run gini smoke
```

Each smoke run creates an ephemeral instance under `/tmp`, chooses available localhost ports, uses deterministic echo model providers, exercises the real runtime/API, writes evidence, and stops the runtime afterward. Multiple coding agents can run smoke tests at the same time without sharing the `dev` instance.

For a named persistent test instance:

```sh
bun run gini smoke --instance codex-a --state-root /tmp/gini-codex-a --log-root /tmp/gini-codex-a-logs --port 7601
```

## Verification

```sh
bun run typecheck
bun test
bun run gini smoke
```

Common runtime checks:

```sh
bun run gini doctor
bun run gini evidence
```

## Update

To update an existing install:

```sh
gini update
```

Pulls the latest source into `~/.gini/runtime`, reinstalls dependencies, and leaves your state under `~/.gini/instances/` and the model cache at `~/.gini/models/` untouched. If a runtime is currently running, Gini restarts it automatically so the new code is picked up without a manual `gini stop && gini start`.

When the web app is running from the installer-managed runtime, its sidebar shows the current package/git version and exposes the same update action through its Update button.

`gini update` only operates on the installer-managed runtime at `~/.gini/runtime`. From a repo clone, use `git pull && bun install` instead.

## Local Development Install

If you're working on gini-agent itself and want to test the install/update/uninstall flow against your local checkout (without pushing to GitHub):

```sh
./scripts/install.sh --local
```

This is the same as the default install except it clones from your local repo into `~/.gini/runtime`. After you commit changes locally, `gini update` will pull them in. `gini uninstall` works exactly the same as a real install (same marker, same wrapper path).

## Agent Iteration Cap

The chat-task agent loop is bounded by a per-iteration cap that prevents
runaway tool-calling. The default is 200 iterations (one iteration = one
model call plus any tool dispatches that follow). Most tasks finish well
under 10 iterations; the cap exists as a safety bound, not a meaningful
budget for normal work. It is deliberately generous because runaway loops
are caught far earlier by the stuck-pattern detectors below — the cap only
ever bounds tasks that are making genuine progress every iteration (such as
a bulk download of many items, each needing several tool calls).

Prior chat history replay is also bounded. The full chat remains stored,
but each new chat-task prompt packs prior rows under `agent.priorContextTokens`
before the current turn. When unset, the default is 65% of the effective
provider/model context window; unknown routed or local models fall back to a
conservative 32K window. The runtime then caps that replay budget to the
space left after the live system prompt, current turn, tool schemas, and a
small response reserve. Older omitted rows are still available through
Hindsight recall and exact `search_history`; omitted skill instructions can
be loaded again with `read_skill`.

When the cap is hit the loop does NOT fail. Instead it makes one final
tool-less model call asking for a summary of what was learned and what
remained undone, and completes the task with that text. A warning trace
records the cap hit so the activity is auditable.

The loop also stops early when it detects a stuck pattern — repeating the
same tool call, or navigating pages without acting on them — and takes the
same graceful summary exit, completing the task with a "stopped: tool loop
made no progress" note rather than failing. Within a long turn the model
context is kept bounded too: older tool-result content is trimmed before
each model call and each individual tool result is size-capped, so a heavy
tool loop cannot overflow the provider context window. See ADR
chat-context-window.md and ADR agent-loop-tool-calling.md.

To override the cap for a single instance, edit
`~/.gini/instances/<instance>/config.json` and add an `agent` object:

```json
{
  "instance": "main",
  "port": 7337,
  "...": "...",
  "agent": {
    "maxIterations": 400,
    "priorContextTokens": 50000
  }
}
```

`maxIterations` and `priorContextTokens` must be positive integers.
Invalid values (zero, negative, non-numeric) fall back to their defaults
(`maxIterations` is built-in; `priorContextTokens` is provider-derived) and
emit a warning trace on the next task. Oversized `priorContextTokens` values
are clamped to the available provider context and emit a warning trace. The runtime reads
`config.json` once at server start and holds `RuntimeConfig` in memory,
so edits don't take effect until you restart `gini run` (stop the tmux
session and re-issue the command).

## Approval Settings

Controls live behind a single endpoint (`/api/settings/auto-approve`):

- **`approvalMode`** — `"strict" | "auto" | "yolo"`. New instances
  default to `"yolo"`; existing instances are not auto-escalated (a
  config that predates an explicit `approvalMode` keeps resolving to
  `"auto"`). `strict` gates every approval-eligible action
  (`file_write`, `file_patch`, `terminal_exec`, `code_exec`,
  `browser_upload_file`, `send_message`) for a human decision. `auto`
  auto-approves the safe set (including `send_message`) and gates
  `terminal_exec` / `code_exec` only when the command matches a
  dangerous-pattern entry. `yolo` bypasses every gate. See
  [ADR approval-mode.md](adr/approval-mode.md) for the full contract.

- **`autoApproveCommands` (shell-glob allowlist for `terminal_exec`).**
  Skip the human gate for specific shell commands the agent runs.
  Patterns are anchored on both ends (so `memo *` matches `memo notes
  -a` but NOT `rm -rf / && memo notes`); `*` and `?` use standard glob
  semantics, everything else is a literal match. An allowlist match
  ALWAYS short-circuits the dangerous-pattern blocklist — explicit
  operator allow beats heuristic block. Auto-approved commands still
  write a high-risk `terminal.exec` audit row with
  `evidence.autoApproved=true` and
  `evidence.autoApprovedReason=<pattern>`.

- **`dangerousTerminalPatterns`** — optional operator overlay that
  EXTENDS the built-in dangerous-pattern blocklist for `approvalMode:
  "auto"`. The built-ins (`rm -rf /` against system paths, any
  `sudo`, pipe-to-shell, `chmod 777`, destructive git, writes to
  `/etc/` and friends) always apply; operator entries add to them.
  An empty list keeps the built-ins. Only consulted in `"auto"` mode.

- **`dangerouslyAutoApprove`** — deprecated read alias for
  `approvalMode === "yolo"`. Returned as a derived boolean on GET;
  accepted on PATCH as a one-shot alias (`true` → `"yolo"`, `false`
  → `"auto"`). New configuration should prefer `approvalMode`.

Read current settings:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7337/api/settings/auto-approve
```

Set patterns:

```sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"patterns": ["memo *", "remindctl *"]}' \
  http://127.0.0.1:7337/api/settings/auto-approve
```

Switch modes:

```sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"approvalMode": "yolo"}' \
  http://127.0.0.1:7337/api/settings/auto-approve
```

Any subset of fields can be set in a single PATCH; omitted keys keep
their current value. The endpoint persists to
`~/.gini/instances/<instance>/config.json` in one write and takes
effect immediately for new tool dispatches.

## Cleanup

Remove a single instance:

```sh
gini uninstall --instance <instance>
```

Full uninstall (interactive, two prompts):

```sh
gini uninstall
```

The first prompt asks "are you sure" (default no). The second asks whether to keep instance state at `~/.gini/instances/` (default yes). The full uninstall stops every running instance, removes the installer-managed wrapper at `~/.local/bin/gini`, removes the runtime checkout at `~/.gini/runtime/`, and strips the PATH block (marker `# Added by gini-agent installer`) from your shell rc. The model cache at `~/.gini/models/` is never auto-removed — the summary prints its size and the `rm -rf` command to remove it manually.

Non-interactive variants:

```sh
gini uninstall --yes      # full uninstall, no prompts, keep instances
gini uninstall --purge    # full uninstall + delete instances (implies --yes)
```

For disposable development and tests, override roots:

```sh
GINI_STATE_ROOT=.gini GINI_LOG_ROOT=.gini-logs bun run gini --instance sandbox smoke
```
