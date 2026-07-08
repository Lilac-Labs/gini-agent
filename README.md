# Gini Agent

Gini Agent is a personal agent that remembers, improves, and runs without forcing you to read a log line.

Gini is not just a chat box, CLI, messaging bot, or pile of tools. Chat is an interaction surface. The runtime is the system of record for conversations, runs, tasks, approvals, memory, skills, jobs, tools, traces, audit events, and runtime health.

It's also built to be a product, not plumbing. When the agent needs you, it hands you a purpose-built control right where the work is — a secure field, a choice, a sign-in handoff, a confirm-before-send — instead of a prose instruction or a detour. And because every client speaks the same runtime, those controls reach you on your phone as readily as the desktop, so the machine the agent runs on is not where you have to be.

## Docs

- [Whitepaper](docs/whitepaper.md): the gaps this project is closing and the bar it's measured against
- [Architecture Overview](docs/architecture-overview.md): gateway/client map
- [Gateway And Control Plane](docs/gateway.md): runtime process, BFF, auth, instances, ports, disk layout
- [Conversation And Runs](docs/conversation-runs.md): chat, runs, tasks, plan steps, traces, and audit handoff
- [Memory](docs/memory.md): retain, recall, embeddings, reranking, review, and storage
- [Skill Learning From Skills](docs/skill-learning.md): how Gini improves its own skills from task outcomes (two-tier reward, attribution, the daily review, the human gate)
- [Runtime Capabilities](docs/runtime-capabilities.md): current CLI/API capability map and verification commands
- [Model Providers](docs/providers/README.md): per-provider setup guides (credentials, prerequisites, CLI/web config) for OpenAI, Anthropic, Bedrock, Azure, OpenRouter, DeepSeek, Codex, and Local
- [Operations](docs/operations.md): install, start, stop, smoke, diagnostics, and cleanup
- [Docker Deployment](docs/deployment-docker.md): run an instance headless in a container with a real browser under Xvfb
- [Remote Access](docs/remote-access.md): tunnel modes and confirmation, plus a self-contained guide per tunnel provider — [Gini Relay](docs/remote-access/gini-relay.md), [Tailscale](docs/remote-access/tailscale.md), [ngrok](docs/remote-access/ngrok.md), [Cloudflare](docs/remote-access/cloudflare.md) — the same pages the app opens inline
- [Releases](docs/releases.md): versioning, CHANGELOG conventions, and the release process
- [Migrating from openclaw](docs/migration-from-openclaw.md): import an existing openclaw install into gini
- [Implementation Notes](docs/implementation-notes.md): source layout and module boundary rules
- [Roadmap](ROADMAP.md): shipped surfaces and what's planned, with design intent

## Architecture decisions

- [Architecture Decision Records](docs/adr/README.md): index of all ADRs and how to add new ones

## Architecture In One Sentence

Gini's **runtime is the gateway**: a single Bun process per instance owns state and performs work. The Next.js web app, CLI, Expo mobile app, MCP surfaces, and messaging bridges are clients of the same authenticated `/api/*` contract. See [Architecture Overview](docs/architecture-overview.md) for the design.

```text
                 GATEWAY (Bun runtime, one per instance)
                 state, agent loop, tools, memory, jobs
                              ^
          --------------------+--------------------
          |                    |                   |
      Next.js BFF          CLI / scripts       other clients
      browser UI           bearer token        mobile, MCP, messaging
      no browser token
```

## What's in the box

- Authenticated localhost gateway and a Next.js + Tailwind + shadcn/ui control plane
- Persistent chat, runs, tasks, approvals, traces, audit events, jobs, memories, and skills
- Approval-gated file, terminal, and code tools
- Provider support: Codex OAuth; OpenAI / Azure OpenAI / DeepSeek / OpenRouter API keys; the first-party Anthropic Claude API; Amazon Bedrock (model-agnostic Converse, AWS SigV4 — Claude, Nova, Llama, Mistral, DeepSeek); and any OpenAI-compatible local server
- Local embeddings, reranking, and voice-message speech-to-text by default
- Parallel instances with isolated state, ports, and logs
- In-chat actionable controls — secure credential/secret fields, sign-in and sensitive-step handoff into the agent's browser, choice prompts, and confirm-before-send — so the agent unblocks itself in context instead of stranding you

See the [Whitepaper](docs/whitepaper.md) and [Architecture Overview](docs/architecture-overview.md) for the design.

## Built to be used

