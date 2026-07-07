// CLI entry point. Parses global flags, resolves the instance and runtime
// config, builds a CliContext, and dispatches to the right command module.

import "../hooks/builtins"; // registers trusted hook handlers (skill-script) so any in-process createScheduledJob path resolves isKnownHook
import { defaultWebPort, loadConfig, parseInstance } from "../paths";
import { loadSecretsEnvIntoProcess } from "../state/secrets-env";
import type { RuntimeConfig } from "../types";
import { applyGlobalEnvOverrides, flagValue, hasFlag, stripGlobalArgs } from "./args";
import type { CliContext } from "./context";
import { help } from "./output";
import { task } from "./commands/task";
import { chat } from "./commands/chat";
import { runs } from "./commands/runs";
import { approval } from "./commands/approval";
import { memory } from "./commands/memory";
import { embedding } from "./commands/embedding";
import { reranker } from "./commands/reranker";
import { skill } from "./commands/skills";
import { job } from "./commands/jobs";
import { email } from "./commands/email";
import { connector } from "./commands/connectors";
import { improvement } from "./commands/improvements";
import { mobile } from "./commands/mobile";
import { search } from "./commands/search";
import { toolset } from "./commands/toolsets";
import { browser } from "./commands/browser";
import { subagent } from "./commands/subagents";
import { mcp } from "./commands/mcp";
import { messaging } from "./commands/messaging";
import { importInspect } from "./commands/imports";
import { agent } from "./commands/agents";
import { relay } from "./commands/relay";
import { tunnel } from "./commands/tunnel";
import { notification } from "./commands/notifications";
import { promotion } from "./commands/promotions";
import { snapshot } from "./commands/snapshots";
import { provider } from "./commands/provider";
import { trace } from "./commands/trace";
import { audit } from "./commands/audit";
import { events } from "./commands/events";
import { evidence } from "./commands/evidence";
import { smoke } from "./commands/smoke";
import { doctorCmd, install_, reset, runForeground, start, statusCmd, stop, uninstall, update } from "./commands/admin";
import { setup } from "./commands/setup";
import { autostart } from "./commands/autostart";
import { identity } from "./commands/identity";
import { watchdog } from "./commands/watchdog";

