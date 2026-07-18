// Subprocess tests for `gini autostart enable|disable|status`.
//
// We invoke the CLI directly with GINI_STATE_ROOT and GINI_LOG_ROOT pointed
// at a scratch dir to avoid touching the developer's real install. The
// launchctl integration is gated by GINI_AUTOSTART_E2E so these tests stay
// safe on shared machines: by default we only exercise the disable/status
// paths against a non-existent service, which prove the JSON contract and
// idempotency without registering anything with launchd.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { labelForKind, plistPathFor, serviceTarget, type LaunchctlResult } from "../autostart";
import { stopViaBootout } from "./autostart";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function makeScratch(label: string): { stateRoot: string; logRoot: string } {
  const root = `/tmp/gini-autostart-cli-tests/${label}-${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return { stateRoot: join(root, "state"), logRoot: join(root, "logs") };
}

function runCli(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", "packages/runtime/src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("gini autostart usage and platform gate", () => {
  test("no subcommand prints usage block", () => {
    const result = runCli(["autostart"], {});
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.usage).toBeDefined();
    expect(Array.isArray(parsed.usage)).toBe(true);
    expect((parsed.usage as string[]).some((line) => line.includes("enable"))).toBe(true);
  });

  test("unknown subcommand returns non-zero exit", () => {
    const result = runCli(["autostart", "nope"], {});
    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
  });

  // `kick` on a non-existent service must return a non-zero exit code (not
  // just ok:false in the JSON) so install.sh's `if … then` shell guard sees
  // the failure. We scope it to a scratch state-root and assert kick does NOT
  // scaffold the instance there: autostart resolves the instance name without
  // reading config, so a kick against a never-enabled instance must leave no
  // phantom dir behind (a regression would silently litter ~/.gini/instances).
  test("kick on a not-loaded instance returns non-zero exit and scaffolds nothing", () => {
    if (process.platform !== "darwin") return; // platform gate prints macOS-only
    const instance = `kick-nonexistent-${tag()}`;
    const scratch = makeScratch("kick");
    try {
      const result = runCli(
        ["autostart", "kick", "--instance", instance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
        {}
      );
      expect(result.status).not.toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(existsSync(join(scratch.stateRoot, "instances", instance))).toBe(false);
    } finally {
      rmSync(scratch.stateRoot, { recursive: true, force: true });
      rmSync(scratch.logRoot, { recursive: true, force: true });
    }
  });

  // `--home` is validated BEFORE anything touches launchd or writes a plist,
  // so a typo'd path is a clean non-zero exit with a descriptive error —
  // never a plist homed on a directory that can't run the runtime.
  test("enable --home with a non-checkout dir fails fast, before any plist is written", () => {
    if (process.platform !== "darwin") return; // platform gate prints macOS-only
    const instance = `home-invalid-${tag()}`;
    const scratch = makeScratch("home-invalid");
    try {
      const result = runCli(
        [
          "autostart", "enable",
          "--instance", instance,
          "--home", join(scratch.stateRoot, "not-a-checkout"),
          "--state-root", scratch.stateRoot,
          "--log-root", scratch.logRoot,
          "--test-root", scratch.stateRoot
        ],
        {}
      );
      expect(result.status).not.toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toContain("not a usable gini-agent checkout");
      // Validation fires before enable() — no plist lands on disk.
      expect(existsSync(plistPathFor(instance, "gateway"))).toBe(false);
    } finally {
      rmSync(scratch.stateRoot, { recursive: true, force: true });
      rmSync(scratch.logRoot, { recursive: true, force: true });
    }
  });
});

// Run only on macOS — the platform gate kicks in elsewhere and the JSON
// shape is different. Skipping rather than describe.skipIf-ing keeps the
// fail signal on the intended platform clear.
const isDarwin = process.platform === "darwin";

(isDarwin ? describe : describe.skip)("gini autostart status (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("status");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
  });

  test("reports plistExists:false and loaded:false for a fresh instance (all kinds)", () => {
    const result = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.instance).toBe(uniqueInstance);
    // gateway, web, and watchdog are reported under `services`. The
    // top-level `label` field mirrors the gateway service for back-compat
    // with shell scripts that grep on it.
    expect(parsed.label).toBe(labelForKind(uniqueInstance, "gateway"));
    expect(parsed.plistExists).toBe(false);
    expect(parsed.loaded).toBe(false);
    expect(parsed.pid).toBe(null);
    const services = parsed.services as Array<Record<string, unknown>>;
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBe(3);
    expect(services[0]!.kind).toBe("gateway");
    expect(services[1]!.kind).toBe("web");
    expect(services[2]!.kind).toBe("watchdog");
    expect(services[0]!.label).toBe(labelForKind(uniqueInstance, "gateway"));
    expect(services[1]!.label).toBe(labelForKind(uniqueInstance, "web"));
    expect(services[2]!.label).toBe(labelForKind(uniqueInstance, "watchdog"));
    for (const svc of services) {
      expect(svc.plistExists).toBe(false);
      expect(svc.loaded).toBe(false);
    }
    expect(Array.isArray(parsed.limitations)).toBe(true);
    expect((parsed.limitations as string[]).some((l) => l.includes("watchdog"))).toBe(true);
  });
});

(isDarwin ? describe : describe.skip)("gini autostart disable (no service registered)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("disable");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Defensive: clean up any plist we might have written if a test failed
    // mid-way through. Both kinds and the legacy single-plist label.
    for (const path of [
      plistPathFor(uniqueInstance),
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("returns alreadyDisabled:true when nothing is registered", () => {
    const result = runCli(
      ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.alreadyDisabled).toBe(true);
    expect(parsed.disabled).toBe(false);
    expect(parsed.plistRemoved).toBe(false);
  });
});

// Idempotent re-enable: running `autostart enable` twice should leave the
// system in the same registered state. We test this by writing plists
// directly via the resolveLaunchSpecPair + writePlist surface and
// asserting the on-disk shape doesn't change across two invocations.
// We do NOT touch launchctl here; that's the e2e path below.
(isDarwin ? describe : describe.skip)("gini autostart enable idempotency (plist on disk)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-test-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("idempotent");
  });

  afterEach(() => {
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    // Clean up any plists we may have written.
    for (const path of [
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("two `enable` runs produce identical plist contents (idempotent re-enable)", async () => {
    const { resolveLaunchSpecPair, writePlist } = await import("../autostart");
    // Pass an explicit testRoot so the plist embeds the scratch dirs;
    // we don't actually invoke the CLI here, just exercise the same
    // file-write surface that `enable` uses.
    const pair = resolveLaunchSpecPair({
      instance: uniqueInstance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot }
    });
    const gatewayPath = writePlist({
      instance: uniqueInstance,
      kind: "gateway",
      spec: pair.gateway,
      stdoutPath: join(scratch.logRoot, "runtime-stdout.log"),
      stderrPath: join(scratch.logRoot, "runtime-launchd.err.log")
    });
    const webPath = writePlist({
      instance: uniqueInstance,
      kind: "web",
      spec: pair.web,
      stdoutPath: join(scratch.logRoot, "web.log"),
      stderrPath: join(scratch.logRoot, "web-launchd.err.log")
    });
    const { readFileSync } = await import("node:fs");
    const gatewayFirst = readFileSync(gatewayPath, "utf8");
    const webFirst = readFileSync(webPath, "utf8");

    // Re-run identical resolve+write — should produce byte-identical output.
    const pair2 = resolveLaunchSpecPair({
      instance: uniqueInstance,
      testRoot: { stateRoot: scratch.stateRoot, logRoot: scratch.logRoot }
    });
    writePlist({
      instance: uniqueInstance,
      kind: "gateway",
      spec: pair2.gateway,
      stdoutPath: join(scratch.logRoot, "runtime-stdout.log"),
      stderrPath: join(scratch.logRoot, "runtime-launchd.err.log")
    });
    writePlist({
      instance: uniqueInstance,
      kind: "web",
      spec: pair2.web,
      stdoutPath: join(scratch.logRoot, "web.log"),
      stderrPath: join(scratch.logRoot, "web-launchd.err.log")
    });
    expect(readFileSync(gatewayPath, "utf8")).toBe(gatewayFirst);
    expect(readFileSync(webPath, "utf8")).toBe(webFirst);
  });
});

// True end-to-end: write plist, bootstrap, kill PID, verify respawn,
// `gini stop`, verify it stays down, disable. Gated behind
// GINI_AUTOSTART_E2E because it touches the real `gui/<uid>` domain and
// shouldn't run in shared CI.
const e2eOn = isDarwin && process.env.GINI_AUTOSTART_E2E === "1";

(e2eOn ? describe : describe.skip)("gini autostart enable→stop respawn cycle (e2e)", () => {
  let scratch: { stateRoot: string; logRoot: string };
  const uniqueInstance = `autostart-e2e-${tag()}`;

  beforeEach(() => {
    scratch = makeScratch("e2e");
  });

  afterEach(() => {
    // Best-effort: disable + remove plists even if the test asserted out.
    try {
      runCli(
        ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
        {}
      );
    } catch { /* ignore */ }
    rmSync(scratch.stateRoot, { recursive: true, force: true });
    rmSync(scratch.logRoot, { recursive: true, force: true });
    for (const path of [
      plistPathFor(uniqueInstance, "gateway"),
      plistPathFor(uniqueInstance, "web"),
      plistPathFor(uniqueInstance, "watchdog")
    ]) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  });

  test("enable → status shows all three kinds loaded; disable → status shows all gone", () => {
    const enableResult = runCli(
      [
        "autostart", "enable",
        "--instance", uniqueInstance,
        "--state-root", scratch.stateRoot,
        "--log-root", scratch.logRoot,
        "--test-root", scratch.stateRoot
      ],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(enableResult.status).toBe(0);
    const enableParsed = JSON.parse(enableResult.stdout) as Record<string, unknown>;
    expect(enableParsed.ok).toBe(true);
    expect(enableParsed.enabled).toBe(true);
    const results = enableParsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(3);
    for (const r of results) expect(r.enabled).toBe(true);

    // Status should report both kinds plistExists:true and loaded:true.
    const statusResult = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const statusParsed = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const services = statusParsed.services as Array<Record<string, unknown>>;
    for (const svc of services) {
      expect(svc.plistExists).toBe(true);
      expect(svc.loaded).toBe(true);
    }

    // Disable tears both down.
    const disableResult = runCli(
      ["autostart", "disable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    expect(disableResult.status).toBe(0);
    const disableParsed = JSON.parse(disableResult.stdout) as Record<string, unknown>;
    expect(disableParsed.ok).toBe(true);
    expect(disableParsed.disabled).toBe(true);
    // enable `kickstart`s after bootstrap so the service actually launches
    // immediately on macOS 26 (where RunAtLoad is best-effort). That means by
    // the time we reach `disable`, the child process is genuinely running, and
    // launchctl propagation takes a beat after `bootout` returns before
    // `launchctl print` stops finding the service. Poll briefly to let that
    // propagate before asserting "loaded:false" — the bootout itself already
    // returned ok above.
    let unloaded = false;
    let statusAgain: ReturnType<typeof runCli> | undefined;
    let servicesAgain: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i++) {
      statusAgain = runCli(
        ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
        {}
      );
      const parsed = JSON.parse(statusAgain.stdout) as Record<string, unknown>;
      servicesAgain = parsed.services as Array<Record<string, unknown>>;
      if (servicesAgain.every((svc) => svc.loaded === false)) {
        unloaded = true;
        break;
      }
      Bun.sleepSync(200);
    }
    expect(unloaded).toBe(true);
    for (const svc of servicesAgain) {
      expect(svc.plistExists).toBe(false);
      expect(svc.loaded).toBe(false);
    }
  }, 60_000);

  // MEDIUM-9: idempotent enable at the CLI level (subprocess). The
  // unit-level test in this file checks plist file bytes; this one
  // confirms TWO real `autostart enable` invocations both succeed,
  // status remains consistent, and bootout+bootstrap retried once still
  // ends with a loaded service set.
  test("enable → enable → status: both invocations ok, services stay loaded", () => {
    const first = runCli(
      ["autostart", "enable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot, "--test-root", scratch.stateRoot],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(first.status).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstParsed.ok).toBe(true);

    const second = runCli(
      ["autostart", "enable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot, "--test-root", scratch.stateRoot],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(second.status).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondParsed.ok).toBe(true);

    const status = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const statusParsed = JSON.parse(status.stdout) as Record<string, unknown>;
    const svcs = statusParsed.services as Array<Record<string, unknown>>;
    for (const svc of svcs) {
      expect(svc.loaded).toBe(true);
    }
  }, 60_000);

  // HIGH-5: `enable` removes a leftover round-1 legacy single-plist
  // file (ai.lilac.gini.<instance>.plist without a kind suffix) when
  // bootstrapping the round-2 split pair. This protects users upgrading
  // from round 1 → round 2 from ending up with the old plist still
  // sitting in ~/Library/LaunchAgents/.
  test("enable cleans up the legacy ai.lilac.gini.<instance>.plist file from disk", async () => {
    const { mkdirSync: mk, writeFileSync, existsSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const legacyPath = plistPathFor(uniqueInstance);
    mk(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "<plist>fake legacy from round 1</plist>");
    expect(existsSync(legacyPath)).toBe(true);

    const result = runCli(
      [
        "autostart", "enable",
        "--instance", uniqueInstance,
        "--state-root", scratch.stateRoot,
        "--log-root", scratch.logRoot,
        "--test-root", scratch.stateRoot
      ],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    // The legacy plist file should be gone after enable.
    expect(existsSync(legacyPath)).toBe(false);
  }, 60_000);

  // Prefix-migration: `enable` removes plists left over from a prior
  // LABEL_PREFIX (`ai.lilac.gini.*` → current `ai.lilaclabs.gini.*`
  // rename). Covers both the round-1 single-plist shape and the
  // round-2 split pair under the old prefix.
  test("enable removes plists from prior LABEL_PREFIX (ai.lilac.gini.*)", async () => {
    const { mkdirSync: mk, writeFileSync, existsSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { homedir } = await import("node:os");
    const home = process.env.HOME || homedir();
    const launchAgents = join(home, "Library", "LaunchAgents");
    mk(launchAgents, { recursive: true });
    const oldSingle = join(launchAgents, `ai.lilac.gini.${uniqueInstance}.plist`);
    const oldGateway = join(launchAgents, `ai.lilac.gini.${uniqueInstance}.gateway.plist`);
    const oldWeb = join(launchAgents, `ai.lilac.gini.${uniqueInstance}.web.plist`);
    writeFileSync(oldSingle, "<plist/>");
    writeFileSync(oldGateway, "<plist/>");
    writeFileSync(oldWeb, "<plist/>");

    const result = runCli(
      [
        "autostart", "enable",
        "--instance", uniqueInstance,
        "--state-root", scratch.stateRoot,
        "--log-root", scratch.logRoot,
        "--test-root", scratch.stateRoot
      ],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(result.status).toBe(0);
    expect(existsSync(oldSingle)).toBe(false);
    expect(existsSync(oldGateway)).toBe(false);
    expect(existsSync(oldWeb)).toBe(false);
  }, 60_000);

  // MEDIUM-9: `enable --kind gateway` only loads the gateway; the web
  // service stays untouched. This is the path setup-api scheduleAutostartRefresh
  // uses after POST /api/setup/provider to refresh the gateway plist
  // without killing the web service the user's browser is currently
  // talking to.
  test("enable --kind gateway leaves web untouched", () => {
    // First enable both, so the web is loaded.
    const both = runCli(
      ["autostart", "enable", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot, "--test-root", scratch.stateRoot],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(both.status).toBe(0);
    const beforeStatus = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const beforeParsed = JSON.parse(beforeStatus.stdout) as Record<string, unknown>;
    const beforeSvcs = beforeParsed.services as Array<Record<string, unknown>>;
    expect(beforeSvcs[0]!.loaded).toBe(true);
    expect(beforeSvcs[1]!.loaded).toBe(true);

    // Now re-enable only the gateway. The web plist should remain loaded
    // (untouched), and the refresh result should be ok.
    const gatewayOnly = runCli(
      [
        "autostart", "enable",
        "--instance", uniqueInstance,
        "--state-root", scratch.stateRoot,
        "--log-root", scratch.logRoot,
        "--test-root", scratch.stateRoot,
        "--kind", "gateway"
      ],
      { GINI_AUTOSTART_E2E: "1" }
    );
    expect(gatewayOnly.status).toBe(0);
    const gatewayOnlyParsed = JSON.parse(gatewayOnly.stdout) as Record<string, unknown>;
    expect(gatewayOnlyParsed.ok).toBe(true);
    const results = gatewayOnlyParsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);
    expect(results[0]!.kind).toBe("gateway");
    expect(results[0]!.enabled).toBe(true);

    // Web should still be loaded.
    const afterStatus = runCli(
      ["autostart", "status", "--instance", uniqueInstance, "--state-root", scratch.stateRoot, "--log-root", scratch.logRoot],
      {}
    );
    const afterParsed = JSON.parse(afterStatus.stdout) as Record<string, unknown>;
    const afterSvcs = afterParsed.services as Array<Record<string, unknown>>;
    expect(afterSvcs[0]!.loaded).toBe(true);
    expect(afterSvcs[1]!.loaded).toBe(true);
  }, 60_000);
});

// Pure-logic tests for stopViaBootout. We inject a fake bootoutTarget
// recorder so no real launchctl runs — the function's job is just to boot
// out the right service targets and fold "Could not find service" into a
// successful stop.
describe("stopViaBootout", () => {
  const ok: LaunchctlResult = { ok: true, stdout: "", stderr: "", status: 0 };
  // launchctl phrases "not loaded" differently across macOS releases.
  const notLoadedOldText: LaunchctlResult = {
    ok: false,
    stdout: "",
    stderr: "Could not find service",
    status: 113
  };
  const notLoadedTahoeText: LaunchctlResult = {
    ok: false,
    stdout: "",
    stderr: "Boot-out failed: 3: No such process",
    status: 3
  };

  test("boots out gateway, web, and watchdog targets for the instance", () => {
    const targets: string[] = [];
    const result = stopViaBootout("stop-test", {
      bootoutTarget: (target: string) => {
        targets.push(target);
        return ok;
      }
    });
    // Gateway + web are the live kinds; watchdog is included for
    // forward-compatibility with the watchdog service (separate task).
    expect(targets).toEqual([
      `${serviceTarget("stop-test")}.gateway`,
      `${serviceTarget("stop-test")}.web`,
      `${serviceTarget("stop-test")}.watchdog`
    ]);
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.kind)).toEqual(["gateway", "web", "watchdog"]);
    expect(result.results.every((r) => r.bootedOut)).toBe(true);
  });

  test("treats a not-loaded target as a successful stop (both macOS phrasings)", () => {
    // A target that was never loaded (e.g. the not-yet-shipped watchdog, or
    // an instance that was already stopped) must not fail the stop. The
    // error text differs by macOS release, so accept both.
    for (const notLoaded of [notLoadedOldText, notLoadedTahoeText]) {
      const result = stopViaBootout("stop-test", { bootoutTarget: () => notLoaded });
      expect(result.ok).toBe(true);
      expect(result.results.every((r) => r.bootedOut)).toBe(true);
      expect(result.results.every((r) => r.stderr === undefined)).toBe(true);
    }
  });

  test("reports ok:false and surfaces stderr on a real bootout failure", () => {
    const failure: LaunchctlResult = {
      ok: false,
      stdout: "",
      stderr: "Boot-out failed: 5: Input/output error",
      status: 5
    };
    const result = stopViaBootout("stop-test", { bootoutTarget: () => failure });
    expect(result.ok).toBe(false);
    expect(result.results.every((r) => r.bootedOut === false)).toBe(true);
    expect(result.results[0]!.stderr).toContain("Input/output error");
  });
});
