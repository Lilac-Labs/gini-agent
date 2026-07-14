// Unit tests for the pure-logic side of src/cli/autostart.ts.
//
// Real `launchctl bootstrap`/`bootout` flows are exercised by the manual
// e2e test the developer runs on the dev machine — those need `gui/<uid>`
// which CI runners (headless) don't have. Pure logic (plist XML, label /
// path derivation, wrapper detection, source-vs-installed flow selection)
// is fully covered here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GINI_SUPERVISOR_VALUE,
  LABEL_PREFIX,
  computePlistStamp,
  generatePlist,
  guiDomain,
  labelFor,
  plistStampInput,
  plistPathFor,
  readPlistStamp,
  readPlistWorkingDirectory,
  resolveLaunchSpec,
  resolveLaunchSpecPair,
  serviceTarget,
  supervisedServices,
  supervisor,
  writePlist,
  type LaunchSpec,
  type PlistKind
} from "./autostart";

function makeTempHome(tag: string): string {
  const path = `/tmp/gini-autostart-tests/${tag}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

describe("labelFor / plistPathFor", () => {
  test("label is namespaced under the gini prefix", () => {
    expect(labelFor("dev")).toBe(`${LABEL_PREFIX}.dev`);
    expect(labelFor("main")).toBe(`${LABEL_PREFIX}.main`);
    expect(labelFor("feature-x")).toBe(`${LABEL_PREFIX}.feature-x`);
  });

  test("plist path lives in ~/Library/LaunchAgents and ends with .plist", () => {
    const path = plistPathFor("dev");
    expect(path).toContain("/Library/LaunchAgents/");
    expect(path.endsWith(`${LABEL_PREFIX}.dev.plist`)).toBe(true);
  });
});

describe("serviceTarget / guiDomain", () => {
  test("service target combines gui/<uid> with the label", () => {
    const target = serviceTarget("dev");
    expect(target.startsWith(guiDomain() + "/")).toBe(true);
    expect(target.endsWith(`/${LABEL_PREFIX}.dev`)).toBe(true);
  });

  test("guiDomain uses the current uid", () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(guiDomain()).toBe(`gui/${uid}`);
  });
});

describe("resolveLaunchSpec", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("resolve");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // A neutral cwd that isn't a gini-agent checkout — so resolveLaunchSpec
  // does NOT take the source-flow branch unless we explicitly point it
  // at one. Without this, the test suite running from the repo cwd would
  // always prefer source flow (the cwd-is-source-checkout branch).
  const neutralCwd = "/tmp/gini-autostart-tests-neutral-cwd";

  test("uses ~/.gini/runtime as workingDirectory when a runtime checkout exists and cwd is not a checkout", () => {
    mkdirSync(join(home, ".gini", "runtime", "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');
    writeFileSync(join(home, ".gini", "runtime", "packages", "runtime", "src", "server.ts"), "// stub\n");

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      cwdOverride: neutralCwd,
      projectRootOverride: neutralCwd
    });

    // Direct exec of bun against the server entry — no wrapper, no CLI
    // layer. Single-process job so the launchd-tracked PID is the runtime
    // itself and KeepAlive respawns it on any exit.
    expect(spec.programArguments).toEqual([
      "/Users/test/.bun/bin/bun",
      "run",
      "packages/runtime/src/server.ts",
      "--instance",
      "main"
    ]);
    expect(spec.workingDirectory).toBe(join(home, ".gini", "runtime"));
    expect(spec.environment.GINI_INSTANCE).toBe("main");
    expect(spec.environment.PATH).toContain("/Users/test/.bun/bin");
    expect(spec.environment.PATH).toContain(join(home, ".local", "bin"));
    expect(spec.environment.HOME).toBe(home);
  });

  test("falls back to repo root when ~/.gini/runtime is not a runtime checkout", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });

    expect(spec.programArguments[0]).toBe("/opt/bun/bin/bun");
    expect(spec.programArguments).toContain("run");
    expect(spec.programArguments).toContain("packages/runtime/src/server.ts");
    expect(spec.programArguments).toContain("--instance");
    expect(spec.programArguments).toContain("dev");
    expect(spec.workingDirectory).toBe("/repo/gini");
    expect(spec.environment.GINI_INSTANCE).toBe("dev");
    expect(spec.environment.PATH).toContain("/opt/bun/bin");
  });

  test("falls back to repo root when runtime dir lacks packages/runtime/src/server.ts (stale install)", () => {
    // package.json present but no packages/runtime/src/server.ts → not a usable checkout.
    mkdirSync(join(home, ".gini", "runtime"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/Users/test/.bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });

    expect(spec.workingDirectory).toBe("/repo/gini");
  });

  test("prefers source flow when cwd is a gini-agent checkout (even if ~/.gini/runtime exists)", () => {
    // Installed runtime is present and usable…
    mkdirSync(join(home, ".gini", "runtime", "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(home, ".gini", "runtime", "package.json"), '{"name":"gini-agent"}');
    writeFileSync(join(home, ".gini", "runtime", "packages", "runtime", "src", "server.ts"), "// stub\n");
    // …but cwd is a source checkout.
    const sourceCwd = join(home, "Dev", "gini-agent");
    mkdirSync(sourceCwd, { recursive: true });
    writeFileSync(join(sourceCwd, "package.json"), '{"name":"gini-agent"}');

    const spec = resolveLaunchSpec({
      instance: "feature-x",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/some/other/repo/root",
      cwdOverride: sourceCwd
    });

    // Source flow wins — we use the cwd, not ~/.gini/runtime.
    expect(spec.workingDirectory).toBe(sourceCwd);
  });

  test("propagates testRoot.{stateRoot,logRoot} into plist env when passed (E2E-only)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      testRoot: { stateRoot: "/tmp/scratch-state", logRoot: "/tmp/scratch-logs" }
    });
    expect(spec.environment.GINI_STATE_ROOT).toBe("/tmp/scratch-state");
    expect(spec.environment.GINI_LOG_ROOT).toBe("/tmp/scratch-logs");
  });

  test("does NOT leak shell GINI_STATE_ROOT into plist env when testRoot is unset (production default)", () => {
    const prevState = process.env.GINI_STATE_ROOT;
    const prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = "/tmp/leak-state";
    process.env.GINI_LOG_ROOT = "/tmp/leak-logs";
    try {
      const spec = resolveLaunchSpec({
        instance: "dev",
        homeOverride: home,
        bunPathOverride: "/opt/bun/bin/bun",
        projectRootOverride: "/repo/gini",
        cwdOverride: neutralCwd
      });
      // No testRoot opt-in → no leak. Guards against shell env vars
      // baking into the persistent plist; GINI_STATE_ROOT in the
      // developer's shell must never survive into a LaunchAgent record.
      expect(spec.environment.GINI_STATE_ROOT).toBeUndefined();
      expect(spec.environment.GINI_LOG_ROOT).toBeUndefined();
    } finally {
      if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
      else process.env.GINI_STATE_ROOT = prevState;
      if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
      else process.env.GINI_LOG_ROOT = prevLog;
    }
  });

  test("merges secrets.env into gateway plist EnvironmentVariables (OPENAI_API_KEY)", () => {
    const secretsBody = [
      "# comment",
      "export OPENAI_API_KEY='sk-test-12345'",
      "BARE_KEY=bare-value",
      "QUOTED=\"with spaces\""
    ].join("\n");
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => secretsBody
    });
    expect(spec.environment.OPENAI_API_KEY).toBe("sk-test-12345");
    expect(spec.environment.BARE_KEY).toBe("bare-value");
    expect(spec.environment.QUOTED).toBe("with spaces");
  });

  test("does not put secrets into env when secrets.env is missing", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => null
    });
    expect(spec.environment.OPENAI_API_KEY).toBeUndefined();
  });

  test("merges login-shell PATH into plist PATH (nvm / asdf / volta visibility)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => "/Users/test/.nvm/versions/node/v20.0.0/bin:/opt/homebrew/bin",
      mergeShellPath: true
    });
    // bunDir stays at position 0 so the web shim can't be coerced into
    // running a shell-provided bun. nvm bin is inserted right after,
    // ahead of the rest of the base, so it still wins over the system
    // dirs for any node lookup.
    expect(spec.environment.PATH.startsWith(
      "/opt/bun/bin:/Users/test/.nvm/versions/node/v20.0.0/bin:"
    )).toBe(true);
    expect(spec.environment.PATH).toContain(join(home, ".local", "bin"));
  });

  test("falls back to base PATH when the login-shell reader returns null", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => null,
      mergeShellPath: true
    });
    // No nvm dir, no shell-additions. Base launchd PATH still intact.
    expect(spec.environment.PATH).not.toContain(".nvm");
    expect(spec.environment.PATH).toContain("/opt/bun/bin");
  });

  test("does not invoke the login shell when an explicit reader is omitted under test", () => {
    // Sanity: tests that don't opt in to shell-PATH-merge shouldn't pay the
    // spawn cost or pick up developer-shell quirks. We assert by checking
    // the base PATH stays exactly what buildLaunchAgentPath would produce
    // without a reader.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });
    // No nvm path should appear unless we explicitly asked for it.
    expect(spec.environment.PATH).not.toContain(".nvm");
  });

  test("does not invoke the login shell when mergeShellPath is false (status / disable / kick paths)", () => {
    // resolveLaunchSpecPair is called by read-only paths (status,
    // disable, kick) as well as enable. Read-only callers must not
    // spawn the user's interactive shell; the gate keeps them silent.
    // A counting reader proves it was never invoked.
    let calls = 0;
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => {
        calls += 1;
        return "/Users/test/.nvm/bin";
      },
      mergeShellPath: false
    });
    expect(calls).toBe(0);
    expect(spec.environment.PATH).not.toContain(".nvm");
  });

  test("bakes SHELL into the gateway plist so refresh respawns can re-read it", () => {
    // The autostart-refresh flow runs `gini autostart enable --kind
    // gateway` as a launchd-spawned child of the gateway. Without
    // SHELL in the plist's EnvironmentVariables, the child's
    // process.env.SHELL is unset and the regenerated plist drops the
    // nvm/asdf merge from first enable. Pin SHELL so refresh keeps
    // the user's interactive PATH discoverable across respawns.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      loginShellReader: () => "/Users/test/.nvm/bin",
      mergeShellPath: true
    });
    expect(spec.environment.SHELL).toBe("/bin/zsh");
  });

  test("omits SHELL from the plist when neither loginShell nor process.env.SHELL is set", () => {
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const spec = resolveLaunchSpec({
        instance: "dev",
        homeOverride: home,
        bunPathOverride: "/opt/bun/bin/bun",
        projectRootOverride: "/repo/gini",
        cwdOverride: neutralCwd
      });
      expect(spec.environment.SHELL).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SHELL = prev;
    }
  });

  test("omits SHELL from the plist when the configured shell does not exist on disk", () => {
    // A stale or garbage $SHELL must not survive into the LaunchAgent's
    // EnvironmentVariables — children of the gateway would inherit it
    // and break in surprising ways. Gate on file existence.
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/no/such/shell/at/this/path",
      // fileExists is the resolveLaunchSpec test seam; treat the bogus
      // path (and only that path) as absent. The real bun + plist
      // files still need to look present so other branches don't error.
      fileExists: (p: string) => p !== "/no/such/shell/at/this/path"
    });
    expect(spec.environment.SHELL).toBeUndefined();
  });

  test("keeps bunDir at the head of PATH when the shell merge adds entries (no bun shadowing)", () => {
    const spec = resolveLaunchSpec({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      loginShell: "/bin/zsh",
      // Shell PATH puts a different bun ahead of nvm. The merged PATH
      // must still resolve `bun` to /opt/bun/bin first.
      loginShellReader: () =>
        "/Users/test/.brew/bin:/Users/test/.nvm/versions/node/v20.0.0/bin",
      mergeShellPath: true
    });
    expect(spec.environment.PATH.startsWith("/opt/bun/bin:")).toBe(true);
    // Shell additions land right after bunDir, ahead of the rest of the base.
    expect(spec.environment.PATH).toContain("/opt/bun/bin:/Users/test/.brew/bin:");
  });

  test("web shim execs the absolute bun path so gateway + web share a Bun", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd
    });
    // sh -c <shim> — the shim's last line execs the resolved bun, not
    // bare `bun`. Without this, a shell-provided bun in the plist PATH
    // could drive the web dev server while the gateway runs under a
    // different Bun.
    const shim = pair.web.programArguments[pair.web.programArguments.length - 1] ?? "";
    expect(shim).toContain(`exec "/opt/bun/bin/bun" run dev -- -H 127.0.0.1`);
    expect(shim).not.toMatch(/exec bun run dev/m);
  });

  test("buildWebShim rejects bunPath with shell-special characters", async () => {
    const { __testing } = await import("./autostart");
    expect(() => __testing.buildWebShim("dev", "/opt/bun;rm -rf /")).toThrow();
    expect(() => __testing.buildWebShim("dev", "/opt/bun bin/bun")).toThrow();
    expect(() => __testing.buildWebShim("dev", "/opt/bun/bin/bun")).not.toThrow();
  });

  // The Next.js BFF only proxies to the gateway over /api/*; it never
  // invokes a provider directly. Provider secrets in the web plist's
  // EnvironmentVariables would widen the secret-exposure surface for zero gain,
  // so they belong in the gateway plist only.
  test("does NOT merge secrets.env into web plist EnvironmentVariables", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const secretsBody = [
      "export OPENAI_API_KEY='sk-test-web-isolation'",
      "BARE_KEY=bare-value"
    ].join("\n");
    const pair = resolveLaunchSpecPair({
      instance: "dev",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: neutralCwd,
      readSecretsFile: () => secretsBody
    });
    // Gateway gets the secrets.
    expect(pair.gateway.environment.OPENAI_API_KEY).toBe("sk-test-web-isolation");
    expect(pair.gateway.environment.BARE_KEY).toBe("bare-value");
    // Web must not.
    expect(pair.web.environment.OPENAI_API_KEY).toBeUndefined();
    expect(pair.web.environment.BARE_KEY).toBeUndefined();
  });

});

