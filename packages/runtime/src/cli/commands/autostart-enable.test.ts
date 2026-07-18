// Tests for the exported `enable()` function with launchctl dependency
// injection. The integration-level behavior (real launchctl shellouts)
// is covered by autostart.test.ts under GINI_AUTOSTART_E2E=1; this file
// targets the bookkeeping branches that real launchctl can't reach —
// notably the rollback-bootout-itself-fails path and the corresponding
// EnableResult.rollbackState contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enable } from "./autostart";
import { defaultRuntimePort, defaultWebPort } from "../../paths";
import { plistPathFor, readPlistWorkingDirectory, type LaunchctlResult, type PlistKind } from "../autostart";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeScratch(label: string): { stateRoot: string; logRoot: string; home: string } {
  const root = `/tmp/gini-autostart-enable-tests/${label}-${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { stateRoot: join(root, "state"), logRoot: join(root, "logs"), home };
}

function ok(stdout = ""): LaunchctlResult {
  return { ok: true, stdout, stderr: "", status: 0 };
}

function fail(stderr: string): LaunchctlResult {
  return { ok: false, stdout: "", stderr, status: 1 };
}

const isDarwin = process.platform === "darwin";

(isDarwin ? describe : describe.skip)("autostart enable (DI) — rollback failure surfacing", () => {
  let scratch: { stateRoot: string; logRoot: string; home: string };
  let envHome: string | undefined;
  const instance = `enable-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("rollback");
    envHome = process.env.HOME;
    // Point HOME at the scratch dir so the plist file writes land there
    // instead of the developer's real ~/Library/LaunchAgents. The
    // writePlist call is unmocked — only the launchctl shellouts are.
    process.env.HOME = scratch.home;
  });

  afterEach(() => {
    if (envHome === undefined) delete process.env.HOME;
    else process.env.HOME = envHome;
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Remove any plists we wrote into the scratch LaunchAgents.
    rmSync(join(scratch.home, "Library"), { recursive: true, force: true });
  });

  test("happy path: both kinds bootstrap → rollbackState 'clean', no rollbackFailures", async () => {
    const kickstartCalls: Array<{ inst: string; kind?: PlistKind }> = [];
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: (inst: string, kind?: PlistKind) => {
        kickstartCalls.push({ inst, kind });
        return ok();
      },
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.rollbackState).toBe("clean");
    expect(result.rollbackFailures).toBeUndefined();
    expect(result.results.length).toBe(2);
    for (const r of result.results) {
      expect(r.enabled).toBe(true);
      expect(r.kickstartError).toBeUndefined();
    }
    // kickstart must fire once per successful bootstrap so services actually
    // launch on macOS 26 (where RunAtLoad is best-effort). Order matches the
    // kinds slice: gateway, then web.
    expect(kickstartCalls.length).toBe(2);
    expect(kickstartCalls[0]!.kind).toBe("gateway");
    expect(kickstartCalls[1]!.kind).toBe("web");
  });

  test("watchdog bootstrap failure does NOT roll back the already-loaded gateway/web", async () => {
    // The watchdog is supplementary and bootstrapped last. If it fails, the
    // gateway/web are already up — tearing them down to "clean up" would take
    // the instance offline over a missing health-prober. Assert no rollback
    // bootout fires for gateway/web and the partial failure is surfaced.
    let bootstrapCalls = 0;
    const bootoutKinds: Array<PlistKind | undefined> = [];
    const deps = {
      isLoaded: () => false,
      bootout: (_inst: string, kind?: PlistKind) => {
        bootoutKinds.push(kind);
        return ok();
      },
      bootstrap: () => {
        bootstrapCalls += 1;
        // gateway (1) + web (2) succeed; watchdog (3) fails permanently.
        if (bootstrapCalls < 3) return ok();
        return fail("Bootstrap failed: watchdog plist rejected");
      },
      kickstart: () => ok(),
      // isLoaded is false in these cases, so the port-free wait never fires;
      // stub it as already-free so the type is satisfied either way.
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: deps
    });
    // Partial failure surfaced, but no rollback of the core services.
    expect(result.ok).toBe(false);
    expect(result.rollbackState).toBe("clean");
    expect(result.rollbackFailures).toBeUndefined();
    // CRITICAL: no bootout for gateway or web — they stay loaded.
    expect(bootoutKinds).not.toContain("gateway");
    expect(bootoutKinds).not.toContain("web");
    const gateway = result.results.find((r) => r.kind === "gateway")!;
    const web = result.results.find((r) => r.kind === "web")!;
    const watchdog = result.results.find((r) => r.kind === "watchdog")!;
    expect(gateway.enabled).toBe(true);
    expect(web.enabled).toBe(true);
    expect(watchdog.enabled).toBe(false);
    expect(watchdog.error).toBe("launchctl bootstrap failed");
  });

  test("kickstart failure is surfaced per-kind but does NOT fail the enable", async () => {
    // The bootstrap succeeded (services are registered), but kickstart
    // returned non-zero. We keep enabled:true so install.sh proceeds
    // and surface the soft failure so the user can recover with
    // `gini autostart kick` manually.
    let kickstartCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: () => {
        kickstartCalls += 1;
        // First call (gateway) succeeds, second (web) fails — exercises
        // both branches.
        if (kickstartCalls === 1) return ok();
        return fail("Could not kickstart service: 3: No such process");
      },
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    // Whole-enable still ok — bootstrap succeeded for both.
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.rollbackState).toBe("clean");
    expect(result.results.length).toBe(2);
    const gateway = result.results.find((r) => r.kind === "gateway")!;
    const web = result.results.find((r) => r.kind === "web")!;
    expect(gateway.enabled).toBe(true);
    expect(gateway.kickstartError).toBeUndefined();
    expect(web.enabled).toBe(true);
    expect(web.kickstartError).toBe("launchctl kickstart failed");
    expect(web.kickstartStderr).toContain("No such process");
  });

  test("web fails AND rollback bootout fails → rollbackState 'rollback_failed' + stderr surfaced", async () => {
    // Bookkeeping: track per-call so the test can distinguish web's
    // bootstrap call (fails) from the rollback bootout call (also fails).
    let bootstrapCalls = 0;
    let bootoutCalls = 0;
    const bootoutStderrSeen: string[] = [];
    const deps = {
      isLoaded: () => false,
      bootout: (_inst: string, _kind?: PlistKind) => {
        bootoutCalls += 1;
        // Rollback bootout itself fails — the scenario this test pins.
        return fail("Bootout failed: 5: Input/output error");
      },
      bootstrap: (_inst: string, _path: string) => {
        bootstrapCalls += 1;
        // Gateway succeeds; web fails. The retry-on-IO-error path won't
        // help here because the stderr doesn't contain "Input/output
        // error" (we're simulating a permanent failure).
        if (bootstrapCalls === 1) return ok();
        return fail("Bootstrap failed: permanent fault");
      },
      kickstart: () => ok(),
      // isLoaded is false in these cases, so the port-free wait never fires;
      // stub it as already-free so the type is satisfied either way.
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    // Top-level: enable failed.
    expect(result.ok).toBe(false);
    expect(result.enabled).toBe(false);
    // The honest state: gateway was bootstrapped, web failed, rollback of
    // gateway also failed → "rollback_failed".
    expect(result.rollbackState).toBe("rollback_failed");
    expect(result.rollbackFailures).toBeDefined();
    expect(result.rollbackFailures!.length).toBe(1);
    expect(result.rollbackFailures![0]!.kind).toBe("gateway");
    expect(result.rollbackFailures![0]!.error).toBe("rollback bootout failed");
    expect(result.rollbackFailures![0]!.stderr).toContain("Input/output error");
    // Per-kind detail still surfaces the underlying web failure.
    const webResult = result.results.find((r) => r.kind === "web");
    expect(webResult).toBeDefined();
    expect(webResult!.enabled).toBe(false);
    expect(webResult!.stderr).toContain("permanent fault");
    // Confirm the rollback was actually attempted (one bootout call for
    // the gateway after web failed).
    expect(bootoutCalls).toBeGreaterThanOrEqual(1);
    // Mark variables as used.
    expect(bootoutStderrSeen).toBeDefined();
  });

  test("web fails but rollback bootout SUCCEEDS → rollbackState 'rolled_back', no rollbackFailures", async () => {
    let bootstrapCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(), // rollback succeeds
      bootstrap: () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return ok(); // gateway
        return fail("Bootstrap failed: web missing"); // web
      },
      kickstart: () => ok(),
      // isLoaded is false in these cases, so the port-free wait never fires;
      // stub it as already-free so the type is satisfied either way.
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(false);
    expect(result.rollbackState).toBe("rolled_back");
    expect(result.rollbackFailures).toBeUndefined();
  });

  test("rollback that hits 'Could not find service' is treated as success (idempotent)", async () => {
    let bootstrapCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => fail("Could not find service ai.lilaclabs.gini.x.gateway"),
      bootstrap: () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return ok();
        return fail("Bootstrap failed: web missing");
      },
      kickstart: () => ok(),
      // isLoaded is false in these cases, so the port-free wait never fires;
      // stub it as already-free so the type is satisfied either way.
      waitForPortFree: async () => true
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web"],
      launchctl: deps
    });
    expect(result.ok).toBe(false);
    // "Could not find service" doesn't count as a real rollback failure —
    // the service was never loaded in the first place.
    expect(result.rollbackState).toBe("rolled_back");
  });
});

