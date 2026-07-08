// Unit tests for the tunnel connectivity behavior module (ADR
// tunnel-connectivity.md). Covers the full TunnelState contract returned by
// every function, the provider catalog, selection validation, the real
// gini-relay connect flow (connecting -> connected / error), cancel,
// disconnect, and the startup reconcile + resume (a previously connected tunnel
// comes back automatically by reusing the stored session) — at 100% line +
// function coverage.
//
// Every gini-relay seam (login primitive, tunnel builder, store, defaults,
// browser opener, local-port resolver) is injected via `setTunnelDeps`, so
// these tests never hit the network, OAuth, the host browser, or a spawned
// frpc child.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitTunnelSettled,
  cancelTunnel,
  connectTunnel,
  defaultLogout,
  defaultOpenBrowser,
  defaultPersistWorkspaceGrant,
  defaultReadCloudflareConfig,
  defaultRunCommand,
  defaultTunnelProcSpawn,
  disconnectTunnel,
  getTunnel,
  makeDefaultDeps,
  makeDefaultDrivers,
  parseCloudflareConfig,
  PROVIDER_UNAVAILABLE,
  reconcileTunnelOnStartup,
  refreshProviderDetection,
  selectProvider,
  setTunnelDeps,
  spawnUrlChild,
  stopAllTunnels,
  type ManualDriver,
  type SpawnedTunnelProc,
  type TunnelChild,
  type TunnelDeps
} from "./tunnel";
import { mutateState, readState } from "../state";
import { addGoogleAccount } from "../state/google-accounts";
import { isRuntimeTunnelHost } from "../lib/origin-trust";
import type { RuntimeConfig, TunnelProviderId } from "../types";
import type { LoginHandle, RelayDefaults, Session, Store, TunnelOptions } from "gini-relay";

const ROOT = `/tmp/gini-tunnel-integration-tests-${import.meta.file}`;

function testConfig(instance: string): RuntimeConfig {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(ROOT, instance, "workspace"),
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// The relay defaults the fake login + tunnel builder echo back. relayDomain
// drives the public url the connected record records.
const RELAY: RelayDefaults = {
  relayUrl: "https://relay.test",
  frpsAddr: "relay.test",
  frpsPort: 7000,
  relayDomain: "relay.test",
  tlsServerName: "relay.test",
  frpToken: "tok",
  caFile: "/tmp/ca.crt",
  loopbackPorts: [8765, 8766, 8767],
  bandwidth: "1220KB"
};

const SESSION: Session = { token: "gsk_abc", subdomain: "subdom7", account: "user@test" };

// A controllable fake frpc child: `start()` resolves (or rejects), `stop()`
// records the call, `exited` never settles unless stopped.
function fakeChild(opts: { startRejects?: Error } = {}): TunnelChild & { stopped: boolean } {
  const exited = Promise.withResolvers<number>();
  return {
    stopped: false,
    start() {
      if (opts.startRejects) return Promise.reject(opts.startRejects);
      return Promise.resolve(this);
    },
    stop() {
      this.stopped = true;
      exited.resolve(0);
      return Promise.resolve(0);
    },
    exited: exited.promise
  };
}

// A child whose `exited` can be resolved on demand to simulate frpc dying on its
// own (crash / relay drop) WITHOUT a stop() call.
function crashableChild(): TunnelChild & { stopped: boolean; crash: (code: number) => void } {
  const exited = Promise.withResolvers<number>();
  return {
    stopped: false,
    start() {
      return Promise.resolve(this);
    },
    stop() {
      this.stopped = true;
      exited.resolve(0);
      return Promise.resolve(0);
    },
    exited: exited.promise,
    crash(code: number) {
      exited.resolve(code);
    }
  };
}

// A child whose stop() REJECTS (best-effort teardown must swallow it). start()
// is gateable; exited never settles on its own.
function rejectStopChild(
  gated = false
): TunnelChild & { releaseStart: () => void; stopCalls: number } {
  const startGate = Promise.withResolvers<void>();
  if (!gated) startGate.resolve();
  const child = {
    stopCalls: 0,
    start() {
      return startGate.promise.then(() => child);
    },
    stop() {
      child.stopCalls += 1;
      return Promise.reject(new Error("stop failed"));
    },
    exited: Promise.withResolvers<number>().promise,
    releaseStart() {
      startGate.resolve();
    }
  };
  return child;
}

// Poll the persisted tunnel status until it reaches `want` (the child-exit
// watcher writes asynchronously). Bounded at 600 * 5ms = 3000ms (under the
// 10000ms per-test cap) so a genuinely stuck state fails fast without flaking
// under CI load.
async function waitForStatus(c: RuntimeConfig, want: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (getTunnel(c).status === want) return;
    await Bun.sleep(5);
  }
  throw new Error(`tunnel status never reached "${want}" (stuck at "${getTunnel(c).status}")`);
}

// A fake store: deviceId is stable; session read/write are no-ops we don't
// assert on (the login primitive is faked, so it never actually persists).
function fakeStore(): Store {
  return {
    home: "/tmp/gini-relay-fake",
    deviceId: () => "device-1",
    readSession: () => SESSION,
    writeSession: () => {},
    clearSession: () => {}
  };
}

// A fake store with NO persisted session, forcing the OAuth login path.
function fakeStoreNoSession(): Store {
  return {
    home: "/tmp/gini-relay-fake",
    deviceId: () => "device-1",
    readSession: () => null,
    writeSession: () => {},
    clearSession: () => {}
  };
}

// Builds a fake LoginHandle whose waitForSession resolves with SESSION by
// default. Overrides let a test make the login hang or reject.
function fakeLoginHandle(over: Partial<LoginHandle> = {}): LoginHandle {
  return {
    url: "https://relay.test/consent?x=1",
    redirectUri: "http://127.0.0.1:8765/cb",
    waitForSession: () => Promise.resolve(SESSION),
    cancel: () => {},
    ...over
  };
}

// Assemble an injectable deps set. Each seam is overridable per test. The
// base set fixes resolveLocalPort to a sentinel; the port-resolution tests
// use `depsNoPort` to exercise the REAL default resolver.
function deps(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  return { ...depsNoPort(), resolveLocalPort: () => 4321, ...over };
}

// Inert manual drivers: detection reports the default-disabled availability
// and connect/disconnect must never run. Every deps set includes these so no
// test can fall through to the REAL drivers and shell out to a host-installed
// tailscale/ngrok/cloudflared (whose presence would also flip catalog rows).
function fakeDrivers(over: Partial<TunnelDeps["drivers"]> = {}): TunnelDeps["drivers"] {
  const inert = (requires: string): ManualDriver => ({
    detect: () => Promise.resolve({ enabled: false, requires }),
    connect: () => Promise.reject(new Error("manual driver connect must not run in this test"))
  });
  return {
    tailscale: inert("Tailscale network"),
    ngrok: inert("ngrok account"),
    cloudflare: inert("cloudflared CLI"),
    ...over
  };
}

// The same seams MINUS resolveLocalPort, so the module's default
// (env override -> gateway port config.port) runs.
function depsNoPort(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  const opened: string[] = [];
  return {
    loginUrl: () => Promise.resolve(fakeLoginHandle()),
    buildTunnel: (_opts: TunnelOptions) => fakeChild(),
    createStore: () => fakeStore(),
    resolveDefaults: () => RELAY,
    openBrowser: (url: string) => {
      opened.push(url);
    },
    probeLocalPort: () => Promise.resolve(true),
    logout: () => Promise.resolve(),
    persistWorkspaceGrant: () => Promise.resolve(),
    drivers: fakeDrivers(),
    ...over
  };
}

// Deps whose store has NO session, so connect must run the browser login flow.
function depsLogin(over: Partial<TunnelDeps> = {}): Partial<TunnelDeps> {
  return { ...deps(), createStore: () => fakeStoreNoSession(), ...over };
}

// ---------------------------------------------------------------------------
// Manual drivers: detection-driven catalog, the manual connect/disconnect/
// resume flows, and the runtime-tunnel origin trust they publish.
// ---------------------------------------------------------------------------

// A manual driver whose detect/connect are scriptable and counted.
function scriptedDriver(over: Partial<ManualDriver> & { requires?: string } = {}): ManualDriver & {
  detects: number;
  connects: number;
  disconnects: number;
} {
  const driver = {
    detects: 0,
    connects: 0,
    disconnects: 0,
    detect() {
      driver.detects += 1;
      return over.detect ? over.detect() : Promise.resolve({ enabled: true });
    },
    connect(port: number, onSpawn?: (kill: () => void) => void) {
      driver.connects += 1;
      return over.connect ? over.connect(port, onSpawn) : Promise.resolve({ url: "https://machine.tail-test.ts.net" });
    },
    disconnect() {
      driver.disconnects += 1;
      return over.disconnect ? over.disconnect() : Promise.resolve();
    }
  };
  return driver;
}

