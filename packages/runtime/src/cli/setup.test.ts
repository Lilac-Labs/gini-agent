// Subprocess tests for `gini setup`. The interactive read-secret path
// requires a real TTY, so these tests exercise only the non-TTY refusal
// and the --non-interactive (--yes) short-circuit. Real prompts are
// validated by manual smoke through the curl|bash installer.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  __testing,
  checkOpenAIKeyStatus,
  hasKeyInSecretsFile,
  readKeyFromSecretsFile,
  writeKeyToSecretsFile,
  type SetupIO
} from "./commands/setup";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");

interface RunOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: "ignore" | "pipe";
  stdinData?: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn("bun", ["run", CLI_PATH, ...opts.args], {
      cwd: PROJECT_ROOT,
      env: opts.env,
      stdio: [opts.stdin ?? "ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (opts.stdin === "pipe" && opts.stdinData !== undefined) {
      child.stdin?.write(opts.stdinData);
      child.stdin?.end();
    }
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function scratch(tag: string): string {
  const dir = `/tmp/gini-setup-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Subprocess tests inherit the developer shell by default. Clear every signal
// the non-interactive provider picker recognizes so a real Anthropic,
// OpenRouter, DeepSeek, AWS, or Codex login cannot make a "no credentials"
// scenario pass accidentally.
function clearAutoConfigCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GINI_LOCAL_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE"
  ]) {
    delete env[key];
  }
  env.CODEX_AUTH_JSON = join(env.HOME ?? "/tmp", "missing-codex-auth.json");
}

describe("gini setup", () => {
  test("--non-interactive without provider configured and no credentials exits 1", async () => {
    const stateRoot = scratch("no-key");
    const home = scratch("no-key-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    clearAutoConfigCredentials(env);
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
  }, 30_000);

  test("--non-interactive with OPENAI_API_KEY in env and provider preconfigured exits 0", async () => {
    const stateRoot = scratch("preconfigured");
    const home = scratch("preconfigured-home");
    const instance = "dev";
    const instanceDir = join(stateRoot, "instances", instance);
    mkdirSync(instanceDir, { recursive: true });
    const seedConfig = {
      instance,
      port: 7337,
      token: "test-token",
      provider: {
        name: "openai",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY"
      },
      workspaceRoot: join(instanceDir, "workspace"),
      stateRoot: instanceDir,
      logRoot: join(instanceDir, "logs")
    };
    writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(seedConfig, null, 2)}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-test"
    };
    delete env.CODEX_AUTH_JSON;
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--non-interactive", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already configured");
    expect(result.stdout).toContain("Done.");
  }, 30_000);

  test("--non-interactive with fresh config and OPENAI_API_KEY in env auto-configures openai", async () => {
    const stateRoot = scratch("fresh-yes");
    const home = scratch("fresh-yes-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-test-fresh-123"
    };
    delete env.CODEX_AUTH_JSON;
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Auto-configured");
    expect(result.stdout).toContain("openai");
    const configPath = join(stateRoot, "instances", instance, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { provider?: { name?: string; model?: string } };
    expect(config.provider?.name).toBe("openai");
    expect(config.provider?.model).toBe("gpt-5.4-mini");
    // The non-interactive flow persists the env key to secrets.env with
    // mode 0600 so future shells (loading via the wrapper) pick it up.
    const secretsPath = join(home, ".gini", "secrets.env");
    expect(existsSync(secretsPath)).toBe(true);
    const mode = statSync(secretsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  test("--non-interactive with fresh config and NO OPENAI_API_KEY exits 1 with helpful message", async () => {
    const stateRoot = scratch("fresh-yes-nokey");
    const home = scratch("fresh-yes-nokey-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    clearAutoConfigCredentials(env);
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    // No stack trace in user-facing output.
    expect(result.stderr).not.toContain("    at ");
    // Config should NOT have been mutated to openai.
    const configPath = join(stateRoot, "instances", instance, "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { provider?: { name?: string } };
      expect(config.provider?.name).not.toBe("openai");
    }
  }, 30_000);

  test("--non-interactive chmods a pre-existing 0644 secrets.env to 0600", async () => {
    const stateRoot = scratch("chmod-fix");
    const home = scratch("chmod-fix-home");
    const instance = "dev";
    const giniDir = join(home, ".gini");
    mkdirSync(giniDir, { recursive: true });
    const secretsPath = join(giniDir, "secrets.env");
    writeFileSync(secretsPath, "");
    chmodSync(secretsPath, 0o644);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      OPENAI_API_KEY: "sk-chmod-test"
    };
    delete env.CODEX_AUTH_JSON;
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const mode = statSync(secretsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 30_000);

  test("non-TTY without --yes refuses", async () => {
    const stateRoot = scratch("no-tty");
    const home = scratch("no-tty-home");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      HOME: home
    };
    clearAutoConfigCredentials(env);
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--state-root", stateRoot],
      env,
      stdin: "pipe",
      stdinData: ""
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to run interactively without a TTY");
    void existsSync(stateRoot);
  }, 30_000);
});

describe("secrets.env helpers (direct)", () => {
  function withHome<T>(fn: (home: string) => T): T {
    const home = scratch("secrets-direct-home");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      return fn(home);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  }

  test("key with $, \", backtick characters round-trips identically", () => {
    withHome((home) => {
      const original = `sk-test"with$dollar\`and\\backslash`;
      writeKeyToSecretsFile("OPENAI_API_KEY", original);
      const readBack = readKeyFromSecretsFile("OPENAI_API_KEY");
      expect(readBack).toBe(original);
      // Permissions should be tightened on every touch.
      const path = join(home, ".gini", "secrets.env");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  test("key with embedded single quote round-trips identically", () => {
    withHome(() => {
      const original = `sk-key'with'singles`;
      writeKeyToSecretsFile("OPENAI_API_KEY", original);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBe(original);
    });
  });

  test("empty value: OPENAI_API_KEY=\"\" → hasKeyInSecretsFile returns false", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `export OPENAI_API_KEY=""\n`, { mode: 0o600 });
      expect(hasKeyInSecretsFile("OPENAI_API_KEY")).toBe(false);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBeNull();
    });
  });

  test("bare form OPENAI_API_KEY=value (no export) is accepted", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `OPENAI_API_KEY=sk-bare-form\n`, { mode: 0o600 });
      expect(hasKeyInSecretsFile("OPENAI_API_KEY")).toBe(true);
      expect(readKeyFromSecretsFile("OPENAI_API_KEY")).toBe("sk-bare-form");
    });
  });

  test("checkOpenAIKeyStatus reports env source when env is set", () => {
    withHome(() => {
      const old = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-from-env";
      try {
        const status = checkOpenAIKeyStatus();
        expect(status.source).toBe("env");
        expect(status.value).toBe("sk-from-env");
      } finally {
        if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
      }
    });
  });

  test("checkOpenAIKeyStatus reports missing when neither env nor file has a value", () => {
    withHome(() => {
      const old = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        expect(checkOpenAIKeyStatus().source).toBe("missing");
      } finally {
        if (old !== undefined) process.env.OPENAI_API_KEY = old;
      }
    });
  });

  test("chmods pre-existing 0644 secrets.env to 0600 on read", () => {
    withHome((home) => {
      const path = join(home, ".gini", "secrets.env");
      mkdirSync(join(home, ".gini"), { recursive: true });
      writeFileSync(path, `export OPENAI_API_KEY='sk-loose'\n`);
      chmodSync(path, 0o644);
      // Reading should tighten perms.
      readKeyFromSecretsFile("OPENAI_API_KEY");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});

describe("codexProvider.checkCredentials (direct)", () => {
  function withCodexEnv<T>(home: string, env: { CODEX_AUTH_JSON?: string }, fn: () => T): T {
    const oldHome = process.env.HOME;
    const oldEnv = process.env.CODEX_AUTH_JSON;
    process.env.HOME = home;
    if (env.CODEX_AUTH_JSON === undefined) {
      delete process.env.CODEX_AUTH_JSON;
    } else {
      process.env.CODEX_AUTH_JSON = env.CODEX_AUTH_JSON;
    }
    try {
      return fn();
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldEnv === undefined) delete process.env.CODEX_AUTH_JSON; else process.env.CODEX_AUTH_JSON = oldEnv;
    }
  }

  test("no env and no file → returns missing", () => {
    const home = scratch("codex-direct-missing");
    // node:os homedir() ignores process.env.HOME mutations after process
    // start in Bun, so swapping HOME alone won't isolate this test from a
    // real ~/.codex/auth.json on the dev machine. Point CODEX_AUTH_JSON at
    // a sandboxed non-existent path so the helper resolves into the test
    // sandbox instead.
    withCodexEnv(home, { CODEX_AUTH_JSON: join(home, "no-such-auth.json") }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });

  test("CODEX_AUTH_JSON points at a usable auth file → returns env", () => {
    const home = scratch("codex-direct-env");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    withCodexEnv(home, { CODEX_AUTH_JSON: authPath }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(true);
      expect(status.source).toBe("env");
    });
  });

  test("CODEX_AUTH_JSON points at a usable auth file (tokens.access_token form) → returns env", () => {
    const home = scratch("codex-direct-env-token");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "tok-abc" } }));
    withCodexEnv(home, { CODEX_AUTH_JSON: authPath }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(true);
      expect(status.source).toBe("env");
    });
  });

  test("CODEX_AUTH_JSON points at a file with no credentials → returns missing", () => {
    const home = scratch("codex-direct-empty");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, "{}");
    withCodexEnv(home, { CODEX_AUTH_JSON: authPath }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });

  test("CODEX_AUTH_JSON points at a file with invalid JSON → returns missing", () => {
    const home = scratch("codex-direct-invalid-env");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, "not json {");
    withCodexEnv(home, { CODEX_AUTH_JSON: authPath }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });

  test("CODEX_AUTH_JSON points at a non-existent path → returns missing", () => {
    const home = scratch("codex-direct-missing-path");
    withCodexEnv(home, { CODEX_AUTH_JSON: join(home, "no-such-auth.json") }, () => {
      const status = __testing.codexProvider.checkCredentials();
      expect(status.available).toBe(false);
      expect(status.source).toBe("missing");
    });
  });
});