describe("resolveLaunchSpecPair", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("pair");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("web spec is a sh -c shim that gates on /api/status before exec'ing Next.js", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.programArguments[0]).toBe("/bin/sh");
    expect(pair.web.programArguments[1]).toBe("-c");
    const shim = pair.web.programArguments[2]!;
    expect(shim).toContain("/api/status");
    // Shim execs the resolved absolute bunPath (not bare `bun`) so a
    // shell-provided bun on the launchd PATH can't run a different
    // binary than the gateway — and binds loopback (`next dev` defaults
    // to 0.0.0.0 like `next start`).
    expect(shim).toContain(`exec "/opt/bun/bin/bun" run dev -- -H 127.0.0.1`);
    // Polls the gateway port file under the state root.
    expect(shim).toContain("instances/main/runtime.port");
  });

  test("web shim serves the sha-keyed prod bundle on loopback, with dev fallback", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    const shim = pair.web.programArguments[2]!;
    // The prod pick is keyed on the CURRENT checkout's short sha and gated on
    // next build's completion marker, so a stale or aborted bundle can never
    // be served.
    expect(shim).toContain("git rev-parse --short=12 HEAD");
    expect(shim).toContain(`[ -f ".next-prod-$sha/BUILD_ID" ]`);
    // The prod branch must override the plist's dev dist dir and — SECURITY —
    // pass -H 127.0.0.1: `next start` defaults to 0.0.0.0 and the BFF trusts
    // a loopback Host for owner-bearer injection.
    expect(shim).toContain(`export GINI_DIST_DIR=".next-prod-$sha"`);
    expect(shim).toContain(`exec "/opt/bun/bin/bun" run start -- -H 127.0.0.1`);
    // Dev fallback survives as the unconditional last exec — and it must
    // bind loopback too (`next dev` also defaults to 0.0.0.0).
    expect(shim.trimEnd().endsWith(`exec "/opt/bun/bin/bun" run dev -- -H 127.0.0.1`)).toBe(true);
  });

  test("gateway and web share the same workingDirectory", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral"
    });
    expect(pair.gateway.workingDirectory).toBe(pair.web.workingDirectory);
  });

  test("gateway and web env both carry GINI_SUPERVISOR=launchd", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    // The marker is how a launchd-spawned runtime/web recognizes its
    // supervisor at runtime (supervisor()==="launchd"). Foreground/
    // `gini start` never set it.
    expect(pair.gateway.environment.GINI_SUPERVISOR).toBe("launchd");
    expect(pair.web.environment.GINI_SUPERVISOR).toBe("launchd");
  });

  test("watchdog spec runs `gini watchdog --instance <name>` with the launchd marker", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => "OPENAI_API_KEY=sk-should-not-leak\n"
    });
    expect(pair.watchdog.programArguments).toEqual([
      "/opt/bun/bin/bun",
      "run",
      "gini",
      "watchdog",
      "--instance",
      "main"
    ]);
    expect(pair.watchdog.environment.GINI_SUPERVISOR).toBe("launchd");
    expect(pair.watchdog.environment.GINI_INSTANCE).toBe("main");
    expect(pair.watchdog.workingDirectory).toBe(pair.gateway.workingDirectory);
  });

  test("watchdog env carries NO provider secrets (it never talks to a provider)", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      // A secret here MUST land in the gateway env but never the watchdog env.
      readSecretsFile: () => "OPENAI_API_KEY=sk-secret-value\n"
    });
    expect(pair.gateway.environment.OPENAI_API_KEY).toBe("sk-secret-value");
    expect(pair.watchdog.environment.OPENAI_API_KEY).toBeUndefined();
    // The watchdog also doesn't need the web's Next.js knobs.
    expect(pair.watchdog.environment.PORT).toBeUndefined();
    expect(pair.watchdog.environment.GINI_DIST_DIR).toBeUndefined();
  });

  test("rejects suspicious instance names that could break out of the shell shim", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    expect(() => resolveLaunchSpecPair({
      instance: "bad`name",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral"
    })).toThrow(/refusing to embed instance name/);
  });

  // MEDIUM-C: per-instance Next.js dist dir. Two autostarted instances
  // from the same checkout (e.g. `dev` and `main`) both `bun run dev`
  // from web/, which writes build artifacts to `.next/` by default.
  // Without GINI_DIST_DIR=.next-<instance> in the plist env, they race
  // each other's compile caches. `gini start` already sets this in
  // src/cli/process.ts; the autostart plist MUST mirror it.
  test("web env includes GINI_DIST_DIR=.next-<instance> to avoid Next.js dist-dir races", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.environment.GINI_DIST_DIR).toBe(".next-main");
  });

  test("web env GINI_DIST_DIR sanitizes unsafe characters in the instance name", async () => {
    const { resolveLaunchSpecPair } = await import("./autostart");
    // Names like `feat.x` get punctuation other than [A-Za-z0-9_-]
    // replaced with `_` because Next.js rejects non-relative paths.
    // Match what process.ts does so behavior is consistent between
    // `gini start` and autostart.
    const pair = resolveLaunchSpecPair({
      instance: "feat.x",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    expect(pair.web.environment.GINI_DIST_DIR).toBe(".next-feat_x");
  });
});