describe("manual tunnel drivers", () => {
  let config: RuntimeConfig;

  // Seed a persisted "connected" record as if the runtime had this provider up
  // before a restart (mirrors the relay reconcile tests' helper, which is
  // scoped to their describe).
  async function seedManualConnected(c: RuntimeConfig, provider: TunnelProviderId): Promise<void> {
    await mutateState(c.instance, (s) => {
      s.tunnel = {
        instance: c.instance,
        selectedProvider: provider,
        status: "connected",
        url: "https://stale.tail-test.ts.net",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
  }

  beforeEach(() => {
    config = testConfig(`m-${Math.random().toString(36).slice(2)}`);
    delete process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS;
    setTunnelDeps(deps());
  });

  afterEach(() => {
    setTunnelDeps();
    delete process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS;
    rmSync(`${ROOT}/instances/${config.instance}`, { recursive: true, force: true });
  });

  test("refreshProviderDetection flips detected rows enabled and drops their requires", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    await refreshProviderDetection();
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId.tailscale.enabled).toBe(true);
    expect(byId.tailscale.requires).toBeUndefined();
    expect(byId.ngrok.enabled).toBe(false);
    expect(byId.ngrok.requires).toBe("ngrok account");
  });

  test("a throwing detect keeps the default-disabled entry", async () => {
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        cloudflare: scriptedDriver({ detect: () => Promise.reject(new Error("spawn ENOENT")) })
      })
    }));
    await refreshProviderDetection();
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId.cloudflare.enabled).toBe(false);
    expect(byId.cloudflare.requires).toBe("cloudflared CLI");
  });

  test("detection results inside the TTL are reused; concurrent callers share one probe", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await Promise.all([refreshProviderDetection(), refreshProviderDetection()]);
    expect(tailscale.detects).toBe(1);
    await refreshProviderDetection(); // within TTL — no new probe
    expect(tailscale.detects).toBe(1);
  });

  test("selecting a manual provider re-probes a stale disabled cache and then succeeds", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    // No prior refresh: the cache still says disabled; select must re-detect.
    const state = await selectProvider(config, "tailscale");
    expect(state.selectedProvider).toBe("tailscale");
    expect(state.status).toBe("idle");
  });

  test("manual connect (childless driver) flips to connected and publishes origin trust", async () => {
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale: scriptedDriver() }) }));
    const connecting = await connectTunnel(config, "tailscale");
    expect(connecting.status).toBe("connecting");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("connected");
    expect(state.url).toBe("https://machine.tail-test.ts.net");
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(true);

    // Disconnect clears the record AND revokes the trusted front, and runs the
    // driver's provider-side teardown instead of the relay logout.
    let loggedOut = 0;
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({
      logout: () => {
        loggedOut += 1;
        return Promise.resolve();
      },
      drivers: fakeDrivers({ tailscale })
    }));
    const after = await disconnectTunnel(config);
    expect(after.status).toBe("idle");
    expect(after.selectedProvider).toBe("tailscale");
    expect(tailscale.disconnects).toBe(1);
    expect(loggedOut).toBe(0);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("manual connect with a child supervises it: a crash flips connected -> error (reconnect disabled)", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "0"; // cleared in afterEach
    const child = crashableChild();
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => Promise.resolve({ url: "https://abc.ngrok-free.app", child }) })
      })
    }));
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).url).toBe("https://abc.ngrok-free.app");
    expect(isRuntimeTunnelHost("abc.ngrok-free.app")).toBe(true);

    child.crash(7);
    await waitForStatus(config, "error");
    expect(getTunnel(config).message).toBe("Tunnel process exited (code 7).");
    expect(isRuntimeTunnelHost("abc.ngrok-free.app")).toBe(false);
  });

  test("a failing manual driver folds its message into the error record", async () => {
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        cloudflare: scriptedDriver({ connect: () => Promise.reject(new Error("cloudflared exited (code 1) before reporting a public URL")) })
      })
    }));
    await connectTunnel(config, "cloudflare");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toContain("cloudflared exited");
  });

  test("manual connect refuses when the web UI is not reachable", async () => {
    setTunnelDeps(deps({
      probeLocalPort: () => Promise.resolve(false),
      drivers: fakeDrivers({ tailscale: scriptedDriver() })
    }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    expect(getTunnel(config).message).toContain("isn't responding on port");
  });

  test("a superseded childless manual connect tears down its provider config instead of publishing", async () => {
    const gate = Promise.withResolvers<void>();
    // The teardown call's failure must be swallowed (best-effort) — reject it
    // so the swallow path actually runs.
    const tailscale = scriptedDriver({
      connect: () => gate.promise.then(() => ({ url: "https://machine.tail-test.ts.net" })),
      disconnect: () => Promise.reject(new Error("serve off failed"))
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    // Capture the in-flight background connect BEFORE cancel tears the
    // supervisor entry down (afterwards awaitTunnelSettled has nothing to wait
    // on and would race the abort path).
    const settled = awaitTunnelSettled(config.instance);
    // Cancel while the driver is mid-connect; it must return promptly (NOT
    // wait behind the parked serve op) and instead queue the provider-side
    // off to land once the in-flight op finishes. Then release the driver.
    await cancelTunnel(config);
    expect(tailscale.disconnects).toBe(0);
    gate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    // Cancel's queued off runs as a queue continuation, concurrent with the
    // abort path `settled` tracks — poll the counter instead of racing it.
    for (let i = 0; tailscale.disconnects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("a teardown during the web-ready probe aborts before the driver ever connects", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({
      probeLocalPort: () => probeGate.promise,
      drivers: fakeDrivers({ tailscale })
    }));
    await connectTunnel(config, "tailscale");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    probeGate.resolve(true);
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(tailscale.connects).toBe(0);
  });

  test("a driver failure after a teardown logs an abort instead of clobbering the idle record", async () => {
    const gate = Promise.withResolvers<never>();
    setTunnelDeps(deps({
      drivers: fakeDrivers({ ngrok: scriptedDriver({ connect: () => gate.promise }) })
    }));
    await connectTunnel(config, "ngrok");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    gate.reject(new Error("agent died"));
    await settled;
    // The superseded run must not write an error over cancel's idle record.
    expect(getTunnel(config).status).toBe("idle");
    expect(getTunnel(config).message).toBeUndefined();
  });

  test("a stale superseded run never tears down the front a NEWER connect just published", async () => {
    // R1 connects (slow driver); cancel supersedes it; R2 connects and
    // publishes. When R1's driver finally resolves, its abort path must SKIP
    // the provider-side teardown — otherwise the serve config R2 just brought
    // up would be yanked while the record reads connected. Cancel's OWN
    // queued off is fine: queue order puts it after R1's serve op and before
    // R2's, so R2's front is published last and survives.
    const r1Gate = Promise.withResolvers<void>();
    let connects = 0;
    const tailscale = scriptedDriver({
      connect: () => {
        connects += 1;
        return connects === 1
          ? r1Gate.promise.then(() => ({ url: "https://machine.tail-test.ts.net" }))
          : Promise.resolve({ url: "https://machine.tail-test.ts.net" });
      }
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));

    await connectTunnel(config, "tailscale"); // R1, parked on r1Gate
    const r1Settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);               // supersede R1; queues the provider-side off behind R1's serve op
    await connectTunnel(config, "tailscale"); // R2 — its serve op queues behind cancel's off
    const r2Settled = awaitTunnelSettled(config.instance);
    r1Gate.resolve();                          // release the queue: R1 aborts, cancel's off runs, R2 publishes
    await r1Settled;
    await r2Settled;
    expect(getTunnel(config).status).toBe("connected");
    // Exactly cancel's off ran — R1's abort path must NOT have added another
    // teardown after R2's publish.
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(true);
  });

  test("a superseded child-backed manual connect stops the child it spawned (a stop failure is swallowed)", async () => {
    const gate = Promise.withResolvers<void>();
    const child = fakeChild();
    let stops = 0;
    // stop() rejecting must not surface — the abort path is best-effort.
    const rejectingChild: TunnelChild = {
      start: () => child.start(),
      stop: () => {
        stops += 1;
        void child.stop();
        return Promise.reject(new Error("kill failed"));
      },
      exited: child.exited
    };
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => gate.promise.then(() => ({ url: "https://abc.ngrok-free.app", child: rejectingChild })) })
      })
    }));
    await connectTunnel(config, "ngrok");
    const settled = awaitTunnelSettled(config.instance);
    await cancelTunnel(config);
    gate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(stops).toBeGreaterThanOrEqual(1);
  });

  test("a childless connect that lands after the shutdown teardown turns its own front off", async () => {
    // Shutdown clears the supervisors WITHOUT bumping the provider-side
    // epoch, so a serve --bg that lands after the teardown is the abort
    // path's to clean up: its deferred off must fire (and a failing off is
    // swallowed).
    const gate = Promise.withResolvers<void>();
    const tailscale = scriptedDriver({
      connect: () => gate.promise.then(() => ({ url: "https://machine.tail-test.ts.net" })),
      disconnect: () => Promise.reject(new Error("serve off failed"))
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    for (let i = 0; tailscale.connects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    const settled = awaitTunnelSettled(config.instance);
    const stopping = stopAllTunnels(); // clears the supervisor synchronously; queues its own off
    gate.resolve();                    // serve --bg lands AFTER the shutdown teardown
    await stopping;
    await settled;
    // Two idempotent offs, both queue-ordered after the serve op: the
    // shutdown sweep's and the aborted run's deferred one.
    for (let i = 0; tailscale.disconnects < 2 && i < 1000; i += 1) await Bun.sleep(1);
    expect(tailscale.disconnects).toBe(2);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("a publish-window failure stops the live child before folding into the error record", async () => {
    // The exit watcher is attached AFTER the connected write; a throw in that
    // window (publish/log machinery) must stop the child it would otherwise
    // orphan — pendingKill is already cleared and no watcher exists yet.
    let stops = 0;
    const child: TunnelChild = {
      start: () => Promise.resolve(0),
      stop: () => {
        stops += 1;
        // The stop is best-effort — its rejection must be swallowed.
        return Promise.reject(new Error("kill failed"));
      },
      get exited(): Promise<number> {
        throw new Error("exit watcher unavailable");
      }
    };
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => Promise.resolve({ url: "https://pub.ngrok-free.app", child }) })
      })
    }));
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toContain("exit watcher unavailable");
    expect(stops).toBe(1);
    // The connected write's trust grant must not survive the error fold.
    expect(isRuntimeTunnelHost("pub.ngrok-free.app")).toBe(false);
  });

  test("a stale selection parked in its re-probe never reverts a newer selection", async () => {
    // select(tailscale) parks in the forced availability re-probe (the cache
    // starts disabled); select(gini-relay) completes meanwhile. The parked
    // select resumes with no supervisor for the write guard to compare — the
    // attempt stamp must make it bail instead of writing the OLDER provider
    // over the user's last action.
    const detectGate = Promise.withResolvers<{ enabled: boolean }>();
    const tailscale = scriptedDriver({ detect: () => detectGate.promise });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    const stale = selectProvider(config, "tailscale"); // parks in refreshProviderDetection
    for (let i = 0; tailscale.detects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    const newer = await selectProvider(config, "gini-relay");
    expect(newer.selectedProvider).toBe("gini-relay");
    detectGate.resolve({ enabled: true }); // the CLI IS available — staleness, not rejection, must stop the write
    const resumed = await stale;
    expect(resumed.selectedProvider).toBe("gini-relay");
    expect(getTunnel(config).selectedProvider).toBe("gini-relay");
  });

  test("disconnect swallows a live child's stop rejection during teardown", async () => {
    const exited = Promise.withResolvers<number>();
    const child: TunnelChild = {
      start: () => Promise.resolve(0),
      stop: () => Promise.reject(new Error("kill failed")),
      exited: exited.promise
    };
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ connect: () => Promise.resolve({ url: "https://abc.ngrok-free.app", child }) })
      })
    }));
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    // teardown()'s best-effort child stop rejects — the rejection must be
    // swallowed and the record still settle to idle.
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
  });

  test("cancel on an ERROR record runs the provider-side off (a failing off is swallowed)", async () => {
    // A partial connect can leave provider-side state up behind an error
    // record; cancel must clean it rather than write idle over it — and a
    // failing off must not block the cancel.
    const tailscale = scriptedDriver({
      connect: () => Promise.reject(new Error("tailscale status failed: down")),
      disconnect: () => Promise.reject(new Error("serve off failed"))
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
  });

  test("re-selecting the SAME provider from an ERROR record cleans provider-side state", async () => {
    const tailscale = scriptedDriver({
      connect: () => Promise.reject(new Error("tailscale status failed: down")),
      disconnect: () => Promise.reject(new Error("serve off failed"))
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    // Same-provider select from error must run the off (and swallow its
    // failure), not silently clear the error record over a live front.
    const state = await selectProvider(config, "tailscale");
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("tailscale");
    expect(tailscale.disconnects).toBe(1);
  });

  test("disconnect still settles idle when the provider-side off fails", async () => {
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
  });

  test("switching away still completes when the old provider's off fails", async () => {
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    const state = await selectProvider(config, "gini-relay");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
  });

  test("a direct connect to another provider still proceeds when the old off fails", async () => {
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    const ngrok = scriptedDriver({
      connect: () => Promise.resolve({ url: "https://xy.ngrok-free.app", child: fakeChild() })
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config)).toMatchObject({ selectedProvider: "ngrok", status: "connected" });
    expect(tailscale.disconnects).toBe(1);
  });

  test("cancel after a childless manual connect already landed tears down the provider state", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    // The UI's Cancel can land after the background connect completed; the
    // serve config must not keep serving while the record reads idle.
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("connecting DIRECTLY to a different provider tears down the old childless manual front", async () => {
    const tailscale = scriptedDriver();
    const ngrok = scriptedDriver({
      connect: () => Promise.resolve({ url: "https://xy.ngrok-free.app", child: fakeChild() })
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    // No selectProvider step — the explicit-provider connect path must run
    // the old provider's teardown itself, or serve keeps running while the
    // record describes ngrok.
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(tailscale.disconnects).toBe(1);
    expect(getTunnel(config)).toMatchObject({ selectedProvider: "ngrok", status: "connected" });
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);
  });

  test("switching away from an ERROR-state manual provider still cleans its provider-side state", async () => {
    // A partial connect (serve up, then failure) leaves an error record with
    // provider-side state live — the switch teardown must include it.
    const tailscale = scriptedDriver({ connect: () => Promise.reject(new Error("dns lookup failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    await selectProvider(config, "gini-relay");
    expect(tailscale.disconnects).toBe(1);
  });

  test("a selection write never clobbers a connect that landed during its teardown await", async () => {
    const disconnectGate = Promise.withResolvers<void>();
    const tailscale = scriptedDriver({ disconnect: () => disconnectGate.promise });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    // The switch to gini-relay parks on the old provider's disconnect; a new
    // tailscale connect lands during that await (its serve op queues behind
    // the parked disconnect, so off-then-on lands in action order). The
    // selection's idle write must yield to the live record (the later user
    // action wins).
    const switching = selectProvider(config, "gini-relay");
    await connectTunnel(config, "tailscale");
    const settled = awaitTunnelSettled(config.instance);
    disconnectGate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("connected");
    await switching;
    expect(getTunnel(config)).toMatchObject({ selectedProvider: "tailscale", status: "connected" });
  });

  test("an explicit detect refresh bypasses the TTL; plain refreshes stay cached", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await refreshProviderDetection();
    expect(tailscale.detects).toBe(1);
    // Within the TTL a plain refresh is a cache hit, but the explicit
    // panel-open/CLI path re-probes — availability is re-checked on every
    // user-initiated look.
    await refreshProviderDetection(true);
    expect(tailscale.detects).toBe(2);
  });

  test("a connect within the detection TTL still re-probes — installing a CLI right before tapping Connect works", async () => {
    let enabled = false;
    const tailscale = scriptedDriver({
      detect: () => Promise.resolve(enabled ? { enabled: true } : { enabled: false, requires: "Tailscale network" })
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await refreshProviderDetection(); // fresh cache: disabled
    enabled = true; // the user installs/logs in seconds later...
    await connectTunnel(config, "tailscale"); // ...and taps Connect within the TTL
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
  });

  test("a connect that resumes from its prep awaits after a NEWER connect ran bails instead of clobbering the winner", async () => {
    // Old provider live so the next connect's prep awaits its teardown.
    const disconnectGates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let disconnectCalls = 0;
    const tailscale = scriptedDriver({
      disconnect: () => disconnectGates[Math.min(disconnectCalls++, 1)]!.promise
    });
    const ngrok = scriptedDriver({ connect: () => Promise.resolve({ url: "https://a.ngrok-free.app", child: fakeChild() }) });
    const cloudflare = scriptedDriver({ connect: () => Promise.resolve({ url: "https://b.example.com", child: fakeChild() }) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok, cloudflare }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);

    // A (ngrok) parks on tailscale's teardown; B (cloudflare) ENTERS after —
    // entering alone supersedes A. When A's prep await releases, A must bail
    // instead of claiming/overwriting; B then proceeds and wins.
    const a = connectTunnel(config, "ngrok");
    // Poll the driver's call counter: disconnect is invoked exactly when A's
    // prep reaches its (parked) teardown await — no blind sleeps.
    for (let i = 0; disconnectCalls < 1 && i < 1000; i += 1) await Bun.sleep(1);
    expect(disconnectCalls).toBe(1);
    // B supersedes A synchronously at entry (the attempt stamp bumps before
    // B's first await); B's own teardown then queues behind A's parked one.
    const b = connectTunnel(config, "cloudflare");
    disconnectGates[0]!.resolve(); // A's prep completes — superseded, bails
    const aState = await a;
    expect(ngrok.connects).toBe(0);
    expect(aState.status).toBe("connected"); // A reports the still-live tailscale state, untouched
    disconnectGates[1]!.resolve(); // B's prep completes — B claims and connects
    await b;
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config)).toMatchObject({ selectedProvider: "cloudflare", status: "connected" });
    expect(ngrok.connects).toBe(0);
  });

  test("a disconnect issued during a connect's prep supersedes it (the connect bails)", async () => {
    const prepGate = Promise.withResolvers<void>();
    let disconnects = 0;
    const tailscale = scriptedDriver({
      disconnect: () => {
        disconnects += 1;
        return disconnects === 1 ? prepGate.promise : Promise.resolve();
      }
    });
    const ngrok = scriptedDriver({ connect: () => Promise.resolve({ url: "https://a.ngrok-free.app", child: fakeChild() }) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);

    const a = connectTunnel(config, "ngrok"); // prep parks on tailscale's teardown
    for (let i = 0; disconnects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    expect(disconnects).toBe(1);
    const d = disconnectTunnel(config); // the user's LAST action
    prepGate.resolve(); // a's prep completes — superseded by the disconnect, bails
    await a;
    await d;
    expect(getTunnel(config).status).toBe("idle");
    expect(ngrok.connects).toBe(0);
  });

  test("a driver with no provider-side disconnect connects outside the serialization queue", async () => {
    // Child-backed drivers (no singleton provider-side state) bypass the
    // per-(instance,provider) op queue — their teardown is the child stop.
    const ngrok: ManualDriver = {
      detect: () => Promise.resolve({ enabled: true }),
      connect: (_port, onSpawn) => {
        onSpawn?.(() => {});
        return Promise.resolve({ url: "https://q.ngrok-free.app", child: fakeChild() });
      }
    };
    setTunnelDeps(deps({ drivers: fakeDrivers({ ngrok }) }));
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
  });

  test("cancel during URL discovery kills the in-flight agent promptly (no orphan, no error write)", async () => {
    // The driver invokes onSpawn the moment its agent spawns (mirroring
    // spawnUrlChild); the kill handle rejects the parked discovery.
    let killed = 0;
    const discovery = Promise.withResolvers<never>();
    const ngrok = scriptedDriver({
      connect: (_port: number, onSpawn?: (kill: () => void) => void) => {
        onSpawn?.(() => {
          killed += 1;
          discovery.reject(new Error("ngrok killed (exit 143)"));
        });
        return discovery.promise;
      }
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ ngrok }) }));
    await connectTunnel(config, "ngrok");
    // Wait until the background flow actually reaches the driver (the agent
    // has spawned and is hunting for its URL) before cancelling.
    for (let i = 0; ngrok.connects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    expect(ngrok.connects).toBe(1);
    const settled = awaitTunnelSettled(config.instance);
    // Cancel lands while the agent is still hunting for its URL: teardown's
    // pendingKill must terminate it NOW, not after the discovery timeout.
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(killed).toBe(1);
    await settled; // the killed connect aborts quietly (no clobbering error)
    expect(getTunnel(config).status).toBe("idle");
  });

  test("stopAllTunnels kills an agent still in URL discovery (a shutdown can't orphan it)", async () => {
    let killed = 0;
    const discovery = Promise.withResolvers<never>();
    const ngrok = scriptedDriver({
      connect: (_port: number, onSpawn?: (kill: () => void) => void) => {
        onSpawn?.(() => {
          killed += 1;
          discovery.reject(new Error("ngrok killed (exit 143)"));
        });
        return discovery.promise;
      }
    });
    setTunnelDeps(deps({ drivers: fakeDrivers({ ngrok }) }));
    await connectTunnel(config, "ngrok");
    for (let i = 0; ngrok.connects < 1 && i < 1000; i += 1) await Bun.sleep(1);
    expect(ngrok.connects).toBe(1);
    // Shutdown mid-discovery: sup.child doesn't exist yet, so only the
    // pendingKill seam can stop the spawned agent before process exit.
    await stopAllTunnels();
    expect(killed).toBe(1);
  });

  test("stopAllTunnels turns serve off for a record still CONNECTING (serve --bg precedes the connected write)", async () => {
    // Park the connect between serve --bg and the DNS lookup: provider-side
    // state is live while the record reads "connecting".
    const dnsGate = Promise.withResolvers<never>();
    const tailscale = scriptedDriver({ connect: () => dnsGate.promise });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    // The connect is parked, so both stopAllTunnels drain races (the pending
    // `settled` and the queued `off`) would otherwise eat the full 2s default
    // shutdown-drain bound. Shrink it — the queued off still fires when the
    // connect rejects below, independent of this timeout.
    const prevDrain = process.env.GINI_TUNNEL_SHUTDOWN_DRAIN_MS;
    process.env.GINI_TUNNEL_SHUTDOWN_DRAIN_MS = "20";
    try {
      await connectTunnel(config, "tailscale");
      for (let i = 0; tailscale.connects < 1 && i < 1000; i += 1) await Bun.sleep(1);
      expect(getTunnel(config).status).toBe("connecting");
      await stopAllTunnels();
      // The off is queued behind the parked connect op, so it lands once the
      // in-flight serve op settles — but it MUST have been issued.
      dnsGate.reject(new Error("shutdown"));
      for (let i = 0; tailscale.disconnects < 1 && i < 1000; i += 1) await Bun.sleep(1);
      expect(tailscale.disconnects).toBe(1);
    } finally {
      if (prevDrain === undefined) delete process.env.GINI_TUNNEL_SHUTDOWN_DRAIN_MS;
      else process.env.GINI_TUNNEL_SHUTDOWN_DRAIN_MS = prevDrain;
    }
  });

  test("reconcile tears provider-side state down when resetting a stale manual CONNECTING record", async () => {
    // A crash mid-connect (after serve --bg, before the connected write)
    // persists "connecting" with serve live; the reset must clean it up.
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await mutateState(config.instance, (state) => {
      state.tunnel = {
        instance: config.instance,
        selectedProvider: "tailscale",
        status: "connecting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    // And no detection probe was awaited for a record that can't resume.
    expect(tailscale.detects).toBe(0);
  });

  test("reconcile still resets a stale connecting record when the provider-side off fails", async () => {
    // The cleanup is best-effort: a failing `serve off` must not leave the
    // record wedged in "connecting" across boots.
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await mutateState(config.instance, (state) => {
      state.tunnel = {
        instance: config.instance,
        selectedProvider: "tailscale",
        status: "connecting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
  });

  test("stopAllTunnels turns childless provider-side state off; the record stays connected for the boot resume", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    await stopAllTunnels();
    // serve must stop fronting the gateway port (whatever binds it next must
    // not inherit the public URL)…
    expect(tailscale.disconnects).toBe(1);
    // …while the persisted record stays connected so the next boot's
    // reconcile re-publishes the same URL.
    expect(getTunnel(config).status).toBe("connected");
  });

  test("disconnect while idle never runs provider-side teardown (protects a pre-existing serve config)", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await selectProvider(config, "tailscale");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    // Gini never started a tunnel — it must not turn off the operator's own
    // tailscale serve config.
    expect(tailscale.disconnects).toBe(0);
  });

  test("disconnect while idle with the relay selected does not log the relay out", async () => {
    let loggedOut = 0;
    setTunnelDeps(deps({
      logout: () => {
        loggedOut += 1;
        return Promise.resolve();
      }
    }));
    await selectProvider(config, "gini-relay");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(loggedOut).toBe(0);
  });

  test("disconnect after a partial manual connect failure (error record) still cleans up provider state", async () => {
    // tailscale serve came up but the DNS lookup failed -> record "error" with
    // provider-side state live; disconnect must be able to clean that up.
    const tailscale = scriptedDriver({ connect: () => Promise.reject(new Error("tailscale status failed: down")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    await disconnectTunnel(config);
    expect(tailscale.disconnects).toBe(1);
  });

  test("reconcile resumes a connected manual tunnel when its driver is still available", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale }) }));
    await seedManualConnected(config, "tailscale");
    const flipped = await reconcileTunnelOnStartup(config);
    expect(flipped.status).toBe("connecting");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(getTunnel(config).url).toBe("https://machine.tail-test.ts.net");
    expect(tailscale.connects).toBe(1);
  });

  // The manual resume gets the same port-ownership gate as the relay: parked on
  // gatewayReady, the driver must not front config.port until THIS process owns
  // it — and once the bind lands, the front returns without ever probing the
  // web child (a slow recompile can't keep it down).
  test("manual resume waits for the gateway port before fronting it, without probing the web child", async () => {
    const ready = Promise.withResolvers<void>();
    let probed = 0;
    const tailscale = scriptedDriver();
    setTunnelDeps(
      deps({
        // The tunnel fronts this process's own gateway port…
        resolveLocalPort: (c) => c.port,
        // …and the web child is still down at resume time. It must never be
        // consulted on this path — the bind is the proof.
        probeLocalPort: () => {
          probed += 1;
          return Promise.resolve(false);
        },
        drivers: fakeDrivers({ tailscale })
      })
    );
    await seedManualConnected(config, "tailscale");
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    // Parked on the bind: still "connecting", the driver has not run.
    expect(getTunnel(config).status).toBe("connecting");
    expect(tailscale.connects).toBe(0);
    ready.resolve();
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(getTunnel(config).url).toBe("https://machine.tail-test.ts.net");
    expect(tailscale.connects).toBe(1);
    expect(probed).toBe(0);
  });

  // A cancel landing while the manual resume is parked on gatewayReady bails
  // without running the driver and without clobbering the cancel's idle.
  test("manual resume bails if cancelled while waiting for the gateway port", async () => {
    const ready = Promise.withResolvers<void>();
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ resolveLocalPort: (c) => c.port, drivers: fakeDrivers({ tailscale }) }));
    await seedManualConnected(config, "tailscale");
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    const settled = awaitTunnelSettled(config.instance);
    const cancelled = await cancelTunnel(config);
    expect(cancelled.status).toBe("idle");
    // The port binds, but the resume was superseded — it must not run the driver.
    ready.resolve();
    await settled;
    expect(tailscale.connects).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  test("reconcile resets a connected manual tunnel to idle when its prerequisite is gone", async () => {
    setTunnelDeps(deps()); // all manual drivers detect disabled
    await seedManualConnected(config, "tailscale");
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("tailscale");
  });

  test("an unavailable connect rejects with the provider_unavailable code (clients branch on it)", async () => {
    setTunnelDeps(deps({
      drivers: fakeDrivers({
        ngrok: scriptedDriver({ detect: () => Promise.resolve({ enabled: false, requires: "ngrok account" }) })
      })
    }));
    expect.assertions(2);
    try {
      await connectTunnel(config, "ngrok");
    } catch (error) {
      expect((error as Error).message).toContain("requires ngrok account");
      expect((error as Error & { code?: string }).code).toBe(PROVIDER_UNAVAILABLE);
    }
  });

  test("switching providers away from a live childless manual tunnel tears down its provider state", async () => {
    const tailscale = scriptedDriver();
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok: scriptedDriver() }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Selecting a DIFFERENT provider while tailscale serve is live must turn
    // the serve config off — otherwise the old front keeps serving while the
    // record reads idle.
    const switched = await selectProvider(config, "ngrok");
    expect(switched.selectedProvider).toBe("ngrok");
    expect(switched.status).toBe("idle");
    expect(tailscale.disconnects).toBe(1);
    expect(isRuntimeTunnelHost("machine.tail-test.ts.net")).toBe(false);

    // Re-selecting the already-idle provider does NOT re-run the teardown.
    await selectProvider(config, "tailscale");
    expect(tailscale.disconnects).toBe(1);
  });

  test("a failing provider-side teardown never blocks the provider switch", async () => {
    const tailscale = scriptedDriver({ disconnect: () => Promise.reject(new Error("serve off failed")) });
    setTunnelDeps(deps({ drivers: fakeDrivers({ tailscale, ngrok: scriptedDriver() }) }));
    await connectTunnel(config, "tailscale");
    await awaitTunnelSettled(config.instance);
    const switched = await selectProvider(config, "ngrok");
    expect(switched.selectedProvider).toBe("ngrok");
    expect(switched.status).toBe("idle");
  });

  test("manual resume settles to idle when the web never comes back", async () => {
    const prevWait = process.env.GINI_TUNNEL_RESUME_WAIT_MS;
    const prevPoll = process.env.GINI_TUNNEL_RESUME_POLL_MS;
    process.env.GINI_TUNNEL_RESUME_WAIT_MS = "0";
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "1";
    try {
      setTunnelDeps(deps({
        probeLocalPort: () => Promise.resolve(false),
        drivers: fakeDrivers({ ngrok: scriptedDriver() })
      }));
      await seedManualConnected(config, "ngrok");
      await reconcileTunnelOnStartup(config);
      await awaitTunnelSettled(config.instance);
      expect(getTunnel(config).status).toBe("idle");
      expect(getTunnel(config).selectedProvider).toBe("ngrok");
    } finally {
      if (prevWait === undefined) delete process.env.GINI_TUNNEL_RESUME_WAIT_MS;
      else process.env.GINI_TUNNEL_RESUME_WAIT_MS = prevWait;
      if (prevPoll === undefined) delete process.env.GINI_TUNNEL_RESUME_POLL_MS;
      else process.env.GINI_TUNNEL_RESUME_POLL_MS = prevPoll;
    }
  });
});
// ---------------------------------------------------------------------------
// spawnUrlChild: the URL-scanning process wrapper the ngrok/cloudflared
// drivers ride on.
// ---------------------------------------------------------------------------

// A scriptable SpawnedTunnelProc: push lines into stdout/stderr, resolve exit.
function fakeProc(): SpawnedTunnelProc & {
  emitOut: (line: string) => Promise<void>;
  emitErr: (line: string) => Promise<void>;
  writeErr: (text: string) => Promise<void>;
  exit: (code: number) => void;
  killed: boolean;
} {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const err = new TransformStream<Uint8Array, Uint8Array>();
  const outWriter = out.writable.getWriter();
  const errWriter = err.writable.getWriter();
  const exited = Promise.withResolvers<number>();
  const encoder = new TextEncoder();
  const proc = {
    stdout: out.readable,
    stderr: err.readable,
    exited: exited.promise,
    killed: false,
    kill() {
      proc.killed = true;
      exited.resolve(143);
    },
    // Return the write promise: awaiting it deterministically orders the
    // scanner's read (the parked reader resolves in the same microtask job)
    // ahead of the test's next step — no fixed sleeps needed.
    emitOut(line: string) {
      return outWriter.write(encoder.encode(`${line}\n`));
    },
    emitErr(line: string) {
      return errWriter.write(encoder.encode(`${line}\n`));
    },
    // Raw write WITHOUT a newline — for interleaving partial lines.
    writeErr(text: string) {
      return errWriter.write(encoder.encode(text));
    },
    exit(code: number) {
      exited.resolve(code);
    }
  };
  return proc;
}

describe("spawnUrlChild", () => {
  test("resolves the first capture-group match and wraps the live process", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(https:\/\/[^\s"]+)/, 5_000);
    proc.emitOut("t=1 lvl=info msg=starting");
    proc.emitOut('t=2 lvl=info msg="started tunnel" url=https://ab-12.ngrok-free.app');
    const result = await pending;
    expect(result.url).toBe("https://ab-12.ngrok-free.app");
    expect(result.child).toBeDefined();
    await result.child!.start();
    const stopped = result.child!.stop();
    expect(proc.killed).toBe(true);
    expect(await stopped).toBe(143);
  });

  test("interleaved partial chunks across stdout and stderr never corrupt a line", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(https:\/\/\S+)/, 5_000);
    // stderr emits HALF a line, stdout interleaves a full line, stderr
    // finishes its line. With a shared buffer the stdout chunk would splice
    // into stderr's partial line and corrupt the URL.
    await proc.writeErr("t=1 url=https://real");
    await proc.emitOut("t=2 lvl=info msg=heartbeat");
    await proc.writeErr("-tunnel.example\n");
    const result = await pending;
    expect(result.url).toBe("https://real-tunnel.example");
  });

  test("onSpawn hands out a kill handle the moment the process spawns", async () => {
    const proc = fakeProc();
    let kill: (() => void) | undefined;
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(\S+)/, 5_000, (k) => {
      kill = k;
    });
    // The handle exists BEFORE any output/resolution — that's the point: an
    // in-flight discovery must be killable by cancel/shutdown.
    expect(kill).toBeDefined();
    kill!();
    expect(proc.killed).toBe(true);
    await expect(pending).rejects.toThrow(/ngrok exited/);
  });

  test("matches on stderr too (cloudflared logs there) using the whole match", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(
      () => proc,
      ["cloudflared"],
      /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/,
      5_000
    );
    proc.emitErr("INF +--------------------------------+");
    proc.emitErr("INF |  https://some-words.trycloudflare.com  |");
    const result = await pending;
    expect(result.url).toBe("https://some-words.trycloudflare.com");
  });

  test("an exit before the URL rejects with the output tail and the agent name", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["ngrok"], /url=(\S+)/, 5_000);
    // Awaiting the write delivers the line to the scanner (same microtask job
    // resolves the parked read) before the exit races it — deterministic.
    await proc.emitErr("ERROR: authentication failed: your authtoken is invalid");
    proc.exit(1);
    await expect(pending).rejects.toThrow(/ngrok exited \(code 1\).*authtoken is invalid/);
  });

  test("a silent agent times out, is killed, and rejects", async () => {
    const proc = fakeProc();
    const pending = spawnUrlChild(() => proc, ["cloudflared"], /never-matches/, 10);
    await expect(pending).rejects.toThrow(/did not report a public URL/);
    expect(proc.killed).toBe(true);
  });

  test("a stream that errors mid-read is swallowed; the exit watcher still settles the result", async () => {
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const writer = out.writable.getWriter();
    const exited = Promise.withResolvers<number>();
    const proc: SpawnedTunnelProc = {
      stdout: out.readable,
      stderr: null,
      exited: exited.promise,
      kill: () => exited.resolve(143)
    };
    const pending = spawnUrlChild(() => proc, ["agent"], /url=(\S+)/, 5_000);
    await writer.write(new TextEncoder().encode("warming up\n"));
    // The pipe tears down (e.g. the process was killed externally) — the read
    // loop's catch must swallow it rather than surface an unhandled rejection.
    await writer.abort(new Error("pipe torn down"));
    exited.resolve(9);
    await expect(pending).rejects.toThrow(/agent exited \(code 9\)/);
  });

  test("stop escalates to SIGKILL when the child survives the TERM kill", async () => {
    const prev = process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
    process.env.GINI_TUNNEL_KILL_ESCALATION_MS = "5";
    try {
      const out = new TransformStream<Uint8Array, Uint8Array>();
      void out.writable.getWriter().write(new TextEncoder().encode("url=https://stubborn.example\n"));
      const exited = Promise.withResolvers<number>();
      const signals: (number | undefined)[] = [];
      const proc: SpawnedTunnelProc = {
        stdout: out.readable,
        stderr: null,
        exited: exited.promise,
        // A TERM-trapping agent: only SIGKILL fells it.
        kill: (signal?: number) => {
          signals.push(signal);
          if (signal === 9) exited.resolve(137);
        }
      };
      const result = await spawnUrlChild(() => proc, ["agent"], /url=(\S+)/, 5_000);
      expect(await result.child!.stop()).toBe(137);
      expect(signals).toEqual([undefined, 9]);
    } finally {
      if (prev === undefined) delete process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
      else process.env.GINI_TUNNEL_KILL_ESCALATION_MS = prev;
    }
  });

  test("a discovery-phase kill escalates to SIGKILL for a TERM-trapping agent", async () => {
    // ngrok/cloudflared bring the remote tunnel up BEFORE printing the URL
    // line — a TERM-trapping agent killed during discovery may already be
    // forwarding, so the discovery failure path must escalate like stop().
    const prev = process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
    process.env.GINI_TUNNEL_KILL_ESCALATION_MS = "5";
    try {
      const out = new TransformStream<Uint8Array, Uint8Array>();
      const exited = Promise.withResolvers<number>();
      const signals: (number | undefined)[] = [];
      const proc: SpawnedTunnelProc = {
        stdout: out.readable,
        stderr: null,
        exited: exited.promise,
        kill: (signal?: number) => {
          signals.push(signal);
          if (signal === 9) exited.resolve(137);
        }
      };
      // The agent never prints a URL: the discovery timeout kills it, and
      // the TERM-trapping process must still die via the escalation.
      await expect(spawnUrlChild(() => proc, ["agent"], /never-matches/, 10)).rejects.toThrow(/did not report a public URL/);
      for (let i = 0; signals.length < 2 && i < 1000; i += 1) await Bun.sleep(1);
      expect(signals).toEqual([undefined, 9]);
      expect(await exited.promise).toBe(137);
    } finally {
      if (prev === undefined) delete process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
      else process.env.GINI_TUNNEL_KILL_ESCALATION_MS = prev;
    }
  });

  test("the default spawn wrapper drives a real process end to end", async () => {
    const pending = spawnUrlChild(
      defaultTunnelProcSpawn,
      ["sh", "-c", 'echo "url=https://real.example.test"; sleep 30'],
      /url=(\S+)/,
      5_000
    );
    let child: TunnelChild | undefined;
    try {
      const result = await pending;
      child = result.child;
      expect(result.url).toBe("https://real.example.test");
    } finally {
      // stop() kills the real child even when an assertion threw, so a failed
      // run can't leave the `sleep 30` process behind.
      await child?.stop();
    }
  });
});
// ---------------------------------------------------------------------------
// makeDefaultDrivers: the real CLI adapters, exercised through injected
// run/spawn seams (no tailscale/ngrok/cloudflared binaries involved).
// ---------------------------------------------------------------------------
describe("makeDefaultDrivers", () => {
  const TS_STATUS_RUNNING = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail-test.ts.net." } });

  function runScript(script: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): {
    run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      run: (argv: string[]) => {
        const key = argv.join(" ");
        calls.push(key);
        const entry = script[key];
        if (!entry) return Promise.reject(new Error(`unscripted command: ${key}`));
        return Promise.resolve({ exitCode: entry.exitCode, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" });
      }
    };
  }

  test("tailscale: detect requires a Running backend with a MagicDNS name", async () => {
    const running = runScript({ "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING } });
    expect(await makeDefaultDrivers(running.run).tailscale.detect()).toEqual({ enabled: true });

    const stopped = runScript({
      "tailscale status --json": { exitCode: 0, stdout: JSON.stringify({ BackendState: "Stopped", Self: {} }) }
    });
    expect((await makeDefaultDrivers(stopped.run).tailscale.detect()).enabled).toBe(false);

    const badJson = runScript({ "tailscale status --json": { exitCode: 0, stdout: "not json" } });
    expect((await makeDefaultDrivers(badJson.run).tailscale.detect()).enabled).toBe(false);

    const missing = runScript({});
    expect((await makeDefaultDrivers(missing.run).tailscale.detect()).enabled).toBe(false);
  });

  test("tailscale: connect serves the gateway port and reports the ts.net URL; disconnect turns serve off", async () => {
    const script = runScript({
      "tailscale serve status --json": { exitCode: 0, stdout: "{}" },
      "tailscale serve --bg http://127.0.0.1:7342": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING },
      "tailscale serve --https=443 off": { exitCode: 0 }
    });
    const driver = makeDefaultDrivers(script.run).tailscale;
    expect(await driver.connect(7342)).toEqual({ url: "https://mac.tail-test.ts.net" });
    await driver.disconnect!();
    expect(script.calls).toEqual([
      "tailscale serve status --json",
      "tailscale serve --bg http://127.0.0.1:7342",
      "tailscale status --json",
      "tailscale serve --https=443 off"
    ]);
  });

  test("tailscale: connect refuses when serve already fronts a DIFFERENT port", async () => {
    // The serve config is machine-global: a sibling instance's front must
    // not be silently stolen (and later torn down by our disconnect).
    const foreign = runScript({
      "tailscale serve status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ Web: { "mac.tail-test.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } })
      }
    });
    await expect(makeDefaultDrivers(foreign.run).tailscale.connect(7342)).rejects.toThrow("already fronts http://127.0.0.1:9999");
    // The refusal happens BEFORE any serve --bg is issued.
    expect(foreign.calls).toEqual(["tailscale serve status --json"]);
  });

  test("tailscale: the foreign-claim check catches localhost-typed targets and ignores non-443 listeners", async () => {
    // `tailscale serve --bg localhost:3001` stores its target un-normalized —
    // the check must catch any loopback spelling at :443…
    const localhostClaim = runScript({
      "tailscale serve status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ Web: { "mac.tail-test.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3001" } } } } })
      }
    });
    await expect(makeDefaultDrivers(localhostClaim.run).tailscale.connect(7342)).rejects.toThrow("already fronts http://localhost:3001");
    // …while a listener on another port (serve --https=8443) never collides
    // with the 443 front and must NOT block the connect.
    const otherPort = runScript({
      "tailscale serve status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ Web: { "mac.tail-test.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } })
      },
      "tailscale serve --bg http://127.0.0.1:7342": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING }
    });
    expect(await makeDefaultDrivers(otherPort.run).tailscale.connect(7342)).toEqual({ url: "https://mac.tail-test.ts.net" });
    // Unparseable status output proceeds best-effort (same as a failed probe).
    const garbled = runScript({
      "tailscale serve status --json": { exitCode: 0, stdout: "not json" },
      "tailscale serve --bg http://127.0.0.1:7342": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING }
    });
    expect(await makeDefaultDrivers(garbled.run).tailscale.connect(7342)).toEqual({ url: "https://mac.tail-test.ts.net" });
  });

  test("tailscale: connect proceeds when the existing serve proxy is OUR port (boot resume)", async () => {
    const own = runScript({
      "tailscale serve status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ Web: { "mac.tail-test.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7342" } } } } })
      },
      "tailscale serve --bg http://127.0.0.1:7342": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: TS_STATUS_RUNNING }
    });
    expect(await makeDefaultDrivers(own.run).tailscale.connect(7342)).toEqual({ url: "https://mac.tail-test.ts.net" });
  });

  test("tailscale: disconnect throws when serve off exits non-zero (the front may still be live)", async () => {
    const offFails = runScript({
      "tailscale serve --https=443 off": { exitCode: 1, stderr: "serve: backend stopped" }
    });
    await expect(makeDefaultDrivers(offFails.run).tailscale.disconnect!()).rejects.toThrow(
      "tailscale serve off failed: serve: backend stopped"
    );
  });

  test("tailscale: connect surfaces serve failures, status failures, bad json, and a missing DNS name", async () => {
    const serveFails = runScript({ "tailscale serve --bg http://127.0.0.1:1": { exitCode: 1, stderr: "serve: not allowed" } });
    await expect(makeDefaultDrivers(serveFails.run).tailscale.connect(1)).rejects.toThrow("tailscale serve failed: serve: not allowed");

    const statusFails = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 1, stderr: "down" },
      "tailscale serve --https=443 off": { exitCode: 0 }
    });
    await expect(makeDefaultDrivers(statusFails.run).tailscale.connect(1)).rejects.toThrow("tailscale status failed: down");
    // serve came up before the URL lookup failed — connect must turn it back
    // off rather than leave an orphaned front behind the error record.
    expect(statusFails.calls).toContain("tailscale serve --https=443 off");

    const badJson = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: "{" }
    });
    await expect(makeDefaultDrivers(badJson.run).tailscale.connect(1)).rejects.toThrow("unparseable JSON");

    const noName = runScript({
      "tailscale serve --bg http://127.0.0.1:1": { exitCode: 0 },
      "tailscale status --json": { exitCode: 0, stdout: JSON.stringify({ Self: {} }) }
    });
    await expect(makeDefaultDrivers(noName.run).tailscale.connect(1)).rejects.toThrow("MagicDNS");
  });

  test("ngrok and cloudflared: detect maps the CLI checks; a missing binary disables", async () => {
    const prevToken = process.env.NGROK_AUTHTOKEN;
    delete process.env.NGROK_AUTHTOKEN; // ambient env must not flip fixtures
    try {
      const ok = runScript({
        "ngrok config check": { exitCode: 0, stdout: "Valid configuration file at /home/u/ngrok.yml" },
        "cloudflared --version": { exitCode: 0, stdout: "cloudflared version 2026.6.0" }
      });
      // A valid config WITH an authtoken -> enabled.
      const withToken = makeDefaultDrivers(ok.run, undefined, undefined, async (path) =>
        path === "/home/u/ngrok.yml" ? "version: 3\nagent:\n  authtoken: tok_x\n" : null
      );
      // The v3 nested layout, read from the exact path the check reported.
      expect(await withToken.ngrok.detect()).toEqual({ enabled: true });
      // The simple `authtoken:` line form is the common v2 layout.
      const v2 = makeDefaultDrivers(ok.run, undefined, undefined, async () => "authtoken: tok_x\n");
      expect(await v2.ngrok.detect()).toEqual({ enabled: true });
      expect(await withToken.cloudflare.detect()).toEqual({ enabled: true });
      // A valid config WITHOUT an authtoken -> still "requires ngrok account":
      // `ngrok config check` validates the file, not the account.
      const noToken = makeDefaultDrivers(ok.run, undefined, undefined, async () => "version: 3\n");
      expect(await noToken.ngrok.detect()).toEqual({ enabled: false, requires: "ngrok account" });
      // NGROK_AUTHTOKEN env satisfies the account requirement without a file.
      process.env.NGROK_AUTHTOKEN = "tok_env";
      const envToken = makeDefaultDrivers(ok.run, undefined, undefined, async () => null);
      expect(await envToken.ngrok.detect()).toEqual({ enabled: true });
      delete process.env.NGROK_AUTHTOKEN;

      const none = runScript({});
      expect((await makeDefaultDrivers(none.run).ngrok.detect()).enabled).toBe(false);
      expect((await makeDefaultDrivers(none.run).cloudflare.detect()).enabled).toBe(false);
    } finally {
      if (prevToken === undefined) delete process.env.NGROK_AUTHTOKEN;
      else process.env.NGROK_AUTHTOKEN = prevToken;
    }
  });

  test("ngrok and cloudflared: connect spawns the agent and scans for its URL", async () => {
    const prevTimeout = process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const spawned: string[][] = [];
      const procs: ReturnType<typeof fakeProc>[] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        procs.push(proc);
        return proc;
      };
      // No ~/.cloudflared/config.yml -> the quick-tunnel fallback.
      const drivers = makeDefaultDrivers(runScript({}).run, spawn, async () => null);

      const ngrokPending = drivers.ngrok.connect(7342);
      procs[0]!.emitOut('msg="started tunnel" url=https://xy-1.ngrok-free.app');
      expect((await ngrokPending).url).toBe("https://xy-1.ngrok-free.app");
      expect(spawned[0]).toEqual(["ngrok", "http", "7342", "--log", "stdout", "--log-format", "logfmt"]);

      const cfPending = drivers.cloudflare.connect(7342);
      // The cloudflare connect awaits the config read before spawning — poll
      // for the spawn (bounded; the assertion below fails loudly on timeout).
      for (let i = 0; procs.length < 2 && i < 1000; i += 1) await Bun.sleep(1);
      expect(procs.length).toBe(2);
      procs[1]!.emitErr("INF |  https://ab-cd.trycloudflare.com  |");
      expect((await cfPending).url).toBe("https://ab-cd.trycloudflare.com");
      expect(spawned[1]).toEqual(["cloudflared", "--config", "/dev/null", "tunnel", "--url", "http://127.0.0.1:7342"]);
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
      else process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = prevTimeout;
    }
  });

  test("cloudflared: a named-tunnel config.yml runs the OPERATOR'S tunnel against the gateway and publishes its stable hostname", async () => {
    const prevTimeout = process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const CONFIG = [
        "tunnel: d8eafe76-0586-454c-8846-2e86db3cecb3",
        "credentials-file: /Users/op/.cloudflared/d8eafe76-0586-454c-8846-2e86db3cecb3.json",
        "",
        "ingress:",
        "  - hostname: app.demoivyly.com",
        "    service: http://localhost:3000",
        "  - service: http_status:404"
      ].join("\n");
      const spawned: string[][] = [];
      const procs: ReturnType<typeof fakeProc>[] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        procs.push(proc);
        return proc;
      };
      const drivers = makeDefaultDrivers(runScript({}).run, spawn, async () => CONFIG);
      const pending = drivers.cloudflare.connect(7342);
      for (let i = 0; procs.length < 1 && i < 1000; i += 1) await Bun.sleep(1);
      expect(procs.length).toBe(1);
      procs[0]!.emitErr("2026-06-12T00:00:00Z INF Registered tunnel connection connIndex=0");
      const result = await pending;
      // The stable named-tunnel hostname (SSE-capable), NOT a trycloudflare URL.
      expect(result.url).toBe("https://app.demoivyly.com");
      expect(result.child).toBeDefined();
      // --config /dev/null is required even here: with ingress rules loaded
      // the --url origin override would be ignored.
      expect(spawned[0]).toEqual([
        "cloudflared", "--config", "/dev/null",
        "tunnel", "--cred-file", "/Users/op/.cloudflared/d8eafe76-0586-454c-8846-2e86db3cecb3.json",
        "run", "--url", "http://127.0.0.1:7342", "d8eafe76-0586-454c-8846-2e86db3cecb3"
      ]);
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
      else process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = prevTimeout;
    }
  });

  test("defaultReadCloudflareConfig returns text when readable and null otherwise", async () => {
    const prevHome = process.env.HOME;
    // Unique temp HOMEs so a parallel or leftover run can never collide.
    const root = mkdtempSync(join(tmpdir(), "gini-cloudflared-home-"));
    try {
      // A HOME with no ~/.cloudflared -> null.
      process.env.HOME = join(root, "empty");
      expect(await defaultReadCloudflareConfig()).toBeNull();
      // A HOME with a config.yml -> its text.
      const home = join(root, "configured");
      mkdirSync(`${home}/.cloudflared`, { recursive: true });
      await Bun.write(`${home}/.cloudflared/config.yml`, "tunnel: abc\n");
      process.env.HOME = home;
      expect(await defaultReadCloudflareConfig()).toBe("tunnel: abc\n");
    } finally {
      process.env.HOME = prevHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parseCloudflareConfig folds: null, no tunnel id, no hostname, defaulted credentials file", () => {
    expect(parseCloudflareConfig(null)).toBeNull();
    expect(parseCloudflareConfig("ingress:\n  - hostname: a.example\n    service: x")).toBeNull();
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - service: http_status:404")).toBeNull();
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - hostname: a.example\n    service: x")).toEqual({
      id: "abc-123",
      credentialsFile: undefined,
      hostname: "a.example"
    });
  });

  test("parseCloudflareConfig handles quoted YAML scalars and rejects quote residue", () => {
    // The file is hand-authored: quoted scalars are ordinary YAML. The quotes
    // must not leak into the id (silent quick-tunnel fallback) or the
    // hostname (a published https://"host" whose trust entry never matches
    // the real edge Host).
    expect(
      parseCloudflareConfig('tunnel: "abc-123"\ncredentials-file: "/cred dir/abc-123.json"\ningress:\n  - hostname: \'a.example\'\n    service: x')
    ).toEqual({
      id: "abc-123",
      credentialsFile: "/cred dir/abc-123.json",
      hostname: "a.example"
    });
    // Mismatched quotes keep their residue and must fail the shape checks
    // (quick-tunnel fallback), never connect with a garbage URL.
    expect(parseCloudflareConfig('tunnel: "abc-123\'\ningress:\n  - hostname: a.example\n    service: x')).toBeNull();
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - hostname: \"a.example'\n    service: x")).toBeNull();
  });

  test("parseCloudflareConfig skips wildcard ingress hostnames for the first concrete one", () => {
    // `- hostname: "*.example.com"` is Cloudflare's canonical wildcard setup;
    // its literal host can never serve as a published URL (origin trust would
    // match no real visitor). A later concrete hostname must win…
    expect(
      parseCloudflareConfig(
        "tunnel: abc-123\ningress:\n  - hostname: '*.example.com'\n    service: x\n  - hostname: gini.example.com\n    service: x"
      )?.hostname
    ).toBe("gini.example.com");
    // …and a config with ONLY wildcard hostnames falls back to a quick tunnel.
    expect(parseCloudflareConfig("tunnel: abc-123\ningress:\n  - hostname: '*.example.com'\n    service: x")).toBeNull();
  });

  test("cloudflared: a config without credentials-file defaults to ~/.cloudflared/<id>.json", async () => {
    const prevTimeout = process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "5000";
    try {
      const spawned: string[][] = [];
      const spawn = (argv: string[]): SpawnedTunnelProc => {
        spawned.push(argv);
        const proc = fakeProc();
        void proc.emitErr("INF Registered tunnel connection connIndex=0");
        return proc;
      };
      const drivers = makeDefaultDrivers(
        runScript({}).run,
        spawn,
        async () => "tunnel: abc-123\ningress:\n  - hostname: gini.example.com\n    service: http://localhost:3000"
      );
      const result = await drivers.cloudflare.connect(7342);
      expect(result.url).toBe("https://gini.example.com");
      expect(spawned[0]).toEqual([
        "cloudflared", "--config", "/dev/null",
        "tunnel", "--cred-file", `${process.env.HOME}/.cloudflared/abc-123.json`,
        "run", "--url", "http://127.0.0.1:7342", "abc-123"
      ]);
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
      else process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = prevTimeout;
    }
  });

  test("the manual-connect timeout env knob falls back on garbage and applies when set", async () => {
    const prevTimeout = process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
    process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = "10";
    try {
      const spawn = (): SpawnedTunnelProc => fakeProc();
      await expect(makeDefaultDrivers(runScript({}).run, spawn).ngrok.connect(1)).rejects.toThrow(
        /did not report a public URL/
      );
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS;
      else process.env.GINI_TUNNEL_MANUAL_TIMEOUT_MS = prevTimeout;
    }
  });

  test("defaultRunCommand runs a real command and captures exit code + both streams", async () => {
    const result = await defaultRunCommand(["sh", "-c", "echo out; echo err 1>&2; exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("defaultRunCommand kills a command that outlives its timeout", async () => {
    const result = await defaultRunCommand(["sleep", "30"], 25);
    expect(result.exitCode).not.toBe(0);
  });

  test("defaultRunCommand escalates to SIGKILL when the command ignores SIGTERM", async () => {
    // A wedged CLI trapping TERM would hold the stream/exit awaits open
    // forever without the escalation (boot awaits a detection pass, so a
    // hang here would block the port bind). The escalation delay is env-driven
    // (read at call time via killEscalationMs), so shrink it here — the SIGKILL
    // still fires, just sooner — keeping this bounded well under the per-test cap.
    const prevEscalation = process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
    process.env.GINI_TUNNEL_KILL_ESCALATION_MS = "20";
    try {
      const result = await defaultRunCommand(["sh", "-c", 'trap "" TERM; sleep 30'], 25);
      expect(result.exitCode).not.toBe(0);
    } finally {
      if (prevEscalation === undefined) delete process.env.GINI_TUNNEL_KILL_ESCALATION_MS;
      else process.env.GINI_TUNNEL_KILL_ESCALATION_MS = prevEscalation;
    }
  });
});
// ---------------------------------------------------------------------------
// Auto-reconnect after an unexpected child exit, and the relay readiness
// timeout. frp's own loop recovers a transient drop without exiting; these
// cover the gini-level recovery for the exits that DO reach the watcher (crash,
// OOM, unrecoverable rejection) plus the start()-never-settles hang guard.
// ---------------------------------------------------------------------------
describe("tunnel auto-reconnect", () => {
  let config: RuntimeConfig;
  const KEYS = [
    "GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS",
    "GINI_TUNNEL_RECONNECT_BASE_MS",
    "GINI_TUNNEL_RECONNECT_MAX_MS",
    "GINI_TUNNEL_RELAY_READY_TIMEOUT_MS",
    "GINI_TUNNEL_SHUTDOWN_DRAIN_MS",
    "GINI_TUNNEL_RELAY_SETTLE_MS"
  ] as const;
  let prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    config = testConfig(`rc-${Math.random().toString(36).slice(2)}`);
    prev = {};
    for (const k of KEYS) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    // Near-zero backoff so the bounded loop runs fast under the per-test cap.
    process.env.GINI_TUNNEL_RECONNECT_BASE_MS = "1";
    process.env.GINI_TUNNEL_RECONNECT_MAX_MS = "2";
    setTunnelDeps(deps());
  });

  // Poll a counter until it reaches `want`. Used instead of waiting on status,
  // because right after crash() the record still reads the pre-crash status for
  // a microtask (the exit watcher fires async) and a status poll could observe
  // the stale value; a build/connect counter only moves when a rebuild truly ran.
  async function waitForCount(get: () => number, want: number): Promise<void> {
    for (let i = 0; i < 600; i += 1) {
      if (get() >= want) return;
      await Bun.sleep(5);
    }
    throw new Error(`counter never reached ${want} (stuck at ${get()})`);
  }

  afterEach(() => {
    setTunnelDeps();
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(`${ROOT}/instances/${config.instance}`, { recursive: true, force: true });
  });

  // The headline fix: a relay child that exits unexpectedly is rebuilt by
  // reusing the stored session — the record goes connected -> connecting ->
  // connected without any user action, and the rebuilt child is supervised too.
  test("a relay child exit auto-reconnects by reusing the session (no browser)", async () => {
    const children = [crashableChild(), crashableChild()];
    let built = 0;
    let loginCalls = 0;
    const opened: string[] = [];
    setTunnelDeps(
      deps({
        buildTunnel: () => children[built++] ?? crashableChild(),
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        },
        openBrowser: (url) => opened.push(url)
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(built).toBe(1);

    // First child dies unexpectedly; the watcher rebuilds with the second.
    children[0].crash(1);
    await waitForCount(() => built, 2);
    await waitForStatus(config, "connected");
    expect(getTunnel(config).url).toBe("https://subdom7.relay.test");
    // Recovery reused the session: no browser, no re-login.
    expect(loginCalls).toBe(0);
    expect(opened).toEqual([]);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.reconnect")).toBe(true);

    // The REBUILT child is supervised too — a second crash recovers again,
    // proving each success re-arms a fresh retry budget.
    children[1].crash(1);
    await waitForCount(() => built, 3);
    await waitForStatus(config, "connected");
  });

  // A manual child (ngrok) gets the same treatment: an unexpected exit rebuilds
  // via the driver, no session involved.
  test("a manual child exit auto-reconnects via the driver", async () => {
    const children = [crashableChild(), crashableChild()];
    let connects = 0;
    setTunnelDeps(
      deps({
        drivers: fakeDrivers({
          ngrok: scriptedDriver({
            connect: () => Promise.resolve({ url: "https://abc.ngrok-free.app", child: children[connects++] ?? crashableChild() })
          })
        })
      })
    );
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(connects).toBe(1);

    children[0].crash(2);
    await waitForCount(() => connects, 2);
    await waitForStatus(config, "connected");
    expect(getTunnel(config).url).toBe("https://abc.ngrok-free.app");
  });

  // When every rebuild attempt fails (relay session keeps getting rejected), the
  // loop exhausts its budget and surfaces a clear terminal error naming the
  // attempt count — not an endless spin.
  test("auto-reconnect exhausts its budget and settles error after repeated rebuild failures", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "2";
    const live = crashableChild();
    let built = 0;
    // Modeled with a manual provider whose rebuild connect rejects (lands on
    // "error"); the relay-with-session start-failure path is covered separately
    // below.
    setTunnelDeps(
      deps({
        drivers: fakeDrivers({
          ngrok: scriptedDriver({
            connect: () =>
              built++ === 0
                ? Promise.resolve({ url: "https://abc.ngrok-free.app", child: live })
                : Promise.reject(new Error("agent exited (code 1) before reporting a public URL"))
          })
        })
      })
    );
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    live.crash(1);
    // One initial build + two rebuild attempts, then the terminal exhaustion
    // write. Poll for the final message specifically — intermediate attempts
    // each write a transient per-attempt "error" before the loop retries.
    await waitForCount(() => built, 3);
    for (let i = 0; i < 600 && !(getTunnel(config).message ?? "").includes("auto-reconnect failed"); i += 1) {
      await Bun.sleep(5);
    }
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toContain("auto-reconnect failed after 2 attempts");
    expect(state.url).toBeUndefined();
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.error")).toBe(true);
  });

  // A relay rebuild whose stored-session start() keeps FAILING (readiness
  // timeout / transient transport blip / revoked session) is a retryable error,
  // NOT a needs-user idle: under reuseOnly the loop must consume its budget on
  // the failures and finally settle "error" — never stop early at idle. (The
  // stored session is present on every attempt; only start() throws.)
  test("a relay rebuild whose start keeps failing retries the budget and settles error (not idle)", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "2";
    let built = 0;
    const live = crashableChild();
    setTunnelDeps(
      deps({
        // Session always present (fakeStore), so this exercises the
        // session-present-but-start-fails branch, not the no-session idle branch.
        createStore: () => fakeStore(),
        buildTunnel: () => {
          built += 1;
          // First build (initial connect) succeeds; every rebuild's start throws.
          if (built === 1) return live;
          return fakeChild({ startRejects: new Error("frpc: not ready within 45000ms") });
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    live.crash(1);
    // initial build + 2 rebuild attempts (both start-fail), then exhaustion error.
    await waitForCount(() => built, 3);
    for (let i = 0; i < 600 && !(getTunnel(config).message ?? "").includes("auto-reconnect failed"); i += 1) {
      await Bun.sleep(5);
    }
    const state = getTunnel(config);
    expect(state.status).toBe("error"); // NOT idle — the regression this guards
    expect(state.message).toContain("auto-reconnect failed after 2 attempts");
  });

  // A relay rebuild that settles idle (no stored session on the rebuild) is a
  // needs-user condition retrying can't fix — the loop stops at idle rather than
  // burning the whole budget or flipping to a misleading error. The reuseOnly
  // resume hits its no-session branch and settles idle WITHOUT calling
  // buildTunnel, so the build counter stays at 1 (only the initial connect).
  test("auto-reconnect stops at idle when a rebuild has no usable session", async () => {
    const live = crashableChild();
    let connectStores = 0;
    setTunnelDeps(
      deps({
        buildTunnel: () => live,
        // First connect has the session; the rebuild sees none (cleared creds).
        createStore: () => (connectStores++ === 0 ? fakeStore() : fakeStoreNoSession())
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    live.crash(1);
    await waitForStatus(config, "idle");
    expect(getTunnel(config).status).toBe("idle");
    expect(getTunnel(config).selectedProvider).toBe("gini-relay");
    // The rebuild attempt ran (createStore consulted a second time) but found no
    // session and settled idle before building anything.
    expect(connectStores).toBeGreaterThanOrEqual(2);
  });

  // An intentional disconnect during the reconnect backoff must win: the loop
  // sees the supervisor was replaced and bails without clobbering idle or
  // rebuilding a tunnel the user tore down.
  test("a disconnect during the reconnect backoff bails the loop without rebuilding", async () => {
    process.env.GINI_TUNNEL_RECONNECT_BASE_MS = "50"; // a backoff window to disconnect within
    process.env.GINI_TUNNEL_RECONNECT_MAX_MS = "50";
    const live = crashableChild();
    let built = 0;
    setTunnelDeps(
      deps({
        buildTunnel: () => {
          built += 1;
          return built === 1 ? live : crashableChild();
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(built).toBe(1);

    live.crash(1);
    // The record flips to "connecting" while the loop sleeps in backoff.
    await waitForStatus(config, "connecting");
    // The user disconnects mid-backoff.
    const after = await disconnectTunnel(config);
    expect(after.status).toBe("idle");
    // Give the loop several backoff windows to wake from its sleep and observe
    // the supersede — long enough that a rebuild, had one been going to happen,
    // would have bumped `built` by now.
    await Bun.sleep(200);
    expect(getTunnel(config).status).toBe("idle");
    expect(built).toBe(1); // no rebuild happened
  });

  // With auto-reconnect disabled (max attempts 0), the watcher flips straight to
  // error with the classic message — preserving the pre-fix behavior as an opt-out.
  test("max attempts 0 disables auto-reconnect and flips straight to error", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "0";
    const live = crashableChild();
    let built = 0;
    setTunnelDeps(
      deps({
        buildTunnel: () => {
          built += 1;
          return live;
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    live.crash(9);
    await waitForStatus(config, "error");
    expect(getTunnel(config).message).toBe("Tunnel process exited (code 9).");
    expect(built).toBe(1); // never rebuilt
  });

  // The readiness-timeout wiring: makeDefaultDeps' real buildTunnel passes a
  // positive readyTimeoutMs to the gini-relay Frpc so a proxy that never
  // registers can't hang start() forever. We assert the seam forwards the knob
  // (the real Frpc honors readyTimeoutMs; that behavior is the library's).
  test("makeDefaultDeps builds an frpc child carrying a readiness timeout", () => {
    process.env.GINI_TUNNEL_RELAY_READY_TIMEOUT_MS = "1234";
    const real = makeDefaultDeps();
    const child = real.buildTunnel({
      session: SESSION,
      deviceId: "device-1",
      port: 4321,
      defaults: RELAY
    }) as unknown as { options?: { readyTimeoutMs?: number } };
    // The Frpc instance stores its options; the timeout we injected rides along.
    expect(child.options?.readyTimeoutMs).toBe(1234);
  });

  // A reconnect interrupted by shutdown must be RESUMABLE. The loop bails on the
  // registry clear (no respawn), but the record is left "connecting" — which
  // reconcile would reset to idle. stopAllTunnels re-persists "connected" for a
  // reconnecting entry, so the next boot's reconcile resumes the link.
  test("a shutdown during auto-reconnect re-persists connected so the next boot resumes", async () => {
    process.env.GINI_TUNNEL_RECONNECT_BASE_MS = "5000"; // long backoff: stay parked in the loop
    process.env.GINI_TUNNEL_RECONNECT_MAX_MS = "5000";
    const live = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => live }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Child dies; the watcher flips to connecting and parks in the long backoff.
    live.crash(1);
    await waitForStatus(config, "connecting");
    // Shutdown lands mid-reconnect.
    await stopAllTunnels();
    // The persisted record was rewritten back to connected (resumable), NOT left
    // at the transient connecting that reconcile would discard.
    expect(readState(config.instance).tunnel?.status).toBe("connected");

    // Prove the resume: a fresh reconcile (as on next boot) brings the link back
    // by reusing the session — no browser.
    let loginCalls = 0;
    setTunnelDeps(
      deps({
        buildTunnel: () => crashableChild(),
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        }
      })
    );
    await reconcileTunnelOnStartup(config, { gatewayReady: Promise.resolve() });
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(loginCalls).toBe(0);
  });

  // While a MANUAL provider's rebuilds keep failing, the panel must read
  // "connecting" (recovery in progress), not the transient per-attempt "error".
  // With >1 attempt and a failing-then-succeeding driver, an observer polling
  // between attempts sees connecting, and it ultimately recovers.
  test("a failing manual rebuild shows connecting between attempts, then recovers", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "5";
    process.env.GINI_TUNNEL_RECONNECT_BASE_MS = "30"; // a small window to observe connecting
    process.env.GINI_TUNNEL_RECONNECT_MAX_MS = "30";
    const live = crashableChild();
    const recovered = crashableChild();
    let connects = 0;
    const seen = new Set<string>();
    setTunnelDeps(
      deps({
        drivers: fakeDrivers({
          ngrok: scriptedDriver({
            connect: () => {
              connects += 1;
              if (connects === 1) return Promise.resolve({ url: "https://abc.ngrok-free.app", child: live });
              if (connects === 2) return Promise.reject(new Error("agent exited (code 1) before reporting a public URL"));
              return Promise.resolve({ url: "https://abc.ngrok-free.app", child: recovered });
            }
          })
        })
      })
    );
    await connectTunnel(config, "ngrok");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Sample the status across the recovery so we can assert connecting appears.
    const sampler = (async () => {
      for (let i = 0; i < 400; i += 1) {
        seen.add(getTunnel(config).status);
        if (getTunnel(config).status === "connected" && connects >= 3) return;
        await Bun.sleep(2);
      }
    })();
    live.crash(1);
    await sampler;
    await waitForStatus(config, "connected");
    // The second attempt rejected, but the loop re-asserted connecting for the
    // backoff before the third attempt — so the panel never got stuck on error.
    expect(seen.has("connecting")).toBe(true);
    expect(connects).toBeGreaterThanOrEqual(3);
  });

  // A shutdown landing DURING a boot-resume (the resume is still "connecting",
  // its frpc start parked on gatewayReady) must also leave a resumable
  // "connected" record — the resume supervisor is flagged `reconnecting`, so
  // stopAllTunnels re-persists it. Without the flag the next boot's reconcile
  // would discard the "connecting" record to idle and the link would stay down.
  test("a shutdown during a boot-resume re-persists connected so the next boot resumes again", async () => {
    // The resume parks on an unresolved gatewayReady, so its `settled` never
    // resolves; shrink the shutdown drain bound so stopAllTunnels doesn't wait
    // out its full default while racing that pending settle.
    process.env.GINI_TUNNEL_SHUTDOWN_DRAIN_MS = "20";
    const ready = Promise.withResolvers<void>(); // never resolved: resume parks here
    let built = 0;
    setTunnelDeps(
      deps({
        resolveLocalPort: (c) => c.port,
        buildTunnel: () => {
          built += 1;
          return crashableChild();
        }
      })
    );
    // Seed a connected record (as if connected before the prior restart).
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "connected",
        url: "https://subdom7.relay.test",
        subdomain: "subdom7",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    // The resume is parked on gatewayReady: record reads connecting, nothing built.
    expect(getTunnel(config).status).toBe("connecting");
    expect(built).toBe(0);

    // Shutdown lands mid-resume.
    await stopAllTunnels();
    // The resumable record was preserved as connected (not the transient connecting).
    expect(readState(config.instance).tunnel?.status).toBe("connected");
  });

  // The watcher's catch is a backstop for an UNEXPECTED throw out of the reconnect
  // machinery (e.g. a state-write failure) — it must trace the failure (so a field
  // incident isn't invisible) without becoming an unhandled rejection. Force the
  // throw by making the instance's state dir read-only AFTER connecting, so the
  // reconnect flip's writeState throws; the log dir uses a separate root
  // (GINI_LOG_ROOT), so appendLog still lands.
  test("an unexpected throw in the reconnect machinery is logged, not swallowed silently", async () => {
    const live = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => live }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    const stateDir = join(ROOT, "instances", config.instance);
    chmodSync(stateDir, 0o500); // read+execute, no write — writeState will throw
    try {
      live.crash(1); // watcher fires; the flip's writeState throws into the catch
      const logPath = join(`${ROOT}-logs`, config.instance, "runtime.jsonl");
      let logged = false;
      for (let i = 0; i < 600; i += 1) {
        try {
          if (readFileSync(logPath, "utf8").includes("tunnel.reconnect.error")) {
            logged = true;
            break;
          }
        } catch {
          // log file not created yet
        }
        await Bun.sleep(5);
      }
      expect(logged).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700); // restore so afterEach cleanup can remove it
    }
  });

  // Seed a connected gini-relay record as if the runtime was fronting a tunnel
  // before this restart (the block has no shared seed helper).
  async function seedRelayConnected(c: RuntimeConfig): Promise<void> {
    await mutateState(c.instance, (s) => {
      s.tunnel = {
        instance: c.instance,
        selectedProvider: "gini-relay",
        status: "connected",
        url: "https://subdom7.relay.test",
        subdomain: "subdom7",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
  }

  // The relay-registration settle: by default (knob unset) a resume registers
  // its frpc immediately after the gateway bind — no added delay, buildTunnel
  // runs once.
  test("relay resume applies NO settle by default", async () => {
    let built = 0;
    setTunnelDeps(deps({ resolveLocalPort: (c) => c.port, buildTunnel: () => { built += 1; return crashableChild(); } }));
    await seedRelayConnected(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: Promise.resolve() });
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(built).toBe(1);
  });

  // With the knob set, the resume waits for the settle AFTER the gateway bind and
  // BEFORE building frpc — so a prior process's relay registration can drop first.
  // Asserted by ordering, not wall-clock: buildTunnel must run only after the
  // gateway-ready gate AND the settle have both elapsed.
  test("relay resume waits the configured settle before registering frpc", async () => {
    process.env.GINI_TUNNEL_RELAY_SETTLE_MS = "40";
    const ready = Promise.withResolvers<void>();
    let built = 0;
    setTunnelDeps(deps({ resolveLocalPort: (c) => c.port, buildTunnel: () => { built += 1; return crashableChild(); } }));
    await seedRelayConnected(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    // Gateway not yet bound: nothing built.
    expect(built).toBe(0);
    ready.resolve();
    // The bind resolved, but the settle still gates the build — it must not have
    // happened in the same microtask flush.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(built).toBe(0);
    // After the settle elapses, the rebuild proceeds.
    await awaitTunnelSettled(config.instance);
    expect(built).toBe(1);
    expect(getTunnel(config).status).toBe("connected");
  });

  // A cancel landing DURING the settle must bail the resume without building or
  // publishing — the supersede check after the sleep catches it.
  test("relay resume cancelled during the settle bails without building", async () => {
    process.env.GINI_TUNNEL_RELAY_SETTLE_MS = "60";
    let built = 0;
    setTunnelDeps(deps({ resolveLocalPort: (c) => c.port, buildTunnel: () => { built += 1; return crashableChild(); } }));
    await seedRelayConnected(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: Promise.resolve() });
    const settled = awaitTunnelSettled(config.instance);
    // Cancel while the resume is parked in the settle sleep.
    const cancelled = await cancelTunnel(config);
    expect(cancelled.status).toBe("idle");
    await settled;
    expect(built).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  // A manual provider resume must NOT apply the relay settle (it mints a fresh
  // subdomain / is machine-global, so there is no same-subdomain collision).
  test("a manual provider resume ignores the relay settle", async () => {
    process.env.GINI_TUNNEL_RELAY_SETTLE_MS = "10000"; // huge: would stall a relay resume
    const ready = Promise.withResolvers<void>();
    let connects = 0;
    setTunnelDeps(
      deps({
        resolveLocalPort: (c) => c.port,
        drivers: fakeDrivers({
          tailscale: scriptedDriver({
            connect: () => { connects += 1; return Promise.resolve({ url: "https://machine.tail-test.ts.net" }); }
          })
        })
      })
    );
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "tailscale",
        status: "connected",
        url: "https://machine.tail-test.ts.net",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    ready.resolve();
    await awaitTunnelSettled(config.instance);
    // No 10s stall: the manual resume connected promptly, ignoring the relay knob.
    expect(connects).toBe(1);
    expect(getTunnel(config).status).toBe("connected");
  });

  // relayRegistrationSettleMs env parsing: unset/blank/0/negative/NaN -> 0 (no
  // settle); a positive value is honored. Exercised through the observable resume
  // behavior — a blank/invalid value must not add a delay.
  test("an invalid relay-settle env adds no delay (parses to 0)", async () => {
    process.env.GINI_TUNNEL_RELAY_SETTLE_MS = "not-a-number";
    let built = 0;
    setTunnelDeps(deps({ resolveLocalPort: (c) => c.port, buildTunnel: () => { built += 1; return crashableChild(); } }));
    await seedRelayConnected(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: Promise.resolve() });
    await awaitTunnelSettled(config.instance);
    expect(built).toBe(1);
    expect(getTunnel(config).status).toBe("connected");
  });
});