describe("runCodexLogin (direct)", () => {
  // The spawn is injected so no real codex CLI ever launches (the real one
  // would start an interactive OAuth flow and hang the suite). Only the
  // fields runCodexLogin reads are modeled.
  type SpawnSyncResult = { error?: NodeJS.ErrnoException; status?: number | null };

  function fakeSpawn(result: SpawnSyncResult): {
    calls: Array<{ cmd: string; args: readonly string[] }>;
    spawn: Parameters<typeof __testing.runCodexLogin>[1];
  } {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawn = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return result;
    }) as unknown as Parameters<typeof __testing.runCodexLogin>[1];
    return { calls, spawn };
  }

  function stubIo(errors: string[]): SetupIO {
    return {
      select: async <T,>(_prompt: string, choices: { label: string; value: T }[]) => choices[0]!.value,
      prompt: async () => "",
      secret: async () => "",
      info: () => {},
      success: () => {},
      error: (msg: string) => { errors.push(msg); },
      isNonInteractive: false
    };
  }

  test("spawns the `codex login` subcommand, not a --login flag", () => {
    // The codex CLI has no `--login` flag — login is a subcommand, so the
    // spawned argv must be exactly ["login"] or the setup option is broken.
    const errors: string[] = [];
    const { calls, spawn } = fakeSpawn({ status: 0 });
    expect(__testing.runCodexLogin(stubIo(errors), spawn)).toBe(true);
    expect(calls).toEqual([{ cmd: "codex", args: ["login"] }]);
    expect(errors).toEqual([]);
  });

  test("missing codex binary (ENOENT) → install hint citing codex login", () => {
    const errors: string[] = [];
    const enoent = Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" });
    const { spawn } = fakeSpawn({ error: enoent });
    expect(__testing.runCodexLogin(stubIo(errors), spawn)).toBe(false);
    expect(errors.join("\n")).toContain("codex CLI not found");
    expect(errors.join("\n")).toContain("codex login");
    expect(errors.join("\n")).not.toContain("--login");
  });

  test("other spawn error → failure message naming codex login", () => {
    const errors: string[] = [];
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("EACCES boom"), { code: "EACCES" }) });
    expect(__testing.runCodexLogin(stubIo(errors), spawn)).toBe(false);
    expect(errors.join("\n")).toContain("Failed to run codex login");
  });

  test("non-zero exit status → failure message with the status", () => {
    const errors: string[] = [];
    const { spawn } = fakeSpawn({ status: 3 });
    expect(__testing.runCodexLogin(stubIo(errors), spawn)).toBe(false);
    expect(errors.join("\n")).toContain("codex login exited with status 3");
  });
});