// The home of a supervised instance is STICKY: an existing gateway plist's
// WorkingDirectory is preserved across regenerations regardless of the
// invoking process's cwd/projectRoot. Without this, any plist-writing path
// invoked from the wrong directory (reconcile, refresh, a stray `autostart
// enable`) silently re-homes the instance onto that directory — after which
// `gini update`'s work on ~/.gini/runtime never reaches the running services.
describe("resolveLaunchSpecPair (sticky home)", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("sticky-home");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // A usable gini-agent checkout: package.json with name "gini-agent" AND
  // the runtime entry the gateway plist execs.
  function makeUsableCheckout(root: string, name = "gini-agent"): string {
    mkdirSync(join(root, "packages", "runtime", "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), `{"name":"${name}"}`);
    writeFileSync(join(root, "packages", "runtime", "src", "server.ts"), "// stub\n");
    return root;
  }

  test("preserves an existing usable plist home regardless of cwd/projectRoot (the re-homing regression)", () => {
    const previousHome = makeUsableCheckout(join(home, "previous-home"));
    // The caller sits in a DIFFERENT source checkout — the exact situation
    // that used to re-home the instance onto the caller's worktree.
    const callerWorktree = makeUsableCheckout(join(home, "caller-worktree"));

    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: callerWorktree,
      cwdOverride: callerWorktree,
      readPlistWorkingDirectory: () => previousHome
    });

    expect(pair.gateway.workingDirectory).toBe(previousHome);
    expect(pair.web.workingDirectory).toBe(previousHome);
    expect(pair.watchdog.workingDirectory).toBe(previousHome);
    expect(pair.resolution).toBe("source");
  });

  test("a preserved home equal to the installed runtime reports resolution 'installed'", () => {
    const runtimeDir = makeUsableCheckout(join(home, ".gini", "runtime"));
    const callerWorktree = makeUsableCheckout(join(home, "caller-worktree"));

    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: callerWorktree,
      cwdOverride: callerWorktree,
      readPlistWorkingDirectory: () => runtimeDir
    });

    expect(pair.gateway.workingDirectory).toBe(runtimeDir);
    expect(pair.resolution).toBe("installed");
  });

  test("an explicit homeDir overrides a preserved home (the sanctioned mover)", () => {
    const previousHome = makeUsableCheckout(join(home, "previous-home"));
    const newHome = makeUsableCheckout(join(home, "new-home"));

    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/tmp/gini-sticky-neutral",
      cwdOverride: "/tmp/gini-sticky-neutral",
      homeDir: newHome,
      readPlistWorkingDirectory: () => previousHome
    });

    expect(pair.gateway.workingDirectory).toBe(newHome);
    expect(pair.web.workingDirectory).toBe(newHome);
    expect(pair.watchdog.workingDirectory).toBe(newHome);
  });

  test("an invalid homeDir throws instead of silently homing elsewhere", () => {
    // Missing entirely.
    expect(() => resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/tmp/gini-sticky-neutral",
      cwdOverride: "/tmp/gini-sticky-neutral",
      homeDir: join(home, "does-not-exist")
    })).toThrow(/not a usable gini-agent checkout/);
    // Present but a different package (not a gini-agent checkout).
    const otherPackage = makeUsableCheckout(join(home, "other-package"), "some-other-app");
    expect(() => resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/tmp/gini-sticky-neutral",
      cwdOverride: "/tmp/gini-sticky-neutral",
      homeDir: otherPackage
    })).toThrow(/not a usable gini-agent checkout/);
  });

  test("an unusable preserved home falls back to the installed runtime (self-heal)", () => {
    // The plist records a home that no longer exists (a deleted worktree —
    // the crash-loop case this fallback heals). The installed runtime is
    // usable and the caller sits in a neutral cwd.
    makeUsableCheckout(join(home, ".gini", "runtime"));

    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/tmp/gini-sticky-neutral",
      cwdOverride: "/tmp/gini-sticky-neutral",
      readPlistWorkingDirectory: () => join(home, "deleted-worktree")
    });

    expect(pair.gateway.workingDirectory).toBe(join(home, ".gini", "runtime"));
    expect(pair.resolution).toBe("installed");
  });

  test("first enable (no plist) keeps the source-flow preference unchanged", () => {
    const sourceCwd = makeUsableCheckout(join(home, "Dev", "gini-agent"));
    makeUsableCheckout(join(home, ".gini", "runtime"));

    const pair = resolveLaunchSpecPair({
      instance: "main",
      homeOverride: home,
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/some/other/repo/root",
      cwdOverride: sourceCwd,
      readPlistWorkingDirectory: () => null
    });

    expect(pair.gateway.workingDirectory).toBe(sourceCwd);
    expect(pair.resolution).toBe("source");
  });
});

