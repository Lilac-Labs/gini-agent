import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentOwnerToken, _resetOwnerTokenCache } from "./owner-token";

const INSTANCE = "default";
let root: string;
let prevStateRoot: string | undefined;
let prevHosted: string | undefined;

function cfgPath(): string {
  return join(root, "instances", INSTANCE, "config.json");
}
function writeConfig(token: unknown, mtimeSec?: number): void {
  mkdirSync(join(root, "instances", INSTANCE), { recursive: true });
  writeFileSync(cfgPath(), JSON.stringify({ instance: INSTANCE, token }));
  if (mtimeSec !== undefined) utimesSync(cfgPath(), mtimeSec, mtimeSec);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-ownertok-"));
  prevStateRoot = process.env.GINI_STATE_ROOT;
  prevHosted = process.env.GINI_HOSTED;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_HOSTED = "1";
  _resetOwnerTokenCache();
});
afterEach(() => {
  if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevStateRoot;
  if (prevHosted === undefined) delete process.env.GINI_HOSTED;
  else process.env.GINI_HOSTED = prevHosted;
  rmSync(root, { recursive: true, force: true });
});

test("non-hosted mode returns the fallback without reading disk", () => {
  delete process.env.GINI_HOSTED;
  writeConfig("disk-token");
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("cached");
});

test("hosted mode reads the current token from config.json", () => {
  writeConfig("disk-token");
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("disk-token");
});

test("same mtime serves the cached token; a new mtime re-reads the swap", () => {
  writeConfig("first", 1000);
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("first");
  // Swap the content but keep the same mtime → cache hit still returns "first".
  writeFileSync(cfgPath(), JSON.stringify({ token: "second" }));
  utimesSync(cfgPath(), 1000, 1000);
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("first");
  // Bump the mtime (a real identity swap touches the file) → re-read "second".
  utimesSync(cfgPath(), 2000, 2000);
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("second");
});

test("empty or non-string token falls back to the boot token", () => {
  writeConfig("");
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("cached");
  _resetOwnerTokenCache();
  writeConfig(42);
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("cached");
});

test("missing config.json falls back to the boot token", () => {
  expect(currentOwnerToken(INSTANCE, "cached")).toBe("cached");
});
