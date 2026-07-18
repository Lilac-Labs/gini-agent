# Migrating from openclaw to gini

This guide moves an existing [openclaw](https://github.com/openclaw/openclaw) install onto gini. Read [Per-Agent Memory Isolation](adr/agent-memory-isolation.md), [Connector Secret Storage](adr/connector-secret-storage.md), and [Openclaw Migration](adr/openclaw-migration.md) for the architectural reasoning.

## Prerequisites

- A working openclaw install you no longer want as your primary agent. The state must live on the same machine you are running gini on; the migrator does not transfer state across hosts.
- A gini install (`bun run gini install`). The migrator does not bootstrap gini; it only adds to an existing instance.
- Stop openclaw's gateway before migrating so the migrator reads a consistent snapshot. `openclaw stop` (or its daemon equivalent) is enough — the migrator never writes back into openclaw's state root.
- Stop the gini gateway for the target instance before running `apply`. `gini import apply openclaw` refuses to run while a gateway is alive for the same instance because the in-process `mutateState` lock cannot serialize writes across separate OS processes. Run `gini stop --instance <name>` first, apply, then `gini start --instance <name>`.

## Resolving the openclaw state root

The migrator looks for openclaw's state root in this order, matching openclaw's own resolution:

1. An explicit path argument to `gini import`.
2. `OPENCLAW_STATE_DIR` environment variable.
3. `~/.openclaw/`.
4. The legacy `~/.clawdbot/`.

If none of those exist, you'll see "no openclaw.json found" in the planner output. The apply step does not migrate anything in that case, but it DOES record a failed `ImportReport` row (`status: "failed"`, `mode: "applied"`, with an `error` field naming the missing config path) so the activity feed reflects the attempt. You can ignore that row safely — it exists so a later "where did my migration go?" question has an answer in `gini import`.

## Two-step flow

The migrator separates inspection from mutation. Always run `plan` first so you can read the summary before any state changes.

```bash
# Dry-run: print a redacted summary of what would happen.
bun run gini import plan openclaw

# Apply: actually mutate gini state.
bun run gini import apply openclaw
```

Both commands accept an optional path argument when your openclaw state lives somewhere other than the default. The CLI prints JSON; pipe it to `jq` for readable filtering.

```bash
bun run gini import plan openclaw /Volumes/backup/old-openclaw | jq
```

## What gets migrated

The migrator walks the openclaw state and synthesizes equivalent gini records for the subsystems gini implements today:

| Openclaw artifact | Gini destination | Notes |
| --- | --- | --- |
| Entire `<state>/` directory | `<instance>/imports/openclaw-<timestamp>.zip` | Written before any other step. The migration never deletes openclaw data, but the archive is your insurance policy in case you later wipe `~/.openclaw` thinking the migration moved it. The archive failing to write aborts the migration before any state mutation lands; the safety net is non-optional. |
| `cfg.agents.list[]` | New `AgentRecord` per agent | Agent name carries the openclaw id. The default openclaw agent maps to a new gini agent — the seeded `agent_default` is left alone so your existing defaults aren't disturbed. |
| `agents/<id>/agent/auth-profiles.json` (api_key / token) | `~/.gini/secrets.env` line `<canonical-env-var>=…` | Env var names are taken from the provider layer, not hand-rolled — `openai` → `OPENAI_API_KEY`, `openrouter` → `OPENROUTER_API_KEY`, `local` → `GINI_LOCAL_API_KEY` (the `GINI_` prefix is what `normalizeProvider` in `packages/runtime/src/provider.ts` reads). `codex` is a no-op because gini reads OAuth from `~/.codex/auth.json`; you'll see a `provider:codex` note pointing at `codex login`. Anthropic, Google, and similar are listed in `unsupported` so you can wire them manually. |
| `channels.telegram` + state-dir `.env` `TELEGRAM_BOT_TOKEN` + `credentials/telegram-allowFrom.json` | `MessagingBridgeRecord` (kind `telegram`) with encrypted bot token and per-chat allowlist | Allowlist string ids are coerced to numbers. See [Telegram Messaging Bridge](adr/telegram-bridge.md). |
| `channels.discord` + `DISCORD_BOT_TOKEN` | `MessagingBridgeRecord` (kind `discord`) with encrypted bot token | See [Discord Messaging Bridge](adr/discord-bridge.md). **The supervisor won't poll the bridge until you add at least one delivery channel.** Openclaw stores a per-sender allowlist while gini stores per-channel snowflakes, so the migrator cannot derive the channel list. The migration warning instructs the operator to disable the migrated bridge with `gini messaging disable <id>` and re-create it via `gini messaging add <name> discord <channel-id>... --bot-token <token>` (re-supplying the original openclaw bot token). An in-place edit verb is a known follow-up. |
| `<state>/skills/<name>/SKILL.md` | `<instance>/skills/<name>/SKILL.md` | Top-level `openclaw:` frontmatter block is rewritten to `metadata:\n  gini:`. Sibling files in the skill dir (scripts, references) are copied verbatim. |
| `<state>/workspace/{AGENTS,SOUL,TOOLS,IDENTITY,USER,HEARTBEAT,BOOTSTRAP,MEMORY}.md` | `<instance>/workspace/<file>` | Same-named files are skipped unless `--force` is passed. The migrator resolves the workspace dir in this order: `OPENCLAW_WORKSPACE_DIR` (explicit override, taken verbatim), then `OPENCLAW_PROFILE`-derived `<state>/workspace-<profile>/` (and `~/.openclaw/workspace-<profile>/` when no explicit state path was given), then `<state>/workspace/`, then `~/.openclaw/workspace/` as the final fallback (only when no explicit state path was given). |
| `<state>/agents/<id>/sessions/*.jsonl` | One `ChatSessionRecord` per JSONL plus one `ChatMessageRecord` per `type: "message"` line | Tool_use and tool_result blocks are dropped from migrated message content (`ChatMessageRecord.content` is a flat string). The full verbatim transcript stays in the archive zip. Session createdAt/updatedAt are rebased to the openclaw timestamps so recent-chats sort reflects the original transcript date, not migration day. |
| `<state>/memory/<id>.sqlite` (Hindsight schema: `memory_banks` + `memory_units`) | One `memory_units` row per source row in `<instance>/memory.db`, routed into the per-agent bank (`bank_<agentId>`) of the gini agent whose name matches the source SQLite filename | Migrated with embedding NULL; run `gini embedding reembed --all-banks` after migration to populate vectors across every per-agent bank (the default `gini embedding reembed` only walks the default bank). Unknown statuses/networks are coerced to `active`/`experience` so a schema drift can't poison recall. The legacy file-chunk RAG schema (`chunks` + `files` + `embedding_cache`) has no direct gini target and lands on the `unsupported` list with a `Re-index via /api/memory/retain` hint. |

Provider keys land in `~/.gini/secrets.env` because the installed `gini` wrapper sources that file with `set -a` on every invocation. Connector tokens go through the per-instance encrypted secret store described in [Connector Secret Storage](adr/connector-secret-storage.md) — they are never logged or echoed.

## What is NOT migrated

The migrator surfaces every unmigrated subsystem in the `unsupported` field so you know what is left on the openclaw side:

- **Tasks and cron registries**, **plugin installs**, **device-pair tokens**. Either the feature doesn't exist on the gini side yet or the state is safer to re-establish (devices in particular — openclaw device tokens cannot be reused under gini; re-pair via `gini pair` once you're on gini).
- **Non-Telegram, non-Discord channels** (WhatsApp, Signal, Slack, etc.). The migrator has no import path for those — gini's Slack bridge (see [slack-bridge.md](adr/slack-bridge.md)) uses a two-token create the openclaw state doesn't carry, and the rest have no gini bridge at all; the migrator lists each unsupported channel by name.
- **Openclaw file-chunk RAG memory** (`<state>/memory/*.sqlite` with the `chunks` + `files` + `embedding_cache` schema). The chunk shape doesn't map cleanly to gini's `MemoryUnit` model; re-index relevant files via `/api/memory/retain` if you still need them.