describe("readPlistWorkingDirectory", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempHome("read-wd");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("round-trips the WorkingDirectory generatePlist wrote, including XML-escaped characters", () => {
    // '&' in the path exercises the escape/unescape pair — escapeXml
    // entity-encodes it at write time, so the reader must decode it or a
    // preserved home would drift on every regeneration.
    const workingDirectory = join(home, "checkouts", "gini & co");
    const xml = generatePlist({
      instance: "main",
      kind: "gateway" as PlistKind,
      spec: {
        programArguments: ["/opt/bun/bin/bun", "run", "packages/runtime/src/server.ts", "--instance", "main"],
        workingDirectory,
        environment: { PATH: "/usr/bin", HOME: home, GINI_INSTANCE: "main" }
      },
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    const path = join(home, "gateway.plist");
    writeFileSync(path, xml);
    expect(readPlistWorkingDirectory(path)).toBe(workingDirectory);
  });

  test("returns null for a missing file or a plist without a WorkingDirectory", () => {
    expect(readPlistWorkingDirectory("/tmp/does-not-exist-gini-wd.plist")).toBeNull();
    const noWd = join(home, "no-wd.plist");
    writeFileSync(
      noWd,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>"
    );
    expect(readPlistWorkingDirectory(noWd)).toBeNull();
  });
});

describe("parseSecretsEnv", () => {
  test("parses a mix of export/bare/quoted/comment lines", async () => {
    const { parseSecretsEnv } = await import("./autostart");
    const out = parseSecretsEnv([
      "# header",
      "",
      "export OPENAI_API_KEY='sk-abc'",
      "BARE=bare-value",
      "  WITH_WHITESPACE='quoted with spaces'",
      "QUOTED=\"dq with \\\"escape\\\"\""
    ].join("\n"));
    expect(out.OPENAI_API_KEY).toBe("sk-abc");
    expect(out.BARE).toBe("bare-value");
    expect(out.WITH_WHITESPACE).toBe("quoted with spaces");
    expect(out.QUOTED).toBe('dq with "escape"');
  });

  test("handles single-quote escape sequence (sh ANSI-C quoting)", async () => {
    const { parseSecretsEnv } = await import("./autostart");
    // shellSingleQuote in setup.ts writes `'\''` to escape an embedded single
    // quote inside a single-quoted string. Our parser inverts that.
    const out = parseSecretsEnv(`export TRICKY='val'\\''with'`);
    expect(out.TRICKY).toBe("val'with");
  });
});

describe("supervisor", () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env.GINI_SUPERVISOR;
  });

  afterEach(() => {
    if (prior === undefined) delete process.env.GINI_SUPERVISOR;
    else process.env.GINI_SUPERVISOR = prior;
  });

  test('returns "launchd" when GINI_SUPERVISOR matches the marker', () => {
    process.env.GINI_SUPERVISOR = GINI_SUPERVISOR_VALUE;
    expect(supervisor()).toBe("launchd");
  });

  test("returns null when GINI_SUPERVISOR is unset (foreground/`gini run`)", () => {
    delete process.env.GINI_SUPERVISOR;
    expect(supervisor()).toBeNull();
  });

  test("returns null for an unrelated GINI_SUPERVISOR value", () => {
    process.env.GINI_SUPERVISOR = "systemd";
    expect(supervisor()).toBeNull();
  });
});

