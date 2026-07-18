import { uploadIdsFromText } from "../lib/upload-ref";

export function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

// A chat block as the CLI cares about it for attachment rendering. Loosely
// typed because the CLI consumes the wire JSON, not the runtime ChatBlock type.
// Outbound attachments ride INLINE in the reply text as `gini-upload://<id>`
// markdown refs (the model pastes them where the attachment belongs) — the
// block schema carries no structured `images` field. The text the ref lives in
// differs by kind: an assistant_text block keeps it in `text`, a tool_result
// block in `preview`.
interface RenderableBlock {
  kind?: string;
  text?: string;
  preview?: string;
}

// Block kinds that can carry OUTBOUND (agent-produced) attachment refs, mapped
// to the field whose text holds the reply prose. user_text is inbound — the
// user's own uploads, which they already have locally — so it's excluded; this
// function is outbound-only by name and behavior.
const OUTBOUND_TEXT_FIELD: Record<string, "text" | "preview"> = {
  assistant_text: "text",
  tool_result: "preview"
};

// Render outbound attachments for the CLI. A terminal can't display a picture
// (or a PDF), so the honest behavior is: parse the `gini-upload://<id>` refs the
// model pasted into its reply text, fetch each upload's bytes via
// GET /api/uploads/:id, write them to a temp file, and print the saved path so
// the user can open it. Returns the number of attachments saved. The fetcher —
// which also reports the upload's mime so the saved file gets a sensible
// extension (the markdown ref carries no mime) — is injected so this stays
// unit-testable without a live gateway. Each id is saved once even if referenced
// by multiple blocks.
export async function renderOutboundAttachments(
  blocks: unknown,
  deps: {
    fetchUpload: (id: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
    savePath: (id: string, mimeType: string) => string;
    writeFile: (path: string, bytes: Uint8Array) => void;
  }
): Promise<number> {
  if (!Array.isArray(blocks)) return 0;
  const seen = new Set<string>();
  let saved = 0;
  for (const block of blocks as RenderableBlock[]) {
    const field = block?.kind ? OUTBOUND_TEXT_FIELD[block.kind] : undefined;
    if (!field) continue;
    const text = block[field];
    if (typeof text !== "string") continue;
    for (const id of uploadIdsFromText(text)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const { bytes, mimeType } = await deps.fetchUpload(id);
      const path = deps.savePath(id, mimeType);
      deps.writeFile(path, bytes);
      console.log(paint("dim", "📎 attachment saved:") + ` ${path}`);
      saved += 1;
    }
  }
  return saved;
}

const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m"
} as const;