(isDarwin ? describe : describe.skip)("autostart enable (DI) — port-free wait after bootout", () => {
  let scratch: { stateRoot: string; logRoot: string; home: string };
  let envHome: string | undefined;
  const instance = `enable-portwait-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("portwait");
    envHome = process.env.HOME;
    process.env.HOME = scratch.home;
  });

  afterEach(() => {
    if (envHome === undefined) delete process.env.HOME;
    else process.env.HOME = envHome;
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    rmSync(join(scratch.home, "Library"), { recursive: true, force: true });
  });

  test("waits for the port to free after a bootout of gateway/web, but NOT watchdog", async () => {
    const waited: number[] = [];
    const deps = {
      // Everything is already loaded → bootout runs → port-free wait should
      // fire for the port-binding kinds.
      isLoaded: () => true,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: () => ok(),
      waitForPortFree: async (port: number) => {
        waited.push(port);
        return true;
      }
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: deps
    });
    expect(result.ok).toBe(true);
    // gateway + web each waited once; watchdog binds nothing → no wait.
    expect(waited.length).toBe(2);
    expect(waited).toContain(defaultRuntimePort(instance));
    expect(waited).toContain(defaultWebPort(instance));
  });

  test("does NOT wait when nothing was loaded (no bootout → no wait)", async () => {
    let waitCalls = 0;
    const deps = {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: () => ok(),
      waitForPortFree: async () => {
        waitCalls += 1;
        return true;
      }
    };
    const result = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: deps
    });
    expect(result.ok).toBe(true);
    expect(waitCalls).toBe(0);
  });
});

// Home stickiness at the enable() level: the plists an enable writes must
// preserve the home recorded in the existing gateway plist, and only an
// explicit homeDir may move it. Only the launchctl shellouts are mocked;
// the plist writes (and the preserved-home read) run against the scratch
// HOME, so this pins the on-disk contract end to end.
(isDarwin ? describe : describe.skip)("autostart enable (DI) — sticky home", () => {
  let scratch: { stateRoot: string; logRoot: string; home: string };
  let envHome: string | undefined;
  const instance = `enable-home-${tag()}`;

  // A usable gini-agent checkout: package.json with name "gini-agent" AND
  // the runtime entry the gateway plist execs.
  function makeUsableCheckout(root: string): string {
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"gini-agent"}');
    writeFileSync(join(root, "packages", "runtime", "src", "server.ts"), "// stub\n");
    return root;
  }

  function launchctlOk() {
    return {
      isLoaded: () => false,
      bootout: () => ok(),
      bootstrap: () => ok(),
      kickstart: () => ok(),
      waitForPortFree: async () => true
    };
  }

  beforeEach(() => {
    scratch = makeScratch("home");
    envHome = process.env.HOME;
    process.env.HOME = scratch.home;
  });

  afterEach(() => {
    if (envHome === undefined) delete process.env.HOME;
    else process.env.HOME = envHome;
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    rmSync(join(scratch.home, "Library"), { recursive: true, force: true });
  });

  test("homeDir homes all plists there; a later plain enable preserves it despite a source-checkout cwd", async () => {
    const checkout = makeUsableCheckout(join(scratch.home, "checkout-a"));
    const first = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: launchctlOk(),
      homeDir: checkout
    });
    expect(first.ok).toBe(true);
    for (const kind of ["gateway", "web", "watchdog"] as const) {
      expect(readPlistWorkingDirectory(plistPathFor(instance, kind))).toBe(checkout);
    }

    // Re-enable with NO homeDir. The test process's cwd is the repo — a
    // gini-agent source checkout — which the old cwd-preference would have
    // homed the instance onto. The recorded home must win instead.
    const second = await enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: launchctlOk()
    });
    expect(second.ok).toBe(true);
    for (const kind of ["gateway", "web", "watchdog"] as const) {
      expect(readPlistWorkingDirectory(plistPathFor(instance, kind))).toBe(checkout);
    }
  });

  test("an invalid homeDir rejects before any plist is written", async () => {
    await expect(enable({
      instance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot },
      kinds: ["gateway", "web", "watchdog"],
      launchctl: launchctlOk(),
      homeDir: join(scratch.home, "not-a-checkout")
    })).rejects.toThrow(/not a usable gini-agent checkout/);
    expect(existsSync(plistPathFor(instance, "gateway"))).toBe(false);
  });
});
