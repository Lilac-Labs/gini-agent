// Deterministic auth preflight for the interactive chat turn (instance-local).
//
// Runs BEFORE the first model call of every non-subagent chat turn and reports
// the live auth state of the demo's external tools (yc CLI, Google/gws) as
// FACTUAL context prepended to the user message — never as part of the system
// prompt. The agent no longer has to spend tool calls discovering auth state;
// it is handed the truth up front. When a tool is logged out, the injected text
// EXPLICITLY ORDERS the agent to authenticate it NOW, before the task, even if
// that tool is irrelevant to the current request (a later turn may need it).
//
// Read-only and best-effort: a checker failure degrades to "unknown" and never
// blocks the turn. Cheap (one short shell probe for yc plus one per attached
// Google account, in parallel) and bounded by its own timeout so it can sit on
// the critical path to the model.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { googleAccountsForInstance } from "../integrations/connectors/google-accounts";
import { parseGwsAuthStatus } from "../integrations/connectors/gws-session";
import { readGoogleAccounts } from "../state/google-accounts";
import type { Instance } from "../types";

const PROBE_TIMEOUT_MS = 8_000;
const YC_PATH_PREFIX = `${homedir()}/.yc/bin:${homedir()}/.local/bin`;

interface ToolStatus {
  tool: string;
  ok: boolean;
  detail: string;
  // Imperative remediation the agent MUST perform when ok === false.
  action: string;
}

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

// A command runner: given a shell probe, resolve its exit code + output. The
// default (`realRun`) shells out to the real `yc`/`gws` CLIs. Tests inject a
// stub so the builder's branch logic can be exercised without booting a real
// subprocess or hitting a live OAuth probe — the slow, machine-dependent part.
export type CommandRunner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ProbeResult>;

const realRun: CommandRunner = (cmd, args, env) => {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, env, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
};

async function checkYc(env: NodeJS.ProcessEnv, run: CommandRunner): Promise<ToolStatus> {
  const r = await run("bash", ["-lc", `export PATH="${YC_PATH_PREFIX}:$PATH"; yc me`], env);
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 0 && /\(/.test(r.stdout)) {
    const who = r.stdout.split("\n")[0]?.trim() ?? "signed in";
    return { tool: "yc", ok: true, detail: `signed in (${who})`, action: "" };
  }
  return {
    tool: "yc",
    ok: false,
    detail: out.includes("Not logged in") ? "NOT logged in" : `NOT authenticated (${out.slice(0, 80)})`,
    action:
      "yc is not authenticated. You MUST resolve this now, before continuing the task, even if the " +
      "task does not use yc — then proceed. Follow your own instructions/skills for HOW to authenticate " +
      "yc (e.g. the yc-cli skill); this notice only tells you that you must act, not how."
  };
}

// Resolve the gws config dirs of EVERY account attached to this instance ([]
// when none is attached). Injectable so tests can drive the no-account,
// mixed-liveness, and revoked branches deterministically.
export type AccountConfigDirsLookup = (instance?: Instance) => string[];

const realAccountConfigDirs: AccountConfigDirsLookup = (instance) =>
  (instance ? googleAccountsForInstance(instance) : readGoogleAccounts()).map((account) => account.configDir);