describe("generatePlist", () => {
  const baseSpec = {
    programArguments: ["/Users/test/.local/bin/gini", "run", "--instance", "main", "--no-web"],
    workingDirectory: "/Users/test/.gini/runtime",
    environment: { PATH: "/usr/bin", GINI_INSTANCE: "main", HOME: "/Users/test", LANG: "en_US.UTF-8" }
  };

  test("writes a well-formed plist header and Label (legacy single-plist label by default)", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<!DOCTYPE plist PUBLIC");
    expect(xml).toContain(`<string>${LABEL_PREFIX}.main</string>`);
  });

  test("kind:gateway and kind:web produce kind-suffixed labels", () => {
    const gateway = generatePlist({
      instance: "main",
      kind: "gateway",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    const web = generatePlist({
      instance: "main",
      kind: "web",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(gateway).toContain(`<string>${LABEL_PREFIX}.main.gateway</string>`);
    expect(web).toContain(`<string>${LABEL_PREFIX}.main.web</string>`);
  });

  test("KeepAlive is true (always respawn; bootout is the stop mechanism)", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    // KeepAlive:true means launchd respawns on ANY exit — the runtime must
    // stay up across crashes and clean exits alike. Stopping is done via
    // `launchctl bootout` (see `gini stop`), never by a clean exit. A
    // SuccessfulExit dict would let a clean exit keep the service down,
    // which would re-open the orphan/stay-dead failure mode.
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).not.toContain("<key>SuccessfulExit</key>");
    // NetworkState was deliberately omitted — see the comment in
    // generatePlist for why (pended-spawn semaphore prevents respawn).
    expect(xml).not.toContain("<key>NetworkState</key>");
  });

  test("ThrottleInterval defaults to 10 and is overridable", () => {
    const def = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(def).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    const custom = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log",
      throttleIntervalSeconds: 30
    });
    expect(custom).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  test("RunAtLoad is true (start at login)", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("ProgramArguments are emitted in order", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    // Each arg as its own <string>, in order, preserving --instance value.
    const argSection = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(argSection).toBeTruthy();
    const args = (argSection?.[1] ?? "").match(/<string>([^<]*)<\/string>/g) ?? [];
    expect(args.map((s) => s.replace(/<\/?string>/g, ""))).toEqual([
      "/Users/test/.local/bin/gini",
      "run",
      "--instance",
      "main",
      "--no-web"
    ]);
  });

  test("EnvironmentVariables include PATH, HOME, GINI_INSTANCE", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/tmp/out.log",
      stderrPath: "/tmp/err.log"
    });
    const envSection = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    expect(envSection).toBeTruthy();
    const block = envSection?.[1] ?? "";
    expect(block).toContain("<key>PATH</key>");
    expect(block).toContain("<key>HOME</key>");
    expect(block).toContain("<key>GINI_INSTANCE</key>");
  });

  test("StdoutPath and StderrPath are recorded verbatim", () => {
    const xml = generatePlist({
      instance: "main",
      spec: baseSpec,
      stdoutPath: "/var/log/gini/main-out.log",
      stderrPath: "/var/log/gini/main-err.log"
    });
    expect(xml).toContain("<string>/var/log/gini/main-out.log</string>");
    expect(xml).toContain("<string>/var/log/gini/main-err.log</string>");
  });

  test("escapes XML special characters in arguments and paths", () => {
    const spec = {
      programArguments: ["/path/with <bad>&chars\"'.exe", "run"],
      workingDirectory: "/some/dir & such",
      environment: { TRICKY: '<"&>\'' }
    };
    const xml = generatePlist({
      instance: "weird-instance",
      spec,
      stdoutPath: "/tmp/<out>.log",
      stderrPath: "/tmp/&err.log"
    });
    // No raw `<` other than legitimate tags. Easiest check: special chars
    // appear in their escaped form.
    expect(xml).toContain("&lt;bad&gt;");
    expect(xml).toContain("&amp;chars");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&apos;");
    expect(xml).toContain("&amp; such");
    expect(xml).toContain("&lt;out&gt;");
  });
});

