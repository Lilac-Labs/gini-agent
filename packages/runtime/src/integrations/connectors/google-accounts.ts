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
import { basename, dirname, join } from "node:path";

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
import { now } from "../../state/ids";
import { appendLog } from "../../state/trace";
import { gwsSessionStatusForDir, invalidateGwsSessionDir, type GwsSessionStatus } from "./gws-session";
import { buildAuthorizedUserCredential } from "./relay-workspace-client";

type StatusFetcher = (configDir: string) => Promise<GwsSessionStatus>;

interface AccountDeps {
  statusForDir?: StatusFetcher;
}

// The effective primary account id: the persisted primaryAccountId when it
// still names a registered row (a stale id — e.g. left by an older build or a
// hand-edited registry — is ignored, not healed), else the pre-primary
// heuristic every client used to apply: first provisioned row ?? first row.
// Resolved server-side so every surface agrees on which account is primary.
export function effectivePrimaryAccountId(
  accounts: GoogleAccount[] = readGoogleAccounts()
): string | undefined {
  const persisted = readPrimaryGoogleAccountId();
  if (persisted && accounts.some((a) => a.id === persisted)) return persisted;
  return (accounts.find((a) => a.provisioned) ?? accounts[0])?.id;
}

// List every registered account joined with its live `gws auth status` (one
// spawn per config dir, in parallel). Best-effort: a status fetch that rejects
// degrades that account to signedIn:false rather than failing the whole list.
// Exactly the effective primary row carries `primary: true`.
export async function listAccountsWithStatus(deps: AccountDeps = {}): Promise<GoogleAccountStatus[]> {
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  const accounts = readGoogleAccounts();
  const primaryId = effectivePrimaryAccountId(accounts);
  return Promise.all(
    accounts.map(async (account) => {
      const primary = account.id === primaryId ? { primary: true as const } : {};
      let status: GwsSessionStatus;
      try {
        status = await statusForDir(account.configDir);
      } catch (err) {
        return {
          ...account,
          ...primary,
          signedIn: false,
          tokenRevoked: false,
          services: {},
          message: err instanceof Error ? err.message : "Failed to read Google sign-in status"
        };
      }
      return {
        ...account,
        ...primary,
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
// email-based matching (provisionAccount) sees it. A non-empty stored email
// always wins, and the probed path ignores the field (it captures the live
// email itself).
export async function registerAccount(
  input: { tag?: string; configDir: string; adopt?: boolean; trusted?: boolean; principal?: string; email?: string },
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const statusForDir = deps.statusForDir ?? gwsSessionStatusForDir;
  // A relay-provisioned credential is trustworthy by construction (the relay
  // only issues a refresh token after a completed consent), and gws may not be
  // installed yet at tunnel-connect time. trusted:true registers it without the
  // live `gws auth status` probe; listAccountsWithStatus back-fills the live
  // email/liveness on the next read. The probe stays mandatory for the
  // adopt-an-arbitrary-dir callers, where liveness genuinely must be verified.
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
  const provisioned = input.trusted || existing?.provisioned === true;
  const account: GoogleAccount = {
    id: managed ? basename(input.configDir) : existing?.id ?? newAccountId(),
    tag,
    email: input.trusted ? existing?.email || input.email || "" : email,
    configDir: input.configDir,
    addedAt: existing?.addedAt ?? now(),
    // Relay-provisioned provenance is sticky: once set it stays set, so a later
    // manual re-register of the same dir can't strip it. The grant path re-finds
    // its account by these, not by the mutable tag. `principal` (the relay/Google
    // subject id) keeps distinct identities in separate dirs.
    ...(provisioned ? { provisioned: true } : {}),
    ...(provisioned && (input.principal ?? existing?.principal)
      ? { principal: input.principal ?? existing?.principal }
      : {})
  };
  addGoogleAccount(account);
  // A fresh login just changed this dir's session; drop any cached status so the
  // next listAccountsWithStatus reads the new state instead of a stale entry.
  invalidateGwsSessionDir(input.configDir);
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

// Which add-a-Google-account flow this deployment supports. A hosted guest is
// headless — the gws Desktop-client loopback OAuth can't complete there
// (nothing opens the consent URL, and the localhost redirect resolves to the
// visitor's machine) — so account adds must go through the edge's same-tab
// web-client OAuth ("edge"). Keyed on GINI_HOSTED=1, which the hosted
// provisioner bakes into every guest's env unconditionally (unlike
// GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, which is only present when the login
// granted Workspace scopes — a guest without it still can't do loopback).
export type GoogleAuthMode = "edge" | "loopback";

export function googleAuthMode(): GoogleAuthMode {
  return process.env.GINI_HOSTED === "1" ? "edge" : "loopback";
}

export interface ProvisionAccountInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email?: string;
  principal?: string;
  tag?: string;
  // The hosted edge sign-in re-auth of the guest's OWN primary (vs an
  // add-account of some other mailbox). A hosted guest's gws reads only the
  // baked credential file (GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE pins it
  // regardless of config dir), so a re-auth must overwrite THAT file to heal —
  // which means landing in the boot-registered primary's config dir. A revoked
  // primary can't be matched by principal/email/probe (dead token, no stored
  // identity), so this flag routes the write to the baked-file dir directly.
  primary?: boolean;
  // A sign-in-intent OAuth (vs an add-account): the provisioned/matched
  // account becomes the persisted primary once the provision succeeds.
  // Distinct from `primary` above, which only routes WHERE the credential
  // lands and never touches the persisted primaryAccountId.
  makePrimary?: boolean;
}

// The config dir a hosted guest's baked gws credential lives in — the dir the
// boot-registered primary account owns. undefined off a hosted guest (or when
// the credentials env isn't set), so the primary-heal path is inert anywhere
// the baked-file pinning doesn't apply.
function hostedPrimaryConfigDir(): string | undefined {
  const file = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  return process.env.GINI_HOSTED === "1" && file ? dirname(file) : undefined;
}

// Persist an edge-provisioned Google account: write the standard
// authorized_user credentials.json gws reads into a managed config dir, then
// register it as a tagged account. The hosted edge exchanges the OAuth code
// server-side (web-application client) and POSTs the refresh token here, so
// the credential is trustworthy by construction — registration is trusted:true
// (no gws probe; listAccountsWithStatus back-fills the live email/liveness).
// Mirrors the relay grant path (defaultPersistWorkspaceGrant in
// ../tunnel.ts), with the caller's OAuth client instead of the baked relay one.
//
// IDEMPOTENT per identity: re-adding an account rewrites the credential of
// the row it belongs to instead of minting a duplicate. Match order:
//   1. a provisioned row with the same immutable `principal` (Google sub) —
//      never the mutable tag;
//   2. a row whose STORED email equals input.email case-insensitively;
//   3. among rows with NO stored email, a best-effort live `gws auth status`
//      probe per row matched on the live email (re-finds rows registered
//      before their email was known — e.g. the hosted boot-registered
//      primary; bounded to this rare provision path).
// input.email is trustworthy for matching: both callers (the hosted edge's
// add callback and the loopback web callback) take it from Google userinfo
// fetched with the same exchange's access token, so the user just proved
// ownership of that mailbox. On a match the credential lands in THAT row's
// configDir, the principal is stamped, `provisioned` stays sticky, the
// stored email is backfilled, and the row's tag and id are kept. A fresh
// identity mints a new dir and defaults its tag to the email local-part,
// uniquified case-insensitively against the existing tags so registration
// can never throw on a collision.
export async function provisionAccount(
  input: ProvisionAccountInput,
  deps: AccountDeps = {}
): Promise<GoogleAccount> {
  const existing = await provisionTarget(input, deps.statusForDir ?? gwsSessionStatusForDir);
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
  const account = await registerAccount({
    tag,
    configDir,
    trusted: true,
    principal: input.principal,
    email: input.email
  });
  // Only after the credential landed and the row registered: a failed
  // provision must never flip the primary.
  if (input.makePrimary) setPrimaryGoogleAccountId(account.id);
  return account;
}

// The registry row a provision should land in (see provisionAccount's match
// order), or undefined when the identity is genuinely new.
async function provisionTarget(
  input: ProvisionAccountInput,
  statusForDir: StatusFetcher
): Promise<GoogleAccount | undefined> {
  const accounts = readGoogleAccounts();
  // A primary re-auth heals the baked credential file, so it always lands in the
  // boot-registered primary's config dir (matched by that dir, not by identity —
  // a revoked primary has no live email and the boot registration stored none).
  // Scoped to input.primary so an add-account of a different mailbox never
  // overwrites the primary.
  if (input.primary) {
    const bakedDir = hostedPrimaryConfigDir();
    const primary = bakedDir ? accounts.find((a) => a.configDir === bakedDir) : undefined;
    if (primary) return primary;
  }
  if (input.principal) {
    const byPrincipal = accounts.find((a) => a.provisioned === true && a.principal === input.principal);
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

// Register the credential a hosted guest boots with. The hosted provisioner
// bakes the sign-in's Workspace grant as an authorized_user credentials file and
// points GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE at it, but that file never
// appears in the account registry on its own — so the web's sign-in/accounts
// surfaces would show no account on a fresh guest. Called once at gateway
// boot: registers the file's directory as the trusted "primary" account when
// no registry row points at it yet, and persists it as the primaryAccountId
// only when the field is unset (a user's later sign-in-intent choice must
// survive reboots; a pre-primary-field guest gets the field backfilled on its
// next boot — logged against `instance` when the caller passes one, since the
// already-registered return gives the caller nothing to log). Requires BOTH
// hosted markers (GINI_HOSTED plus the credentials env) so a local machine
// that exports the gws env var for its own use never grows a surprise
// registry row. Returns the account when one was registered, undefined on the
// (normal) no-op paths.
export async function ensureHostedPrimaryAccount(instance?: Instance): Promise<GoogleAccount | undefined> {
  const credentialsFile = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  if (process.env.GINI_HOSTED !== "1" || !credentialsFile) return undefined;
  const configDir = dirname(credentialsFile);
  const existing = readGoogleAccounts().find((a) => a.configDir === configDir);
  const account =
    existing ?? (await registerAccount({ tag: uniqueAccountTag("primary"), configDir, trusted: true }));
  if (!readPrimaryGoogleAccountId()) {
    setPrimaryGoogleAccountId(account.id);
    // A fresh registration is logged by the boot caller; the field backfill on
    // an already-registered row would otherwise be a silent registry write.
    if (existing && instance) {
      appendLog(instance, "google.hosted_primary.primary_backfilled", { id: account.id });
    }
  }
  return existing ? undefined : account;
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
