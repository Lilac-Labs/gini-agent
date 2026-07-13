// Per-account Gmail label profile (ADR routine-templates-gallery.md).
//
// Owns the low-level persistence of the LLM label-discovery digest — the
// filtering-label rules distilled from a Google account's existing Gmail
// labels — at ~/.gini/google-accounts/<accountId>/label-profile.json,
// inside the account's managed config dir so removeAccount's dir cleanup
// sweeps the profile with the account. Machine-global like the registry
// itself: one discovery serves every instance. Same conventions as
// src/state/google-accounts.ts — atomic temp+rename writes at tight modes
// (the dir also holds the account's OAuth credential), and a read that
// never throws (missing/corrupt degrades to "no profile"). The
// orchestration — running the discovery, staleness, seeding the routine
// settings — lives in src/runtime/label-discovery.ts and
// src/runtime/routine-templates.ts.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configDirForAccount } from "./google-accounts";
import type { RoutineLabelRule } from "../runtime/routine-templates";

export interface GoogleLabelProfile {
  version: 1;
  accountId: string;
  // Lowercased account email, informational (the seeding join keys on
  // accountId); "" when the registry row's email wasn't known yet.
  email: string;
  status: "running" | "ready" | "failed";
  // The digested filtering labels — [] while running, after a failure, and
  // for a mailbox with no human-curated labels (a ready-but-empty profile
  // means "discovered nothing worth seeding", so consumers fall back to the
  // catalog defaults).
  labels: RoutineLabelRule[];
  // The standard catalog label names whose FUNCTION one of the digested
  // labels already serves (validated against the catalog by the digest
  // validator) — the seeding merge suggests the standard set minus these.
  // Absent on pre-coveredStandard profiles and on the no-labels shortcut
  // that never ran the digest: the full standard set is suggested then.
  coveredStandard?: string[];
  // How many user-created labels the mailbox held when the digest ran.
  sourceLabelCount?: number;
  // When the running record was stamped — the staleness key: a discovery
  // orphaned by a process death stays "running" forever, and
  // ensureLabelProfile treats an old startedAt as re-runnable (the
  // failStaleScan idiom from src/runtime/onboarding.ts).
  startedAt?: string;
  generatedAt?: string;
  error?: string;
}

export function labelProfilePath(accountId: string): string {
  return join(configDirForAccount(accountId), "label-profile.json");
}

// Read the profile synchronously. Missing or corrupt file → undefined; never
// throws — this is on the gallery GET path, where a garbled file must
// degrade to "no profile" rather than break the listing.
export function readLabelProfile(accountId: string): GoogleLabelProfile | undefined {
  const path = labelProfilePath(accountId);
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isLabelProfile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLabelProfile(value: unknown): value is GoogleLabelProfile {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.accountId === "string" &&
    typeof o.email === "string" &&
    (o.status === "running" || o.status === "ready" || o.status === "failed") &&
    Array.isArray(o.labels) &&
    o.labels.every(isLabelRule)
  );
}

function isLabelRule(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    o.name.length > 0 &&
    typeof o.color === "string" &&
    typeof o.rule === "string" &&
    typeof o.autoArchive === "boolean"
  );
}

// Atomic write: temp file in the account dir, then rename over the target so
// a reader never sees a half-written profile. The dir is created at 0700 and
// the file at 0600 (mirroring writeGoogleAccounts — the same dir holds the
// account's OAuth credential, so nothing here may loosen it).
export function writeLabelProfile(profile: GoogleLabelProfile): void {
  const dir = configDirForAccount(profile.accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = labelProfilePath(profile.accountId);
  const tmp = join(dir, `label-profile.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort tightening */ }
}