describe("generatePlist (scheduling shapes)", () => {
  const baseSpec = {
    programArguments: ["/opt/bun/bin/bun", "run", "gini", "watchdog", "--instance", "main"],
    workingDirectory: "/Users/test/.gini/runtime",
    environment: { PATH: "/usr/bin", GINI_INSTANCE: "main", HOME: "/Users/test", LANG: "en_US.UTF-8" }
  };

  test("an explicit startIntervalSeconds emits the periodic shape: StartInterval + RunAtLoad, no KeepAlive", () => {
    // No current kind uses this shape (the watchdog is a long-lived loop —
    // launchd's spawn deferral gapped StartInterval ticks during the very
    // outages the watchdog covers), but the periodic machinery stays for
    // future short-lived jobs where KeepAlive would respawn in a tight loop.
    const xml = generatePlist({
      instance: "main",
      kind: "watchdog",
      spec: baseSpec,
      stdoutPath: "/tmp/watchdog.log",
      stderrPath: "/tmp/watchdog.err.log",
      startIntervalSeconds: 30
    });
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).not.toContain("<key>KeepAlive</key>");
    // ThrottleInterval is a KeepAlive-job knob; the periodic plist drops it.
    expect(xml).not.toContain("<key>ThrottleInterval</key>");
    expect(xml).toContain(`<string>${LABEL_PREFIX}.main.watchdog</string>`);
  });

  test("all three kinds default to the long-lived shape: KeepAlive <true/>, no StartInterval", () => {
    for (const kind of ["gateway", "web", "watchdog"] as const) {
      const xml = generatePlist({
        instance: "main",
        kind,
        spec: baseSpec,
        stdoutPath: "/tmp/out.log",
        stderrPath: "/tmp/err.log"
      });
      expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
      expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
      expect(xml).not.toContain("<key>StartInterval</key>");
    }
  });

  test("the supervisedServices watchdog descriptor carries no startIntervalSeconds (long-lived KeepAlive loop)", () => {
    const services = supervisedServices({
      instance: "main",
      homeOverride: "/Users/test",
      bunPathOverride: "/opt/bun/bin/bun",
      projectRootOverride: "/repo/gini",
      cwdOverride: "/tmp/neutral",
      readSecretsFile: () => null
    });
    const watchdogSvc = services.find((svc) => svc.kind === "watchdog");
    expect(watchdogSvc).toBeDefined();
    // The probe cadence lives in the watchdog's own loop, not in launchd
    // scheduling — its plist must be the KeepAlive long-lived shape.
    expect(watchdogSvc!.startIntervalSeconds).toBeUndefined();
  });
});

