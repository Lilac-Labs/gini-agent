// Unit tests for `gini install` provider env-override behavior. We point
// HOME and GINI_STATE_ROOT at a scratch dir so the real on-disk config
// never gets touched, then call install_() directly to exercise the
// provider rewrite branch in isolation. The source of truth is the
// persisted config.json after the call.
//
// Coverage focus:
//   - The four (provider-changed, model-set) × (provider-unchanged,
//     model-unset) combinations of GINI_PROVIDER / GINI_MODEL.
//   - The legacy ~/.gini/lanes/<inst>/config.json migration path.
//   - The fresh-install path (no pre-existing config) for both
//     "env vars set" and "env vars unset → platform default".
//   - The validation error path for unrecognized GINI_PROVIDER.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { ProviderConfig, RuntimeConfig } from "../../types";
import {
  convergeUpdatedInstance,
  install_,
  isLaunchdManaged,
  rehomeUpdatedInstance,
  restartUpdatedInstance,
  shouldStopViaBootout,
  startViaLaunchd,
  stop,
  type RehomeUpdatedInstanceDeps,
  type RestartUpdatedInstanceDeps,
  type StartViaLaunchdDeps
} from "./admin";
import { loadConfig } from "../../paths";
import type { WebOptions } from "../process";
import type { PlistKind } from "../autostart";