Gini treats the chat as a product surface, not a transcript. The agent takes initiative — it runs scheduled jobs, drives multi-step work, and reaches across your tools — and an agent that does that has to stay easy to steer. So whenever it needs you, it surfaces the exact interactive control inline and waits, instead of asking you to go do something elsewhere:

- **Secrets stay out of the conversation.** A key, password, OTP, or payment field is typed into a secure card that flows straight to the gateway and never reaches the model, the transcript, or the audit trail. There's no "add a connector first" detour and no pasting credentials into chat — the agent requests exactly what it's missing, the moment it's missing it.
- **The agent can be unblocked from anywhere.** When a task hits a sign-in wall or a step only you can finish, the agent hands you a live view of its own browser to sign in or complete the step, and picks up where it left off. You don't have to be sitting at the machine the gateway runs on.
- **Choices instead of guesses.** When more than one path is reasonable, the agent offers a small set of choices to pick from rather than silently committing to one.
- **Consent before anything goes out in your name.** Before it sends a message, replies, posts, or buys on your behalf, the agent shows you what's about to happen and a single button to send it — so it acts on your say-so, not its own.

The same cards render on the web app and the iOS app off one wire protocol, and they reach your phone off-LAN through a runtime tunnel, so where you act is your choice, not the agent's constraint. The design intent behind each of these lives in the ADRs under [docs/adr/](docs/adr/) — [user-choice-prompt.md](docs/adr/user-choice-prompt.md), [user-confirmation-primitive.md](docs/adr/user-confirmation-primitive.md), [browser-fill-secret.md](docs/adr/browser-fill-secret.md), [chat-credential-provisioning.md](docs/adr/chat-credential-provisioning.md), and [browser-connect-handoff.md](docs/adr/browser-connect-handoff.md).

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/Open-Curiosity/gini-agent/main/scripts/install.sh | bash
```

On macOS the installer enables autostart (per-user LaunchAgents for the runtime and webapp), waits for the webapp to come up, and opens the `/setup` page in your browser. The form offers the full provider catalog — OpenAI, Codex, Anthropic, Amazon Bedrock, Azure OpenAI, OpenRouter, DeepSeek, and Local — and prompts for whatever the one you pick needs (an API key, the AWS access key pair for Bedrock, the resource endpoint for Azure, or your existing `codex login` auth). Save it and you land on the running app. The runtime stays alive across reboots and crashes until you explicitly run `gini stop` or `gini autostart disable`.

If the browser doesn't open automatically (or you want to navigate manually), run `gini status` to print the actual web URL. The installed `default` instance always lives at `:7777`; other instances get hash-derived ports, so check `gini status` rather than guessing. The installer also prints the URL right before opening the browser.

Caveat on macOS 26 (Tahoe): after a SIGKILL, launchd sometimes refuses to auto-respawn (`pended nondemand spawn = inefficient`). Run `gini autostart kick` to force a respawn when that happens; RunAtLoad still fires at login.

If you opted out of autostart (`--no-autostart`) or you're on Linux (autostart is currently macOS-only), run `gini setup` then `gini start` to launch the runtime by hand.

After install, the URLs are stable:

- web: `http://127.0.0.1:7777`
- runtime: `http://127.0.0.1:7778`

### Update

```bash
gini update
```

Updates the installer-managed runtime at `~/.gini/runtime` and restarts it. Per-instance state under `~/.gini/instances/` and the model cache at `~/.gini/models/` are preserved.

### From source

```bash
bun install
bun run gini install
bun run gini start
```

From a repo clone, the instance is derived from the directory basename, so each worktree gets isolated state and ports automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup including `./scripts/install.sh --local` for testing the install flow against a local checkout.

## CLI

The CLI covers chat, runs, tasks, approvals, memory, jobs, connectors, providers, snapshots, imports, and more. Discover commands with:

```bash
gini --help
```

Useful starting points:

```bash
gini status        # runtime health and URLs
gini chat new      # start a chat session
gini approvals     # review pending tool approvals
```

(From a repo clone, prefix with `bun run`.)

## Providers

Run `gini setup` for an interactive picker, or configure directly:

```bash
gini provider set codex gpt-5.5            # Codex OAuth (reads ~/.codex/auth.json)
gini provider set openai gpt-5.4-mini      # uses $OPENAI_API_KEY
gini provider set openrouter <model>       # uses $OPENROUTER_API_KEY
gini provider set local <model> --base-url http://127.0.0.1:8000/v1
gini provider set anthropic claude-opus-4-8 # first-party Claude API, uses $ANTHROPIC_API_KEY
# Amazon Bedrock: model-agnostic Converse, SigV4-signed with AWS keys you enter via the web form or `gini setup`
gini provider set bedrock us.amazon.nova-pro-v1:0 --aws-region us-east-1  # sets model + region; enter keys separately
# Azure OpenAI: a first-class provider targeting a deployment on your resource
gini provider set azure gpt-4o \
  --base-url https://<resource>.openai.azure.com \
  --deployment <deployment> --api-version 2024-10-21 --auth-scheme api-key  # uses $AZURE_OPENAI_API_KEY
```