describe("computePlistStamp / readPlistStamp", () => {
  // A gateway-shaped spec carrying the full env (PATH, secrets, HOME, the
  // supervision keys). The stamp must depend ONLY on the supervision subset.
  function gatewaySpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
    return {
      programArguments: ["/opt/bun/bin/bun", "run", "packages/runtime/src/server.ts", "--instance", "main"],
      workingDirectory: "/Users/test/.gini/runtime",
      environment: {
        PATH: "/usr/bin:/opt/homebrew/bin",
        HOME: "/Users/test",
        LANG: "en_US.UTF-8",
        SHELL: "/bin/zsh",
        OPENAI_API_KEY: "sk-secret-value",
        GINI_STATE_ROOT: "/tmp/scratch",
        GINI_INSTANCE: "main",
        GINI_SUPERVISOR: GINI_SUPERVISOR_VALUE
      },
      ...overrides
    };
  }

  function gatewayStamp(spec: LaunchSpec): string {
    return computePlistStamp(
      plistStampInput({
        kind: "gateway",
        label: `${LABEL_PREFIX}.main.gateway`,
        spec,
        processType: "Interactive",
        throttleIntervalSeconds: 10,
        startIntervalSeconds: null
      })
    );
  }

  test("identical inputs hash to an identical short hex stamp", () => {
    const a = gatewayStamp(gatewaySpec());
    const b = gatewayStamp(gatewaySpec());
    expect(a).toBe(b);
    // Short hex fingerprint (12 chars).
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changing PATH / a secret value / HOME / log paths yields the SAME stamp (false-positive guard)", () => {
    // This is the loop-safety test. PATH (shell-merged), secret VALUES, HOME,
    // SHELL, and the state/log roots all vary legitimately between machines
    // and between the merge/no-merge code paths. If any of them fed the stamp,
    // a fresh boot would see drift, rewrite + relaunch, boot again, see drift
    // again — an infinite reconcile loop. They must NOT affect the stamp.
    const base = gatewayStamp(gatewaySpec());
    expect(
      gatewayStamp(gatewaySpec({ environment: { ...gatewaySpec().environment, PATH: "/totally/different/path" } }))
    ).toBe(base);
    expect(
      gatewayStamp(gatewaySpec({ environment: { ...gatewaySpec().environment, OPENAI_API_KEY: "sk-rotated-key" } }))
    ).toBe(base);
    expect(
      gatewayStamp(gatewaySpec({ environment: { ...gatewaySpec().environment, HOME: "/Users/other" } }))
    ).toBe(base);
    expect(
      gatewayStamp(gatewaySpec({ environment: { ...gatewaySpec().environment, SHELL: "/bin/bash" } }))
    ).toBe(base);
    expect(
      gatewayStamp(gatewaySpec({ environment: { ...gatewaySpec().environment, GINI_STATE_ROOT: "/tmp/other-scratch" } }))
    ).toBe(base);
  });

  test("changing a supervision-critical field yields a DIFFERENT stamp", () => {
    const base = gatewayStamp(gatewaySpec());
    // A ProgramArgument move (e.g. bun path changes) re-stamps.
    expect(
      gatewayStamp(gatewaySpec({
        programArguments: ["/different/bun", "run", "packages/runtime/src/server.ts", "--instance", "main"]
      }))
    ).not.toBe(base);
    // The supervisor marker disappearing (the exact stale case we heal) re-stamps.
    const noMarker = { ...gatewaySpec().environment };
    delete noMarker.GINI_SUPERVISOR;
    expect(gatewayStamp(gatewaySpec({ environment: noMarker }))).not.toBe(base);
    // WorkingDirectory change re-stamps.
    expect(
      gatewayStamp(gatewaySpec({ workingDirectory: "/somewhere/else" }))
    ).not.toBe(base);
    // The KeepAlive-vs-periodic scheduling shape re-stamps: same spec but
    // computed as the periodic shape.
    const periodic = computePlistStamp(
      plistStampInput({
        kind: "gateway",
        label: `${LABEL_PREFIX}.main.gateway`,
        spec: gatewaySpec(),
        processType: "Interactive",
        throttleIntervalSeconds: null,
        startIntervalSeconds: 30
      })
    );
    expect(periodic).not.toBe(base);
  });

  test("round-trip: writePlist → readPlistStamp returns the same value computePlistStamp produced", () => {
    const home = makeTempHome("stamp-roundtrip");
    try {
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const spec = gatewaySpec();
        const expected = gatewayStamp(spec);
        const path = writePlist({
          instance: "main",
          kind: "gateway" as PlistKind,
          spec,
          stdoutPath: "/tmp/out.log",
          stderrPath: "/tmp/err.log"
        });
        expect(readPlistStamp(path)).toBe(expected);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readPlistStamp returns null for a missing file or a stamp-less plist", () => {
    expect(readPlistStamp("/tmp/does-not-exist-gini-stamp.plist")).toBeNull();
    const home = makeTempHome("stamp-missing");
    try {
      const stampless = join(home, "no-stamp.plist");
      writeFileSync(
        stampless,
        "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>"
      );
      expect(readPlistStamp(stampless)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