function paint(color: keyof typeof ANSI, text: string): string {
  // Skip colors when stdout isn't a TTY (piped/redirected) so callers parsing
  // output don't have to strip escape codes.
  if (!process.stdout.isTTY) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

interface StartBanner {
  started?: boolean;
  running?: boolean;
  url?: string;
  webUrl?: string;
  webError?: string;
  instance?: string;
  foreground?: boolean;
}

// Friendly multi-line banner for `gini start` / `gini run`. Replaces the raw
// JSON dump so users see a clear status indicator and clickable web URL.
// Keeps each field on its own line — terminals make URLs clickable when they
// stand alone with no surrounding punctuation.
export function printStartBanner(value: unknown): void {
  const banner = value as StartBanner;
  const justStarted = banner.started === true;
  const wasRunning = !justStarted && banner.running === true;
  const dot = paint("green", "●");
  const verb = justStarted ? "started" : wasRunning ? "running" : "running";
  const mode = banner.foreground ? paint("dim", " (foreground — Ctrl-C to stop)") : "";
  const lines: string[] = [];
  lines.push(`${dot} ${paint("bold", "Gini")} ${verb}${mode}`);
  if (banner.instance) lines.push(`  ${paint("dim", "Instance")}  ${banner.instance}`);
  if (banner.webUrl) lines.push(`  ${paint("dim", "Web     ")}  ${banner.webUrl}`);
  if (banner.webError) {
    // The runtime is still up if only the web failed — surface it here so the
    // user can recover (e.g. retry, look at logs) without re-running status.
    lines.push(`  ${paint("yellow", "⚠ Web failed:")} ${banner.webError}`);
    if (banner.url) lines.push(`  ${paint("dim", "Runtime ")}  ${banner.url}`);
  }
  console.log(lines.join("\n"));
}

export function compactTask(task: { id: string; status: string; title: string; updatedAt: string }) {
  return { id: task.id, status: task.status, title: task.title, updatedAt: task.updatedAt };
}

export function improvementPayload(kind: string, title: string, content: string): Record<string, unknown> {
  if (kind === "skill") {
    return { name: title, description: content, trigger: title, steps: [content], status: "enabled" };
  }
  if (kind === "job") {
    return { name: title, prompt: content, intervalSeconds: 3600 };
  }
  // Legacy "memory" payload was removed alongside the state.memories
  // consolidation. Fall through to a skill-shaped payload so a legacy
  // caller gets a sane proposal instead of crashing.
  return { name: title, description: content, trigger: title, steps: [content], status: "enabled" };
}

export function help(): void {
  console.log(`Gini CLI

Usage:
  bun run gini install [--instance <name>]
  bun run gini start|stop|status|doctor|reset [--instance <name>] [--port <port>]
  bun run gini run [--instance <name>] [--no-web]
  bun run gini uninstall [--instance <name>] [--yes] [--purge]
  bun run gini update
  bun run gini setup [--force] [--yes]
  bun run gini onboarding skip [--instance <name>]
  bun run gini autostart enable|disable|status|kick [--instance dev]
  bun run gini task submit <prompt>
  bun run gini task list
  bun run gini task show <task-id>
  bun run gini runs list|show
  bun run gini approvals
  bun run gini approval approve|deny <approval-id>
  bun run gini memory retain|recall|reflect|units|banks|migrate
  bun run gini reranker status
  bun run gini skills list|add|show|search|validate|test|enable|disable|rollback
  bun run gini jobs list|add|run|pause|resume|remove|runs|replay
  bun run gini email list|add --from <sender>|remove <id>
  bun run gini connectors list|providers|add|remove|rotate|health
  bun run gini connector accounts list|retag <id> --tag <tag>|remove <id>|add
  bun run gini improvements list|propose|approve|reject
  bun run gini mobile bootstrap
  bun run gini search <query>
  bun run gini toolsets list|enable|disable
  bun run gini browser status|connect [--url WSURL]|disconnect
  bun run gini subagents list|spawn
  bun run gini mcp list|add|health|invoke|disable
  bun run gini messaging list|add|health|disable|remove|allow|deny|reject-pending|chats|receive|send|messages
  bun run gini import inspect openclaw <path>
  bun run gini import plan openclaw [path]
  bun run gini import apply openclaw [path] [--force]
  bun run gini agents list|create|use
  bun run gini relays list|add|health
  bun run gini tunnel [status] | select <provider> | connect [provider] | cancel | disconnect
  bun run gini notifications list|queue|send|ack
  bun run gini promotions list|propose|approve|reject
  bun run gini snapshots list|create|restore
  bun run gini provider show|catalog|set echo|openai|codex|openrouter|local|deepseek|azure [model]
                  [--base-url <url>] [--api-key-env <NAME>] [--extra-body <JSON>]
                  [--api-version <V>] [--deployment <NAME>] [--auth-scheme bearer|api-key]
                  --base-url and --api-key-env work for every OpenAI-compatible
                  provider (local / openai / openrouter / deepseek / azure —
                  point at servers like oMLX, vLLM, LM Studio) AND for codex
                  (override the backend URL or auth-file env var). --extra-body
                  forwards server-specific request fields like
                  \`chat_template_kwargs\` and applies to the chat-completions
                  calls of local / openai / openrouter / deepseek / azure;
                  codex (/responses) and echo ignore it. --api-version,
                  --deployment, and --auth-scheme configure the azure provider
                  (Azure OpenAI): set --base-url to https://<resource>.openai.azure.com;
                  --auth-scheme api-key (default) uses a resource key.
  bun run gini trace <task-id>
  bun run gini events
  bun run gini audit
  bun run gini evidence
  bun run gini smoke
  bun run gini identity show|history|rollback

Process lifecycle:
  gini start      - daemon mode; instance keeps running after the terminal
                    closes. Use this for a persistent personal agent on
                    your machine.
  gini run        - foreground mode; instance dies when this terminal
                    exits or you Ctrl-C. Use this for coding-agent
                    worktrees and CI.
  gini autostart  - macOS LaunchAgent integration. \`enable\` registers a
                    per-instance plist so the runtime starts at login.
                    \`gini stop\` is honored (clean exits don't respawn).
                    On macOS 26+, launchd auto-respawn after SIGKILL is
                    unreliable — use \`gini autostart kick\` to force a
                    respawn when the runtime crashed. v1 supervises by PID
                    only; a wedged-but-alive runtime isn't detected yet.

Global options:
  --instance <name>        Select a persistent instance. Smoke uses an ephemeral instance when omitted.
  --state-root <path>  Override state root for tests or parallel agents.
  --log-root <path>    Override log root for tests or parallel agents.
  --port <number>      Preferred runtime localhost port. Start scans upward if busy.
  --web-port <number>  Preferred Next.js port (default 3000).
  --no-web             Don't launch the Next.js control plane (smoke uses this automatically).
  --web                Force the Next.js control plane to launch even for smoke runs.
`);
}