describe("gini setup --yes codex precedence", () => {
  test("CODEX_AUTH_JSON set and fresh config → lands on codex with default model", async () => {
    // Platform default is codex/gpt-5.5, and CODEX_AUTH_JSON satisfies the
    // credential check, so `gini setup --yes` reports the codex provider
    // step as already configured and leaves the config pointing at codex.
    const stateRoot = scratch("codex-yes");
    const home = scratch("codex-yes-home");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      CODEX_AUTH_JSON: authPath
    };
    delete env.OPENAI_API_KEY;
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const cfgPath = join(stateRoot, "instances", instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: { name?: string; model?: string } };
    expect(cfg.provider?.name).toBe("codex");
    expect(cfg.provider?.model).toBe("gpt-5.5");
  }, 30_000);

  test("CODEX_AUTH_JSON and OPENAI_API_KEY both set → picks codex (precedence)", async () => {
    const stateRoot = scratch("codex-precedence");
    const home = scratch("codex-precedence-home");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      CODEX_AUTH_JSON: authPath,
      OPENAI_API_KEY: "sk-also-set"
    };
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    const cfgPath = join(stateRoot, "instances", instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: { name?: string } };
    expect(cfg.provider?.name).toBe("codex");
  }, 30_000);

  test("neither CODEX_AUTH_JSON nor OPENAI_API_KEY set → exits 1 naming all three sources", async () => {
    const stateRoot = scratch("codex-none");
    const home = scratch("codex-none-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home
    };
    clearAutoConfigCredentials(env);
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain("CODEX_AUTH_JSON");
    expect(result.stderr).toContain("~/.codex/auth.json");
  }, 30_000);

  test("only ANTHROPIC_API_KEY set → auto-configures anthropic (not just openai/codex)", async () => {
    const stateRoot = scratch("anthropic-yes");
    const home = scratch("anthropic-yes-home");
    const instance = "dev";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GINI_STATE_ROOT: stateRoot,
      GINI_INSTANCE: instance,
      HOME: home,
      ANTHROPIC_API_KEY: "sk-ant-test"
    };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_AUTH_JSON;
    delete env.GINI_PROVIDER;
    delete env.GINI_MODEL;
    const result = await runCli({
      args: ["setup", "--yes", "--state-root", stateRoot, "--instance", instance],
      env
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("anthropic");
    const cfg = JSON.parse(readFileSync(join(stateRoot, "instances", instance, "config.json"), "utf8")) as { provider?: { name?: string; model?: string } };
    expect(cfg.provider?.name).toBe("anthropic");
    expect(cfg.provider?.model).toBe("claude-opus-4-8");
  }, 30_000);
});

