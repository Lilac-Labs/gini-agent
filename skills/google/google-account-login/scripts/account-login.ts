#!/usr/bin/env bun
// Per-account Google sign-in for the multi-account gws model.
//
// One OAuth client (held by the google-workspace-oauth connector) can authorize
// many Google accounts, each living in its OWN gws config dir selected via
// GOOGLE_WORKSPACE_CLI_CONFIG_DIR. This script signs ONE account into its own
// config dir and registers it (tagged) with the local gateway.
//
// It is normally invoked by the google-workspace-setup skill via
//   skill_run({ skill: "google-account-login", script: "account-login", args })
// AFTER the google-workspace-oauth connector exists, so resolveSkillEnv injects
// GOOGLE_WORKSPACE_CLI_CLIENT_ID/_SECRET (declared in this skill's
// requires.credentials). `gws auth login` reads those from the child env.
//
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.
//
// Contract:
//   stdin:  JSON { tag, services?, readonly?, scopes?, adopt? }
//   stdout: JSON { ok: true, id, tag, email, configDir, scopes }  on success
//           JSON { ok: false, error }                              on failure
//   exit:   0 on success, non-zero on failure (with the error JSON on stdout)
//
// The flow:
//   adopt:true  → configDir = ~/.config/gws; require an already-signed-in
//                 session there (no re-login); register it.
//   otherwise   → mint a gini-managed config dir under ~/.gini/google-accounts/,
//                 run `gws auth login` (background + scrape the consent URL +
//                 open it + wait for the user to finish OAuth), then register.
//
// The 5-minute default skill-script timeout (DEFAULT_TIMEOUT_MS in
// src/capabilities/skill-scripts.ts) bounds the human OAuth wait — this script
// just awaits the gws child's exit and adds no competing multi-minute cap.

import { spawn } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SERVICES = ["drive", "gmail", "calendar", "docs", "sheets", "meet", "forms"];

// How long to wait for `gws auth login` to print its consent URL. gws prints it
// within a second of starting its local callback server; cap the poll so a
// wedged child can't hang before the OAuth wait even begins.
const URL_POLL_MS = 15_000;
const URL_POLL_INTERVAL_MS = 1_000;

