// Orchestration for the machine-global tagged Google account registry.
//
// Low-level persistence lives in src/state/google-accounts.ts; per-config-dir
// `gws auth status` lives in ./gws-session.ts. This module joins them: live
// status for the listing, and register/remove/retag that drive the registry +
// (for register) capture the signed-in email.
//
// The status fetcher is injectable (the `deps` param) so these can be
// unit-tested without a real `gws` binary on PATH.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { GoogleAccount, GoogleAccountStatus, Instance } from "../../types";
import {
  addGoogleAccount,
  configDirForAccount,
  getGoogleAccount,
  googleAccountsRoot,
  newAccountId,
  readGoogleAccounts,
  readPrimaryGoogleAccountId,
  removeGoogleAccount,
  retagGoogleAccount,
  setPrimaryGoogleAccountId
} from "../../state/google-accounts";
import {
  attachGoogleAccountToInstance,
  detachGoogleAccountFromInstance,
  getGoogleAccountBindings,
  readGoogleAccountBindings,
  signOutGoogleAccountsForInstance,
  writeGoogleAccountBindings
} from "../../state/google-account-bindings";
import { now } from "../../state/ids";
import { readOnboarding } from "../../state/onboarding";
import { gwsSessionStatusForDir, invalidateGwsSessionDir, type GwsSessionStatus } from "./gws-session";
import { buildAuthorizedUserCredential } from "./google-oauth-client";

type StatusFetcher = (configDir: string) => Promise<GwsSessionStatus>;

interface AccountDeps {
  statusForDir?: StatusFetcher;
}

// The effective primary account id: the persisted primaryAccountId when it
// still names a registered row (a stale id — e.g. left by an older build or a
// hand-edited registry — is ignored, not healed), else the first registry row.
// Resolved server-side so every surface agrees on which account is primary.
export function effectivePrimaryAccountId(
  accounts: GoogleAccount[] = readGoogleAccounts()
): string | undefined {
  const persisted = readPrimaryGoogleAccountId();
  if (persisted && accounts.some((a) => a.id === persisted)) return persisted;
  return accounts[0]?.id;
}

// List registered accounts joined with live `gws auth status` (one spawn per
// visible config dir, in parallel). Best-effort: a status fetch that rejects
// degrades that account to signedIn:false rather than failing the whole list.
// When an instance is provided, only credentials attached to that instance are
// returned. The machine-global registry remains an implementation detail that
// lets a fresh OAuth login reuse an existing credential without exposing other
// instances' accounts in product surfaces.
export async function listAccountsWithStatus(
  instanceOrDeps?: Instance | AccountDeps,
  maybeDeps: AccountDeps = {}
): Promise<GoogleAccountStatus[]> {
  const instance = typeof instanceOrDeps === "string" ? instanceOrDeps : undefined;
  const deps = typeof instanceOrDeps === "string" ? maybeDeps : (instanceOrDeps ?? {});
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  const accounts = readGoogleAccounts();
  const bindings = instance ? effectiveInstanceBindings(instance, accounts) : undefined;
  const attachedIds = new Set(bindings?.attachedAccountIds ?? []);
  const primaryId = bindings?.primaryAccountId;
  const visibleAccounts = instance
    ? accounts.filter((account) => attachedIds.has(account.id))
    : accounts;
  return Promise.all(
    visibleAccounts.map(async (account) => {
      const instanceFlags = {
        ...(account.id === primaryId ? { primary: true as const } : {}),
        ...(attachedIds.has(account.id) ? { attached: true as const } : {})
      };
      let status: GwsSessionStatus;
      try {
        status = await statusForDir(account.configDir);
      } catch (err) {
        return {
          ...account,
          ...instanceFlags,
          signedIn: false,
          tokenRevoked: false,
          services: {},
          message: err instanceof Error ? err.message : "Failed to read Google sign-in status"
        };
      }
      return {
        ...account,
        ...instanceFlags,
        // A freshly captured email can drift from what was stored (e.g. adopted
        // dir later re-authed as a different user); prefer the live one.
        email: status.email ?? account.email,
        signedIn: status.signedIn,
        tokenRevoked: status.tokenRevoked,
        services: status.services,
        message: status.message
      };
    })
  );
}