## Idempotency and re-runs

`gini import apply openclaw` is safe to re-run. The default behavior skips anything that already exists by name:

- Agents with a matching `name`: behavior depends on provenance. If the existing agent was created by an earlier run of this migrator (audited via an `openclaw.agent.tagged` row tying the agent id to the openclaw agent id), re-importing reuses it and idempotently dedupes sessions and memory. If it's a native gini agent the operator created themselves, the migrator refuses to attach openclaw sessions and memory to it — an `agent:<name>:name-collision` entry lands on the `unsupported` list and the operator must either delete the native agent (`gini agent delete <name>`) and re-migrate so a fresh tagged agent gets created, or pass `--force` to acknowledge the merge of openclaw history into the existing agent.
- Workspace files that already exist on disk are skipped.
- Skills with the same directory name are skipped.
- Messaging bridges: at most one per kind exists per instance. If the bridge was created by an earlier run of this migrator (audited via a `messaging.configured` row carrying `evidence.source: "openclaw-migration"`), `--force` rotates its token and merges the allow-list. If it's a native bridge the operator created themselves, the migrator refuses to touch it even with `--force` (the bot token and allow-list would be silently overwritten); a `messaging:<kind>:native-collision` entry lands on the `unsupported` list with remediation pointing at `gini messaging disable <bridge-id>` followed by a re-migration.

Use `--force` to rotate values: a fresh openclaw config with a new `TELEGRAM_BOT_TOKEN` re-applied with `--force` against a migrator-created bridge rewrites the encrypted secret file and updates `metadata.allowedChatIds`. Workspace files and skills also overwrite under `--force`.