describe("install_ provider env override", () => {
  let scratchHome: string;
  let originalHome: string | undefined;
  let originalState: string | undefined;
  let originalLogRoot: string | undefined;
  let originalProvider: string | undefined;
  let originalModel: string | undefined;
  let originalInstance: string | undefined;
  let originalWorkspace: string | undefined;
  let originalPort: string | undefined;

  beforeEach(() => {
    scratchHome = `/tmp/gini-admin-cli-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(scratchHome, { recursive: true });
    originalHome = process.env.HOME;
    originalState = process.env.GINI_STATE_ROOT;
    originalLogRoot = process.env.GINI_LOG_ROOT;
    originalProvider = process.env.GINI_PROVIDER;
    originalModel = process.env.GINI_MODEL;
    originalInstance = process.env.GINI_INSTANCE;
    originalWorkspace = process.env.GINI_WORKSPACE;
    originalPort = process.env.GINI_PORT;
    process.env.HOME = scratchHome;
    process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
    // Keep the workspace inside the scratch dir so install() doesn't try
    // to materialize anything outside the test sandbox.
    process.env.GINI_WORKSPACE = join(scratchHome, "workspace");
    delete process.env.GINI_INSTANCE;
    delete process.env.GINI_LOG_ROOT;
    delete process.env.GINI_PROVIDER;
    delete process.env.GINI_MODEL;
    delete process.env.GINI_PORT;
  });

  afterEach(() => {
    restore("HOME", originalHome);
    restore("GINI_STATE_ROOT", originalState);
    restore("GINI_LOG_ROOT", originalLogRoot);
    restore("GINI_PROVIDER", originalProvider);
    restore("GINI_MODEL", originalModel);
    restore("GINI_INSTANCE", originalInstance);
    restore("GINI_WORKSPACE", originalWorkspace);
    restore("GINI_PORT", originalPort);
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("codex → openai with GINI_PROVIDER=openai GINI_MODEL=gpt-5.4 rewrites provider", async () => {
    const instance = "switch-to-openai";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    process.env.GINI_PROVIDER = "openai";
    process.env.GINI_MODEL = "gpt-5.4";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" });
  });

  test("openai → codex without GINI_MODEL uses codex default and clears apiKeyEnv", async () => {
    const instance = "switch-to-codex";
    seedInstanceConfig(instance, { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
    process.env.GINI_PROVIDER = "codex";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.5");
    // apiKeyEnv must be unset for codex — the stale "OPENAI_API_KEY"
    // value from the previous openai config would otherwise survive
    // and confuse downstream consumers.
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("codex → codex with GINI_MODEL=gpt-5.6 only updates the model", async () => {
    const instance = "same-codex-new-model";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    process.env.GINI_PROVIDER = "codex";
    process.env.GINI_MODEL = "gpt-5.6";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.6");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("codex → codex with NO GINI_MODEL preserves an existing custom model", async () => {
    // A user with codex/gpt-custom must not have their model clobbered
    // to gpt-5.5 by a re-run of `gini install` with the same provider.
    const instance = "preserve-custom-model";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-custom" });
    process.env.GINI_PROVIDER = "codex";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-custom");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });

  test("GINI_PROVIDER=echo throws and leaves the existing config byte-identical on disk", async () => {
    // Echo is a test-only provider, reachable only through the
    // ephemeral smoke path (src/cli/args.ts) which bypasses install_.
    // A user-facing `gini install` with GINI_PROVIDER=echo must throw
    // the same kind of validation error as a bogus provider, and must
    // not touch the existing on-disk config.
    const instance = "echo-rejected";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMtime = statSync(cfgPath).mtimeMs;
    process.env.GINI_PROVIDER = "echo";
    await expect(install_(makeCtx(instance))).rejects.toThrow(/is not a recognized provider/);
    expect(readFileSync(cfgPath).equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).mtimeMs).toBe(beforeMtime);
  });

  test("GINI_MODEL alone on existing config updates the model in place", async () => {
    // Symmetry with defaultConfig(): fresh configs honor GINI_MODEL
    // even when GINI_PROVIDER is unset, so existing configs must too.
    // The provider name and apiKeyEnv stay as they were.
    const instance = "model-only-update";
    seedInstanceConfig(instance, { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" });
    process.env.GINI_MODEL = "gpt-5.6";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("openai");
    expect(cfg.provider.model).toBe("gpt-5.6");
    expect(cfg.provider.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  test("pre-existing config + no env vars leaves provider byte-identical on disk", async () => {
    // install() always rewrites config.json on every call
    // (src/runtime/index.ts), so the file's mtime WILL advance even
    // when the content is unchanged — mtime is not a usable invariant
    // here. Byte equality is the meaningful pin: a regression where
    // the no-env branch silently mutated fields would show up as a
    // bytes diff. Seed a config matching the install()-produced shape
    // so the installer's own write is a content no-op, leaving any
    // byte drift attributable to the env-override branch.
    const instance = "no-env-preserved";
    seedFullyFormedInstanceConfig(instance, {
      provider: { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" }
    });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    await install_(makeCtx(instance));
    const afterBytes = readFileSync(cfgPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).size).toBe(beforeBytes.length);
  });

  test("GINI_PROVIDER=bogus throws and leaves the existing config byte-identical on disk", async () => {
    const instance = "bogus-provider";
    seedInstanceConfig(instance, { name: "codex", model: "gpt-5.5" });
    const cfgPath = persistedConfigPath(instance);
    const beforeBytes = readFileSync(cfgPath);
    const beforeMtime = statSync(cfgPath).mtimeMs;
    process.env.GINI_PROVIDER = "bogus";
    await expect(install_(makeCtx(instance))).rejects.toThrow(/is not a recognized provider/);
    // Validation runs before ctx.config materializes (no loadConfig, no
    // install() write). The on-disk file must therefore be both
    // byte-identical AND mtime-unchanged from what we seeded.
    expect(readFileSync(cfgPath).equals(beforeBytes)).toBe(true);
    expect(statSync(cfgPath).mtimeMs).toBe(beforeMtime);
  });

  test("legacy ~/.gini/lanes/<inst>/config.json gets migrated AND rewritten by env override", async () => {
    // Pins the legacy-migration race: loadConfig moves the legacy
    // config into ~/.gini/instances/<inst>/, then the env-override
    // branch must still rewrite it. A previous version of install_
    // snapshotted existsSync(configPath) BEFORE ctx.config triggered
    // the migration and skipped the rewrite.
    const instance = "legacy-migrate";
    const stateRoot = process.env.GINI_STATE_ROOT!;
    const lanesDir = join(stateRoot, "lanes", instance);
    mkdirSync(lanesDir, { recursive: true });
    const legacyCfg: Partial<RuntimeConfig> = {
      instance,
      port: 7400,
      token: "legacy-token",
      provider: { name: "openai", model: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" },
      workspaceRoot: join(lanesDir, "workspace"),
      stateRoot: lanesDir,
      logRoot: join(lanesDir, "logs")
    };
    writeFileSync(join(lanesDir, "config.json"), `${JSON.stringify(legacyCfg, null, 2)}\n`);
    process.env.GINI_PROVIDER = "codex";
    process.env.GINI_MODEL = "gpt-5.5";
    await install_(makeCtx(instance));
    // Legacy dir should be gone after migration.
    expect(existsSync(join(stateRoot, "lanes", instance))).toBe(false);
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "codex", model: "gpt-5.5", apiKeyEnv: undefined });
  });

  test("fresh install with GINI_PROVIDER=openai lands on openai via defaultConfig", async () => {
    const instance = "fresh-openai";
    process.env.GINI_PROVIDER = "openai";
    process.env.GINI_MODEL = "gpt-5.4";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider).toEqual({ name: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" });
  });

  test("fresh install with no env vars lands on the codex/gpt-5.5 platform default", async () => {
    const instance = "fresh-default";
    await install_(makeCtx(instance));
    const cfg = readPersistedConfig(instance);
    expect(cfg.provider.name).toBe("codex");
    expect(cfg.provider.model).toBe("gpt-5.5");
    expect(cfg.provider.apiKeyEnv).toBeUndefined();
  });
});

// `gini stop` dispatches on supervisor(): a launchd-supervised instance
// (GINI_SUPERVISOR=launchd) is stopped via `launchctl bootout` because
// KeepAlive:true would respawn a SIGTERM; everything else keeps the
// existing SIGTERM-based stopRuntime behavior.
describe("stop dispatch (launchd vs foreground)", () => {
  let scratchHome: string;
  let originalHome: string | undefined;
  let originalState: string | undefined;
  let originalSupervisor: string | undefined;
  let logs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    scratchHome = `/tmp/gini-stop-cli-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(join(scratchHome, ".gini"), { recursive: true });
    originalHome = process.env.HOME;
    originalState = process.env.GINI_STATE_ROOT;
    originalSupervisor = process.env.GINI_SUPERVISOR;
    process.env.HOME = scratchHome;
    process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    console.log = originalLog;
    restore("HOME", originalHome);
    restore("GINI_STATE_ROOT", originalState);
    restore("GINI_SUPERVISOR", originalSupervisor);
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("foreground (GINI_SUPERVISOR unset) takes the stopRuntime path", () => {
    delete process.env.GINI_SUPERVISOR;
    const instance = "stop-foreground";
    const ctx = makeStopCtx(instance);
    stop(ctx);
    const out = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    // stopRuntime with no pid file reports "No pid file" and stopped:false —
    // and crucially does NOT carry the bootout `results` array.
    expect(out.reason).toBe("No pid file");
    expect(out.results).toBeUndefined();
  });

  // Real launchctl is only available on macOS, and bootout of a service
  // that was never registered is a harmless "Could not find service"
  // no-op that stopViaBootout folds into ok:true.
  (process.platform === "darwin" ? test : test.skip)(
    "launchd (GINI_SUPERVISOR=launchd) takes the bootout path",
    () => {
      process.env.GINI_SUPERVISOR = "launchd";
      const instance = `stop-launchd-${Math.random().toString(36).slice(2)}`;
      const ctx = makeStopCtx(instance);
      stop(ctx);
      const out = JSON.parse(logs.join("\n")) as Record<string, unknown>;
      // bootout result carries the per-kind `results` array (gateway, web,
      // watchdog) — the stopRuntime path never does.
      expect(out.instance).toBe(instance);
      const results = out.results as Array<Record<string, unknown>>;
      expect(Array.isArray(results)).toBe(true);
      expect(results.map((r) => r.kind)).toEqual(["gateway", "web", "watchdog"]);
      // Nothing was registered, so every bootout is a "Could not find
      // service" no-op folded into a successful stop.
      expect(out.ok).toBe(true);
    }
  );
});

// `gini stop` decides bootout-vs-SIGTERM on the TARGET instance's launchd
// state, not the calling process's env. A user running `gini stop` from a
// terminal has no GINI_SUPERVISOR, so the decision must come from
// isLoaded()/plist-on-disk — otherwise a launchd instance gets a SIGTERM
// that KeepAlive immediately respawns. Inject fakes so no real launchctl runs.
describe("shouldStopViaBootout (target launchd state, not process env)", () => {
  const noPlist = () => false;
  const plistFor = (instance: string, kind?: PlistKind) => `/fake/${instance}.${kind}.plist`;

  test("any service loaded -> bootout (even with GINI_SUPERVISOR unset)", () => {
    const loadedKinds: Array<PlistKind | undefined> = [];
    const decision = shouldStopViaBootout("inst", {
      isLoaded: (_inst: string, kind?: PlistKind) => {
        loadedKinds.push(kind);
        return kind === "gateway";
      },
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
    // Short-circuits on the first loaded kind (gateway).
    expect(loadedKinds).toEqual(["gateway"]);
  });

  test("a plist on disk (registered but stopped) -> bootout", () => {
    const decision = shouldStopViaBootout("inst", {
      isLoaded: () => false,
      plistExists: (path: string) => path.includes("web"),
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
  });

  test("nothing loaded and no plist (pure foreground) -> SIGTERM path", () => {
    const decision = shouldStopViaBootout("inst", {
      isLoaded: () => false,
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(false);
  });
});

// `gini start` routes on the same TARGET-instance launchd state as `gini stop`:
// a service loaded OR a plist on disk means launchd manages the instance, so
// start must ensure it via launchd instead of spawning a competing daemon.
// Mirrors the shouldStopViaBootout cases (start delegates to this predicate).
describe("isLaunchdManaged (start/stop launchd routing)", () => {
  const noPlist = () => false;
  const plistFor = (instance: string, kind?: PlistKind) => `/fake/${instance}.${kind}.plist`;

  test("any service loaded -> managed", () => {
    const decision = isLaunchdManaged("inst", {
      isLoaded: (_inst: string, kind?: PlistKind) => kind === "gateway",
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
  });

  test("a plist on disk (registered but stopped) -> managed", () => {
    const decision = isLaunchdManaged("inst", {
      isLoaded: () => false,
      plistExists: (path: string) => path.includes("web"),
      plistPathFor: plistFor
    });
    expect(decision).toBe(true);
  });

  test("nothing loaded and no plist -> not managed", () => {
    const decision = isLaunchdManaged("inst", {
      isLoaded: () => false,
      plistExists: noPlist,
      plistPathFor: plistFor
    });
    expect(decision).toBe(false);
  });
});

// startViaLaunchd ensures a launchd-managed instance's services VIA launchd
// (kickstart a loaded-but-down kind, bootstrap a not-loaded one via enable) and
// no-ops when already healthy — never spawning a competing detached daemon. All
// seams (isRunning/existingWebUrl/isLoaded/kickstart/enable/sleep + the health
// deadline) are injected so the test runs instantly with no real launchctl,
// fetch, or wall-clock waits.
describe("startViaLaunchd (ensure via launchd, never spawn a daemon)", () => {
  const config = { instance: "inst", port: 7777 } as unknown as RuntimeConfig;
  const web: WebOptions = { webPort: 8777, webPortPinned: false, noWeb: false };

  interface Recorder {
    kickstarts: Array<{ kind?: PlistKind }>;
    enables: Array<{ kinds: PlistKind[] }>;
  }

  // Build a fully-stubbed deps set. `loaded` decides isLoaded() per kind;
  // `runtimeUp`/`webUp` are the INITIAL health state. Any revive action
  // (kickstart or enable) flips the instance to healthy when
  // `healthyAfterRevive` is true; otherwise web never reports healthy and the
  // poll runs out the (tiny, injected) deadline.
  function makeDeps(opts: {
    rec: Recorder;
    loaded: (kind?: PlistKind) => boolean;
    runtimeUp: boolean;
    webUp: boolean;
    healthyAfterRevive: boolean;
  }): StartViaLaunchdDeps {
    let revived = false;
    const markRevived = () => {
      if (opts.healthyAfterRevive) revived = true;
    };
    return {
      isRunning: async () => revived || opts.runtimeUp,
      existingWebUrl: async () => (revived ? "http://localhost:8777" : opts.webUp ? "http://localhost:8777" : null),
      isLoaded: (_inst: string, kind?: PlistKind) => opts.loaded(kind),
      kickstart: (_inst: string, kind?: PlistKind) => { opts.rec.kickstarts.push({ kind }); markRevived(); },
      enable: async ({ kinds }) => { opts.rec.enables.push({ kinds }); markRevived(); },
      sleep: async () => { /* no real wait */ },
      // Zero deadline => the health loop runs exactly one poll then exits on the
      // deadline check, so the unhealthy case is instant and deterministic (no
      // wall-clock dependence); the healthy cases break on success first.
      healthDeadlineMs: 0,
      healthIntervalMs: 1
    };
  }

  test("already healthy -> running banner, runtimeStarted:false, ZERO launchd churn", async () => {
    const rec: Recorder = { kickstarts: [], enables: [] };
    const deps = makeDeps({
      rec,
      loaded: () => true, // watchdog loaded
      runtimeUp: true,
      webUp: true,
      healthyAfterRevive: true
    });
    const { banner, runtimeStarted } = await startViaLaunchd(config, web, deps);
    expect(runtimeStarted).toBe(false);
    expect(banner.running).toBe(true);
    expect(banner.webUrl).toBe("http://localhost:7777");
    expect(banner.webError).toBeUndefined();
    // The happy path must not touch launchd at all.
    expect(rec.kickstarts).toEqual([]);
    expect(rec.enables).toEqual([]);
  });

  test("gateway down + gateway loaded -> kickstart gateway, NOT enable", async () => {
    const rec: Recorder = { kickstarts: [], enables: [] };
    const deps = makeDeps({
      rec,
      // gateway + watchdog loaded; gateway is down (runtimeUp:false) so it gets kickstarted.
      loaded: (kind) => kind === "gateway" || kind === "watchdog",
      runtimeUp: false,
      webUp: false,
      healthyAfterRevive: true
    });
    const { banner, runtimeStarted } = await startViaLaunchd(config, web, deps);
    expect(rec.kickstarts.some((k) => k.kind === "gateway")).toBe(true);
    expect(rec.enables.some((e) => e.kinds.includes("gateway"))).toBe(false);
    expect(runtimeStarted).toBe(true);
    expect(banner.started).toBe(true);
  });

  test("gateway down + gateway NOT loaded -> enable gateway, NOT kickstart", async () => {
    const rec: Recorder = { kickstarts: [], enables: [] };
    const deps = makeDeps({
      rec,
      // nothing loaded → gateway must be bootstrapped via enable.
      loaded: () => false,
      runtimeUp: false,
      webUp: false,
      healthyAfterRevive: true
    });
    await startViaLaunchd(config, web, deps);
    expect(rec.enables.some((e) => e.kinds.includes("gateway"))).toBe(true);
    expect(rec.kickstarts.some((k) => k.kind === "gateway")).toBe(false);
  });

  test("web down (runtime up) + watchdog not loaded -> revive web and watchdog", async () => {
    const rec: Recorder = { kickstarts: [], enables: [] };
    const deps = makeDeps({
      rec,
      // web loaded but down; watchdog NOT loaded (must be ensured via enable).
      loaded: (kind) => kind === "web",
      runtimeUp: true,
      webUp: false,
      healthyAfterRevive: true
    });
    const { banner, runtimeStarted } = await startViaLaunchd(config, web, deps);
    // gateway was already up → not revived.
    expect(rec.kickstarts.some((k) => k.kind === "gateway")).toBe(false);
    expect(rec.enables.some((e) => e.kinds.includes("gateway"))).toBe(false);
    // web loaded-but-down → kickstart; watchdog not loaded → enable.
    expect(rec.kickstarts.some((k) => k.kind === "web")).toBe(true);
    expect(rec.enables.some((e) => e.kinds.includes("watchdog"))).toBe(true);
    expect(runtimeStarted).toBe(false);
    // Runtime was already up (only web/watchdog revived) → verb is `running`,
    // and the revived web becomes healthy so its URL is advertised.
    expect(banner.running).toBe(true);
    expect(banner.started).toBeUndefined();
    expect(banner.webUrl).toBe("http://localhost:7777");
    expect(banner.webError).toBeUndefined();
  });

  test("health never comes up within deadline -> banner with webError, no throw/hang", async () => {
    const rec: Recorder = { kickstarts: [], enables: [] };
    const deps = makeDeps({
      rec,
      loaded: () => false,
      runtimeUp: false,
      webUp: false,
      healthyAfterRevive: false // web never reports healthy
    });
    const { banner, runtimeStarted } = await startViaLaunchd(config, web, deps);
    expect(banner.started).toBe(true);
    expect(typeof banner.webError).toBe("string");
    // webUrl and webError are mutually exclusive (mirrors startLifecycle): a
    // failed web carries webError only, never a webUrl.
    expect(banner.webUrl).toBeUndefined();
    expect(banner.url).toBe("http://127.0.0.1:7777");
    expect(runtimeStarted).toBe(true);
  });
});

// The `gini update` restart routes on whether the gateway is actively loaded
// under launchd. On a loaded launchd gateway a plain SIGTERM is respawned by
// KeepAlive, so the restart must bootout (not stopRuntime) before re-ensuring
// via launchd — otherwise waitForRuntimeStopped would time out and throw. All
// seams are injected so no real launchctl / SIGTERM / wall-clock wait runs.
describe("restartUpdatedInstance (update restart gateway-loaded routing)", () => {
  const config = { instance: "inst", stateRoot: "/fake/state" } as unknown as RuntimeConfig;
  const web: WebOptions = { webPort: 8777, webPortPinned: false, noWeb: false };

  interface Recorder {
    bootouts: string[];
    cleanups: number;
    stopRuntimes: number;
    starts: number;
  }

  function makeDeps(opts: {
    rec: Recorder;
    gatewayLoaded: boolean;
    stopped: boolean;
  }): RestartUpdatedInstanceDeps {
    return {
      isGatewayLoaded: () => opts.gatewayLoaded,
      stopViaBootout: ((instance: string) => {
        opts.rec.bootouts.push(instance);
        return { ok: true } as never;
      }) as unknown as RestartUpdatedInstanceDeps["stopViaBootout"],
      cleanupRuntimeFiles: () => { opts.rec.cleanups += 1; },
      stopRuntime: (() => {
        opts.rec.stopRuntimes += 1;
        return { stopped: true, pid: 1234 } as never;
      }) as unknown as RestartUpdatedInstanceDeps["stopRuntime"],
      waitForRuntimeStopped: (async () => opts.stopped) as RestartUpdatedInstanceDeps["waitForRuntimeStopped"],
      startInstance: (async () => {
        opts.rec.starts += 1;
        return { banner: {}, runtimeStarted: true };
      }) as RestartUpdatedInstanceDeps["startInstance"]
    };
  }

  test("gateway loaded -> bootout (NOT stopRuntime), then start; no SIGTERM-timeout throw", async () => {
    const rec: Recorder = { bootouts: [], cleanups: 0, stopRuntimes: 0, starts: 0 };
    const deps = makeDeps({ rec, gatewayLoaded: true, stopped: true });
    await restartUpdatedInstance(config, web, deps);
    // Bootout path: bootout + pid/port cleanup, never a SIGTERM stopRuntime.
    expect(rec.bootouts).toEqual(["inst"]);
    expect(rec.cleanups).toBe(1);
    expect(rec.stopRuntimes).toBe(0);
    expect(rec.starts).toBe(1);
  });

  test("gateway not loaded -> stopRuntime (SIGTERM) path, then start", async () => {
    const rec: Recorder = { bootouts: [], cleanups: 0, stopRuntimes: 0, starts: 0 };
    const deps = makeDeps({ rec, gatewayLoaded: false, stopped: true });
    await restartUpdatedInstance(config, web, deps);
    expect(rec.stopRuntimes).toBe(1);
    expect(rec.bootouts).toEqual([]);
    expect(rec.cleanups).toBe(0);
    expect(rec.starts).toBe(1);
  });

  test("gateway loaded but the booted-out gateway never stops -> throws, no start", async () => {
    const rec: Recorder = { bootouts: [], cleanups: 0, stopRuntimes: 0, starts: 0 };
    const deps = makeDeps({ rec, gatewayLoaded: true, stopped: false });
    await expect(restartUpdatedInstance(config, web, deps)).rejects.toThrow(/Timed out waiting/);
    expect(rec.bootouts).toEqual(["inst"]);
    expect(rec.starts).toBe(0);
  });
});

// `gini update` re-homes a launchd instance whose gateway plist points
// anywhere other than the installed runtime — the wrongly-homed instance
// keeps executing the wrong checkout's code across every respawn, so the
// update's work on ~/.gini/runtime never reaches it. All seams are injected;
// realpath comparisons run against real tmp dirs so the compare semantics
// (symlinks equal, deleted homes unequal) are pinned for real.
describe("rehomeUpdatedInstance (update re-home onto the installed runtime)", () => {
  const config = { instance: "inst", port: 7777 } as unknown as RuntimeConfig;
  const web: WebOptions = { webPort: 8777, webPortPinned: false, noWeb: false };
  let scratch: string;

  beforeEach(() => {
    scratch = `/tmp/gini-rehome-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(scratch, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  interface Recorder {
    enables: Array<{ instance: string; kinds: PlistKind[]; homeDir: string }>;
  }

  function makeDeps(opts: {
    rec: Recorder;
    plistHome: string | null;
    installed: string;
    enableOk?: boolean;
    healthy?: boolean;
  }): RehomeUpdatedInstanceDeps {
    const healthy = opts.healthy ?? true;
    return {
      gatewayPlistHome: () => opts.plistHome,
      installedRuntimeDir: () => opts.installed,
      enable: async (options) => {
        opts.rec.enables.push(options);
        return { ok: opts.enableOk ?? true };
      },
      isRunning: (async () => healthy) as RehomeUpdatedInstanceDeps["isRunning"],
      existingWebUrl: (async () => (healthy ? "http://localhost:8777" : null)) as RehomeUpdatedInstanceDeps["existingWebUrl"],
      sleep: async () => { /* no real wait */ },
      // Zero deadline => the health loop runs exactly one poll then exits on
      // the deadline check, so the unhealthy case is instant and
      // deterministic; the healthy case breaks on success first.
      healthDeadlineMs: 0,
      healthIntervalMs: 1
    };
  }

  test("plist homed on a different checkout -> enables all kinds with homeDir=installed runtime", async () => {
    const wrongHome = join(scratch, "conductor-clone");
    const installed = join(scratch, "installed-runtime");
    mkdirSync(wrongHome, { recursive: true });
    mkdirSync(installed, { recursive: true });
    const rec: Recorder = { enables: [] };
    const rehomed = await rehomeUpdatedInstance(config, web, makeDeps({ rec, plistHome: wrongHome, installed }));
    expect(rehomed).toBe(true);
    expect(rec.enables).toEqual([
      { instance: "inst", kinds: ["gateway", "web", "watchdog"], homeDir: installed }
    ]);
  });

  test("plist already homed on the installed runtime (via a symlinked spelling) -> no re-home", async () => {
    const installed = join(scratch, "installed-runtime");
    mkdirSync(installed, { recursive: true });
    const alias = join(scratch, "runtime-alias");
    symlinkSync(installed, alias);
    const rec: Recorder = { enables: [] };
    // The plist records the symlinked spelling; realpath compare must read
    // it as the installed runtime, not as a wrong home to churn on.
    const rehomed = await rehomeUpdatedInstance(config, web, makeDeps({ rec, plistHome: alias, installed }));
    expect(rehomed).toBe(false);
    expect(rec.enables).toEqual([]);
  });

  test("no gateway plist (foreground / conductor instance) -> untouched", async () => {
    const installed = join(scratch, "installed-runtime");
    mkdirSync(installed, { recursive: true });
    const rec: Recorder = { enables: [] };
    const rehomed = await rehomeUpdatedInstance(config, web, makeDeps({ rec, plistHome: null, installed }));
    expect(rehomed).toBe(false);
    expect(rec.enables).toEqual([]);
  });

  test("plist homed on a deleted checkout -> re-homes (self-heal)", async () => {
    const installed = join(scratch, "installed-runtime");
    mkdirSync(installed, { recursive: true });
    const rec: Recorder = { enables: [] };
    const rehomed = await rehomeUpdatedInstance(
      config,
      web,
      makeDeps({ rec, plistHome: join(scratch, "deleted-worktree"), installed })
    );
    expect(rehomed).toBe(true);
    expect(rec.enables.length).toBe(1);
  });

  test("a failed enable still reports the re-home attempt (caller must not double-restart)", async () => {
    const wrongHome = join(scratch, "conductor-clone");
    const installed = join(scratch, "installed-runtime");
    mkdirSync(wrongHome, { recursive: true });
    mkdirSync(installed, { recursive: true });
    const rec: Recorder = { enables: [] };
    const rehomed = await rehomeUpdatedInstance(
      config,
      web,
      makeDeps({ rec, plistHome: wrongHome, installed, enableOk: false })
    );
    expect(rehomed).toBe(true);
    expect(rec.enables.length).toBe(1);
  });
});

// The re-home leg is deliberately INDEPENDENT of the sha-based restart
// check: a wrongly-homed checkout can sit at the very same sha as the
// freshly updated runtime (upToDate:true, matching /api/status sha) while
// every respawn keeps executing the wrong checkout. convergeUpdatedInstance
// pins the ordering: re-home first, unconditionally; the sha-based restart
// only when no re-home happened (a re-home already restarted the services).
describe("convergeUpdatedInstance (re-home is independent of the sha check)", () => {
  const config = { instance: "inst", port: 7777 } as unknown as RuntimeConfig;
  const web: WebOptions = { webPort: 8777, webPortPinned: false, noWeb: false };

  test("wrong home re-homes even when upToDate with matching shas, and skips the restart leg", async () => {
    const calls: string[] = [];
    await convergeUpdatedInstance(config, web, { upToDate: true, afterSha: "abc123" }, {
      rehomeUpdatedInstance: async () => { calls.push("rehome"); return true; },
      // Even a needs-restart=true answer must not run the restart leg after
      // a re-home — enable already restarted the services on the new home.
      runningRuntimeNeedsRestart: async () => { calls.push("needsRestart"); return true; },
      restartUpdatedInstance: async () => { calls.push("restart"); }
    });
    expect(calls).toEqual(["rehome"]);
  });

  test("correct home falls through to the sha-based restart", async () => {
    const calls: string[] = [];
    await convergeUpdatedInstance(config, web, { upToDate: false, afterSha: "abc123" }, {
      rehomeUpdatedInstance: async () => { calls.push("rehome"); return false; },
      runningRuntimeNeedsRestart: async () => { calls.push("needsRestart"); return true; },
      restartUpdatedInstance: async () => { calls.push("restart"); }
    });
    expect(calls).toEqual(["rehome", "needsRestart", "restart"]);
  });

  test("correct home + up to date + matching sha -> no restart at all", async () => {
    const calls: string[] = [];
    await convergeUpdatedInstance(config, web, { upToDate: true, afterSha: "abc123" }, {
      rehomeUpdatedInstance: async () => { calls.push("rehome"); return false; },
      runningRuntimeNeedsRestart: async () => { calls.push("needsRestart"); return false; },
      restartUpdatedInstance: async () => { calls.push("restart"); }
    });
    expect(calls).toEqual(["rehome", "needsRestart"]);
  });
});

function makeStopCtx(instance: string): CliContext {
  const rawArgs = ["stop", "--instance", instance];
  let cached: RuntimeConfig | null = null;
  return {
    get config(): RuntimeConfig {
      if (!cached) cached = loadConfig(instance);
      return cached;
    },
    cliArgs: rawArgs,
    command: "stop",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function seedInstanceConfig(
  instance: string,
  provider: ProviderConfig
): void {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  const instanceDir = join(stateRoot, "instances", instance);
  mkdirSync(instanceDir, { recursive: true });
  const cfg: Partial<RuntimeConfig> = {
    instance,
    port: 7400,
    token: "seed-token",
    provider,
    workspaceRoot: join(instanceDir, "workspace"),
    stateRoot: instanceDir,
    logRoot: join(instanceDir, "logs")
  };
  writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

// Seeds a config in the exact field order that loadConfig() + install()
// would produce, so a subsequent install_() call rewrites it
// byte-for-byte identically. Required by byte-equality assertions: the
// minimal seedInstanceConfig() omits approvalMode, which the merge in
// loadConfig() adds, so a normal seed always changes bytes on the
// installer's unconditional rewrite. This helper matches the merged shape.
function seedFullyFormedInstanceConfig(
  instance: string,
  overrides: { provider: ProviderConfig; approvalMode?: RuntimeConfig["approvalMode"] }
): void {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  const instanceDir = join(stateRoot, "instances", instance);
  mkdirSync(instanceDir, { recursive: true });
  // Key order matches the spread in loadConfig() (defaults then parsed
  // then explicit overrides). defaultConfig key order is:
  //   instance, port, token, provider, workspaceRoot, stateRoot, logRoot, approvalMode
  // JSON.stringify preserves insertion order, so reproduce it here.
  const cfg: RuntimeConfig = {
    instance,
    port: 7400,
    token: "seed-token",
    provider: overrides.provider,
    workspaceRoot: join(instanceDir, "workspace"),
    stateRoot: instanceDir,
    logRoot: join(instanceDir, "logs"),
    approvalMode: overrides.approvalMode ?? "auto"
  };
  writeFileSync(join(instanceDir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

function readPersistedConfig(instance: string): RuntimeConfig {
  return JSON.parse(readFileSync(persistedConfigPath(instance), "utf8")) as RuntimeConfig;
}

function persistedConfigPath(instance: string): string {
  const stateRoot = process.env.GINI_STATE_ROOT!;
  return join(stateRoot, "instances", instance, "config.json");
}

function makeCtx(instance: string): CliContext {
  // install_ resolves the instance via parseInstance(ctx.rawArgs), so
  // we must pass --instance in rawArgs. ctx.config is wired as a
  // lazy getter that calls loadConfig(instance) — same shape as the
  // real CLI entry in src/cli/index.ts.
  const rawArgs = ["install", "--instance", instance];
  let cached: RuntimeConfig | null = null;
  return {
    get config(): RuntimeConfig {
      // Lazy resolution mirrors the real CLI getter in src/cli/index.ts:
      // ctx.config materializes on first access so loadConfig sees the
      // process.env state at that moment (matters for tests that mutate
      // GINI_PROVIDER / GINI_STATE_ROOT in beforeEach).
      if (!cached) cached = loadConfig(instance);
      return cached;
    },
    cliArgs: rawArgs,
    command: "install",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