// Synchronous instance view for hot paths that do not need a live gws status
// probe (system-prompt assembly and credential activation). Legacy completed
// instances still pass through the same one-time primary migration as the API.
export function googleAccountsForInstance(
  instance: Instance,
  accounts: GoogleAccount[] = readGoogleAccounts()
): GoogleAccount[] {
  const attached = new Set(effectiveInstanceBindings(instance, accounts).attachedAccountIds);
  return accounts.filter((account) => attached.has(account.id));
}

export async function useAccountForInstance(
  instance: Instance,
  accountId: string,
  deps: AccountDeps = {}
): Promise<GoogleAccountStatus> {
  const account = getGoogleAccount(accountId);
  if (!account) throw new Error(`Google account not found: ${accountId}`);
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  const status = await statusForDir(account.configDir);
  if (!status.signedIn) {
    throw new Error(status.message || `Google account ${account.tag} is not signed in`);
  }
  attachGoogleAccountToInstance(instance, { ...account, email: status.email ?? account.email }, { primary: true });
  const [row] = (await listAccountsWithStatus(instance, deps)).filter((candidate) => candidate.id === account.id);
  if (!row) throw new Error(`Google account not found: ${accountId}`);
  return row;
}

export function signOutInstanceGoogleAccounts(instance: Instance): void {
  signOutGoogleAccountsForInstance(instance);
}

export function detachInstanceGoogleAccount(instance: Instance, accountId: string): void {
  detachGoogleAccountFromInstance(instance, accountId);
}

// Disconnect one reusable credential from this instance without deleting it
// from the machine-global registry. The primary is intentionally protected:
// the user must make another attached account primary before disconnecting it.
export function disconnectInstanceGoogleAccount(instance: Instance, accountId: string): void {
  const bindings = effectiveInstanceBindings(instance, readGoogleAccounts());
  if (!bindings.attachedAccountIds.includes(accountId)) {
    throw new Error(`Google account is not connected to this instance: ${accountId}`);
  }
  const primaryId = bindings.primaryAccountId ?? bindings.attachedAccountIds[0];
  if (accountId === primaryId) {
    throw new Error("Primary Google account cannot be disconnected. Make another account primary first.");
  }
  detachGoogleAccountFromInstance(instance, accountId);
}

export function primaryGoogleAccountForInstance(instance: Instance): GoogleAccount | undefined {
  const accounts = readGoogleAccounts();
  const bindings = effectiveInstanceBindings(instance, accounts);
  return bindings.primaryAccountId ? accounts.find((account) => account.id === bindings.primaryAccountId) : undefined;
}

// Register (or refresh) a tagged account for an already-signed-in gws config
// dir. Reads `gws auth status` for the dir to confirm a live session and
// capture the email; throws when not signed in so we never register an empty
// dir. The account id is derived from the config-dir basename when the dir is a
// gini-managed one (under googleAccountsRoot()), so the dir↔id coupling
// configDirForAccount(id) === account.configDir holds and removeAccount cleans
// the dir up. For an adopted dir outside the root (e.g. ~/.config/gws), reuse
// the existing id when a registry entry already points at this configDir, else
// mint a new one.
//
// `tag` is optional: when omitted, a re-register keeps the existing row's tag,
// and a fresh registration derives it from the live session's email local-part
// via uniqueAccountTag — uniquified case-insensitively so a defaulted
// registration can never throw on a collision (an EXPLICIT tag keeps its
// collision error; the caller chose it deliberately).
//
// `email` is a trusted-path backfill: a trusted registration with no stored
// email to keep (fresh mint, or a reused row registered before its email was
// known — listAccountsWithStatus back-fills live emails on reads but never
// persists them) stores the caller's Google-verified email so later
// email-based matching (saveGoogleAccountCredential) sees it. A non-empty stored email
// always wins, and the probed path ignores the field (it captures the live
// email itself).
export async function registerAccount(
  input: { tag?: string; configDir: string; adopt?: boolean; trusted?: boolean; principal?: string; email?: string },
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  // The local OAuth callback has already verified the account with Google.
  // trusted:true lets that path register without a second `gws auth status`
  // probe. The probe stays mandatory for adopt-an-arbitrary-dir callers.
  let email = "";
  if (!input.trusted) {
    const status = await statusForDir(input.configDir);
    if (!status.signedIn) {
      throw new Error(`No signed-in Google session in ${input.configDir}`);
    }
    email = status.email ?? "";
  }
  const existing = readGoogleAccounts().find((a) => a.configDir === input.configDir);
  const tag =
    input.tag ?? existing?.tag ?? uniqueAccountTag(email.split("@")[0]?.trim() || "google");
  const managed = input.configDir.startsWith(googleAccountsRoot());
  const account: GoogleAccount = {
    id: managed ? basename(input.configDir) : existing?.id ?? newAccountId(),
    tag,
    email: input.trusted ? existing?.email || input.email || "" : email,
    configDir: input.configDir,
    addedAt: existing?.addedAt ?? now(),
    // Google's immutable subject id keeps local OAuth refreshes idempotent even
    // when the user retags an account or changes its email address.
    ...(input.principal ?? existing?.principal
      ? { principal: input.principal ?? existing?.principal }
      : {})
  };
  addGoogleAccount(account);
  // A fresh login just changed this dir's session; drop any cached status so the
  // next listAccountsWithStatus reads the new state instead of a stale entry.
  invalidateGwsSessionDir(input.configDir);
  return account;
}