export async function run(): Promise<void> {
  const args = Bun.argv.slice(2);
  const cliArgs = stripGlobalArgs(args);
  const command = cliArgs[0] ?? "help";
  // Populate this process's env from ~/.gini/secrets.env so CLI-local,
  // single-process commands that read creds themselves (provider show, status,
  // setup) report accurate health. Skip `run`/`start`: they spawn the Next.js
  // web/BFF child with `env: {...process.env}`, and provider secrets must stay
  // out of the web process (see docs/adr/bff-trust-boundary.md) — the gateway
  // child self-loads them at its own boot instead. Skip `smoke`: it stays
  // hermetic/offline. Fill-missing, so ambiently-exported vars still win.
  if (command !== "run" && command !== "start" && command !== "smoke") loadSecretsEnvIntoProcess();
  const ephemeralSmoke = command === "smoke" && !hasFlag(args, "--instance") && !process.env.GINI_INSTANCE;
  // Smoke always runs headless unless the user explicitly opts in with --web.
  // Decoupled from the ephemeral-instance decision so `gini smoke --instance <x>` stays headless.
  const smokeImpliesNoWeb = command === "smoke" && !hasFlag(args, "--web");
  const noWeb = hasFlag(args, "--no-web") || smokeImpliesNoWeb;
  // Snapshot whether the user pinned ports BEFORE applyGlobalEnvOverrides
  // mutates GINI_PORT/GINI_WEB_PORT. Smoke-generated random ports must NOT
  // be treated as user pins (strict-fail would defeat smoke's randomization).
  const userPinnedRuntimePort = Boolean(flagValue(args, "--port")) || Boolean(process.env.GINI_PORT);
  const userPinnedWebPort = Boolean(flagValue(args, "--web-port")) || Boolean(process.env.GINI_WEB_PORT);
  applyGlobalEnvOverrides(args, ephemeralSmoke);
  const instance = ephemeralSmoke ? `smoke-${process.pid}-${crypto.randomUUID().slice(0, 6)}` : parseInstance(args);
  const webPortFlag = flagValue(args, "--web-port");
  const webPortPinned = userPinnedWebPort;
  const webPort = Number(process.env.GINI_WEB_PORT ?? webPortFlag ?? defaultWebPort(instance));
  const runtimePortPinned = userPinnedRuntimePort;

  // `uninstall` reaches into HOME-level paths (wrapper, rc file, runtime dir) when
  // the user didn't explicitly target one instance. We must distinguish "user
  // typed --instance" from "we resolved a default instance" — stripGlobalArgs
  // erases the flag, so we sniff the raw args here. The installed wrapper sets
  // GINI_INSTANCE=default on every invocation, so env presence cannot count as
  // "explicit"; only an explicit --instance flag opts into single-instance mode.
  const explicitInstance = hasFlag(args, "--instance");

  // Full-uninstall must not create instance scaffolding before prompting the
  // user. loadConfig has the side effect of ensuring instance/trace/log/skills
  // dirs, so we defer it via a getter that fires only on first .config access.
  let _config: RuntimeConfig | null = null;
  const ctx: CliContext = {
    get config() {
      if (!_config) _config = loadConfig(instance);
      return _config;
    },
    cliArgs,
    command,
    ephemeralSmoke,
    explicitInstance,
    rawArgs: args,
    web: { webPort, webPortPinned, noWeb, runtimePortPinned }
  };

  switch (command) {
    case "install": await install_(ctx); break;
    case "uninstall": await uninstall(ctx); break;
    case "update": await update(ctx); break;
    case "start": await start(ctx); break;
    case "run": await runForeground(ctx); break;
    case "stop": stop(ctx); break;
    case "status": await statusCmd(ctx); break;
    case "doctor": await doctorCmd(ctx); break;
    case "reset": await reset(ctx); break;
    case "setup": await setup(ctx); break;
    case "autostart": await autostart(ctx); break;
    case "task": await task(ctx); break;
    case "chat": await chat(ctx); break;
    case "run-record":
    case "run-records":
    case "runs": await runs(ctx); break;
    case "approval":
    case "approvals": await approval(ctx); break;
    case "memory": await memory(ctx); break;
    case "embedding":
    case "embeddings": await embedding(ctx); break;
    case "reranker":
    case "rerankers": await reranker(ctx); break;
    case "skill":
    case "skills": await skill(ctx); break;
    case "job":
    case "jobs": await job(ctx); break;
    case "email": await email(ctx); break;
    case "connector":
    case "connectors": await connector(ctx); break;
    case "improvement":
    case "improvements": await improvement(ctx); break;
    case "mobile": await mobile(ctx); break;
    case "search": await search(ctx); break;
    case "toolset":
    case "toolsets": await toolset(ctx); break;
    case "browser": await browser(ctx); break;
    case "subagent":
    case "subagents": await subagent(ctx); break;
    case "mcp": await mcp(ctx); break;
    case "message":
    case "messaging": await messaging(ctx); break;
    case "import":
    case "imports": await importInspect(ctx); break;
    case "agent":
    case "agents": await agent(ctx); break;
    case "relay":
    case "relays": await relay(ctx); break;
    case "tunnel": await tunnel(ctx); break;
    case "notification":
    case "notifications": await notification(ctx); break;
    case "promotion":
    case "promotions": await promotion(ctx); break;
    case "snapshot":
    case "snapshots": snapshot(ctx); break;
    case "provider": await provider(ctx); break;
    case "trace": trace(ctx); break;
    case "audit": audit(ctx); break;
    case "events":
    case "event": await events(ctx); break;
    case "evidence": evidence(ctx); break;
    case "smoke": await smoke(ctx); break;
    case "identity": await identity(ctx); break;
    case "watchdog": await watchdog(ctx); break;
    default: help();
  }
}

// Allow `bun run src/cli/index.ts` to execute directly. The conventional
// entry is via the cli.ts shim (see package.json bin), which keeps the
// `bun run gini` and the `gini` binary path stable.
if (import.meta.main) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