async function checkGws(
  env: NodeJS.ProcessEnv,
  run: CommandRunner,
  accountConfigDirs: AccountConfigDirsLookup,
  instance?: Instance
): Promise<ToolStatus> {
  const dirs = accountConfigDirs(instance);
  // Probe every attached account (parallel; accounts are few). One live
  // session anywhere means Google is usable, so nothing is injected — a dead
  // account among live ones surfaces at gws-call time through the skills' own
  // auth guidance instead of ordering a reconnect on every turn.
  const statuses = await Promise.all(
    dirs.map(async (dir) => {
      const r = await run(
        "bash",
        ["-lc", `export PATH="${YC_PATH_PREFIX}:$PATH"; GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${dir}" gws auth status`],
        env
      );
      return parseGwsAuthStatus(r.stdout);
    })
  );
  const live = statuses.find((s) => s.signedIn);
  if (live) {
    return { tool: "google (gws)", ok: true, detail: `signed in${live.email ? ` (${live.email})` : ""}`, action: "" };
  }
  // Genuine re-auth: no live session anywhere and at least one attached
  // account holds a grant gws classified as revoked/expired. Only this state
  // orders the reconnect button.
  if (statuses.some((s) => s.tokenRevoked)) {
    return {
      tool: "google (gws)",
      ok: false,
      detail: "session expired / not signed in",
      action:
        "The Google session is expired (the account is already attached to this instance, so this is a " +
        "RE-AUTH of the existing account, not first-time setup). You MUST resolve this now, before continuing " +
        "the task, even if the task does not use Google — then proceed. To resolve it, call " +
        "`request_google_account`: it puts a reconnect button (→ the Integrations page) in the chat. Tell the user " +
        "to click it, then stop and wait for them to say it's done. Never run `gws auth login`, and never drive a " +
        "Google sign-in page with the browser tools."
    };
  }
  // No account attached, or accounts registered but none ever signed in (and
  // none revoked). On hosted this is typically the post-sign-in provisioning
  // window: the edge delivers the credential asynchronously, retrying for ~90s
  // after the redirect, so the state usually heals itself — the agent must
  // re-check before surfacing any button.
  return {
    tool: "google (gws)",
    ok: false,
    detail:
      dirs.length === 0
        ? "no Google account attached to this Gini instance"
        : "no live Google session on any attached account",
    action:
      "No Google account is signed in yet. On hosted, the account is connected at sign-in through the host, " +
      "and right after a fresh sign-in the credential can still be landing (delivery retries for about 90 " +
      "seconds) — so this often resolves on its own. You MUST resolve this now, before continuing the task, " +
      "even if the task does not use Google — then proceed. First re-check once by calling `list_connectors`: " +
      "it refreshes the Google account registry and re-probes sign-in. Only if it still reports no signed-in " +
      "Google account, call `request_google_account`: it puts a connect button (→ the Integrations page) in " +
      "the chat. Tell the user to click it, then stop and wait for them to say it's done. Never run " +
      "`gws auth login`, and never drive a Google sign-in page with the browser tools."
  };
}

// Build the preflight block to append to the turn's ephemeral (user-role)
// context. Returns "" when everything is authenticated (no noise on the happy
// path). When something is logged out, emits a directive block the agent must
// act on. The string is plain factual text authored by the runtime (not
// external/untrusted input), safe to inject verbatim.
export async function buildAuthPreflightBlock(
  env: NodeJS.ProcessEnv = process.env,
  run: CommandRunner = realRun,
  accountConfigDirs: AccountConfigDirsLookup = realAccountConfigDirs,
  instance?: Instance
): Promise<string> {
  // Gate: only run on a provisioned machine. Absent/empty GINI_RELAY_PROVISIONED
  // => safe no-op (no checks, no injected block), so an install without the
  // fleet's yc/gws tooling never pays for (or fails) the probes on every turn.
  const provisioned = env.GINI_RELAY_PROVISIONED;
  if (!provisioned || provisioned.trim().length === 0) return "";
  let statuses: ToolStatus[];
  try {
    statuses = await Promise.all([checkYc(env, run), checkGws(env, run, accountConfigDirs, instance)]);
  } catch {
    return "";
  }
  const failed = statuses.filter((s) => !s.ok);
  if (failed.length === 0) return "";

  const lines: string[] = [];
  lines.push("=== AUTH PREFLIGHT (runtime check — ACT ON THIS FIRST) ===");
  lines.push(
    "A deterministic check ran before this turn and found one or more authenticated tools NOT signed in. " +
      "This notice does not perform any login; it only informs you that you MUST address each one below " +
      "by following your own instructions and skills, BEFORE starting the task. This is unconditional and " +
      "applies even to tools the current request does not use, because a later turn may need them — do not weigh relevance."
  );
  for (const s of statuses) {
    if (s.ok) {
      lines.push(`- ${s.tool}: OK — ${s.detail}.`);
    } else {
      lines.push(`- ${s.tool}: ${s.detail}. REQUIRED ACTION: ${s.action}`);
    }
  }
  lines.push("=== END AUTH PREFLIGHT ===");
  return lines.join("\n");
}
