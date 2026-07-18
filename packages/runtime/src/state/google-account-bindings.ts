// Per-instance Google account binding state.
//
// The machine-global registry in google-accounts.ts records reusable local gws
// credential dirs. This file records which of those accounts a specific Gini
// instance is signed into. It stores labels and timestamps only; OAuth tokens
// remain in the gws config dirs under ~/.gini/google-accounts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { instanceRoot } from "../paths";
import type { GoogleAccount, GoogleAccountBindings, Instance } from "../types";
import { now } from "./ids";

export function googleAccountBindingsPath(instance: Instance): string {
  return join(instanceRoot(instance), "google-account-bindings.json");
}

export function defaultGoogleAccountBindings(): GoogleAccountBindings {
  return { version: 1, attachedAccountIds: [], accounts: {} };
}

export function readGoogleAccountBindings(instance: Instance): GoogleAccountBindings | undefined {
  const path = googleAccountBindingsPath(instance);
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isGoogleAccountBindings(parsed) ? normalizeBindings(parsed) : undefined;
  } catch {
    return undefined;
  }
}

export function getGoogleAccountBindings(instance: Instance): GoogleAccountBindings {
  return readGoogleAccountBindings(instance) ?? defaultGoogleAccountBindings();
}

export function writeGoogleAccountBindings(instance: Instance, bindings: GoogleAccountBindings): void {
  const root = instanceRoot(instance);
  mkdirSync(root, { recursive: true });
  const path = googleAccountBindingsPath(instance);
  const tmp = join(root, `google-account-bindings.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(normalizeBindings(bindings), null, 2)}\n`);
  renameSync(tmp, path);
}

export function attachGoogleAccountToInstance(
  instance: Instance,
  account: GoogleAccount,
  options: { primary?: boolean } = {}
): GoogleAccountBindings {
  const bindings = getGoogleAccountBindings(instance);
  const stamped = upsertSnapshot(bindings, account, now());
  if (!stamped.attachedAccountIds.includes(account.id)) stamped.attachedAccountIds.push(account.id);
  if (options.primary) stamped.primaryAccountId = account.id;
  writeGoogleAccountBindings(instance, stamped);
  return stamped;
}

export function detachGoogleAccountFromInstance(instance: Instance, accountId: string): GoogleAccountBindings {
  const bindings = getGoogleAccountBindings(instance);
  const timestamp = now();
  const next: GoogleAccountBindings = {
    ...bindings,
    attachedAccountIds: bindings.attachedAccountIds.filter((id) => id !== accountId),
    accounts: { ...bindings.accounts },
    ...(bindings.primaryAccountId === accountId ? {} : { primaryAccountId: bindings.primaryAccountId })
  };
  if (bindings.primaryAccountId === accountId) delete next.primaryAccountId;
  const snapshot = next.accounts[accountId];
  if (snapshot) next.accounts[accountId] = { ...snapshot, lastSignedOutAt: timestamp };
  writeGoogleAccountBindings(instance, next);
  return next;
}

export function signOutGoogleAccountsForInstance(instance: Instance): GoogleAccountBindings {
  const bindings = getGoogleAccountBindings(instance);
  const timestamp = now();
  const signedOut = new Set([
    ...bindings.attachedAccountIds,
    ...(bindings.primaryAccountId ? [bindings.primaryAccountId] : [])
  ]);
  const accounts = { ...bindings.accounts };
  for (const accountId of signedOut) {
    const snapshot = accounts[accountId];
    if (snapshot) accounts[accountId] = { ...snapshot, lastSignedOutAt: timestamp };
  }
  const next: GoogleAccountBindings = {
    version: 1,
    attachedAccountIds: [],
    accounts,
    ...(bindings.legacyPrimaryMigratedAt ? { legacyPrimaryMigratedAt: bindings.legacyPrimaryMigratedAt } : {})
  };
  writeGoogleAccountBindings(instance, next);
  return next;
}

function upsertSnapshot(
  bindings: GoogleAccountBindings,
  account: GoogleAccount,
  timestamp: string
): GoogleAccountBindings {
  const existing = bindings.accounts[account.id];
  return {
    ...bindings,
    attachedAccountIds: [...bindings.attachedAccountIds],
    accounts: {
      ...bindings.accounts,
      [account.id]: {
        id: account.id,
        ...(account.email ? { email: account.email } : existing?.email ? { email: existing.email } : {}),
        ...(account.principal ? { principal: account.principal } : existing?.principal ? { principal: existing.principal } : {}),
        firstSignedInAt: existing?.firstSignedInAt ?? timestamp,
        lastSignedInAt: timestamp,
        ...(existing?.lastSignedOutAt ? { lastSignedOutAt: existing.lastSignedOutAt } : {})
      }
    }
  };
}

function normalizeBindings(bindings: GoogleAccountBindings): GoogleAccountBindings {
  const attachedAccountIds = [...new Set(bindings.attachedAccountIds.filter(Boolean))];
  const accounts = Object.fromEntries(
    Object.entries(bindings.accounts).filter(([id, snapshot]) => {
      return id && snapshot.id === id && typeof snapshot.firstSignedInAt === "string";
    })
  );
  const primaryAccountId =
    bindings.primaryAccountId && attachedAccountIds.includes(bindings.primaryAccountId)
      ? bindings.primaryAccountId
      : undefined;
  return {
    version: 1,
    attachedAccountIds,
    accounts,
    ...(primaryAccountId ? { primaryAccountId } : {}),
    ...(bindings.legacyPrimaryMigratedAt ? { legacyPrimaryMigratedAt: bindings.legacyPrimaryMigratedAt } : {})
  };
}

function isGoogleAccountBindings(value: unknown): value is GoogleAccountBindings {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.attachedAccountIds) || !o.attachedAccountIds.every((id) => typeof id === "string")) return false;
  if (!o.accounts || typeof o.accounts !== "object" || Array.isArray(o.accounts)) return false;
  if (o.primaryAccountId !== undefined && typeof o.primaryAccountId !== "string") return false;
  if (o.legacyPrimaryMigratedAt !== undefined && typeof o.legacyPrimaryMigratedAt !== "string") return false;
  for (const [id, snapshot] of Object.entries(o.accounts as Record<string, unknown>)) {
    if (!snapshot || typeof snapshot !== "object") return false;
    const s = snapshot as Record<string, unknown>;
    if (s.id !== id || typeof s.firstSignedInAt !== "string") return false;
    if (s.email !== undefined && typeof s.email !== "string") return false;
    if (s.principal !== undefined && typeof s.principal !== "string") return false;
    if (s.lastSignedInAt !== undefined && typeof s.lastSignedInAt !== "string") return false;
    if (s.lastSignedOutAt !== undefined && typeof s.lastSignedOutAt !== "string") return false;
  }
  return true;
}