For step-by-step setup of each provider — getting credentials, installing any prerequisite tooling (Ollama, …), and configuring it in the CLI or web — see the per-provider guides: [OpenAI](docs/providers/openai.md), [Anthropic](docs/providers/anthropic.md), [Amazon Bedrock](docs/providers/bedrock.md), [Azure OpenAI](docs/providers/azure.md), [OpenRouter](docs/providers/openrouter.md), [DeepSeek](docs/providers/deepseek.md), [Codex](docs/providers/codex.md), and [Local](docs/providers/local.md). The [providers index](docs/providers/README.md) lists them all with their auth model at a glance.

The `local` provider works with any OpenAI-compatible server (oMLX, vLLM, LM Studio, llama.cpp). The `azure` provider targets an Azure OpenAI resource: set `--base-url` to `https://<resource>.openai.azure.com` and pick a deployment; `--api-version` defaults to a GA value and `--auth-scheme` defaults to `api-key` (a resource key), with `bearer` available for an Entra token. API keys are read from environment variables, and Codex OAuth is read from `~/.codex/auth.json` (or `CODEX_AUTH_JSON`) — nothing is written to Gini config. Run `gini --help` for the full flag set, or see [provider-extra-body.md](docs/adr/provider-extra-body.md) for the `--extra-body` contract and [Azure OpenAI As A First-Class Provider](docs/adr/azure-provider.md) for the Azure routing contract. When a credential fails mid-chat, see [Codex re-authentication](docs/providers/codex.md#re-authentication) and [Provider Re-Authentication Guidance](docs/adr/provider-reauth-guidance.md).

`gini setup`'s interactive picker covers every provider — OpenAI, Codex, Anthropic, Amazon Bedrock, Azure OpenAI, OpenRouter, DeepSeek, and Local — prompting for whatever each one needs (an API key, the AWS access key + secret for Bedrock, the resource endpoint and deployment for Azure, the base URL for Local). `gini provider set …` (above) and the web **Settings → Add provider** form remain available for scripted or non-interactive configuration.

## Parallel Instances

Each instance has isolated state, ports, and logs:

```bash
gini --instance sandbox run
gini smoke                  # ephemeral instance under /tmp
```

Multiple agents can run smoke tests concurrently without colliding.

## Messaging channels

Gini can bridge to messaging channels such as Telegram, Discord, and Slack. These bridges were added to exercise the gateway's messaging contract and are **not** being actively worked on. We highly recommend interacting with Gini through the native web app and iOS app. Those are the primary, actively developed surfaces. See [telegram-bridge.md](docs/adr/telegram-bridge.md), [discord-bridge.md](docs/adr/discord-bridge.md), and [slack-bridge.md](docs/adr/slack-bridge.md) for the bridge contracts.

## Migrating from openclaw

Already running [openclaw](https://github.com/openclaw/openclaw)? Import your agents, chat history, memory, skills, workspace files, and messaging bridges into a gini instance. The import is two steps — `plan` prints a redacted summary, `apply` writes the state:

```bash
gini import plan openclaw    # dry-run: summarize what would be imported
gini import apply openclaw   # import the openclaw state into gini
```

`apply` mutates state in-process, so stop the target instance first (`gini stop --instance <name>`), apply, then start it again. Every applied import first archives your full openclaw state to `<instance>/imports/openclaw-<timestamp>.zip`, so nothing is lost. See [Migrating from openclaw](docs/migration-from-openclaw.md) for the field-by-field mapping, idempotency rules, and verification steps.

## Local State

```text
~/.gini/instances/<instance>/   # config, state.json, memory.db, traces, snapshots, workspace, logs
~/.gini/models/                 # shared embedding/reranker/speech-to-text model cache
```

Use `gini uninstall` to remove an instance or the whole install. See [Operations](docs/operations.md) for diagnostics and cleanup.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for shipped surfaces and what's planned.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, verification commands, and PR conventions. For architecture conventions and module boundaries, see [AGENTS.md](AGENTS.md). Report security issues privately per [SECURITY.md](SECURITY.md).


## License

[MIT](LICENSE)