interface LoginArgs {
  tag?: string;
  services?: string[];
  readonly?: boolean;
  scopes?: string[];
  adopt?: boolean;
  // Target an EXISTING config dir instead of minting a new one — used to
  // re-auth an account whose session expired (re-using its tag). Pass the
  // account's stored configDir (or "~/.config/gws" to re-log-in the default-dir
  // session). Ignored when adopt is true; when omitted a new dir is minted.
  configDir?: string;
  // The intended account's email; pre-highlights it in Google's account
  // chooser (login_hint) so a re-auth doesn't require hunting for it.
  loginHint?: string;
  // The account this dir must end up as. When set, login FAILS fast (never
  // registers) if a different account signs in, instead of overwriting the tag.
  expectedEmail?: string;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Scrape the first Google consent URL out of `gws auth login`'s output. gws
// prints "Open this URL in your browser to authenticate:" followed by a
// https://accounts.google.com/... URL. Returns null when none is present yet.
export function extractConsentUrl(text: string): string | null {
  const match = text.match(/https:\/\/accounts\.google\.com\/\S+/);
  return match ? match[0] : null;
}

// Build the `gws auth login` arg list. `--scopes` (explicit full scope URLs)
// wins over `-s` (service-name shorthand) when supplied; `--readonly` narrows
// the grant. Defaults to the seven-service `-s` list.
export function buildLoginArgs(opts: {
  services?: string[];
  readonly?: boolean;
  scopes?: string[];
}): string[] {
  const args = ["auth", "login"];
  if (opts.readonly) args.push("--readonly");
  if (opts.scopes && opts.scopes.length > 0) {
    args.push("--scopes", opts.scopes.join(","));
  } else {
    const services = opts.services && opts.services.length > 0 ? opts.services : DEFAULT_SERVICES;
    args.push("-s", services.join(","));
  }
  return args;
}

// Expand a leading "~" / "~/" to the home dir so a caller-supplied configDir
// like "~/.config/gws" resolves to a real path. Absolute or other paths pass
// through unchanged.
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

// Force Google's account chooser onto a scraped consent URL. Without
// prompt=select_account, Google silently continues as whatever account the
// user's default browser is already signed into, so a multi-account re-auth
// mints the token for the WRONG identity and overwrites the target dir's tag.
// Adding select_account makes Google always show the chooser; a loginHint
// pre-highlights the intended account. We MERGE select_account into any prompt
// gws already set (e.g. consent, which guarantees a refresh token on re-auth)
// rather than replacing it — only add the chooser, never drop gws's directives.
// Returns the original URL unchanged if it can't be parsed.
export function forceAccountChooser(url: string, loginHint?: string): string {
  try {
    const parsed = new URL(url);
    const prompts = new Set(
      (parsed.searchParams.get("prompt") ?? "").split(/\s+/).filter(Boolean)
    );
    prompts.add("select_account");
    parsed.searchParams.set("prompt", [...prompts].join(" "));
    if (loginHint && loginHint.trim()) parsed.searchParams.set("login_hint", loginHint.trim());
    return parsed.toString();
  } catch {
    return url;
  }
}

// ── gws subprocess boundary ──────────────────────────────────────────────────

// `gws auth status` for a config dir → parsed JSON (or undefined). Drains
// stdout AND stderr concurrently (gws emits a keyring preamble to stderr; an
// unread piped stream can fill its OS buffer and deadlock the child).
async function gwsAuthStatus(configDir: string, env: Record<string, string>): Promise<Record<string, unknown> | undefined> {
  const proc = spawn(["gws", "auth", "status"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir }
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Run the `gws auth login` browser dance for a config dir: spawn gws, scrape the
// consent URL from its output, open it in the user's browser, then wait for gws
// to exit (the user completing OAuth unblocks it). Returns { ok } plus the last
// meaningful output line on failure.
async function runLogin(
  loginArgs: string[],
  configDir: string,
  env: Record<string, string>,
  loginHint?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proc = spawn(["gws", ...loginArgs], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir }
  });

  // Accumulate stdout+stderr so the URL scrape and the failure-reason extraction
  // both see the full output; drain concurrently to avoid the buffer deadlock.
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  const draining = Promise.all([collect(proc.stdout), collect(proc.stderr)]);

  // Poll for the consent URL, then open it. gws prints it within a second.
  let url: string | null = null;
  const deadline = Date.now() + URL_POLL_MS;
  while (Date.now() < deadline) {
    url = extractConsentUrl(output);
    if (url) break;
    if (await exitedWithin(proc, URL_POLL_INTERVAL_MS)) break;
  }
  if (!url) {
    // The poll ended with no URL — either gws exited first or the deadline
    // elapsed. Stop the (already-dead-or-wedged) child, drain its remaining
    // output, then RE-SCRAPE: a late flush can land the URL after the last poll
    // tick, especially on the early-exit path. Only if it's still absent do we
    // surface the real failure — gws's last line carries invalid_client /
    // redirect_uri mismatch / scope errors the SKILL keys on — instead of the
    // generic "never printed" message. When a URL did flush late but gws has
    // already exited, the `code !== 0` check below returns that same error line.
    try { proc.kill(); } catch { /* already exited */ }
    await draining;
    url = extractConsentUrl(output);
    if (!url) {
      return { ok: false, error: lastMeaningfulLine(output) || "gws never printed the consent URL" };
    }
  }

  openInBrowser(forceAccountChooser(url, loginHint), env);

  // Wait for the user to complete OAuth — gws exits when its callback server
  // receives the code. The skill-script timeout bounds this wait.
  const code = await proc.exited;
  await draining;
  if (code !== 0) {
    return { ok: false, error: lastMeaningfulLine(output) || `gws auth login exited ${code}` };
  }
  return { ok: true };
}

// Resolve to true if the process exits within `ms`, false otherwise (a poll
// tick elapsed with the process still running).
async function exitedWithin(proc: { exited: Promise<number> }, ms: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ]);
}

// Open a URL in the user's default browser (macOS `open`, else `xdg-open`).
// Best-effort: a spawn failure leaves gws blocking, which the timeout bounds.
function openInBrowser(url: string, env: Record<string, string>): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env });
  } catch {
    /* best-effort */
  }
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}

// ── Registration via the local gateway ───────────────────────────────────────

