# Runtime Capabilities

This document maps the current runtime surfaces to the product capabilities Gini is expected to provide.

## Verification

Run:

```sh
bun run typecheck
bun test
bun run gini smoke
```

The smoke output should include:

- an `evidencePath`

For an installed instance:

```sh
bun run gini evidence
```

## Capability Map

| Capability | Current surface |
| --- | --- |
| CLI task workflow | `gini task submit/list/show/retry/cancel` |
| Chat and session history | `gini chat new/send/sync/show/list`, `/api/chat` |
| Execution runs | `gini runs list/show`, `/api/runs`; chat turns create durable runs with plan steps and compatibility task links |
| Persistent memory | USER.md (instance), SOUL.md (per-agent), Hindsight (per-agent SQLite bank). `gini memory retain/recall/reflect/units/banks/migrate`, `/api/memory/{retain,recall,reflect,units,banks}` |
| Agent database | Per-agent sandboxed SQL database for keeping and exhaustively querying structured records (the access pattern memory recall can't serve). `db_query`/`db_execute`/`db_import`/`db_schema` tools; isolated per-agent file, separate from system data. Use-cases (e.g. a LinkedIn people-CRM via the `people-crm` skill) layer on top. See [agent-database.md](adr/agent-database.md) |
| Embeddings | Local Transformers.js by default; OpenAI and echo are opt-in. `gini embedding status`, `gini embedding reembed`, `/api/embedding/*` |
| Reranker | Local Transformers.js cross-encoder by default; echo and none are opt-in. `gini reranker status`, `/api/reranker/status` |
| Voice messages / speech-to-text | Mobile (iOS) press-and-hold records a 16 kHz mono WAV; `/api/uploads` accepts `audio/*`, `POST /api/chat/:id/messages` takes an `audio` ref, and the gateway transcribes it locally (Transformers.js whisper-small by default; echo is opt-in) so only the transcript reaches the model — the audio is kept render-only for playback. Readiness at `/api/stt/status`. See [voice-messages-and-local-stt.md](adr/voice-messages-and-local-stt.md) |
| Skills | Skills load enabled by default and can be enabled or disabled. `gini skills list/add/show/search/validate/test/enable/disable/rollback`, `/api/skills` |
| Search | `gini search <query>`, `/api/search` with task, trace, skill, and audit citations (pinned-memory citations were dropped with the state.memories consolidation; Hindsight recall is its own surface via `recall_memory`) |
| Jobs | `gini jobs list/add/run/pause/resume/remove/runs/replay`, prompt jobs, and script jobs. A prompt job's final output posts into its bound chat session when it has one (a dedicated job channel by default; the originating conversation when created with `create_job` `deliverTo: "chat"`; rebindable later via `update_job` `deliverTo` — switching to "channel" mints a fresh channel, switching to "chat" archives the job's old channel out of the lists with history intact) and is delivered to any messaging bridges named on the job's `deliveryTargets` — jobs without a chat session deliver the task summary (settable via the `create_job`/`update_job` tools, validated against configured Telegram/Discord bridges; see [job channels ADR](adr/agent-chat-threads-and-channels.md)) |
| File tools | task inputs: `read`, `list`, `find`, `write`, `patch` |
| Web access | `web_fetch` (fetch a known URL); `web_search` tool backed by Brave Search / Exa connectors — auto-selects a healthy provider, gated by the `web_search` toolset (see ADR web-search-connectors.md) |
| Terminal/code tools | task inputs: `shell`, `code js|python :: ...`, approval gated under `approvalMode: "strict"`; under the default `"yolo"` mode every gate is bypassed, and the safe-middle `"auto"` mode (which operators can switch to) auto-runs safe commands while dangerous shapes still gate (see ADR approval-mode.md) |
| Approval settings | `GET/PATCH /api/settings/auto-approve` for `approvalMode` (`strict`/`auto`/`yolo`), `autoApproveCommands` (shell-glob allowlist for `terminal_exec`), and `dangerousTerminalPatterns` (operator extension to the built-in blocklist) |
| Toolsets | `gini toolsets list/enable/disable`, `/api/toolsets` |
| Providers | `gini provider show/catalog/set`, Codex OAuth, OpenAI, OpenRouter-compatible records, Azure OpenAI (deployment-scoped; see [azure-provider.md](adr/azure-provider.md)), first-party Anthropic Claude (see [anthropic-messages-provider.md](adr/anthropic-messages-provider.md)), Amazon Bedrock (model-agnostic Converse, AWS SigV4; see [bedrock-converse-provider.md](adr/bedrock-converse-provider.md)), DeepSeek, local, echo |
| Runtime updates | `gini update`, `/api/version`, `/api/update/check`, `/api/update`; installer-managed web runtimes show the current package/git version and can trigger an update |
| Delegation records | `gini subagents list/spawn`, `/api/subagents` |
| MCP/plugin records | `gini mcp list/add/health/invoke/disable` |
| Messaging bridge records | `gini messaging list/add/health/receive/send/messages/disable/remove`; inbound messages create tasks. Telegram bridges support per-chat enrollment via `gini messaging allow/deny/reject-pending/chats` (no trust-on-first-use; on each DM from an unrecognized chat the poller mints a short verification code in `F971-8261` format, DMs it to the user, and records the same code on `recentDeniedChats` so the operator can confirm a match before clicking Approve; `reject-pending` clears a pending request row without granting allowlist access). Discord uses channel-as-auth — every non-bot poster in a configured `deliveryTargets` channel can submit, see [Discord bridge ADR](adr/discord-bridge.md) for the Message Content Intent setup step |
| Agents/config | `gini agents list/create/use/delete`, instance-aware config |
| Self-config from chat | Gini inspects and reconfigures its own runtime — provider/model, active agent, toolsets, skills, MCP servers, connectors, approval mode + auto-approve allowlist / dangerous-pattern blocklist, and runtime update — through deferred direct tools (`get_self`, `set_provider`, `enable_toolset`, `set_approval_mode`, `update_self`, …) over a `SelfOperation` registry. The model `load_tools` them on demand; read ops run inline, config changes route through the approval seam as `self.config`. `list_skills` is always-on so capped skill prompt blocks have a discovery fallback. Secret tool args (api keys, tokens) are redacted from chat blocks + approval payloads. See [self-config registry ADR](adr/self-config-registry.md) |
| Import inspection and migration | `gini import inspect openclaw <path>` (read-only summary), `gini import plan openclaw [path]` (dry-run with redacted secret summary), `gini import apply openclaw [path] [--force]` (mutates gini state — creates agents, encrypted bridge tokens, skills, workspace bootstrap files). See [openclaw migration ADR](adr/openclaw-migration.md) and [migration guide](migration-from-openclaw.md) |
| Self-improvement proposals | `gini improvements propose/approve/reject`, trace-backed application |
| Observability | `gini trace`, `gini audit`, `gini events`, `/api/events/stream`, `gini evidence` |
| Web control plane | Next.js app at `packages/web/`, launched by `gini start` or `gini run` unless `--no-web` is set |
| Off-LAN access (tunnel) | `gini tunnel [select <provider> \| connect [provider] \| cancel \| disconnect]`, `/api/tunnel{,/select,/connect,/cancel,/disconnect}`. The gini-relay provider runs an OAuth-loopback login on the host, assigns a per-device subdomain, and runs a supervised `frpc` child exposing the gateway port (the single origin fronting UI + API) at `https://<subdomain>.<relayDomain>`; `tailscale`/`ngrok`/`cloudflare` are detection-gated native drivers (`tailscale serve` / `ngrok http` / a cloudflared named-or-quick tunnel) whose connected fronts are origin-trusted automatically; connecting a provider without its prerequisite rejects with `provider_unavailable` and the web UI opens that provider's guide (`docs/remote-access/<id>.md`). See [remote-access.md](remote-access.md) for the per-provider guides and mode confirmation, and [tunnel-connectivity.md](adr/tunnel-connectivity.md) for the contract |
| Push notifications (iOS) | The gateway signs APNs ES256 JWTs and pushes directly to Apple for `authorization_requested` / `setup_requested` prompts and `phase: Completed/Failed` turns; an iOS Notification Service Extension enriches the banner on-device via `GET /api/push/preview` (real title/body fetched over the device's own authenticated connection, so chat text never transits Apple), and a per-device SSE watch registry suppresses completion pushes to a device while it is actively streaming the session. A parallel per-session registry tracks tokenless web/CLI stream presence and downgrades a completion alert to a silent badge tick on the user's phones while they are reading the chat on the web app, so the phone does not buzz for a message they are already looking at (the badge still ticks — web reads do not clear a phone's read cursor). `POST /api/push/devices` (register), `DELETE /api/push/devices/:token` (deregister on sign-out), `GET /api/push/preview` (NSE enrichment), `POST /api/push/unwatch` (watch-clear beacon). Lock-screen Approve/Deny actions require device unlock for Approve. See [mobile-push-notifications.md](adr/mobile-push-notifications.md) |

## Runtime Contracts

Stable local clients use the gateway API:

- `/api/status`, `/api/healthz`, `/api/state`
- `/api/version`, `/api/update/check`, `/api/update`
- `/api/tasks`, `/api/usage`, `/api/chat`, `/api/runs`, `/api/authorizations`, `/api/setup-requests`
- `/api/memory/retain`, `/api/memory/recall`, `/api/memory/reflect`, `/api/memory/units`, `/api/memory/banks`, `/api/memory/migrate`
- `/api/embedding/status`, `/api/embedding/reembed`, `/api/reranker/status`, `/api/stt/status`
- `/api/uploads` (POST `image/*` or `audio/*`), `GET /api/uploads/:id` — serves both inbound (user-attached) and outbound (agent-produced) media; the same store backs agent screenshots / promoted files, which the agent references inline in its reply text as `gini-upload://<id>` markdown (the block schema is unchanged — only `UserTextBlock.images` carries inbound attachments). See [outbound-chat-attachments.md](adr/outbound-chat-attachments.md)
- `/api/skills`, `/api/jobs`, `/api/connectors`, `/api/toolsets`
- `/api/mobile/bootstrap`
- `/api/messaging`, `/api/mcp`, `/api/subagents`, `/api/agents`
- `/api/tunnel`, `/api/tunnel/select`, `/api/tunnel/connect`, `/api/tunnel/cancel`, `/api/tunnel/disconnect`
- `/api/audit`, `/api/events`, `/api/events/stream`
- `/api/settings/auto-approve`
- `/api/parity/hermes`, `/api/readiness/v1`

Native gateway `/api/*` routes require the **owner bearer** (`Authorization: Bearer <config.token>`) — the only credential the runtime authorizes — with health checks and signed upload GETs excepted. Hosted requests arrive pre-authenticated via `X-Gini-Edge`: the edge authenticates the user with Google OAuth and injects the guest's own owner token upstream. See [ADR: Owner-token-only authentication](adr/owner-token-auth.md).

## Boundaries

Current runtime work is local-first, with off-LAN reach available through the gini-relay tunnel (see the capability map above). The mobile client and APNs push notifications already consume these contracts directly; further mobile surfaces and richer live external transports should do the same rather than adding a second source of truth.
