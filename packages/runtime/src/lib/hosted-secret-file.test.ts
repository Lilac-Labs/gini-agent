import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostedSecretFromFile, _resetHostedSecretCache } from "./hosted-secret-file";

const FILE_ENV = "GINI_ROUTER_KEY_FILE";
let root: string;
let file: string;
let prevHosted: string | undefined;
let prevFileEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-secretfile-"));
  file = join(root, "router-key");
  prevHosted = process.env.GINI_HOSTED;
  prevFileEnv = process.env[FILE_ENV];
  process.env.GINI_HOSTED = "1";
  process.env[FILE_ENV] = file;
  _resetHostedSecretCache();
});
afterEach(() => {
  if (prevHosted === undefined) delete process.env.GINI_HOSTED;
  else process.env.GINI_HOSTED = prevHosted;
  if (prevFileEnv === undefined) delete process.env[FILE_ENV];
  else process.env[FILE_ENV] = prevFileEnv;
  rmSync(root, { recursive: true, force: true });
});

test("non-hosted mode returns the fallback without reading the file", () => {
  delete process.env.GINI_HOSTED;
  writeFileSync(file, "tenant-key");
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("env-key");
});

test("no file env configured returns the fallback", () => {
  delete process.env[FILE_ENV];
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("env-key");
});

test("hosted mode reads the tenant secret from the file (trimmed)", () => {
  writeFileSync(file, "tenant-key\n");
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("tenant-key");
});

test("same mtime serves the cache; a new mtime re-reads the tenant swap", () => {
  writeFileSync(file, "first");
  utimesSync(file, 1000, 1000);
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("first");
  writeFileSync(file, "second");
  utimesSync(file, 1000, 1000); // same mtime → cache hit
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("first");
  utimesSync(file, 2000, 2000); // bumped → re-read
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("second");
});

test("empty file falls back to the env value", () => {
  writeFileSync(file, "   \n");
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("env-key");
});

test("missing file falls back to the env value", () => {
  expect(hostedSecretFromFile(FILE_ENV, "env-key")).toBe("env-key");
});
