// Per-instance web-onboarding record (ADR web-onboarding-flow.md).
//
// Owns the low-level persistence of the first-run flow's durable state —
// completion, timezone/theme picks, the Gmail profile scan, and the routine
// job ids — at ~/.gini/instances/<instance>/onboarding.json. Deliberately NOT
// part of state.json: the record is read by the web gate on every page load
// and written from a handful of endpoints, so it gets its own small file with
// the same conventions as the google-accounts registry — atomic temp+rename
// writes, and a read that never throws (missing/corrupt degrades to "no
// record" so the orchestration layer in src/runtime/onboarding.ts decides
// what a first read means). Instance dir resolution goes through
// instanceRoot() like every other instance-scoped state module, so
// GINI_STATE_ROOT overrides work in tests.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { instanceRoot } from "../paths";
import type { Instance, OnboardingRecord } from "../types";

export function onboardingPath(instance: Instance): string {
  return join(instanceRoot(instance), "onboarding.json");
}

export function defaultOnboardingRecord(): OnboardingRecord {
  return { version: 1, completed: false, scan: { status: "idle" }, routineJobIds: [] };
}

// Read the record synchronously. Missing or corrupt file → undefined; never
// throws — the caller (getOnboarding) treats "no record" as first read.
export function readOnboarding(instance: Instance): OnboardingRecord | undefined {
  const path = onboardingPath(instance);
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isOnboardingRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isOnboardingRecord(value: unknown): value is OnboardingRecord {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.completed === "boolean" &&
    !!o.scan &&
    typeof o.scan === "object" &&
    typeof (o.scan as { status?: unknown }).status === "string" &&
    Array.isArray(o.routineJobIds)
  );
}

// Atomic write: temp file in the instance dir, then rename over the target so
// a reader never sees a half-written record (same discipline as
// writeGoogleAccounts / writeState).
export function writeOnboarding(instance: Instance, record: OnboardingRecord): void {
  const root = instanceRoot(instance);
  mkdirSync(root, { recursive: true });
  const path = onboardingPath(instance);
  const tmp = join(root, `onboarding.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}