// Register the signed-in config dir with the gateway. Reads the instance's
// config.json for the API port + bearer token; the gateway derives the
// canonical account id (from the dir basename for gini-managed dirs).
async function registerWithApi(
  home: string,
  instance: string,
  body: { tag: string; configDir: string; adopt: boolean }
): Promise<{ id: string; tag: string; email: string; configDir: string }> {
  const configPath = join(home, ".gini", "instances", instance, "config.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { port?: number; token?: string };
  if (!cfg.port || !cfg.token) {
    throw new Error("Gateway config.json missing port or token");
  }
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/google/accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(message || `Register failed (HTTP ${res.status})`);
  }
  return JSON.parse(text) as { id: string; tag: string; email: string; configDir: string };
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function login(args: LoginArgs): Promise<Record<string, unknown>> {
  const tag = typeof args.tag === "string" ? args.tag.trim() : "";
  if (!tag) return { ok: false, error: "A tag is required to label this account." };

  const home = process.env.HOME;
  if (!home) return { ok: false, error: "HOME is not set." };
  const instance = process.env.GINI_INSTANCE;
  if (!instance) return { ok: false, error: "GINI_INSTANCE is not set." };
  const env = { ...process.env } as Record<string, string>;

  const adopt = args.adopt === true;
  const targetDir = typeof args.configDir === "string" ? args.configDir.trim() : "";
  let configDir: string;
  if (adopt) {
    // Adopt the pre-existing default-dir session in place — no re-login.
    configDir = join(home, ".config", "gws");
    const status = await gwsAuthStatus(configDir, env);
    if (status?.token_valid !== true) {
      return { ok: false, error: "No signed-in Google session in the default gws config dir to adopt." };
    }
  } else if (targetDir) {
    // Re-auth / target an existing dir: run the login dance into the dir the
    // caller named instead of minting a new one, so re-registering reuses the
    // same id (and tag). mkdir is a no-op when the dir already exists.
    configDir = expandHome(targetDir, home);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const loginArgs = buildLoginArgs({ services: args.services, readonly: args.readonly, scopes: args.scopes });
    const result = await runLogin(loginArgs, configDir, env, args.loginHint);
    if (!result.ok) return { ok: false, error: result.error };
  } else {
    // Mint a gini-managed config dir and run the browser OAuth login into it.
    const id = "gacct_" + crypto.randomUUID().slice(0, 8);
    configDir = join(home, ".gini", "google-accounts", id);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const loginArgs = buildLoginArgs({ services: args.services, readonly: args.readonly, scopes: args.scopes });
    const result = await runLogin(loginArgs, configDir, env, args.loginHint);
    if (!result.ok) return { ok: false, error: result.error };
  }

  // Confirm a valid session + capture the email/scopes the user actually granted.
  const status = await gwsAuthStatus(configDir, env);
  if (status?.token_valid !== true) {
    return { ok: false, error: "Login did not produce a valid session." };
  }
  const scopes = Array.isArray(status.scopes)
    ? status.scopes.filter((s): s is string => typeof s === "string")
    : [];

  // Fail before registering if the signed-in account isn't the intended one —
  // never register the wrong identity under this tag (the silent-overwrite bug).
  const actualEmail = typeof status.user === "string" ? status.user : "";
  const expected = typeof args.expectedEmail === "string" ? args.expectedEmail.trim() : "";
  if (expected && actualEmail && actualEmail.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      error: `Signed in as ${actualEmail}, but this account is ${expected}. ` +
        `Re-run and pick ${expected} at Google's account chooser.`
    };
  }

  // The gateway derives the canonical id (dir basename for managed dirs).
  const account = await registerWithApi(home, instance, { tag, configDir, adopt });
  return {
    ok: true,
    id: account.id,
    tag: account.tag,
    email: account.email,
    configDir: account.configDir,
    scopes
  };
}

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

async function main(): Promise<void> {
  try {
    const args = await readStdinJson<LoginArgs>();
    const result = await login(args);
    process.stdout.write(JSON.stringify(result));
    if (result.ok !== true) process.exitCode = 1;
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
    process.exitCode = 1;
  }
}

// Only run main when executed directly (the unit test imports the pure helpers).
if (import.meta.main) {
  await main();
}