// Drive the interactive picker through a scripted SetupIO (the same approach
// the runCodexLogin tests use), since the real prompt requires a TTY the
// subprocess path refuses. Verifies every provider kind configures correctly.
describe("gini setup interactive picker (scripted IO)", () => {
  const { providerStep } = require("./commands/setup") as typeof import("./commands/setup");

  // Build a SetupIO that answers select() by matching a predicate over the
  // prompt, prompt()/secret() by substring of the question, with recorded
  // success/error lines for assertions.
  function scriptedIo(opts: {
    pickProviderId: string;
    answers?: Record<string, string>;
    secret?: string;
    selectFor?: (prompt: string, choices: { label: string; value: unknown }[]) => unknown | undefined;
  }): SetupIO & { successes: string[]; errors: string[] } {
    const successes: string[] = [];
    const errors: string[] = [];
    return {
      isNonInteractive: false,
      successes,
      errors,
      async select<T>(prompt: string, choices: { label: string; value: T }[], def = 0): Promise<T> {
        if (prompt.startsWith("Select provider")) {
          return choices.find((c) => (c.value as unknown) === opts.pickProviderId)!.value;
        }
        const custom = opts.selectFor?.(prompt, choices as { label: string; value: unknown }[]);
        if (custom !== undefined) return custom as T;
        return choices[def]!.value;
      },
      async prompt(question: string, dflt?: string): Promise<string> {
        for (const [key, val] of Object.entries(opts.answers ?? {})) {
          if (question.includes(key)) return val;
        }
        return dflt ?? "";
      },
      async secret(): Promise<string> {
        return opts.secret ?? "";
      },
      info() {},
      success(m: string) { successes.push(m); },
      error(m: string) { errors.push(m); }
    };
  }

  function freshConfig(): RuntimeConfigShape {
    // A minimal fresh config: no provider set yet.
    return { instance: "dev" } as RuntimeConfigShape;
  }
  type RuntimeConfigShape = Parameters<typeof providerStep.run>[0];

  // Isolate HOME (so secrets.env writes land in a scratch dir, not the real
  // ~/.gini) AND GINI_STATE_ROOT (so writeRuntimeConfig's config path resolves
  // under the scratch tree); pre-create the instance dir the atomic write needs.
  async function withScratchHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
    const home = scratch("picker-home");
    const stateRoot = scratch("picker-state");
    mkdirSync(join(stateRoot, "instances", "dev"), { recursive: true });
    const oldHome = process.env.HOME;
    const oldStateRoot = process.env.GINI_STATE_ROOT;
    process.env.HOME = home;
    process.env.GINI_STATE_ROOT = stateRoot;
    try {
      return await fn(home);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldStateRoot === undefined) delete process.env.GINI_STATE_ROOT; else process.env.GINI_STATE_ROOT = oldStateRoot;
    }
  }

  test("picker offers all eight providers in display order", () => {
    expect(__testing.PROVIDERS.map((p) => p.id)).toEqual([
      "openai", "codex", "anthropic", "bedrock", "azure", "openrouter", "deepseek", "local"
    ]);
  });

  test("api-key provider (deepseek): prompts for key, saves it, sets provider", async () => {
    await withScratchHome(async () => {
      const old = process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        const io = scriptedIo({ pickProviderId: "deepseek", secret: "sk-deepseek-xyz" });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("deepseek");
        expect(config.provider?.model).toBe("deepseek-v4-flash");
        expect(config.provider?.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
        expect(readKeyFromSecretsFile("DEEPSEEK_API_KEY")).toBe("sk-deepseek-xyz");
      } finally {
        if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
      }
    });
  });

  test("azure: captures endpoint, deployment, api-version, and auth scheme", async () => {
    await withScratchHome(async () => {
      const old = process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_API_KEY;
      try {
        const io = scriptedIo({
          pickProviderId: "azure",
          secret: "azkey-123",
          answers: {
            "Azure resource endpoint": "https://myres.openai.azure.com",
            "Deployment name": "my-deploy",
            "API version": "2024-10-21"
          },
          selectFor: (prompt, choices) => (prompt.startsWith("Auth scheme") ? choices[0]!.value : undefined)
        });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("azure");
        expect(config.provider?.baseUrl).toBe("https://myres.openai.azure.com");
        expect(config.provider?.deployment).toBe("my-deploy");
        expect(config.provider?.apiVersion).toBe("2024-10-21");
        expect(config.provider?.authScheme).toBe("api-key");
        expect(readKeyFromSecretsFile("AZURE_OPENAI_API_KEY")).toBe("azkey-123");
      } finally {
        if (old === undefined) delete process.env.AZURE_OPENAI_API_KEY; else process.env.AZURE_OPENAI_API_KEY = old;
      }
    });
  });

  test("azure: blank endpoint aborts without setting the provider", async () => {
    await withScratchHome(async () => {
      const old = process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_API_KEY;
      try {
        const io = scriptedIo({ pickProviderId: "azure", secret: "azkey-123", answers: { "Azure resource endpoint": "" } });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).not.toBe("azure");
        expect(io.errors.join("\n")).toContain("Azure requires a resource endpoint");
      } finally {
        if (old === undefined) delete process.env.AZURE_OPENAI_API_KEY; else process.env.AZURE_OPENAI_API_KEY = old;
      }
    });
  });

  test("azure: non-https endpoint aborts", async () => {
    await withScratchHome(async () => {
      const old = process.env.AZURE_OPENAI_API_KEY;
      delete process.env.AZURE_OPENAI_API_KEY;
      try {
        const io = scriptedIo({ pickProviderId: "azure", secret: "azkey-123", answers: { "Azure resource endpoint": "http://insecure.example.com" } });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).not.toBe("azure");
        expect(io.errors.join("\n")).toContain("https://");
      } finally {
        if (old === undefined) delete process.env.AZURE_OPENAI_API_KEY; else process.env.AZURE_OPENAI_API_KEY = old;
      }
    });
  });

  test("local: captures base URL and saves an optional key", async () => {
    await withScratchHome(async () => {
      const old = process.env.GINI_LOCAL_API_KEY;
      delete process.env.GINI_LOCAL_API_KEY;
      try {
        const io = scriptedIo({
          pickProviderId: "local",
          secret: "local-secret",
          answers: { "Local server base URL": "http://localhost:1234/v1" }
        });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("local");
        expect(config.provider?.baseUrl).toBe("http://localhost:1234/v1");
        expect(readKeyFromSecretsFile("GINI_LOCAL_API_KEY")).toBe("local-secret");
      } finally {
        if (old === undefined) delete process.env.GINI_LOCAL_API_KEY; else process.env.GINI_LOCAL_API_KEY = old;
      }
    });
  });

  test("local: no key entered → no-auth gateway, base URL still set", async () => {
    await withScratchHome(async () => {
      const old = process.env.GINI_LOCAL_API_KEY;
      delete process.env.GINI_LOCAL_API_KEY;
      try {
        const io = scriptedIo({ pickProviderId: "local", secret: "", answers: { "Local server base URL": "http://127.0.0.1:11434/v1" } });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("local");
        expect(config.provider?.baseUrl).toBe("http://127.0.0.1:11434/v1");
        expect(hasKeyInSecretsFile("GINI_LOCAL_API_KEY")).toBe(false);
      } finally {
        if (old === undefined) delete process.env.GINI_LOCAL_API_KEY; else process.env.GINI_LOCAL_API_KEY = old;
      }
    });
  });

  test("api-key provider with key already in env: reuses it without prompting", async () => {
    await withScratchHome(async () => {
      const old = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-or-fromenv";
      try {
        // secret() returns "" — if it were called the flow would abort, so a
        // successful set proves the env key was reused without a prompt.
        const io = scriptedIo({ pickProviderId: "openrouter", secret: "" });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("openrouter");
        expect(readKeyFromSecretsFile("OPENROUTER_API_KEY")).toBe("sk-or-fromenv");
      } finally {
        if (old === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = old;
      }
    });
  });

  test("api-key provider: empty key entry aborts without setting the provider", async () => {
    await withScratchHome(async () => {
      const old = process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
      try {
        const io = scriptedIo({ pickProviderId: "deepseek", secret: "" });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).not.toBe("deepseek");
        expect(io.errors.join("\n")).toContain("No API key entered");
      } finally {
        if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old;
      }
    });
  });

  test("bedrock: with AWS keys already in env, captures region and persists the env keys to secrets.env", async () => {
    await withScratchHome(async () => {
      const saved = {
        id: process.env.AWS_ACCESS_KEY_ID,
        secret: process.env.AWS_SECRET_ACCESS_KEY,
        profile: process.env.AWS_PROFILE,
        file: process.env.AWS_SHARED_CREDENTIALS_FILE
      };
      try {
        delete process.env.AWS_PROFILE;
        process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
        process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTEST";
        process.env.AWS_SECRET_ACCESS_KEY = "secret/value";
        const io = scriptedIo({ pickProviderId: "bedrock", answers: { "AWS region": "us-west-2" } });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("bedrock");
        expect(config.provider?.awsRegion).toBe("us-west-2");
        // Keys present only in the live shell env get persisted to secrets.env so
        // a later launchd respawn (which re-sources secrets.env) keeps signing.
        expect(readKeyFromSecretsFile("AWS_ACCESS_KEY_ID")).toBe("AKIATESTTESTTEST");
        expect(readKeyFromSecretsFile("AWS_SECRET_ACCESS_KEY")).toBe("secret/value");
      } finally {
        for (const [k, v] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.secret], ["AWS_PROFILE", saved.profile], ["AWS_SHARED_CREDENTIALS_FILE", saved.file]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });

  test("bedrock: with no env keys, prompts for and saves the AWS access key + secret", async () => {
    await withScratchHome(async () => {
      const saved = {
        id: process.env.AWS_ACCESS_KEY_ID,
        secret: process.env.AWS_SECRET_ACCESS_KEY,
        profile: process.env.AWS_PROFILE,
        file: process.env.AWS_SHARED_CREDENTIALS_FILE
      };
      try {
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_PROFILE;
        process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
        const io = scriptedIo({
          pickProviderId: "bedrock",
          answers: { "AWS Access Key ID": "AKIATESTTESTTEST", "AWS region": "us-west-2" },
          secret: "wJalrXUtnFEMIsecret"
        });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).toBe("bedrock");
        expect(config.provider?.awsRegion).toBe("us-west-2");
        // Keys written to the scratch secrets.env under the standard AWS_* names.
        expect(readKeyFromSecretsFile("AWS_ACCESS_KEY_ID")).toBe("AKIATESTTESTTEST");
        expect(readKeyFromSecretsFile("AWS_SECRET_ACCESS_KEY")).toBe("wJalrXUtnFEMIsecret");
      } finally {
        for (const [k, v] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.secret], ["AWS_PROFILE", saved.profile], ["AWS_SHARED_CREDENTIALS_FILE", saved.file]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });

  test("bedrock: with no env keys and no access key entered, aborts", async () => {
    await withScratchHome(async () => {
      const saved = {
        id: process.env.AWS_ACCESS_KEY_ID,
        secret: process.env.AWS_SECRET_ACCESS_KEY,
        profile: process.env.AWS_PROFILE,
        file: process.env.AWS_SHARED_CREDENTIALS_FILE
      };
      try {
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_PROFILE;
        process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
        // No "AWS Access Key ID" answer → the prompt returns "" → abort.
        const io = scriptedIo({ pickProviderId: "bedrock" });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).not.toBe("bedrock");
        expect(io.errors.join("\n")).toContain("No AWS Access Key ID entered");
      } finally {
        for (const [k, v] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.secret], ["AWS_PROFILE", saved.profile], ["AWS_SHARED_CREDENTIALS_FILE", saved.file]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });

  test("bedrock: access key entered but secret left blank, aborts", async () => {
    await withScratchHome(async () => {
      const saved = {
        id: process.env.AWS_ACCESS_KEY_ID,
        secret: process.env.AWS_SECRET_ACCESS_KEY,
        profile: process.env.AWS_PROFILE,
        file: process.env.AWS_SHARED_CREDENTIALS_FILE
      };
      try {
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_PROFILE;
        process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
        // Access key answered, but secret() returns "" (no `secret` opt) → abort.
        const io = scriptedIo({ pickProviderId: "bedrock", answers: { "AWS Access Key ID": "AKIATESTTESTTEST" } });
        const config = freshConfig();
        await providerStep.run(config, io);
        expect(config.provider?.name).not.toBe("bedrock");
        expect(io.errors.join("\n")).toContain("No AWS Secret Access Key entered");
      } finally {
        for (const [k, v] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.secret], ["AWS_PROFILE", saved.profile], ["AWS_SHARED_CREDENTIALS_FILE", saved.file]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });
});

// Drive runConfiguredFlow: when the current provider is already configured the
// step offers keep / update-credentials / change-model / switch / cancel.
describe("gini setup configured-provider flow (scripted IO)", () => {
  const { providerStep } = require("./commands/setup") as typeof import("./commands/setup");

  function ioChoosing(action: string, over: Partial<SetupIO> = {}): SetupIO & { successes: string[] } {
    const successes: string[] = [];
    return {
      isNonInteractive: false,
      successes,
      select: async <T,>(prompt: string, choices: { label: string; value: T }[], def = 0) => {
        const hit = choices.find((c) => (c.value as unknown) === action);
        if (prompt.startsWith("What would you like to do") && hit) return hit.value;
        return choices[def]!.value;
      },
      prompt: async (_q: string, dflt?: string) => dflt ?? "",
      secret: async () => "",
      info() {},
      success(m: string) { successes.push(m); },
      error() {},
      ...over
    } as SetupIO & { successes: string[] };
  }

  async function withConfiguredOpenAI<T>(fn: () => T | Promise<T>): Promise<T> {
    const home = scratch("configured-home");
    const stateRoot = scratch("configured-state");
    mkdirSync(join(stateRoot, "instances", "dev"), { recursive: true });
    const oldHome = process.env.HOME;
    const oldRoot = process.env.GINI_STATE_ROOT;
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.HOME = home;
    process.env.GINI_STATE_ROOT = stateRoot;
    process.env.OPENAI_API_KEY = "sk-configured";
    try {
      // Must AWAIT so env stays overridden through the async config write —
      // restoring in finally before the promise settles would strip
      // GINI_STATE_ROOT mid-write and send the config to the real ~/.gini.
      return await fn();
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldRoot === undefined) delete process.env.GINI_STATE_ROOT; else process.env.GINI_STATE_ROOT = oldRoot;
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    }
  }

  test("keep: leaves the configured provider unchanged", async () => {
    await withConfiguredOpenAI(async () => {
      const io = ioChoosing("keep");
      const config = { instance: "dev", provider: { name: "openai", model: "gpt-5.4-mini" } } as Parameters<typeof providerStep.run>[0];
      await providerStep.run(config, io);
      expect(io.successes.join("\n")).toContain("Kept current configuration");
      expect(config.provider?.name).toBe("openai");
    });
  });

  test("change model: updates the model to an explicit pick", async () => {
    await withConfiguredOpenAI(async () => {
      // First select() answers the action menu ("Change model"); the second is
      // the model picker — answer it by choosing a concrete model id so the
      // flow persists rather than taking the default "Skip".
      let selectCalls = 0;
      const io = ioChoosing("model", {
        select: async <T,>(prompt: string, choices: { label: string; value: T }[], def = 0) => {
          selectCalls += 1;
          if (prompt.startsWith("What would you like to do")) {
            return choices.find((c) => (c.value as unknown) === "model")!.value;
          }
          // Model picker: pick gpt-5.4 explicitly (not the skip sentinel).
          const pick = choices.find((c) => (c.value as unknown) === "gpt-5.4");
          return (pick ?? choices[def]!).value;
        }
      });
      const config = { instance: "dev", provider: { name: "openai", model: "gpt-5.4-mini" } } as Parameters<typeof providerStep.run>[0];
      await providerStep.run(config, io);
      expect(selectCalls).toBeGreaterThanOrEqual(2);
      expect(config.provider?.name).toBe("openai");
      expect(config.provider?.model).toBe("gpt-5.4");
      expect(io.successes.join("\n")).toContain("Provider set to openai (gpt-5.4)");
    });
  });
});

// Drive runNonInteractive in-process (isNonInteractive: true) so the
// generalized auto-config loop and describeCredentialSource are exercised
// directly (the subprocess tests above cover the wiring; these cover the
// branch matrix without spawning a CLI per case).
describe("gini setup non-interactive (in-process)", () => {
  const { providerStep } = require("./commands/setup") as typeof import("./commands/setup");

  function nonInteractiveIo(): SetupIO & { successes: string[] } {
    const successes: string[] = [];
    return {
      isNonInteractive: true,
      successes,
      select: async <T,>(_p: string, choices: { label: string; value: T }[], def = 0) => choices[def]!.value,
      prompt: async (_q: string, dflt?: string) => dflt ?? "",
      secret: async () => "",
      info() {},
      success(m: string) { successes.push(m); },
      error() {}
    };
  }

  async function withIsolatedEnv<T>(envOverrides: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
    const home = scratch("noninteractive-home");
    const stateRoot = scratch("noninteractive-state");
    mkdirSync(join(stateRoot, "instances", "dev"), { recursive: true });
    // Clear every credential signal first so the host environment can't leak in.
    const keys = [
      "HOME", "GINI_STATE_ROOT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY", "AZURE_OPENAI_API_KEY", "GINI_LOCAL_API_KEY", "CODEX_AUTH_JSON",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE"
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.HOME = home;
    process.env.GINI_STATE_ROOT = stateRoot;
    // Point AWS shared-credentials file at nothing so a real ~/.aws can't leak.
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
    // codex resolves ~/.codex/auth.json via os.homedir() (the OS user database,
    // NOT the HOME env var), so a real ~/.codex/auth.json on the test machine
    // would leak in and always win precedence. CODEX_AUTH_JSON is checked first
    // and DOES honor the env var, so point it at a non-existent path to force
    // codex "unconfigured" unless a test explicitly overrides it.
    process.env.CODEX_AUTH_JSON = "/nonexistent/codex/auth.json";
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  test("only ANTHROPIC_API_KEY in env → auto-configures anthropic and persists the key", async () => {
    await withIsolatedEnv({ ANTHROPIC_API_KEY: "sk-ant-xyz" }, async () => {
      const io = nonInteractiveIo();
      const config = { instance: "dev" } as Parameters<typeof providerStep.run>[0];
      await providerStep.run(config, io);
      expect(config.provider?.name).toBe("anthropic");
      expect(io.successes.join("\n")).toContain("anthropic");
      expect(io.successes.join("\n")).toContain("key from env");
      expect(readKeyFromSecretsFile("ANTHROPIC_API_KEY")).toBe("sk-ant-xyz");
    });
  });

  test("only AWS keys → auto-configures bedrock with AWS source line", async () => {
    await withIsolatedEnv({ AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST", AWS_SECRET_ACCESS_KEY: "secret/value" }, async () => {
      const io = nonInteractiveIo();
      const config = { instance: "dev" } as Parameters<typeof providerStep.run>[0];
      await providerStep.run(config, io);
      expect(config.provider?.name).toBe("bedrock");
      expect(io.successes.join("\n")).toContain("AWS keys from env");
    });
  });

  test("codex precedence: both codex auth and an API key present → codex wins", async () => {
    const home = scratch("codex-prec-home");
    const authPath = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    await withIsolatedEnv({ CODEX_AUTH_JSON: authPath, ANTHROPIC_API_KEY: "sk-ant-xyz" }, async () => {
      const io = nonInteractiveIo();
      const config = { instance: "dev" } as Parameters<typeof providerStep.run>[0];
      await providerStep.run(config, io);
      expect(config.provider?.name).toBe("codex");
      expect(io.successes.join("\n")).toContain("credentials from CODEX_AUTH_JSON env");
    });
  });

  test("no credentials at all → throws naming the OPENAI/CODEX sources", async () => {
    await withIsolatedEnv({}, async () => {
      const io = nonInteractiveIo();
      const config = { instance: "dev" } as Parameters<typeof providerStep.run>[0];
      await expect(providerStep.run(config, io)).rejects.toThrow(/OPENAI_API_KEY[\s\S]*CODEX_AUTH_JSON/);
    });
  });
});

describe("provider modules (direct)", () => {
  test("bedrock.checkCredentials reflects AWS credential presence", () => {
    const oldId = process.env.AWS_ACCESS_KEY_ID;
    const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const oldProfile = process.env.AWS_PROFILE;
    const oldFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    try {
      delete process.env.AWS_PROFILE;
      // Point the shared-credentials file at a non-existent path so a real
      // ~/.aws/credentials on the test machine can't make this flaky.
      process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws/credentials";
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      expect(__testing.bedrockProvider.checkCredentials().available).toBe(false);

      process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTEST";
      process.env.AWS_SECRET_ACCESS_KEY = "secret/key/value";
      expect(__testing.bedrockProvider.checkCredentials().available).toBe(true);
    } finally {
      if (oldId === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = oldId;
      if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
      if (oldProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = oldProfile;
      if (oldFile === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = oldFile;
    }
  });

  test("local.checkCredentials is always available (no-auth gateways are valid)", () => {
    const old = process.env.GINI_LOCAL_API_KEY;
    const oldHome = process.env.HOME;
    // Point HOME at an empty scratch dir so a real ~/.gini/secrets.env with a
    // GINI_LOCAL_API_KEY can't make the source assertion flaky.
    const home = scratch("local-cred-home");
    delete process.env.GINI_LOCAL_API_KEY;
    process.env.HOME = home;
    try {
      const status = __testing.localProvider.checkCredentials();
      expect(status.available).toBe(true);
      expect(status.source).toBe("missing");
    } finally {
      if (old !== undefined) process.env.GINI_LOCAL_API_KEY = old;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  });

  test("AUTO_CONFIGURABLE excludes azure and local (need interactive transport input)", () => {
    const ids = __testing.AUTO_CONFIGURABLE.map((p) => p.id);
    expect(ids).not.toContain("azure");
    expect(ids).not.toContain("local");
    expect(ids).toContain("bedrock");
    expect(ids).toContain("anthropic");
  });
});
