// Machine-global tagged Google account registry.
//
// Account identity == a `gws` config dir (GOOGLE_WORKSPACE_CLI_CONFIG_DIR).
// One OAuth client (held by the google-workspace-oauth connector) can authorize
// many accounts, each its own config dir. This module owns the low-level
// persistence of the registry — the orchestration (live status, register,
// remove) lives in src/integrations/connectors/google-accounts.ts.
//
// Storage is machine-global (NOT per-instance state): log in once, the account
// is available in every instance. The registry file is
// ~/.gini/google-accounts/accounts.json, gini-managed config dirs live under
// ~/.gini/google-accounts/<id>/. The pre-existing ~/.config/gws session is
// adopted in place (its account's configDir points at ~/.config/gws), so no
// forced re-login.
//
// HOME is resolved via process.env.HOME first (mirroring src/state/secrets-env.ts)
// so tests can override the env var; os.homedir() caches getpwuid on macOS and
// won't pick up a runtime HOME change. Writes are atomic (temp + rename) and
// land at mode 0600. readGoogleAccounts never throws (missing/corrupt → []) —
// it's on the hot system-prompt path.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { id } from "./ids";
import type { GoogleAccount } from "../types";

const REGISTRY_VERSION = 1;

export function googleAccountsRoot(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".gini", "google-accounts");
}

export function googleAccountsRegistryPath(): string {
  return join(googleAccountsRoot(), "accounts.json");
}

export function configDirForAccount(accountId: string): string {
  return join(googleAccountsRoot(), accountId);
}

// "gacct_<rand>" — reuses the shared id() helper (crypto-random suffix).
export function newAccountId(): string {
  return id("gacct");
}

// Read the registry synchronously. Missing or corrupt file → []. Never throws:
// this is called on the hot system-prompt path, so a garbled file must degrade
// to "no accounts" rather than crash turn assembly.
export function readGoogleAccounts(): GoogleAccount[] {
  const path = googleAccountsRegistryPath();
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const accounts = (parsed as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) return [];
    return accounts.filter(isGoogleAccount);
  } catch {
    return [];
  }
}

// The user's chosen primary account id, persisted alongside the accounts as an
// OPTIONAL registry field (additive: a registry written before the field
// existed reads as "no primary"). Tolerant like readGoogleAccounts — missing/
// corrupt file or a non-string value degrades to undefined. Whether the id
// still names a live row is the ORCHESTRATION layer's concern
// (effectivePrimaryAccountId in integrations/connectors/google-accounts.ts).
export function readPrimaryGoogleAccountId(): string | undefined {
  const path = googleAccountsRegistryPath();
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const id = (parsed as { primaryAccountId?: unknown }).primaryAccountId;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

// Persist (or clear, with undefined) the primary account id, leaving the
// account rows untouched.
export function setPrimaryGoogleAccountId(accountId: string | undefined): void {
  writeRegistry(readGoogleAccounts(), accountId);
}

function isGoogleAccount(value: unknown): value is GoogleAccount {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.tag === "string" &&
    typeof o.email === "string" &&
    typeof o.configDir === "string" &&
    typeof o.addedAt === "string"
  );
}

// Atomic registry write: mkdir -p root, write a temp file in the same dir, then
// rename over the target so a reader never sees a half-written file. Mode 0600,
// re-chmod after the rename in case the target pre-existed more permissively
// (writeFileSync's mode only applies on creation — mirrors secrets-env.ts). The
// root is forced to 0700 (re-chmod for the same pre-existing-dir reason): it
// holds each account's per-dir OAuth tokens, so it must not be world-readable.
export function writeGoogleAccounts(accounts: GoogleAccount[]): void {
  // Preserve the persisted primary: this writer only replaces the account rows.
  writeRegistry(accounts, readPrimaryGoogleAccountId());
}

function writeRegistry(accounts: GoogleAccount[], primaryAccountId: string | undefined): void {
  const root = googleAccountsRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* best-effort tightening */ }
  const path = googleAccountsRegistryPath();
  const tmp = join(root, `accounts.json.${process.pid}.${Date.now()}.tmp`);
  const body =
    JSON.stringify(
      { version: REGISTRY_VERSION, accounts, ...(primaryAccountId ? { primaryAccountId } : {}) },
      null,
      2
    ) + "\n";
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort tightening */ }
}

export function getGoogleAccount(accountId: string): GoogleAccount | undefined {
  return readGoogleAccounts().find((a) => a.id === accountId);
}

// Upsert by id. Tags are unique case-insensitively, so adding an account whose
// tag collides with a DIFFERENT account throws. Re-adding the same id (e.g.
// re-registering an existing config dir) replaces that entry in place.
export function addGoogleAccount(account: GoogleAccount): void {
  const accounts = readGoogleAccounts();
  assertTagAvailable(accounts, account.tag, account.id);
  const next = accounts.filter((a) => a.id !== account.id);
  next.push(account);
  writeGoogleAccounts(next);
}

export function removeGoogleAccount(accountId: string): void {
  const accounts = readGoogleAccounts();
  const next = accounts.filter((a) => a.id !== accountId);
  const primary = readPrimaryGoogleAccountId();
  if (next.length === accounts.length && primary !== accountId) return;
  // Deleting the primary clears the field: a stale id must not linger and
  // silently reclaim primacy if the same id were ever re-registered.
  writeRegistry(next, primary === accountId ? undefined : primary);
}

// Rename an account's tag. Enforces case-insensitive tag uniqueness against the
// OTHER accounts; throws when the account id is unknown.
export function retagGoogleAccount(accountId: string, tag: string): void {
  const accounts = readGoogleAccounts();
  const target = accounts.find((a) => a.id === accountId);
  if (!target) throw new Error(`Google account not found: ${accountId}`);
  assertTagAvailable(accounts, tag, accountId);
  target.tag = tag;
  writeGoogleAccounts(accounts);
}

function assertTagAvailable(accounts: GoogleAccount[], tag: string, exceptId: string): void {
  const lower = tag.toLowerCase();
  const clash = accounts.find((a) => a.id !== exceptId && a.tag.toLowerCase() === lower);
  if (clash) {
    throw new Error(`A Google account is already tagged "${clash.tag}"; tags must be unique.`);
  }
}