// Register a live credential through an instance-owned HTTP surface and attach
// it to that instance. The first attached row becomes primary; later additions
// preserve the user's existing primary choice.
export async function registerAccountForInstance(
  instance: Instance,
  input: { tag?: string; configDir: string; adopt?: boolean; trusted?: boolean; principal?: string; email?: string },
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const account = await registerAccount(input, deps);
  const hasPrimary = primaryGoogleAccountForInstance(instance) !== undefined;
  attachGoogleAccountToInstance(instance, account, { primary: !hasPrimary });
  return account;
}

// Remove an account from the registry. When its config dir is a gini-managed
// one (under googleAccountsRoot()), best-effort delete that dir too so its
// tokens don't linger. NEVER touches ~/.config/gws (an adopted dir lives
// outside the gini root), so adopting then removing leaves the user's default
// gws session intact.
export function removeAccount(accountId: string): void {
  const account = getGoogleAccount(accountId);
  removeGoogleAccount(accountId);
  if (!account) return;
  // Drop the removed dir's cached status so a later list doesn't resurrect it.
  invalidateGwsSessionDir(account.configDir);
  const managedDir = configDirForAccount(accountId);
  if (account.configDir === managedDir && account.configDir.startsWith(googleAccountsRoot())) {
    try { rmSync(account.configDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function retagAccount(accountId: string, tag: string): void {
  retagGoogleAccount(accountId, tag);
}

export interface SaveGoogleAccountCredentialInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email?: string;
  principal?: string;
  tag?: string;
  // A sign-in-intent OAuth (vs an add-account): the saved/matched
  // account becomes the persisted primary once the provision succeeds.
  makePrimary?: boolean;
  // Runtime instance whose local sign-in binding should be updated. The
  // machine-global registry remains only the reusable credential catalog.
  instance?: Instance;
}

// Persist a Google account completed through the runtime's loopback OAuth
// callback: write the standard authorized_user credentials.json gws reads into
// a managed config dir, then register it as a tagged account. The callback has
// already exchanged Google's authorization code and verified the account, so
// registration is trusted:true (no second gws probe; listAccountsWithStatus
// back-fills live email/liveness).
//
// IDEMPOTENT per identity: re-adding an account rewrites the credential of
// the row it belongs to instead of minting a duplicate. Match order:
//   1. a row with the same immutable `principal` (Google sub), never the
//      mutable tag;
//   2. a row whose STORED email equals input.email case-insensitively;
//   3. among rows with NO stored email, a best-effort live `gws auth status`
//      probe per row matched on the live email (re-finds rows registered
//      before their email was known; bounded to this rare callback path).
// input.email is trustworthy for matching because the loopback callback takes
// it from Google userinfo fetched with the same exchange's access token. On a
// match the credential lands in THAT row's
// configDir, the principal and stored email are backfilled, and the row's tag
// and id are kept. A fresh
// identity mints a new dir and defaults its tag to the email local-part,
// uniquified case-insensitively against the existing tags so registration
// can never throw on a collision.
export async function saveGoogleAccountCredential(
  input: SaveGoogleAccountCredentialInput,
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const existing = await credentialTarget(input, deps.statusForDir ?? gwsSessionStatusForDir);
  const configDir = existing?.configDir ?? configDirForAccount(newAccountId());
  const tag =
    existing?.tag ??
    uniqueAccountTag(input.tag?.trim() || input.email?.split("@")[0]?.trim() || "google");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Atomic write (same-dir temp + rename): on a reused dir a concurrent gws
  // read must never see a half-written credentials.json. The temp is created
  // at 0600 and rename makes the target adopt that mode.
  const path = join(configDir, "credentials.json");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    tmp,
    buildAuthorizedUserCredential(input.refreshToken, {
      clientId: input.clientId,
      clientSecret: input.clientSecret
    }),
    { mode: 0o600 }
  );
  renameSync(tmp, path);
  // An encrypted `gws auth login` credential can outrank credentials.json, so
  // a stale interactive login left in a reused dir would shadow the credential
  // this flow just saved. The fresh consent is authoritative.
  rmSync(join(configDir, "credentials.enc"), { force: true });
  const account = await registerAccount({
    tag,
    configDir,
    trusted: true,
    principal: input.principal,
    email: input.email
  });
  // Only after the credential landed and the row registered: a failed
  // provision must never flip the primary.
  if (input.makePrimary && input.instance) {
    attachGoogleAccountToInstance(input.instance, account, { primary: true });
  } else if (input.makePrimary) {
    // Legacy/test callers without an instance keep the old registry field. The
    // runtime callback always passes an instance.
    setPrimaryGoogleAccountId(account.id);
  } else if (input.instance) {
    attachGoogleAccountToInstance(input.instance, account, { primary: false });
  }
  return account;
}

// The registry row a saved credential should land in (see
// saveGoogleAccountCredential's match
// order), or undefined when the identity is genuinely new.
async function credentialTarget(
  input: SaveGoogleAccountCredentialInput,
  statusForDir: StatusFetcher
): Promise<GoogleAccount | undefined> {
  const accounts = readGoogleAccounts();
  if (input.principal) {
    const byPrincipal = accounts.find((a) => a.principal === input.principal);
    if (byPrincipal) return byPrincipal;
  }
  const email = input.email?.trim().toLowerCase();
  if (!email) return undefined;
  const byStoredEmail = accounts.find((a) => a.email.toLowerCase() === email);
  if (byStoredEmail) return byStoredEmail;
  for (const account of accounts) {
    if (account.email) continue;
    try {
      const status = await statusForDir(account.configDir);
      if (status.email?.trim().toLowerCase() === email) return account;
    } catch {
      // Best-effort: a row whose dir can't be probed simply doesn't match.
    }
  }
  return undefined;
}

function effectiveInstanceBindings(instance: Instance, accounts: GoogleAccount[]) {
  const existing = readGoogleAccountBindings(instance);
  if (existing) {
    const accountIds = new Set(accounts.map((account) => account.id));
    const attachedAccountIds = existing.attachedAccountIds.filter((id) => accountIds.has(id));
    const primaryAccountId =
      existing.primaryAccountId && accountIds.has(existing.primaryAccountId) && attachedAccountIds.includes(existing.primaryAccountId)
        ? existing.primaryAccountId
        : undefined;
    if (
      attachedAccountIds.length !== existing.attachedAccountIds.length ||
      primaryAccountId !== existing.primaryAccountId
    ) {
      writeGoogleAccountBindings(instance, { ...existing, attachedAccountIds, ...(primaryAccountId ? { primaryAccountId } : {}) });
    }
    return getGoogleAccountBindings(instance);
  }

  const onboarding = readOnboarding(instance);
  if (onboarding?.completed) {
    const migratedAt = now();
    const legacyPrimary = effectivePrimaryAccountId(accounts);
    const account = legacyPrimary ? accounts.find((candidate) => candidate.id === legacyPrimary) : undefined;
    if (account) {
      const bindings = attachGoogleAccountToInstance(instance, account, { primary: true });
      writeGoogleAccountBindings(instance, { ...bindings, legacyPrimaryMigratedAt: migratedAt });
      return getGoogleAccountBindings(instance);
    }
    writeGoogleAccountBindings(instance, {
      version: 1,
      attachedAccountIds: [],
      accounts: {},
      legacyPrimaryMigratedAt: migratedAt
    });
    return getGoogleAccountBindings(instance);
  }

  return getGoogleAccountBindings(instance);
}

// First free variant of `base` among the existing tags, case-insensitively:
// "shelden", then "shelden-2", "shelden-3", … (addGoogleAccount throws on a
// case-insensitive collision, so callers that default a tag pick a free one
// up front instead of surfacing that as an error).
function uniqueAccountTag(base: string): string {
  const taken = new Set(readGoogleAccounts().map((a) => a.tag.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`.toLowerCase())) n += 1;
  return `${base}-${n}`;
}
