// Unit tests for the browser-facing setup API. We point HOME at a scratch
// dir and exercise the GET/POST surface directly — no HTTP layer needed.
// The tests confirm the contracts the webapp /setup page relies on:
//   - status reflects the provider config + configured flag
//   - POST openai writes secrets.env, updates process.env, rewrites the
//     runtime config, and signals plistRefreshNeeded
//   - POST codex fails gracefully when no auth.json exists
//   - rejection paths return ok:false with a descriptive error

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetupStatus, removeSetupProvider, setSetupProvider } from "./setup-api";
import { mutateState, readState, recordProviderAuthFailure } from "../state";
import { writeKeyToSecretsEnv } from "../state/secrets-env";
import { loadConfig } from "../paths";
import type { ProviderName, RuntimeConfig } from "../types";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function scratch(): { home: string; stateRoot: string; cleanup: () => void } {
  const root = `/tmp/gini-setup-api-tests/${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const stateRoot = join(home, ".gini");
  return {
    home,
    stateRoot,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("setup-api", () => {
  let env: {
    HOME?: string;
    GINI_STATE_ROOT?: string;
    OPENAI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    CODEX_AUTH_JSON?: string;
    GINI_PROVIDER?: string;
    GINI_MODEL?: string;
  };
  let s: ReturnType<typeof scratch>;
  let config: RuntimeConfig;

  let prevSkipRefresh: string | undefined;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CODEX_AUTH_JSON: process.env.CODEX_AUTH_JSON,
      GINI_PROVIDER: process.env.GINI_PROVIDER,
      GINI_MODEL: process.env.GINI_MODEL
    };
    s = scratch();
    process.env.HOME = s.home;
    process.env.GINI_STATE_ROOT = s.stateRoot;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // Scrub provider/model env so the test's assertions about the
    // platform default ("codex"/gpt-5.5) are not skewed by an ambient
    // GINI_PROVIDER=echo or similar in the caller's shell.
    delete process.env.GINI_PROVIDER;
    delete process.env.GINI_MODEL;
    // Point CODEX_AUTH_JSON at a non-existent scratch path so the codex
    // credential probe in providerHealth() resolves into the test
    // sandbox instead of falling back to ~/.codex/auth.json on the
    // developer machine. node:os homedir() is initialized once at
    // process start in Bun and ignores later mutations to process.env.HOME,
    // so overriding HOME in beforeEach is NOT enough on a dev machine
    // with a real ~/.codex/auth.json — the resolved path would still
    // be the real one and providerConfigured would flip true.
    process.env.CODEX_AUTH_JSON = join(s.stateRoot, "nonexistent-codex-auth.json");
    // Prevent the setSetupProvider path from spawning a real detached
    // `gini autostart enable` subprocess during tests — the production
    // path schedules one to refresh the launchd plist's EnvironmentVariables,
    // but tests assert the contract without firing a real refresh.
    prevSkipRefresh = process.env.GINI_SKIP_PLIST_REFRESH;
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    config = loadConfig(`setup-api-${tag()}`);
  });

  afterEach(() => {
    if (env.HOME === undefined) delete process.env.HOME; else process.env.HOME = env.HOME;
    if (env.GINI_STATE_ROOT === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = env.GINI_STATE_ROOT;
    if (env.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (env.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    if (env.CODEX_AUTH_JSON === undefined) delete process.env.CODEX_AUTH_JSON;
    else process.env.CODEX_AUTH_JSON = env.CODEX_AUTH_JSON;
    if (env.GINI_PROVIDER === undefined) delete process.env.GINI_PROVIDER;
    else process.env.GINI_PROVIDER = env.GINI_PROVIDER;
    if (env.GINI_MODEL === undefined) delete process.env.GINI_MODEL;
    else process.env.GINI_MODEL = env.GINI_MODEL;
    if (prevSkipRefresh === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
    else process.env.GINI_SKIP_PLIST_REFRESH = prevSkipRefresh;
    s.cleanup();
  });

  test("status: providerConfigured reflects the codex platform default on a fresh instance", () => {
    const status = getSetupStatus(config);
    expect(status.ok).toBe(true);
    expect(status.providers).toEqual(["openai", "codex", "openrouter", "deepseek", "local", "anthropic", "bedrock", "azure"]);
    // Platform default is "codex". providerHealth treats codex as
    // configured when the runtime can find an auth.json; in this
    // scratch env there is none (CODEX_AUTH_JSON is scrubbed in
    // beforeEach), so providerConfigured is false and the browser
    // /setup gate still asks the user to finish onboarding.
    expect(status.current).toBe("codex");
    expect(status.providerConfigured).toBe(false);
    // No fallback exists either (no other provider configured), so the
    // fallback fields report the selected provider dispatching directly.
    expect(status.usingFallback).toBe(false);
    expect(status.selectedProvider).toBe("codex");
    expect(status.activeProvider).toBe("codex");
  });

  test("status: providerConfigured is true via a transient fallback when the selected provider is unconfigured", () => {
    // Select bedrock (no AWS creds) but configure deepseek — the app must stay
    // usable (no /setup bounce), dispatching via the deepseek fallback.
    const prevDeepseek = process.env.DEEPSEEK_API_KEY;
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    const prevAwsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const prevAwsProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/gini-setup-fallback/credentials";
    delete process.env.AWS_PROFILE;
    process.env.DEEPSEEK_API_KEY = "ds-key";
    config.provider = { name: "bedrock", model: "us.amazon.nova-pro-v1:0" };
    try {
      const status = getSetupStatus(config);
      // The proxy reads ONLY providerConfigured — it must be true so the
      // loopback nav isn't 307'd to /setup.
      expect(status.providerConfigured).toBe(true);
      expect(status.usingFallback).toBe(true);
      expect(status.selectedProvider).toBe("bedrock");
      expect(status.activeProvider).toBe("deepseek");
      expect(status.current).toBe("bedrock");
    } finally {
      if (prevDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prevDeepseek;
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
      if (prevAwsFile === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = prevAwsFile;
      if (prevAwsProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = prevAwsProfile;
    }
  });

  test("status: a genuinely-unconfigured instance with no fallback still reports providerConfigured false (preserves the /setup gate)", () => {
    // Select bedrock with no AWS creds AND no other provider configured — the
    // fail-open setup gate must still fire (providerConfigured false).
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    const prevAwsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const prevAwsProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/gini-setup-fallback/credentials";
    delete process.env.AWS_PROFILE;
    config.provider = { name: "bedrock", model: "us.amazon.nova-pro-v1:0" };
    try {
      const status = getSetupStatus(config);
      expect(status.providerConfigured).toBe(false);
      expect(status.usingFallback).toBe(false);
      expect(status.activeProvider).toBe("bedrock");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
      if (prevAwsFile === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = prevAwsFile;
      if (prevAwsProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = prevAwsProfile;
    }
  });

  test("POST openai with apiKey writes secrets.env, sets process.env, updates config", async () => {
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test-abcd1234" });
    expect(result.ok).toBe(true);
    // plistRefreshNeeded only flips true when a gateway plist exists for
    // this instance — we don't write one in tests. The dedicated
    // "plist already exists" test below covers that branch.
    expect(result.plistRefreshNeeded).toBe(false);
    // secrets.env wrote the key (shell-escaped form).
    const secretsPath = join(s.home, ".gini", "secrets.env");
    expect(existsSync(secretsPath)).toBe(true);
    const body = readFileSync(secretsPath, "utf8");
    expect(body).toContain("OPENAI_API_KEY=");
    expect(body).toContain("sk-test-abcd1234");
    // process.env is hot — the running gateway picks this up on its next
    // provider call without a restart.
    expect(process.env.OPENAI_API_KEY).toBe("sk-test-abcd1234");
    // Config got rewritten with provider name=openai.
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(cfg.provider?.name).toBe("openai");
    // Re-checking status now reports configured.
    const status = getSetupStatus(config);
    expect(status.providerConfigured).toBe(true);
    expect(status.current).toBe("openai");
  });

  test("POST openai without apiKey returns ok:false", async () => {
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("apiKey is required");
  });

  test("POST codex fails when no auth.json exists", async () => {
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Codex credentials not found");
  });

  test("POST codex succeeds when ~/.codex/auth.json is present and parseable", async () => {
    const codexDir = join(s.home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    // Both codex paths (the codexAuthPath resolution in provider.ts and the
    // gate in setSetupProvider) must agree on what CODEX_AUTH_JSON points
    // at. beforeEach scrubs it to a non-existent sandbox file so the dev
    // machine's real ~/.codex/auth.json doesn't leak in; point it at the
    // test fixture we just wrote so both helpers resolve to the same path.
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(result.plistRefreshNeeded).toBe(false);
    // Pins the helper-divergence regression: a previous version of
    // hasCodexAuth treated CODEX_AUTH_JSON as raw JSON and silently fell
    // back to ~/.codex/auth.json, so result.ok was true for the wrong
    // reason and the embedded provider record reported configured=false.
    expect(result.provider.configured).toBe(true);
    expect(result.provider.provider.name).toBe("codex");
    const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(cfg.provider?.name).toBe("codex");
  });

  test("POST codex succeeds during openai→codex switch even when OPENAI_API_KEY is set", async () => {
    // Pins a one-directional false negative: codexAuthPath() used to
    // honor provider.apiKeyEnv unconditionally. During an openai→codex
    // switch the on-disk config still names openai with
    // apiKeyEnv="OPENAI_API_KEY". With OPENAI_API_KEY=sk-... in env,
    // codexAuthPath would resolve to the literal sk-... string, miss
    // ~/.codex/auth.json, and report no codex credentials. The fix
    // ignores apiKeyEnv whenever the probed provider is not codex.
    const codexDir = join(s.home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-auth" }));
    process.env.CODEX_AUTH_JSON = authPath;
    // Seed an openai config with the stale apiKeyEnv that triggers the bug.
    config.provider = { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" };
    process.env.OPENAI_API_KEY = "sk-fake-openai";
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(result.provider.configured).toBe(true);
    expect(result.provider.provider.name).toBe("codex");
  });

  test("POST unknown provider rejects with descriptive error", async () => {
    const result = await setSetupProvider(config, { provider: "mistral" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported provider");
  });

  test("POST anthropic with a baseUrl override targets the configured endpoint", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await setSetupProvider(config, {
        provider: "anthropic",
        apiKey: "bedrock-api-key-token&Version=1",
        model: "anthropic.claude-opus-4-8",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic"
      });
      expect(result.ok).toBe(true);
      expect(result.provider.provider.name).toBe("anthropic");
      expect(result.provider.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
      expect(result.provider.provider.model).toBe("anthropic.claude-opus-4-8");
      expect(process.env.ANTHROPIC_API_KEY ?? "").toBe("bedrock-api-key-token&Version=1");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("re-setting an already-active anthropic provider preserves baseUrl + apiKeyEnv", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    try {
      await setSetupProvider(config, {
        provider: "anthropic",
        apiKey: "bedrock-token",
        model: "anthropic.claude-opus-4-8",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic"
      });
      expect(config.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");

      // Edit-model / set-active flow: POST {provider, model} with no baseUrl —
      // the configured Bedrock endpoint and key-env must survive.
      const edited = await setSetupProvider(config, { provider: "anthropic", model: "anthropic.claude-haiku-4-5" });
      expect(edited.ok).toBe(true);
      expect(config.provider.model).toBe("anthropic.claude-haiku-4-5");
      expect(config.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
      expect(config.provider.apiKeyEnv).toBe("ANTHROPIC_API_KEY");

      // Re-activate with no model either — both model and baseUrl are kept.
      const reactivated = await setSetupProvider(config, { provider: "anthropic" });
      expect(reactivated.ok).toBe(true);
      expect(config.provider.model).toBe("anthropic.claude-haiku-4-5");
      expect(config.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("editing/rotating an active anthropic provider honors a CLI-set custom apiKeyEnv", async () => {
    const prevBedrock = process.env.BEDROCK_BEARER_TOKEN;
    process.env.BEDROCK_BEARER_TOKEN = "bedrock-old";
    // Simulate a CLI-configured provider keyed on a custom env var, with the
    // canonical ANTHROPIC_API_KEY left unset (scrubbed in beforeEach).
    config.provider = {
      name: "anthropic",
      model: "anthropic.claude-opus-4-8",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      apiKeyEnv: "BEDROCK_BEARER_TOKEN"
    };
    try {
      // Model-only edit, blank key, ANTHROPIC_API_KEY unset → must succeed
      // (the env-already-set check honors the custom var) and keep the env var.
      const edited = await setSetupProvider(config, { provider: "anthropic", model: "anthropic.claude-haiku-4-5" });
      expect(edited.ok).toBe(true);
      expect(config.provider.model).toBe("anthropic.claude-haiku-4-5");
      expect(config.provider.apiKeyEnv).toBe("BEDROCK_BEARER_TOKEN");

      // Rotating the key lands in the custom var (not the canonical one), and
      // the config keeps reading from it.
      const rotated = await setSetupProvider(config, { provider: "anthropic", apiKey: "bedrock-new" });
      expect(rotated.ok).toBe(true);
      expect(config.provider.apiKeyEnv).toBe("BEDROCK_BEARER_TOKEN");
      expect(process.env.BEDROCK_BEARER_TOKEN).toBe("bedrock-new");
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      const secrets = readFileSync(join(s.home, ".gini", "secrets.env"), "utf8");
      expect(secrets).toContain("BEDROCK_BEARER_TOKEN=");
      expect(secrets).not.toContain("ANTHROPIC_API_KEY=");
    } finally {
      if (prevBedrock === undefined) delete process.env.BEDROCK_BEARER_TOKEN;
      else process.env.BEDROCK_BEARER_TOKEN = prevBedrock;
    }
  });

  test("bedrock: writes the entered AWS keys to secrets.env + process.env and persists model + region", async () => {
    // The user enters the access key + secret on add; gini stores them under the
    // standard AWS_* names (so future shells + the running gateway both sign with
    // them) and persists only model + region in config — never the secret values.
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const result = await setSetupProvider(config, {
        provider: "bedrock",
        model: "us.amazon.nova-pro-v1:0",
        awsRegion: "us-west-2",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: "wJalrXUtnFEMIsecret"
      });
      expect(result.ok).toBe(true);
      expect(config.provider.name).toBe("bedrock");
      expect(config.provider.model).toBe("us.amazon.nova-pro-v1:0");
      expect(config.provider.awsRegion).toBe("us-west-2");
      expect(config.provider.baseUrl).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
      expect(result.provider.message).toContain("AWS SigV4");
      // Keys landed in process.env so the running gateway signs on the next call.
      // Read through a fresh alias so the earlier `delete` doesn't narrow the
      // type to `undefined` for the type checker.
      const liveEnv = process.env as Record<string, string | undefined>;
      expect(liveEnv.AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(liveEnv.AWS_SECRET_ACCESS_KEY).toBe("wJalrXUtnFEMIsecret");
      // …and into the shell-sourced secrets.env (HOME points at the scratch dir).
      const secretsBody = readFileSync(join(s.stateRoot, "secrets.env"), "utf8");
      expect(secretsBody).toContain("AWS_ACCESS_KEY_ID=");
      expect(secretsBody).toContain("AWS_SECRET_ACCESS_KEY=");
      // The secret values themselves are NOT persisted into the runtime config.
      expect(JSON.stringify(config.provider)).not.toContain("wJalrXUtnFEMIsecret");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("bedrock: a keyless save succeeds when keys already resolve, preserving model + region", async () => {
    // When usable AWS keys already resolve from the env (a prior add, or ambient
    // AWS_* vars), a model/region-only save must go through without re-typing them.
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    try {
      const result = await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-pro-v1:0", awsRegion: "us-west-2" });
      expect(result.ok).toBe(true);
      expect(config.provider.model).toBe("us.amazon.nova-pro-v1:0");
      expect(config.provider.awsRegion).toBe("us-west-2");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("bedrock: rejects a fresh add with no keys entered and none resolving", async () => {
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    const prevFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const prevProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/gini-test/credentials";
    delete process.env.AWS_PROFILE;
    try {
      const result = await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-pro-v1:0" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Enter your AWS Access Key ID and Secret Access Key/);
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
      if (prevFile === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = prevFile;
      if (prevProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = prevProfile;
    }
  });

  test("bedrock: rejects a half-entered key pair (one field blank)", async () => {
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const result = await setSetupProvider(config, {
        provider: "bedrock",
        model: "us.amazon.nova-pro-v1:0",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE"
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/BOTH the AWS Access Key ID and the Secret Access Key/);
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("bedrock: rejects a malformed awsRegion before persisting", async () => {
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    try {
      const result = await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-pro-v1:0", awsRegion: "us-east-1/evil" });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/awsRegion is invalid/);
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("bedrock: a blank awsRegion clears to the default; an omitted one preserves it (present-clears)", async () => {
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    const prevRegion = process.env.AWS_REGION;
    const prevDef = process.env.AWS_DEFAULT_REGION;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-pro-v1:0", awsRegion: "us-west-2" });
      expect(config.provider.awsRegion).toBe("us-west-2");
      // Omitting awsRegion preserves it (a partial model-only save from the
      // model picker / set_provider tool must not reset the region).
      await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-lite-v1:0" });
      expect(config.provider.awsRegion).toBe("us-west-2");
      // A blank awsRegion CLEARS it — the persisted field goes absent (no env
      // baked into config) and the host resolves at request time back to the
      // us-east-1 default (no AWS_REGION/AWS_DEFAULT_REGION set here).
      const cleared = await setSetupProvider(config, { provider: "bedrock", awsRegion: "" });
      expect(cleared.ok).toBe(true);
      expect(config.provider.awsRegion).toBeUndefined();
      expect(config.provider.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
      if (prevRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = prevRegion;
      if (prevDef === undefined) delete process.env.AWS_DEFAULT_REGION; else process.env.AWS_DEFAULT_REGION = prevDef;
    }
  });

  test("remove rejects codex, local, and unknown providers", async () => {
    expect(await removeSetupProvider(config, "codex")).toMatchObject({ ok: false, error: expect.stringContaining("codex CLI") });
    expect(await removeSetupProvider(config, "local")).toMatchObject({ ok: false });
    expect(await removeSetupProvider(config, "mistral")).toMatchObject({ ok: false });
    expect((await removeSetupProvider(config, "mistral")).error).toContain("Cannot remove provider 'mistral'");
  });

  test("remove scrubs the key and falls back to echo when the removed provider was active", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-active";
    config.provider = { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" };
    try {
      const result = await removeSetupProvider(config, "openai");
      expect(result.ok).toBe(true);
      expect(result.switched).toBe(true);
      expect(config.provider.name).toBe("echo");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  test("remove switches the active provider to codex when codex auth is available", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const authPath = join(s.stateRoot, "codex-auth.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "b" } }));
    process.env.CODEX_AUTH_JSON = authPath;
    process.env.OPENAI_API_KEY = "sk-active";
    config.provider = { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" };
    try {
      const result = await removeSetupProvider(config, "openai");
      expect(result.ok).toBe(true);
      expect(result.switched).toBe(true);
      expect(config.provider.name).toBe("codex");
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  test("remove scrubs the key without switching when the provider was not active", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-inactive";
    // config.provider stays at the codex default — removing openai must not switch it.
    try {
      const result = await removeSetupProvider(config, "openai");
      expect(result.ok).toBe(true);
      expect(result.switched).toBe(false);
      expect(config.provider.name).toBe("codex");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  test("remove bedrock scrubs BOTH AWS keys from secrets.env + env and switches off when active", async () => {
    // Gini stores the AWS access key + secret for bedrock, so disconnect must
    // delete both from the env and the shell-sourced secrets.env, and fall back
    // when bedrock was the active provider.
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    // Seed both stores as if a prior add had written them.
    writeKeyToSecretsEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    writeKeyToSecretsEnv("AWS_SECRET_ACCESS_KEY", "secret");
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    config.provider = { name: "bedrock", model: "us.amazon.nova-pro-v1:0" };
    try {
      const result = await removeSetupProvider(config, "bedrock");
      expect(result.ok).toBe(true);
      expect(result.switched).toBe(true);
      expect(config.provider.name).toBe("echo");
      // Both keys gone from process.env …
      const liveEnv = process.env as Record<string, string | undefined>;
      expect(liveEnv.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(liveEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      // … and from secrets.env.
      const secretsBody = existsSync(join(s.stateRoot, "secrets.env"))
        ? readFileSync(join(s.stateRoot, "secrets.env"), "utf8")
        : "";
      expect(secretsBody).not.toContain("AWS_ACCESS_KEY_ID=");
      expect(secretsBody).not.toContain("AWS_SECRET_ACCESS_KEY=");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("remove scrubs a custom apiKeyEnv (not just the canonical var) for an active anthropic provider", async () => {
    const prevBedrock = process.env.BEDROCK_BEARER_TOKEN;
    process.env.BEDROCK_BEARER_TOKEN = "bedrock-old";
    // Active anthropic provider keyed on a custom env var, as
    // `gini provider set anthropic --api-key-env BEDROCK_BEARER_TOKEN` persists.
    config.provider = {
      name: "anthropic",
      model: "anthropic.claude-opus-4-8",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      apiKeyEnv: "BEDROCK_BEARER_TOKEN"
    };
    try {
      // Rotate the key so the bearer actually lands in secrets.env under the
      // custom var (setSetupProvider routes the write through apiKeyEnv).
      const rotated = await setSetupProvider(config, { provider: "anthropic", apiKey: "bedrock-live" });
      expect(rotated.ok).toBe(true);
      expect(config.provider.apiKeyEnv).toBe("BEDROCK_BEARER_TOKEN");
      expect(process.env.BEDROCK_BEARER_TOKEN).toBe("bedrock-live");
      const before = readFileSync(join(s.home, ".gini", "secrets.env"), "utf8");
      expect(before).toContain("BEDROCK_BEARER_TOKEN=");

      const result = await removeSetupProvider(config, "anthropic");
      expect(result.ok).toBe(true);
      expect(result.switched).toBe(true);
      // The live token must be gone from BOTH stores — the canonical-only
      // scrub would have left it behind under the custom var.
      expect(process.env.BEDROCK_BEARER_TOKEN).toBeUndefined();
      const after = readFileSync(join(s.home, ".gini", "secrets.env"), "utf8");
      expect(after).not.toContain("BEDROCK_BEARER_TOKEN=");
    } finally {
      if (prevBedrock === undefined) delete process.env.BEDROCK_BEARER_TOKEN;
      else process.env.BEDROCK_BEARER_TOKEN = prevBedrock;
    }
  });

  test("POST azure with apiKey + baseUrl writes AZURE_OPENAI_API_KEY and persists azure routing", async () => {
    const prevAzureKey = process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    try {
      const result = await setSetupProvider(config, {
        provider: "azure",
        apiKey: "az-secret-key",
        model: "gpt-4o",
        baseUrl: "https://lilac.openai.azure.com",
        deployment: "gpt-4o-deploy"
      });
      expect(result.ok).toBe(true);
      // Key landed under the Azure env var, not OPENAI_API_KEY.
      const body = readFileSync(join(s.home, ".gini", "secrets.env"), "utf8");
      expect(body).toContain("AZURE_OPENAI_API_KEY=");
      expect(body).toContain("az-secret-key");
      expect(process.env.AZURE_OPENAI_API_KEY as string | undefined).toBe("az-secret-key");
      // Config persisted the azure provider with its routing fields.
      const cfgPath = join(s.stateRoot, "instances", config.instance, "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
      expect(cfg.provider?.name).toBe("azure");
      expect(cfg.provider?.baseUrl).toBe("https://lilac.openai.azure.com");
      expect(cfg.provider?.deployment).toBe("gpt-4o-deploy");
      expect(cfg.provider?.apiVersion).toBe("2024-10-21");
      expect(cfg.provider?.authScheme).toBe("api-key");
    } finally {
      if (prevAzureKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = prevAzureKey;
    }
  });

  test("POST azure rejects a missing base URL and a non-https endpoint", async () => {
    const prevAzureKey = process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    try {
      const noBase = await setSetupProvider(config, { provider: "azure", apiKey: "az-secret-key", model: "gpt-4o" });
      expect(noBase.ok).toBe(false);
      expect(noBase.error).toContain("https://<resource>.openai.azure.com");
      const httpBase = await setSetupProvider(config, {
        provider: "azure",
        apiKey: "az-secret-key",
        model: "gpt-4o",
        baseUrl: "http://lilac.openai.azure.com"
      });
      expect(httpBase.ok).toBe(false);
      expect(httpBase.error).toContain("https://");
    } finally {
      if (prevAzureKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = prevAzureKey;
    }
  });

  test("POST anthropic rejects a plaintext custom baseUrl but accepts https (key-leak guard)", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const httpBase = await setSetupProvider(config, {
        provider: "anthropic",
        apiKey: "sk-ant-secret",
        model: "claude-opus-4-8",
        baseUrl: "http://proxy.example/v1"
      });
      expect(httpBase.ok).toBe(false);
      expect(httpBase.error).toContain("https://");
      const httpsBase = await setSetupProvider(config, {
        provider: "anthropic",
        apiKey: "sk-ant-secret",
        model: "claude-opus-4-8",
        baseUrl: "https://anthropic.gateway.internal/v1"
      });
      expect(httpsBase.ok).toBe(true);
      expect(config.provider.baseUrl).toBe("https://anthropic.gateway.internal/v1");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("a model-only same-provider edit preserves a custom apiKeyEnv and gates on it", async () => {
    const prevKey = process.env.MY_AZURE_KEY;
    config.provider = {
      name: "azure",
      model: "gpt-5.5",
      apiKeyEnv: "MY_AZURE_KEY",
      baseUrl: "https://lilac.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "gpt-5.5",
      authScheme: "api-key"
    };
    process.env.MY_AZURE_KEY = "az-existing";
    try {
      // A keyless model-only edit gates on the CUSTOM env var (already set) and
      // preserves the apiKeyEnv + baseUrl the partial payload didn't resend.
      const result = await setSetupProvider(config, { provider: "azure", model: "gpt-4o" });
      expect(result.ok).toBe(true);
      expect(config.provider.apiKeyEnv).toBe("MY_AZURE_KEY");
      expect(config.provider.baseUrl).toBe("https://lilac.openai.azure.com");
      expect(config.provider.model).toBe("gpt-4o");
    } finally {
      if (prevKey === undefined) delete process.env.MY_AZURE_KEY;
      else process.env.MY_AZURE_KEY = prevKey;
    }
  });

  test("a same-provider edit with a key writes to the custom apiKeyEnv, not the default", async () => {
    const prevCustom = process.env.MY_AZURE_KEY;
    const prevDefault = process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_API_KEY;
    config.provider = {
      name: "azure",
      model: "gpt-5.5",
      apiKeyEnv: "MY_AZURE_KEY",
      baseUrl: "https://lilac.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "gpt-5.5",
      authScheme: "api-key"
    };
    try {
      const result = await setSetupProvider(config, { provider: "azure", apiKey: "az-rotated", model: "gpt-5.5" });
      expect(result.ok).toBe(true);
      // The key lands in the configured env var — the same one the gateway reads.
      expect(process.env.MY_AZURE_KEY).toBe("az-rotated");
      expect(process.env.AZURE_OPENAI_API_KEY).toBeUndefined();
      expect(readFileSync(join(s.home, ".gini", "secrets.env"), "utf8")).toContain("MY_AZURE_KEY=");
    } finally {
      if (prevCustom === undefined) delete process.env.MY_AZURE_KEY;
      else process.env.MY_AZURE_KEY = prevCustom;
      if (prevDefault === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = prevDefault;
    }
  });

  test("a model-only same-provider edit preserves a configured extraBody", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    config.provider = { name: "openai", model: "gpt-5.4", extraBody: { reasoning_effort: "max" } };
    process.env.OPENAI_API_KEY = "sk-existing";
    try {
      const result = await setSetupProvider(config, { provider: "openai", model: "gpt-5.4-mini" });
      expect(result.ok).toBe(true);
      expect(config.provider.extraBody).toEqual({ reasoning_effort: "max" });
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  test("removing an azure provider with a custom apiKeyEnv scrubs that env var, not just the default", async () => {
    const prevKey = process.env.MY_AZURE_KEY;
    config.provider = {
      name: "azure",
      model: "gpt-5.5",
      apiKeyEnv: "MY_AZURE_KEY",
      baseUrl: "https://lilac.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "gpt-5.5",
      authScheme: "api-key"
    };
    writeKeyToSecretsEnv("MY_AZURE_KEY", "az-secret");
    process.env.MY_AZURE_KEY = "az-secret";
    try {
      const result = await removeSetupProvider(config, "azure");
      expect(result.ok).toBe(true);
      // The secret must be gone from BOTH stores, under the custom env var.
      expect(process.env.MY_AZURE_KEY).toBeUndefined();
      const secretsPath = join(s.home, ".gini", "secrets.env");
      const body = existsSync(secretsPath) ? readFileSync(secretsPath, "utf8") : "";
      expect(body).not.toContain("MY_AZURE_KEY");
    } finally {
      if (prevKey === undefined) delete process.env.MY_AZURE_KEY;
      else process.env.MY_AZURE_KEY = prevKey;
    }
  });

  test("a same-provider edit with a malformed persisted apiKeyEnv is rejected", async () => {
    config.provider = { name: "openai", model: "gpt-5.4", apiKeyEnv: "FOO=evil" };
    const result = await setSetupProvider(config, { provider: "openai", model: "gpt-5.4-mini" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("valid environment variable name");
  });

  test("plistRefreshNeeded:true when an autostart plist already exists (macOS only)", async () => {
    if (process.platform !== "darwin") {
      // Linux: function returns false regardless.
      const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test" });
      expect(result.plistRefreshNeeded).toBe(false);
      return;
    }
    // Create a fake plist file at the path the function probes. It's in
    // the real $HOME (not the scratch home) because setup-api reads
    // process.env.HOME, which is overridden in beforeEach.
    const home = s.home;
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    const gatewayPlist = join(launchAgents, `ai.lilaclabs.gini.${config.instance}.gateway.plist`);
    writeFileSync(gatewayPlist, "<?xml version=\"1.0\"?>\n");
    try {
      const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-test" });
      expect(result.ok).toBe(true);
      expect(result.plistRefreshNeeded).toBe(true);
    } finally {
      rmSync(gatewayPlist, { force: true });
    }
  });

  test("POST openai chmods existing secrets.env to 0600 even if it was 0644", async () => {
    // Reproduces MEDIUM-8: writeFileSync's `mode` option only applies on
    // file creation. If secrets.env pre-existed with 0644 (hand-edited or
    // restored from a backup), the write would leave it world-readable.
    const secretsPath = join(s.home, ".gini", "secrets.env");
    mkdirSync(join(s.home, ".gini"), { recursive: true });
    writeFileSync(secretsPath, "# stale\n");
    chmodSync(secretsPath, 0o644);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o644);
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-mode-test" });
    expect(result.ok).toBe(true);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  test("re-POSTing openai overwrites the previous key in secrets.env (no duplicate lines)", async () => {
    await setSetupProvider(config, { provider: "openai", apiKey: "sk-first" });
    await setSetupProvider(config, { provider: "openai", apiKey: "sk-second" });
    const secretsPath = join(s.home, ".gini", "secrets.env");
    const body = readFileSync(secretsPath, "utf8");
    const lines = body.split("\n").filter((l) => l.includes("OPENAI_API_KEY="));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("sk-second");
    expect(process.env.OPENAI_API_KEY).toBe("sk-second");
  });

  // Persistent needs-reauth clearing (issue #233): a successful config write
  // through this API is the user re-establishing the credential, so the
  // per-provider failure record must drop. A FAILED write must leave it.
  async function seedAuthFailure(provider: ProviderName): Promise<void> {
    await mutateState(config.instance, (state) => {
      recordProviderAuthFailure(state, { provider, detail: "token expired", taskId: "task_seed" });
    });
    expect(readState(config.instance).providerAuthFailures?.[provider]).toBeDefined();
  }

  test("POST setup/provider clears the needs-reauth record for the rotated env-keyed provider", async () => {
    await seedAuthFailure("openai");
    const result = await setSetupProvider(config, { provider: "openai", apiKey: "sk-rotated" });
    expect(result.ok).toBe(true);
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.openai).toBeUndefined();
    const cleared = state.audit.find((a) => a.action === "provider.auth.cleared" && a.target === "openai");
    expect(cleared?.evidence).toMatchObject({ reason: "provider configuration updated" });
  });

  test("a keyless model-only edit of an env-keyed provider leaves the needs-reauth record", async () => {
    // The Edit dialog leaves the key field blank to keep the saved key, so a
    // model-only save submits no apiKey; the dead key in process.env passes
    // the env-already-set gate. The write must succeed WITHOUT clearing —
    // editing the model proves nothing about the credential.
    await seedAuthFailure("openai");
    process.env.OPENAI_API_KEY = "sk-dead";
    const result = await setSetupProvider(config, { provider: "openai", model: "gpt-5.4-mini" });
    expect(result.ok).toBe(true);
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.openai).toBeDefined();
    expect(state.audit.some((a) => a.action === "provider.auth.cleared" && a.target === "openai")).toBe(false);
  });

  test("a keyless baseUrl-only edit of an env-keyed provider leaves the needs-reauth record", async () => {
    await seedAuthFailure("openai");
    process.env.OPENAI_API_KEY = "sk-dead";
    const result = await setSetupProvider(config, { provider: "openai", baseUrl: "https://proxy.example.com/v1" });
    expect(result.ok).toBe(true);
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.openai).toBeDefined();
    expect(state.audit.some((a) => a.action === "provider.auth.cleared" && a.target === "openai")).toBe(false);
  });

  test("POST bedrock clears the needs-reauth record when a NEW key pair is entered", async () => {
    // Re-entering the access key + secret IS the recovery seam for bedrock —
    // that's what clears the amber row.
    await seedAuthFailure("bedrock");
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const result = await setSetupProvider(config, {
        provider: "bedrock",
        model: "us.amazon.nova-pro-v1:0",
        awsRegion: "us-west-2",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: "secret"
      });
      expect(result.ok).toBe(true);
      const state = readState(config.instance);
      expect(state.providerAuthFailures?.bedrock).toBeUndefined();
      const cleared = state.audit.find((a) => a.action === "provider.auth.cleared" && a.target === "bedrock");
      expect(cleared?.evidence).toMatchObject({ reason: "provider configuration updated" });
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("POST bedrock keyless model/region edit does NOT clear needs-reauth (presence != validity)", async () => {
    // Dead-but-present AWS keys make hasUsableAwsCredentials() true, so a keyless
    // model/region edit succeeds — but it proves nothing about the credential and
    // must NOT flip the amber row back to a stale "Connected".
    await seedAuthFailure("bedrock");
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIADEADBUTPRESENT";
    process.env.AWS_SECRET_ACCESS_KEY = "stale-secret";
    try {
      const result = await setSetupProvider(config, { provider: "bedrock", model: "us.amazon.nova-lite-v1:0", awsRegion: "us-west-2" });
      expect(result.ok).toBe(true);
      // The record survives — no new credential was supplied.
      expect(readState(config.instance).providerAuthFailures?.bedrock).toBeDefined();
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("POST codex (the setup Verify seam) clears the codex record once credentials are present", async () => {
    await seedAuthFailure("codex");
    const authPath = join(s.stateRoot, "codex-auth.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fresh", refresh_token: "r" } }));
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(readState(config.instance).providerAuthFailures?.codex).toBeUndefined();
  });

  test("codex Verify fails on a provably-expired JWT and leaves the needs-reauth record", async () => {
    // The runtime decodes the OAuth JWT exp locally; Verify must not bless
    // the very credential the connector probe reports as expired.
    await seedAuthFailure("codex");
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const expiredJwt = `${enc({ alg: "none" })}.${enc({ exp: pastExp })}.sig`;
    const authPath = join(s.stateRoot, "codex-auth-expired.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expiredJwt, refresh_token: "r" } }));
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Codex access token expired at");
    expect(result.error).toContain("codex login");
    expect(readState(config.instance).providerAuthFailures?.codex).toBeDefined();
  });

  test("codex Verify passes on a future-exp JWT and clears the needs-reauth record", async () => {
    await seedAuthFailure("codex");
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const freshJwt = `${enc({ alg: "none" })}.${enc({ exp: futureExp })}.sig`;
    const authPath = join(s.stateRoot, "codex-auth-fresh.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: freshJwt, refresh_token: "r" } }));
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(readState(config.instance).providerAuthFailures?.codex).toBeUndefined();
  });

  test("codex Verify preserves a same-provider apiKeyEnv and baseUrl across the write", async () => {
    // Verify probes THROUGH the custom apiKeyEnv resolution; the persisted
    // config must keep pointing at the credential source it just validated.
    await seedAuthFailure("codex");
    const authPath = join(s.stateRoot, "codex-auth-custom.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fresh", refresh_token: "r" } }));
    const prevCustom = process.env.MY_CODEX_AUTH_SETUP;
    process.env.MY_CODEX_AUTH_SETUP = authPath;
    // No CODEX_AUTH_JSON fallback: the custom env is the only working source.
    delete process.env.CODEX_AUTH_JSON;
    config.provider = {
      name: "codex",
      model: "gpt-5.5",
      baseUrl: "http://127.0.0.1:9999/custom",
      apiKeyEnv: "MY_CODEX_AUTH_SETUP"
    };
    try {
      const result = await setSetupProvider(config, { provider: "codex" });
      expect(result.ok).toBe(true);
      expect(config.provider.apiKeyEnv).toBe("MY_CODEX_AUTH_SETUP");
      expect(config.provider.baseUrl).toBe("http://127.0.0.1:9999/custom");
      expect(readState(config.instance).providerAuthFailures?.codex).toBeUndefined();
    } finally {
      if (prevCustom === undefined) delete process.env.MY_CODEX_AUTH_SETUP;
      else process.env.MY_CODEX_AUTH_SETUP = prevCustom;
    }
  });

  test("codex Verify recovers from a torn auth.json read via the single retry", async () => {
    // A read landing inside the codex CLI's non-atomic rewrite produces a
    // transient parse failure; Verify retries once after the rewrite-settle
    // delay (same contract as the connector probe), so a fully-authenticated
    // user racing the rewrite doesn't get a false "not found".
    await seedAuthFailure("codex");
    const authPath = join(s.stateRoot, "codex-auth-torn.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, "{ torn mid-write");
    process.env.CODEX_AUTH_JSON = authPath;
    // Repair lands on the task queue immediately — well inside the 50ms
    // retry delay — simulating the CLI finishing its rewrite.
    setTimeout(() => {
      writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fresh", refresh_token: "r" } }));
    }, 0);
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(true);
    expect(readState(config.instance).providerAuthFailures?.codex).toBeUndefined();
  });

  test("codex Verify fails after the retry when auth.json stays unreadable", async () => {
    await seedAuthFailure("codex");
    const authPath = join(s.stateRoot, "codex-auth-stays-torn.json");
    mkdirSync(s.stateRoot, { recursive: true });
    writeFileSync(authPath, "{ torn mid-write");
    process.env.CODEX_AUTH_JSON = authPath;
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(false);
    expect(readState(config.instance).providerAuthFailures?.codex).toBeDefined();
  });

  test("a FAILED setup/provider write leaves the needs-reauth record in place", async () => {
    await seedAuthFailure("codex");
    // CODEX_AUTH_JSON still points at the scrubbed nonexistent path from
    // beforeEach, so the presence gate rejects the Verify.
    const result = await setSetupProvider(config, { provider: "codex" });
    expect(result.ok).toBe(false);
    expect(readState(config.instance).providerAuthFailures?.codex).toBeDefined();
  });

  test("removing a provider clears its needs-reauth record", async () => {
    await seedAuthFailure("openai");
    process.env.OPENAI_API_KEY = "sk-doomed";
    const result = await removeSetupProvider(config, "openai");
    expect(result.ok).toBe(true);
    const state = readState(config.instance);
    expect(state.providerAuthFailures?.openai).toBeUndefined();
    const cleared = state.audit.find((a) => a.action === "provider.auth.cleared" && a.target === "openai");
    expect(cleared?.evidence).toMatchObject({ reason: "provider removed" });
  });
});