## Audit trail

Every `apply` invocation — whether the migration found data or not — writes:

- An `ImportReport` row with `source: "openclaw"` and `mode: "applied"`. On success the row carries `status: "completed"` plus a `counts` map summarizing each subsystem. On a no-config apply (the state path exists but `openclaw.json` is missing), the row carries `status: "failed"` with an `error` field and empty counts — written deliberately so the activity feed always reflects the attempt instead of silently producing no record.
- Per-creation audit rows in `state.audit` (agent created, messaging configured, etc.) emitted by the same `addAudit` path the live CRUD endpoints use.

You can read the report via `gini import` (the default subcommand lists reports) and the audit rows via `gini audit`.

## Verifying after migration

The verification commands below are API-backed, so they need a running gateway. The migration prerequisite required stopping the gateway before `apply`, so the first step is `gini smoke` — it self-starts the runtime so every command after it has a live `/api/*` to call.

```bash
# Smoke test the runtime end-to-end. This self-starts the runtime,
# so the API-backed commands below have a live gateway to query.
bun run gini smoke

# Inspect agent state.
bun run gini agents list

# Confirm the bridge is configured and healthy.
bun run gini messaging list

# Inspect migrated chat history.
bun run gini chat list
```

After the smoke passes, populate the migrated memory unit embeddings with the active embedding provider, then start gini:

```bash
# Re-embed every migrated memory unit so semantic recall returns them.
# The migrator stores units with embedding NULL and routes them into
# the matching per-agent bank (`bank_<agentId>`); --all-banks
# enumerates every bank in the instance so per-agent units aren't
# missed. Plain `gini embedding reembed` only walks the default bank
# and would leave per-agent units invisible to semantic recall.
bun run gini embedding reembed --all-banks

bun run gini start
```

The newly-imported provider keys are picked up automatically because the installed `gini` wrapper sources `~/.gini/secrets.env` on every invocation.

## Where the openclaw archive lives

Every applied migration writes a verbatim zip of your openclaw state root to:

```
<instance>/imports/openclaw-<timestamp>.zip
```

You can find the instance root with `gini status` (it prints the active instance dir). Restore from the archive by unzipping into a fresh path and pointing `gini import apply openclaw <unzipped-dir>` at it (the path is a positional argument, not a `--path` flag). The archive is intentionally kept on disk indefinitely — delete it manually only after you've confirmed the migration result is what you want.

## Common questions

**Can I run this without stopping openclaw?**
The migrator only reads from the openclaw state, never writes. But openclaw's gateway can rewrite files mid-read (a `sessions.json` flush, an offset bump). Stopping openclaw first guarantees a consistent snapshot.

**Where do I find my openclaw state if I customized it?**
Run `openclaw doctor` — it prints the active state root. Or check `OPENCLAW_STATE_DIR` in your shell environment.

**My openclaw agents use Anthropic. What happens?**
The migrator creates the agent record but skips the API key — it deliberately doesn't auto-map Anthropic credentials, so the `unsupported` array in the report lists `provider:anthropic`. Gini now ships a native first-party `anthropic` provider, so wire it up directly with `gini provider set anthropic <model>` (the Claude API at api.anthropic.com). For Claude (or Nova, Llama, Mistral, etc.) on Amazon Bedrock, use the separate `bedrock` provider instead — `gini provider set bedrock <modelId> --aws-region <region>`, which signs each request with your AWS credentials. OpenRouter remains an alternative.

**Will my chat history come over?**
Yes. Each `<state>/agents/<id>/sessions/<sessionId>.jsonl` becomes one `ChatSessionRecord` plus one `ChatMessageRecord` per `type: "message"` line under the matching gini agent. Tool_use and tool_result blocks are dropped from the migrated message text (`ChatMessageRecord.content` is a single string), but the full verbatim transcript stays in `<instance>/imports/openclaw-<timestamp>.zip` for anyone who needs the original tool-call detail. Session timestamps are rebased to the openclaw values so recent-chats sort matches what you remember from openclaw.

**Will my Hindsight memory come over?**
If your `<state>/memory/<id>.sqlite` carries the Hindsight schema (`memory_banks` + `memory_units`), yes — each unit lands in `<instance>/memory.db` and is routed into the per-agent bank (`bank_<agentId>`) of the gini agent whose name matches the source SQLite filename. Run `gini embedding reembed --all-banks` after migration to populate vectors across every per-agent bank — the plain `gini embedding reembed` only walks `bank_default` and would leave the per-agent units invisible to semantic recall. If your memory store instead carries the legacy file-chunk RAG schema (`chunks` + `files` + `embedding_cache`), it lands on the `unsupported` list — there's no clean target for that shape in gini today; re-index the underlying files via `/api/memory/retain` if you still need them.
