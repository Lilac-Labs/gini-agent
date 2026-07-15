import { spawn } from "bun";
import { resolveWatchAccount } from "../../state/email-watchers";
import { listAccountsWithStatus } from "./google-accounts";
import type { Instance } from "../../types";

// Direct server-side send of a SAVED Gmail draft by id. The email-draft card's
// Send button posts the draft id (which the agent embedded in the rendered
// email-draft fence) to POST /api/email/drafts/send; the gateway resolves the
// account → gws config dir and calls this. No LLM/agent turn is involved — the
// explicit Send click is the user's approval, and the caller stamps the audit
// row.
//
// gws splits `drafts send` into two JSON inputs: `--params` carries the URL/
// query parameters (`userId`) and `--json` carries the request body, which is
// where the draft `id` belongs. The id therefore rides INSIDE the `--json`
// payload, never string-interpolated into the shell command line — the only
// interpolated tokens are the two static JSON literals built here from a
// validated id.

export interface GmailDraftSendResult {
  // Whether gws reported the draft sent.
  ok: boolean;
  // The sent message id (gws returns the new message's `.id`), when present.
  messageId?: string;
  // A short failure reason when ok is false (gws error / non-JSON / timeout).
  message?: string;
}

// Bound the send the same way gws-session bounds `auth status`: a wedged child,
// a token-refresh network call, or a slow `zsh -lc` profile could otherwise
// hang the request until the HTTP idle timeout.
const SPAWN_TIMEOUT_MS = 15_000;

// The subprocess seam. Defaults to a real `zsh -lc` gws spawn (mirroring how
// gws-session and terminal_exec reach gws on PATH); tests inject a stub so they
// never spawn a real gws. Returns the raw stdout and the exit code.
export type GwsDraftSendRunner = (args: {
  draftId: string;
  configDir?: string;
}) => Promise<{ stdout: string; exitCode: number }>;

const realRunner: GwsDraftSendRunner = async ({ draftId, configDir }) => {
  // The id lives inside the --json request body; --params only carries userId.
  // Both are JSON literals built from the validated id, passed as discrete argv
  // entries to a login shell so gws is on PATH.
  const params = JSON.stringify({ userId: "me" });
  const json = JSON.stringify({ id: draftId });
  const proc = spawn(["zsh", "-lc", `gws gmail users drafts send --params "$1" --json "$2"`, "gws", params, json], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: configDir ? { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir } : { ...process.env }
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, SPAWN_TIMEOUT_MS);
  try {
    // Drain stdout AND stderr concurrently: an unread piped stream can fill its
    // OS buffer and deadlock the child until the kill timer fires. gws emits a
    // keyring preamble to stderr, so it always has bytes waiting there.
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { stdout, exitCode: proc.exitCode ?? 0 };
  } finally {
    clearTimeout(timeout);
  }
};

// Parse gws drafts-send stdout into a result. On success gws prints the sent
// message JSON (`{ "id": "...", "labelIds": ["SENT", ...] }`); on an API error
// it prints `{ "error": { "message": "..." } }`. gws can prefix a non-JSON
// keyring preamble, so slice from the first "{". Any non-JSON / non-object
// output is a failure (we can't trust it sent).
export function parseDraftSendResult(stdout: string): GmailDraftSendResult {
  const start = stdout.indexOf("{");
  let parsed: unknown;
  try {
    parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    return { ok: false, message: "Gmail did not return a parseable response." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, message: "Gmail did not return a parseable response." };
  }
  const obj = parsed as Record<string, unknown>;
  const error = obj.error;
  if (error && typeof error === "object") {
    const apiMessage = (error as { message?: unknown }).message;
    return { ok: false, message: typeof apiMessage === "string" ? apiMessage : "Gmail rejected the draft send." };
  }
  // A sent message carries a SENT label; the message id is the new `.id`.
  const messageId = typeof obj.id === "string" ? obj.id : undefined;
  if (!messageId) return { ok: false, message: "Gmail did not confirm the send." };
  return { ok: true, messageId };
}

// The active subprocess runner. Defaults to the real gws spawn; a test swaps it
// via setDraftSendRunner so the gateway route (which calls sendGmailDraft with
// no runner arg) never spawns a real gws — without a process-wide module mock
// that would leak into this module's own unit tests.
let activeRunner: GwsDraftSendRunner = realRunner;

// Test seam: install a stub runner and return a restore fn. Production never
// calls this (the default is the real gws spawn).
export function setDraftSendRunner(runner: GwsDraftSendRunner): () => void {
  const previous = activeRunner;
  activeRunner = runner;
  return () => {
    activeRunner = previous;
  };
}

// The instance Google accounts provider (each `{ email, configDir, signedIn }`).
// Defaults to the live status-augmented binding the email watchers also read; a
// test swaps it via setAccountsProvider so the route never spawns `gws auth
// status`, without a process-wide module mock that would leak into sibling tests.
export type AccountsProvider = (instance?: Instance) => Promise<{ email: string; configDir: string; signedIn: boolean }[]>;

let activeAccountsProvider: AccountsProvider = listAccountsWithStatus;

// Test seam for the accounts provider. Production never calls this.
export function setAccountsProvider(provider: AccountsProvider): () => void {
  const previous = activeAccountsProvider;
  activeAccountsProvider = provider;
  return () => {
    activeAccountsProvider = previous;
  };
}

// Resolve a sending account email → its gws config dir against this instance's
// Google accounts (the same resolution the email watchers use). An unset /
// unresolved account yields undefined (default gws session). Never throws — a
// registry fault degrades to default gws so a send is never blocked on it.
export async function resolveDraftSendConfigDir(
  account: string | undefined,
  instance?: Instance
): Promise<string | undefined> {
  try {
    return resolveWatchAccount(account, await activeAccountsProvider(instance)).configDir;
  } catch {
    return undefined;
  }
}

// Send a saved Gmail draft by id, optionally targeting a specific account's gws
// config dir. `runner` defaults to the active runner (real gws). Never throws —
// a spawn failure resolves to { ok: false } so the caller never marks a draft
// sent on an unconfirmed send.
export async function sendGmailDraft(
  args: { draftId: string; configDir?: string },
  runner: GwsDraftSendRunner = activeRunner
): Promise<GmailDraftSendResult> {
  try {
    const { stdout } = await runner(args);
    return parseDraftSendResult(stdout);
  } catch {
    return { ok: false, message: "Failed to reach Gmail to send the draft." };
  }
}
