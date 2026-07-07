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

const ROOT = "/tmp/gini-tunnel-integration-tests";

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

describe("tunnel integration", () => {
  let config: RuntimeConfig;
  // Snapshot every env knob the tunnel module reads and CLEAR it for each test, so
  // a value left set in the ambient environment (or leaked by a prior test) can't
  // change a test's outcome — e.g. an ambient GINI_TUNNEL_RESUME_WAIT_MS=0 would
  // make the override poll time out immediately. Tests that need a specific value
  // set it themselves; afterEach restores the original.
  const TUNNEL_ENV_KEYS = [
    "GINI_TUNNEL_PORT",
    "GINI_TUNNEL_RESUME_WAIT_MS",
    "GINI_TUNNEL_RESUME_POLL_MS",
    "GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS",
    "GINI_TUNNEL_RECONNECT_BASE_MS",
    "GINI_TUNNEL_RECONNECT_MAX_MS",
    "GINI_RELAY_PROVISIONED"
  ] as const;
  let prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    config = testConfig(`t-${Math.random().toString(36).slice(2)}`);
    prevEnv = {};
    for (const key of TUNNEL_ENV_KEYS) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
    setTunnelDeps(deps());
  });

  afterEach(() => {
    setTunnelDeps(); // restore the real gini-relay seams
    // Restore env even if a test failed mid-assertion, so state never leaks.
    for (const key of TUNNEL_ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
    rmSync(`${ROOT}/instances/${config.instance}`, { recursive: true, force: true });
  });

  // GET on a fresh instance: the catalog is present, nothing selected, idle.
  test("getTunnel on a fresh instance returns catalog + idle/null", () => {
    const state = getTunnel(config);
    expect(state.selectedProvider).toBeNull();
    expect(state.status).toBe("idle");
    expect(state.url).toBeUndefined();
    expect(state.message).toBeUndefined();
    expect(state.providers.map((p) => p.id)).toEqual([
      "gini-relay",
      "tailscale",
      "ngrok",
      "cloudflare"
    ]);
  });

  // The catalog values must match the agreed contract exactly: only
  // gini-relay enabled (until detection finds a manual CLI); the rest disabled
  // with a `requires` reason. Setup guidance lives in docs/remote-access/<id>.md,
  // not in the catalog.
  test("provider catalog matches the agreed shape", () => {
    const byId = Object.fromEntries(getTunnel(config).providers.map((p) => [p.id, p]));
    expect(byId["gini-relay"]).toEqual({ id: "gini-relay", name: "Gini Relay", enabled: true });
    expect(byId.tailscale).toEqual({
      id: "tailscale",
      name: "Tailscale",
      enabled: false,
      requires: "Tailscale network"
    });
    expect(byId.ngrok).toEqual({
      id: "ngrok",
      name: "ngrok",
      enabled: false,
      requires: "ngrok account"
    });
    expect(byId.cloudflare).toEqual({
      id: "cloudflare",
      name: "Cloudflare",
      enabled: false,
      requires: "cloudflared CLI"
    });
  });

  // select saves the choice without connecting; status stays idle.
  test("selectProvider saves selection, stays idle, audits", async () => {
    const state = await selectProvider(config, "gini-relay");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.status).toBe("idle");
    expect(state.url).toBeUndefined();
    const persisted = readState(config.instance);
    expect(persisted.tunnel?.selectedProvider).toBe("gini-relay");
    expect(persisted.audit.some((a) => a.action === "tunnel.select")).toBe(true);
  });

  // Unknown provider -> reject, no state mutation.
  test("selectProvider rejects an unknown provider", async () => {
    await expect(selectProvider(config, "bogus")).rejects.toThrow("Unknown tunnel provider: bogus");
    expect(readState(config.instance).tunnel).toBeNull();
  });

  // Disabled provider -> reject with the requires hint.
  test("selectProvider rejects a disabled provider with the requires hint", async () => {
    await expect(selectProvider(config, "ngrok")).rejects.toThrow("not available (requires ngrok account)");
    expect(readState(config.instance).tunnel).toBeNull();
  });

  // Re-selecting the provider you're already connected to is a no-op: the live
  // tunnel stays up (the edit panel must not disconnect on a redundant click).
  test("re-selecting the connected provider is a no-op and keeps the tunnel live", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    const reselected = await selectProvider(config, "gini-relay");
    expect(reselected.status).toBe("connected");
    expect(reselected.url).toBe("https://subdom7.relay.test");
    expect(child.stopped).toBe(false);
  });

  // connect using the saved selection: returns "connecting" immediately, then
  // the background flow settles to "connected" with the public url and opens
  // the consent URL in the host browser.
  test("connectTunnel reuses a stored session (no browser) and settles connected", async () => {
    const opened: string[] = [];
    let loginCalls = 0;
    setTunnelDeps(deps({
      openBrowser: (url) => opened.push(url),
      loginUrl: () => {
        loginCalls += 1;
        return Promise.resolve(fakeLoginHandle());
      }
    }));
    await selectProvider(config, "gini-relay");
    const connecting = await connectTunnel(config);
    expect(connecting.status).toBe("connecting");
    expect(connecting.url).toBeUndefined();
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    expect(settled.url).toBe("https://subdom7.relay.test");
    expect(settled.selectedProvider).toBe("gini-relay");
    // The stored session was reused: no browser opened, no re-login.
    expect(opened).toEqual([]);
    expect(loginCalls).toBe(0);
    const persisted = readState(config.instance);
    expect(persisted.tunnel?.subdomain).toBe("subdom7");
    expect(persisted.audit.some((a) => a.action === "tunnel.connect")).toBe(true);
    expect(persisted.audit.some((a) => a.action === "tunnel.connected")).toBe(true);
  });

  // No stored session -> connect runs the browser OAuth login flow.
  test("connectTunnel logs in via the browser when there is no stored session", async () => {
    const opened: string[] = [];
    setTunnelDeps(depsLogin({ openBrowser: (url) => opened.push(url) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    expect(settled.url).toBe("https://subdom7.relay.test");
    expect(opened).toEqual(["https://relay.test/consent?x=1"]);
  });

  // A fresh login with GINI_RELAY_PROVISIONED set requests the Workspace
  // services, so the relay can capture the grant in one consent.
  test("connectTunnel requests Workspace services on a fresh login when provisioned", async () => {
    process.env.GINI_RELAY_PROVISIONED = "true"; // restored in afterEach
    let seen: string[] | undefined = ["sentinel"];
    setTunnelDeps(
      depsLogin({
        loginUrl: (deps) => {
          seen = deps.services;
          return Promise.resolve(fakeLoginHandle());
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(seen).toEqual(["calendar", "gmail", "drive", "sheets"]);
  });

  // Without the flag, a fresh login is identity-only: no services field, so the
  // relay request is byte-for-byte the prior behavior.
  test("connectTunnel omits services on a fresh login when not provisioned", async () => {
    let seen: string[] | undefined = ["sentinel"];
    setTunnelDeps(
      depsLogin({
        loginUrl: (deps) => {
          seen = deps.services;
          return Promise.resolve(fakeLoginHandle());
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(seen).toBeUndefined();
  });

  // A fresh login whose session carries a Workspace refresh token persists the
  // grant after the tunnel connects (so gws can use it), passing the token through.
  test("connectTunnel persists the Workspace grant when the login returns a refresh token", async () => {
    let persisted: string | undefined;
    const handle = fakeLoginHandle({
      waitForSession: () => Promise.resolve({ ...SESSION, refreshToken: "rt-from-relay" })
    });
    setTunnelDeps(
      depsLogin({
        loginUrl: () => Promise.resolve(handle),
        persistWorkspaceGrant: (rt) => {
          persisted = rt;
          return Promise.resolve();
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(persisted).toBe("rt-from-relay");
  });

  // An identity-only login (no refresh token) never calls the persist seam.
  test("connectTunnel does not persist a grant when the session has no refresh token", async () => {
    let called = false;
    setTunnelDeps(
      depsLogin({
        persistWorkspaceGrant: () => {
          called = true;
          return Promise.resolve();
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(called).toBe(false);
  });

  // A RESUMED session (read from the store, not a fresh consent) that carries a
  // refresh token still calls the persist seam — persistence is idempotent, so
  // running it on every connect heals a grant that a prior fresh login failed to
  // land, without duplicating the account (the dedup lives in
  // defaultPersistWorkspaceGrant, exercised in its own unit tests below).
  test("connectTunnel persists the grant when reusing a stored session with a refresh token", async () => {
    let persisted: string | undefined;
    const storedWithToken: Store = {
      home: "/tmp/gini-relay-fake",
      deviceId: () => "device-1",
      readSession: () => ({ ...SESSION, refreshToken: "rt-stored" }),
      writeSession: () => {},
      clearSession: () => {}
    };
    setTunnelDeps(
      deps({
        createStore: () => storedWithToken,
        persistWorkspaceGrant: (rt) => {
          persisted = rt;
          return Promise.resolve();
        }
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(persisted).toBe("rt-stored");
  });

  // Persisting the grant is best-effort: a failure must NOT downgrade an
  // already-connected tunnel.
  test("connectTunnel stays connected when persisting the Workspace grant fails", async () => {
    const handle = fakeLoginHandle({
      waitForSession: () => Promise.resolve({ ...SESSION, refreshToken: "rt-boom" })
    });
    setTunnelDeps(
      depsLogin({
        loginUrl: () => Promise.resolve(handle),
        persistWorkspaceGrant: () => Promise.reject(new Error("gws not installed"))
      })
    );
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
  });

  // A stored session the relay rejects (revoked) -> connect self-heals by
  // falling back to a fresh login and retrying the tunnel build.
  test("connectTunnel falls back to login when the stored session is rejected", async () => {
    let build = 0;
    const opened: string[] = [];
    setTunnelDeps(deps({
      openBrowser: (url) => opened.push(url),
      buildTunnel: () => fakeChild(build++ === 0 ? { startRejects: new Error("relay: session rejected") } : {})
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(opened).toEqual(["https://relay.test/consent?x=1"]);
    expect(build).toBe(2);
  });

  // connect with an explicit provider arg overrides the saved selection.
  test("connectTunnel honors an explicit provider override", async () => {
    const state = await connectTunnel(config, "gini-relay");
    expect(state.status).toBe("connecting");
    expect(state.selectedProvider).toBe("gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
  });

  // connect with no selection and no arg -> reject.
  test("connectTunnel with no provider selected rejects", async () => {
    await expect(connectTunnel(config)).rejects.toThrow("No tunnel provider selected.");
  });

  // connect with an unknown explicit provider -> reject.
  test("connectTunnel rejects an unknown explicit provider", async () => {
    await expect(connectTunnel(config, "bogus")).rejects.toThrow("Unknown tunnel provider: bogus");
  });

  // connect with a disabled explicit provider -> reject.
  test("connectTunnel rejects a disabled explicit provider", async () => {
    await expect(connectTunnel(config, "tailscale")).rejects.toThrow("not available (requires Tailscale network)");
  });

  // A login failure flips the record to "error" with the message; no url.
  test("connectTunnel records error when login fails", async () => {
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.reject(new Error("relay returned no login url")) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("relay returned no login url");
    expect(state.url).toBeUndefined();
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.error")).toBe(true);
  });

  // A frpc start failure (after a good login) also flips to "error".
  test("connectTunnel records error when frpc start fails", async () => {
    setTunnelDeps(deps({ buildTunnel: () => fakeChild({ startRejects: new Error("frpc: boom") }) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("frpc: boom");
  });

  // A non-Error rejection is stringified into the message (String(error) path).
  test("connectTunnel stringifies a non-Error rejection", async () => {
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.reject("plain string failure") }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).message).toBe("plain string failure");
  });

  // Cancelling mid-login: the pending login is aborted, the record is idle,
  // and the background flow that loses the race must NOT clobber idle with
  // an error (the registry entry was cleared by the cancel).
  test("cancelTunnel during a pending login aborts and stays idle", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    let cancelled = false;
    const handle = fakeLoginHandle({
      waitForSession: () => hang, // never resolves on its own
      cancel: () => {
        cancelled = true;
      }
    });
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.resolve(handle) }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Let runConnect reach waitForSession (login handle stored).
    await Promise.resolve();
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(cancelled).toBe(true);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.cancel")).toBe(true);
    // The background flow won't settle (the login hangs); the record stays idle.
    expect(getTunnel(config).status).toBe("idle");
  });

  // cancel returns to idle, keeps the selection, clears url/message.
  test("cancelTunnel returns idle keeping the selection", async () => {
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.url).toBeUndefined();
  });

  // cancel with nothing selected still works (selection stays null) and the
  // teardown no-ops cleanly (no supervisor registered).
  test("cancelTunnel with no selection yields idle/null", async () => {
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
  });

  // disconnect tears down a live tunnel (stops the frpc child), keeps selection.
  test("disconnectTunnel stops the child and returns idle keeping the selection", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(state.url).toBeUndefined();
    expect(child.stopped).toBe(true);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.disconnect")).toBe(true);
  });

  // disconnect with nothing selected -> idle/null target audited as "none".
  test("disconnectTunnel with no selection yields idle/null", async () => {
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
    const audit = readState(config.instance).audit.find((a) => a.action === "tunnel.disconnect");
    expect(audit?.target).toBe("none");
  });

  // A second connect tears down the prior in-flight login before starting a
  // fresh one (covers the teardown-with-pending-login branch in connect).
  test("connectTunnel tears down a prior pending login before reconnecting", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    let firstCancelled = false;
    const first = fakeLoginHandle({ waitForSession: () => hang, cancel: () => { firstCancelled = true; } });
    let call = 0;
    setTunnelDeps(depsLogin({
      loginUrl: () => Promise.resolve(call++ === 0 ? first : fakeLoginHandle())
    }));
    await connectTunnel(config, "gini-relay");
    await Promise.resolve();
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(firstCancelled).toBe(true);
    expect(getTunnel(config).status).toBe("connected");
  });

  // A teardown whose child.stop() rejects is swallowed (best-effort path).
  test("disconnectTunnel swallows a child.stop() rejection", async () => {
    const child: TunnelChild = {
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error("already gone")),
      exited: Promise.withResolvers<number>().promise
    };
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
  });

  // A login.cancel() that throws during teardown is swallowed.
  test("cancelTunnel swallows a login.cancel() throw", async () => {
    const { promise: hang } = Promise.withResolvers<Session>();
    const handle = fakeLoginHandle({
      waitForSession: () => hang,
      cancel: () => { throw new Error("cancel blew up"); }
    });
    setTunnelDeps(depsLogin({ loginUrl: () => Promise.resolve(handle) }));
    await connectTunnel(config, "gini-relay");
    await Promise.resolve();
    const state = await cancelTunnel(config);
    expect(state.status).toBe("idle");
  });

  // The default resolveLocalPort path: env override wins.
  test("connectTunnel uses GINI_TUNNEL_PORT override for the local port", async () => {
    process.env.GINI_TUNNEL_PORT = "9911"; // restored in afterEach
    let seenPort = -1;
    setTunnelDeps(depsNoPort({
      buildTunnel: (opts) => {
        seenPort = opts.port;
        return fakeChild();
      }
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(seenPort).toBe(9911);
  });

  // The default resolveLocalPort path: with no env override, the tunnel exposes
  // the instance's GATEWAY port (config.port). The gateway fronts both the
  // native /api/* surface and the reverse-proxied web app, so one relay URL
  // serves the API and the UI.
  test("connectTunnel exposes the gateway port (config.port) for the local port", async () => {
    delete process.env.GINI_TUNNEL_PORT; // restored in afterEach
    let seenPort = -1;
    setTunnelDeps(depsNoPort({
      buildTunnel: (opts) => {
        seenPort = opts.port;
        return fakeChild();
      }
    }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(seenPort).toBe(config.port);
  });

  // disconnect fully logs out: it invokes the logout seam (revoke + clear) so a
  // later connect must log in again.
  test("disconnectTunnel logs out so a later connect must re-login", async () => {
    const child = fakeChild();
    let logoutCalls = 0;
    setTunnelDeps(deps({
      buildTunnel: () => child,
      logout: () => {
        logoutCalls += 1;
        return Promise.resolve();
      }
    }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(child.stopped).toBe(true);
    expect(logoutCalls).toBe(1);
  });

  // disconnect must settle to idle even when logout throws (best-effort).
  test("disconnectTunnel settles idle even when logout throws", async () => {
    setTunnelDeps(deps({ logout: () => Promise.reject(new Error("revoke failed")) }));
    await selectProvider(config, "gini-relay");
    const state = await disconnectTunnel(config);
    expect(state.status).toBe("idle");
  });

  // defaultLogout: no stored session -> nothing to clear.
  test("defaultLogout no-ops when there is no stored session", async () => {
    let unlinked = 0;
    await defaultLogout(
      config.instance,
      () => fakeStoreNoSession(),
      () => {
        unlinked += 1;
      }
    );
    expect(unlinked).toBe(0);
  });

  // defaultLogout: deletes the local session file so the next connect re-logs-in.
  test("defaultLogout deletes the local session file", async () => {
    let unlinkedPath = "";
    await defaultLogout(
      config.instance,
      () => fakeStore(),
      (p) => {
        unlinkedPath = p;
      }
    );
    expect(unlinkedPath).toContain("session.json");
  });

  // defaultLogout: an unlink failure (file already gone) is swallowed.
  test("defaultLogout swallows an unlink failure", async () => {
    await defaultLogout(
      config.instance,
      () => fakeStore(),
      () => {
        throw new Error("gone");
      }
    );
  });

  // The local-port readiness guard: if nothing serves the resolved local
  // port, connect must NOT advertise a connected tunnel — it records "error".
  test("connectTunnel errors when the local web port isn't serving", async () => {
    setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(false) }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe(
      "Gini's web UI isn't responding on port 4321 — start it, then reconnect."
    );
    expect(state.url).toBeUndefined();
  });

  // The default host-browser opener shells out to `open <url>` via Bun.spawn.
  // Driven with a stubbed spawn so no real browser launches.
  test("defaultOpenBrowser spawns `open` with the url", () => {
    const calls: string[][] = [];
    const fakeSpawn = ((cmd: string[]) => {
      calls.push(cmd);
      return {} as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    defaultOpenBrowser("https://relay.test/consent", fakeSpawn);
    expect(calls).toEqual([["open", "https://relay.test/consent"]]);
  });

  // The connect-aborted branch: the login rejects AFTER a cancel has torn
  // down the supervisor, so runConnect must log "aborted" and NOT clobber the
  // idle record the cancel wrote with a spurious error.
  test("connectTunnel aborts cleanly when teardown wins the race against a login failure", async () => {
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    // Login that only rejects once the test releases the gate — by then the
    // cancel below has already deleted this instance's supervisor entry.
    const settled = (async () => {
      await gate;
      throw new Error("relay error getting login URL");
    })();
    setTunnelDeps(depsLogin({ loginUrl: () => settled.then(() => fakeLoginHandle()) }));
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Tear down before the login settles.
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    // Release the login failure; the background flow takes the aborted path.
    // The supervisor entry was deleted by the cancel, so awaitTunnelSettled
    // can't track it — flush the rejection + several microtasks instead.
    openGate();
    await settled.catch(() => {});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    // The cancel's idle record stands — no error clobber.
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect cancelled DURING the port probe must bail before the login —
  // never opening an OAuth browser tab for a connect the user abandoned.
  test("connect cancelled during the port probe never opens a browser", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({ probeLocalPort: () => probeGate.promise, openBrowser: (url) => opened.push(url) })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // runConnect is parked on the probe await; cancel before it resolves.
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    probeGate.resolve(true);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(opened).toEqual([]);
    expect(getTunnel(config).status).toBe("idle");
  });

  // The reuse path (stored session) is guarded too: a connect cancelled during
  // the probe must never spawn frpc.
  test("connect cancelled during the probe never spawns frpc (stored session)", async () => {
    const probeGate = Promise.withResolvers<boolean>();
    let built = 0;
    setTunnelDeps(
      deps({
        probeLocalPort: () => probeGate.promise,
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    probeGate.resolve(true);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(built).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect cancelled DURING loginUrl (after the probe) must cancel the
  // freshly-minted login handle and bail before opening a browser.
  test("connect cancelled during loginUrl cancels the handle and never opens a browser", async () => {
    const loginGate = Promise.withResolvers<void>();
    let cancelled = false;
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({
        loginUrl: () => loginGate.promise.then(() => fakeLoginHandle({ cancel: () => { cancelled = true; } })),
        openBrowser: (url) => opened.push(url)
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    // Let runConnect pass the probe + first guard and park at loginUrl.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await cancelTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    loginGate.resolve();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(opened).toEqual([]);
    expect(getTunnel(config).status).toBe("idle");
  });

  // If a login fails AFTER loginUrl bound its loopback (e.g. waitForSession
  // rejects), the error path must cancel the handle so the loopback isn't leaked.
  test("a login failing after loginUrl cancels the handle (no loopback leak)", async () => {
    let cancelled = false;
    setTunnelDeps(
      depsLogin({
        loginUrl: () =>
          Promise.resolve(
            fakeLoginHandle({
              waitForSession: () => Promise.reject(new Error("relay session exchange failed")),
              cancel: () => {
                cancelled = true;
              }
            })
          )
      })
    );
    await selectProvider(config, "gini-relay");
    await connectTunnel(config);
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("error");
    expect(cancelled).toBe(true);
  });

  // The real gini-relay seam wrappers delegate to the library without any
  // network I/O: createStore (instance-scoped relayHome under the temp ROOT),
  // resolveDefaults (pure), and buildTunnel (pure construction — frpc isn't
  // spawned until start()). loginUrl is the live network primitive, so it's
  // only referenced, never invoked here.
  test("makeDefaultDeps wires the real gini-relay primitives", async () => {
    const real = makeDefaultDeps();
    const relay = real.resolveDefaults();
    expect(typeof relay.relayUrl).toBe("string");
    const store = real.createStore(config);
    expect(typeof store.deviceId()).toBe("string");
    const child = real.buildTunnel({
      session: SESSION,
      deviceId: store.deviceId(),
      port: 4321,
      defaults: relay
    });
    expect(typeof child.start).toBe("function");
    expect(typeof real.loginUrl).toBe("function");
    expect(real.resolveLocalPort(config)).toBeGreaterThan(0);
    expect(typeof real.probeLocalPort).toBe("function");
    expect(typeof (await real.probeLocalPort(config, 1))).toBe("boolean");
    expect(typeof real.logout).toBe("function");
    await real.logout(config);
    expect(typeof real.persistWorkspaceGrant).toBe("function");
  });

  // defaultPersistWorkspaceGrant writes the gws authorized_user credential into a
  // minted config dir and registers it; the register seam is faked so no real gws
  // or disk-registry is touched. Signature:
  // (refreshToken, principal, register, makeConfigDir, mkdir, writeFile, findProvisioned).
  test("defaultPersistWorkspaceGrant writes the credential and registers the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gini-ws-grant-"));
    const writes: Array<{ path: string; body: string }> = [];
    const registered: Array<{ tag: string; configDir: string; trusted?: boolean; principal?: string }> = [];
    await defaultPersistWorkspaceGrant(
      "rt-live",
      "sub-123",
      async (input) => {
        registered.push(input);
        return { id: "gacct_x", tag: input.tag, email: "wilson@lilaclabs.ai", configDir: input.configDir, addedAt: "t" };
      },
      () => dir,
      () => {}, // dir already exists (mkdtemp)
      (path, body) => writes.push({ path, body }),
      () => null // no existing provisioned account → mint the dir under test
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(join(dir, "credentials.json"));
    const cred = JSON.parse(writes[0]!.body) as Record<string, string>;
    expect(cred.type).toBe("authorized_user");
    expect(cred.refresh_token).toBe("rt-live");
    expect(cred.client_id).toMatch(/\.apps\.googleusercontent\.com$/);
    // trusted:true so registration skips the live gws probe; the principal is
    // threaded so distinct identities keep separate dirs.
    expect(registered).toEqual([{ tag: "workspace", configDir: dir, trusted: true, principal: "sub-123" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  // Exercise the REAL default mkdir/writeFile/makeConfigDir/findProvisioned arrows
  // (HOME pointed at an empty temp dir so the registry read is empty and
  // configDirForAccount lands somewhere disposable); only the register seam is
  // faked so no gws subprocess runs.
  test("defaultPersistWorkspaceGrant uses real fs defaults to write the credential", async () => {
    const home = mkdtempSync(join(tmpdir(), "gini-ws-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    let writtenDir = "";
    try {
      await defaultPersistWorkspaceGrant("rt-realfs", undefined, async (input) => {
        writtenDir = input.configDir;
        return { id: "gacct_z", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
      });
      // The default makeConfigDir lands under ~/.gini/google-accounts/<id>, the
      // default mkdir created it, and the default writeFile dropped credentials.json.
      expect(writtenDir).toContain(join(home, ".gini", "google-accounts"));
      const cred = JSON.parse(readFileSync(join(writtenDir, "credentials.json"), "utf8")) as Record<string, string>;
      expect(cred.refresh_token).toBe("rt-realfs");
      expect(cred.type).toBe("authorized_user");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A tag collision (a DIFFERENT account already holds PROVISIONED_TAG) must not
  // throw: the first register rejects, the retry uses a unique tag and succeeds.
  test("defaultPersistWorkspaceGrant retries with a unique tag on collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gini-ws-grant-"));
    const tags: string[] = [];
    await defaultPersistWorkspaceGrant(
      "rt-2",
      undefined,
      async (input) => {
        tags.push(input.tag);
        if (tags.length === 1) throw new Error('tagged "workspace" already exists');
        return { id: "gacct_y", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
      },
      () => dir,
      () => {},
      () => {},
      () => null // no existing provisioned account → mint the dir under test
    );
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBe("workspace");
    expect(tags[1]).toMatch(/^workspace-gacct_/);
    rmSync(dir, { recursive: true, force: true });
  });

  // The retry after a tag collision must ALSO be trusted — otherwise the second
  // attempt would re-introduce the live gws probe the fix is removing.
  test("defaultPersistWorkspaceGrant marks both the first attempt and the collision retry trusted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gini-ws-grant-"));
    const trustedFlags: Array<boolean | undefined> = [];
    await defaultPersistWorkspaceGrant(
      "rt-3",
      undefined,
      async (input) => {
        trustedFlags.push(input.trusted);
        if (trustedFlags.length === 1) throw new Error('tagged "workspace" already exists');
        return { id: "gacct_w", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
      },
      () => dir,
      () => {},
      () => {},
      () => null
    );
    expect(trustedFlags).toEqual([true, true]);
    rmSync(dir, { recursive: true, force: true });
  });

  // Idempotency: when a provisioned account already exists, re-persisting reuses
  // its config dir (rewriting the refreshed credential in place) instead of
  // minting a new one — so a reconnect never accumulates duplicate accounts — AND
  // keeps the user's current tag instead of forcing it back to PROVISIONED_TAG.
  test("defaultPersistWorkspaceGrant reuses the existing provisioned dir and tag on re-persist", async () => {
    const existingDir = mkdtempSync(join(tmpdir(), "gini-ws-existing-"));
    const registered: Array<{ tag: string; configDir: string; trusted?: boolean; principal?: string }> = [];
    let minted = false;
    const writes: Array<{ path: string; body: string }> = [];
    await defaultPersistWorkspaceGrant(
      "rt-refreshed",
      "sub-abc",
      async (input) => {
        registered.push(input);
        return { id: "gacct_x", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
      },
      () => {
        minted = true; // makeConfigDir must NOT be consulted when one exists
        return "/tmp/should-not-be-used";
      },
      () => {},
      (path, body) => writes.push({ path, body }),
      // The user retagged this provisioned account to "work"; reuse must keep it.
      () => ({ configDir: existingDir, tag: "work" })
    );
    expect(minted).toBe(false);
    expect(registered).toEqual([{ tag: "work", configDir: existingDir, trusted: true, principal: "sub-abc" }]);
    // The refreshed credential is rewritten into the SAME dir.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(join(existingDir, "credentials.json"));
    const cred = JSON.parse(writes[0]!.body) as Record<string, string>;
    expect(cred.refresh_token).toBe("rt-refreshed");
    rmSync(existingDir, { recursive: true, force: true });
  });

  // The default findProvisioned seam, against a registry that ALREADY holds a
  // provisioned account for THIS principal, returns its dir+tag so re-persist
  // reuses it (exercises the real readGoogleAccounts filter+match). HOME is
  // isolated so the registry is the one we seed, not the machine's.
  test("defaultPersistWorkspaceGrant default seam reuses the provisioned account for the same principal", async () => {
    const home = mkdtempSync(join(tmpdir(), "gini-ws-seeded-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const seededDir = join(home, ".gini", "google-accounts", "gacct_seeded1");
    const registered: Array<{ tag: string; configDir: string; trusted?: boolean; principal?: string }> = [];
    let minted = false;
    try {
      addGoogleAccount({ id: "gacct_seeded1", tag: "work", email: "x@y.com", configDir: seededDir, addedAt: "t", provisioned: true, principal: "sub-seed" });
      await defaultPersistWorkspaceGrant(
        "rt-reuse",
        "sub-seed",
        async (input) => {
          registered.push(input);
          return { id: "gacct_seeded1", tag: input.tag, email: "x@y.com", configDir: input.configDir, addedAt: "t" };
        },
        () => {
          minted = true;
          return "/tmp/should-not-be-used";
        },
        () => {},
        () => {}
        // findProvisioned left at its default → matches principal → seededDir + tag "work"
      );
      expect(minted).toBe(false);
      expect(registered).toEqual([{ tag: "work", configDir: seededDir, trusted: true, principal: "sub-seed" }]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A DIFFERENT principal must NOT reuse another identity's provisioned dir — it
  // mints its own, so one identity's credential never clobbers the other's.
  test("defaultPersistWorkspaceGrant mints a separate dir for a different principal", async () => {
    const home = mkdtempSync(join(tmpdir(), "gini-ws-principal-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const otherDir = join(home, ".gini", "google-accounts", "gacct_other");
    const freshDir = mkdtempSync(join(tmpdir(), "gini-ws-mine-"));
    const registeredDirs: string[] = [];
    let minted = false;
    try {
      // Account already provisioned for principal A.
      addGoogleAccount({ id: "gacct_other", tag: "workspace", email: "a@y.com", configDir: otherDir, addedAt: "t", provisioned: true, principal: "sub-A" });
      // We connect as principal B.
      await defaultPersistWorkspaceGrant(
        "rt-B",
        "sub-B",
        async (input) => {
          registeredDirs.push(input.configDir);
          return { id: "gacct_n", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
        },
        () => {
          minted = true;
          return freshDir;
        },
        () => {},
        () => {}
        // default findProvisioned → no provisioned account for sub-B → null → mint freshDir
      );
      expect(minted).toBe(true);
      expect(registeredDirs).toEqual([freshDir]); // principal A's dir is untouched
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  // Back-compat: a provisioned account recorded BEFORE principals were tracked
  // has no `principal`. A connect that itself carries no principal must still
  // reuse that unkeyed account (not mint a duplicate) — the default seam's
  // no-principal arm.
  test("defaultPersistWorkspaceGrant default seam reuses an unkeyed provisioned account when no principal is known", async () => {
    const home = mkdtempSync(join(tmpdir(), "gini-ws-nokey-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const legacyDir = join(home, ".gini", "google-accounts", "gacct_legacy");
    const registered: Array<{ tag: string; configDir: string; trusted?: boolean; principal?: string }> = [];
    let minted = false;
    try {
      // Provisioned, but no principal recorded (pre-principal row).
      addGoogleAccount({ id: "gacct_legacy", tag: "workspace", email: "l@y.com", configDir: legacyDir, addedAt: "t", provisioned: true });
      await defaultPersistWorkspaceGrant(
        "rt-legacy",
        undefined, // connect carries no principal
        async (input) => {
          registered.push(input);
          return { id: "gacct_legacy", tag: input.tag, email: "l@y.com", configDir: input.configDir, addedAt: "t" };
        },
        () => {
          minted = true;
          return "/tmp/should-not-be-used";
        },
        () => {},
        () => {}
        // default findProvisioned → no-principal arm → legacyDir + tag "workspace"
      );
      expect(minted).toBe(false);
      expect(registered).toEqual([{ tag: "workspace", configDir: legacyDir, trusted: true, principal: undefined }]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The default findProvisioned seam reads the live registry: with no provisioned
  // account present it returns null, so a fresh dir is minted. HOME points at an
  // empty temp dir so the registry read is genuinely empty.
  test("defaultPersistWorkspaceGrant mints a fresh dir when no provisioned account exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "gini-ws-emptyhome-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    const dir = mkdtempSync(join(tmpdir(), "gini-ws-fresh-"));
    let minted = false;
    const registeredDirs: string[] = [];
    try {
      await defaultPersistWorkspaceGrant(
        "rt-fresh",
        undefined,
        async (input) => {
          registeredDirs.push(input.configDir);
          return { id: "gacct_n", tag: input.tag, email: "", configDir: input.configDir, addedAt: "t" };
        },
        () => {
          minted = true;
          return dir;
        },
        () => {},
        () => {}
        // findProvisioned left at its default → reads the (empty) registry → null
      );
      expect(minted).toBe(true);
      expect(registeredDirs).toEqual([dir]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // awaitTunnelSettled resolves immediately when no connect is in flight.
  test("awaitTunnelSettled resolves when nothing is connecting", async () => {
    await expect(awaitTunnelSettled(config.instance)).resolves.toBeUndefined();
  });

  // Seed a persisted "connected" tunnel record (as if the runtime was exposing a
  // tunnel before this restart). The link is long-lasting, so boot should resume.
  async function seedConnectedRecord(c: RuntimeConfig, provider: TunnelProviderId = "gini-relay"): Promise<void> {
    await mutateState(c.instance, (s) => {
      s.tunnel = {
        instance: c.instance,
        selectedProvider: provider,
        status: "connected",
        url: "https://subdom7.relay.test",
        subdomain: "subdom7",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
  }

  // Startup reconcile RESUMES a tunnel that was connected before the restart by
  // reusing the stored relay session (no browser login) — the link is meant to be
  // long-lasting / 24-7, so it comes back automatically. It first flips to
  // "connecting" so the first GET never reads a stale "connected".
  test("reconcileTunnelOnStartup resumes a previously connected tunnel by reusing the session", async () => {
    const child = fakeChild();
    let loginCalls = 0;
    const opened: string[] = [];
    setTunnelDeps(
      deps({
        buildTunnel: () => child,
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        },
        openBrowser: (url) => opened.push(url)
      })
    );
    await seedConnectedRecord(config);
    const immediate = await reconcileTunnelOnStartup(config);
    expect(immediate.status).toBe("connecting");
    expect(immediate.selectedProvider).toBe("gini-relay");
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    // Same deviceId-keyed subdomain — the link is stable across the restart.
    expect(settled.url).toBe("https://subdom7.relay.test");
    // Headless resume: the stored session was reused, no browser/login.
    expect(loginCalls).toBe(0);
    expect(opened).toEqual([]);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.reconcile")).toBe(true);
  });

  // Regression (relay update "stuck on restarting"): a client connected through
  // the relay has exactly ONE channel to the instance — the public URL the frpc
  // child fronts. A restart kills that child, so the resume must bring it back.
  // The web child the gateway reverse-proxies may still be (re)compiling at that
  // instant, but the tunnel only fronts the GATEWAY port — so once this process
  // owns that port (gatewayReady), reachability is restored WITHOUT blocking the
  // rebuild on the web child. If the resume waited on web-readiness the remote
  // browser would stay blind for the whole restart window and its update gate
  // could never poll the restart to completion.
  test("reconcileTunnelOnStartup resume restores reachability without waiting for the web child", async () => {
    const ready = Promise.withResolvers<void>();
    let built = 0;
    let probed = 0;
    setTunnelDeps(
      deps({
        // The tunnel fronts this process's own gateway port.
        resolveLocalPort: (c) => c.port,
        // The web child is still down at resume time (mid-recompile after the
        // restart). The tunnel must come back anyway — it fronts the gateway,
        // not the web child, so this must never be consulted on the resume.
        probeLocalPort: () => {
          probed += 1;
          return Promise.resolve(false);
        },
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    ready.resolve();
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("connected");
    // Same deviceId-keyed subdomain — the link is stable across the restart.
    expect(settled.url).toBe("https://subdom7.relay.test");
    expect(built).toBe(1);
    // gatewayReady (the gateway-bind proof) sufficed — the web child was never
    // probed, so a slow recompile can't keep the remote client blind.
    expect(probed).toBe(0);
  });

  // Security: reconcileTunnelOnStartup runs before Bun.serve binds config.port,
  // so the resume must NOT expose the relay URL until THIS process owns the port —
  // otherwise the stable public URL could forward to a stale/foreign listener
  // still holding it. The frpc rebuild waits on `gatewayReady`; until it resolves
  // the record stays "connecting" and no tunnel is built.
  test("reconcileTunnelOnStartup resume waits for the gateway port before exposing the tunnel", async () => {
    const ready = Promise.withResolvers<void>();
    let built = 0;
    setTunnelDeps(
      deps({
        resolveLocalPort: (c) => c.port,
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    // The resume parked on gatewayReady (runConnect's first await): the status is
    // "connecting" and no frpc child has been built yet.
    expect(getTunnel(config).status).toBe("connecting");
    expect(built).toBe(0);
    // The gateway binds → the resume proceeds and the tunnel comes up.
    ready.resolve();
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(built).toBe(1);
  });

  // If a cancel/disconnect lands while the resume is parked on gatewayReady, it
  // bails without building the tunnel and without clobbering the cancel's idle.
  test("reconcileTunnelOnStartup resume bails if cancelled while waiting for the gateway port", async () => {
    const ready = Promise.withResolvers<void>();
    let built = 0;
    setTunnelDeps(
      deps({
        resolveLocalPort: (c) => c.port,
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    const settled = awaitTunnelSettled(config.instance);
    const cancelled = await cancelTunnel(config);
    expect(cancelled.status).toBe("idle");
    // The port binds, but the resume was superseded — it must not expose anything.
    ready.resolve();
    await settled;
    expect(built).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  // Security (GINI_TUNNEL_PORT override): the tunnel can be pointed at a port this
  // process does NOT bind (resolveLocalPort ≠ config.port). gatewayReady proves
  // only config.port, so it can't vouch for the override — the resume must instead
  // verify that port's identity (a bounded, cancellable poll, since the override
  // target may still be coming up after a restart) before exposing the stable
  // public URL. It polls the local port and connects once it answers.
  test("reconcileTunnelOnStartup resume polls an overridden tunnel port, then connects", async () => {
    // Fast poll; the wait budget stays at its 60s default (beforeEach cleared any
    // ambient GINI_TUNNEL_RESUME_WAIT_MS), so the three probes land well inside it.
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "1";
    const ready = Promise.withResolvers<void>();
    ready.resolve();
    let probes = 0;
    // resolveLocalPort returns 4321 (the deps() sentinel) ≠ config.port.
    setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(++probes >= 3) }));
    await seedConnectedRecord(config);
    // gatewayReady is resolved but ignored for the override — verification is by
    // probe, not the gateway bind.
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    expect(probes).toBeGreaterThanOrEqual(3);
  });

  // If the overridden port never verifies within the budget, the resume settles
  // idle and builds nothing — it must NOT forward the relay URL to an unverified
  // (possibly foreign) listener, even though gatewayReady has resolved.
  test("reconcileTunnelOnStartup resume settles idle when an overridden port never verifies", async () => {
    process.env.GINI_TUNNEL_RESUME_WAIT_MS = "0"; // give up after the first failed probe
    const ready = Promise.withResolvers<void>();
    ready.resolve();
    let built = 0;
    let probed = 0;
    setTunnelDeps(
      deps({
        probeLocalPort: () => {
          probed += 1;
          return Promise.resolve(false);
        },
        buildTunnel: () => {
          built += 1;
          return fakeChild();
        }
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config, { gatewayReady: ready.promise });
    await awaitTunnelSettled(config.instance);
    expect(probed).toBeGreaterThanOrEqual(1);
    expect(built).toBe(0);
    expect(getTunnel(config).status).toBe("idle");
  });

  // A resume cancelled while polling an overridden port bails without clobbering
  // the idle the cancel wrote (covers the supervisor-superseded guard in the poll).
  test("reconcileTunnelOnStartup resume bails when cancelled while polling an overridden port", async () => {
    process.env.GINI_TUNNEL_RESUME_POLL_MS = "5";
    setTunnelDeps(deps({ probeLocalPort: () => Promise.resolve(false) }));
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config);
    // Capture the resume's settled promise BEFORE cancel tears down the
    // supervisor, then await it: the poll wakes, sees it was superseded, and
    // bails without clobbering the idle the cancel wrote.
    const settled = awaitTunnelSettled(config.instance);
    const cancelled = await cancelTunnel(config);
    expect(cancelled.status).toBe("idle");
    await settled;
    expect(getTunnel(config).status).toBe("idle");
  });

  // Resume is non-interactive: with no stored session it must NOT open a browser
  // or mint a login on a headless restart — it settles idle for a manual reconnect.
  test("reconcileTunnelOnStartup resume settles idle (no login) when there is no stored session", async () => {
    let loginCalls = 0;
    const opened: string[] = [];
    setTunnelDeps(
      depsLogin({
        loginUrl: () => {
          loginCalls += 1;
          return Promise.resolve(fakeLoginHandle());
        },
        openBrowser: (url) => opened.push(url)
      })
    );
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config);
    await awaitTunnelSettled(config.instance);
    const settled = getTunnel(config);
    expect(settled.status).toBe("idle");
    expect(settled.selectedProvider).toBe("gini-relay");
    expect(loginCalls).toBe(0);
    expect(opened).toEqual([]);
  });

  // A resume cancelled mid-rebuild (the frpc start is in flight) bails without
  // clobbering the idle the cancel wrote, and stops the child it spawned so it
  // isn't orphaned (covers the post-start supervisor-superseded guard).
  test("reconcileTunnelOnStartup resume bails when cancelled mid-rebuild", async () => {
    const startGate = Promise.withResolvers<void>();
    const startEntered = Promise.withResolvers<void>();
    let stopped = 0;
    const child: TunnelChild = {
      start: () => {
        startEntered.resolve();
        return startGate.promise.then(() => child);
      },
      stop: () => {
        stopped += 1;
        return Promise.resolve(0);
      },
      exited: Promise.withResolvers<number>().promise
    };
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await seedConnectedRecord(config);
    await reconcileTunnelOnStartup(config);
    // Wait until the resume has actually entered frpc start (deterministic — no
    // reliance on microtask ordering) so the cancel below lands mid-rebuild.
    await startEntered.promise;
    // Capture the settled promise BEFORE cancel tears the supervisor down so the
    // await is deterministic.
    const settled = awaitTunnelSettled(config.instance);
    const cancelled = await cancelTunnel(config);
    expect(cancelled.status).toBe("idle");
    // Release the gated start: the resume sees it was superseded, stops the
    // child it spawned, and bails without clobbering the cancel's idle.
    startGate.resolve();
    await settled;
    expect(getTunnel(config).status).toBe("idle");
    expect(stopped).toBeGreaterThanOrEqual(1);
  });

  // A "connected" record for a provider that is no longer enabled does NOT resume
  // (covers the disabled-provider guard); it just resets to idle.
  test("reconcileTunnelOnStartup does not resume a connected record for a disabled provider", async () => {
    await seedConnectedRecord(config, "tailscale");
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("tailscale");
  });

  // Startup reconcile also resets a stale "connecting" record.
  test("reconcileTunnelOnStartup resets a stale connecting record to idle", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "connecting",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
  });

  // Startup reconcile leaves an idle record untouched (no audit row, no write).
  test("reconcileTunnelOnStartup leaves an idle record untouched", async () => {
    await selectProvider(config, "gini-relay"); // writes an idle record
    const before = readState(config.instance).tunnel?.updatedAt;
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBe("gini-relay");
    expect(readState(config.instance).tunnel?.updatedAt).toBe(before);
    expect(readState(config.instance).audit.some((a) => a.action === "tunnel.reconcile")).toBe(false);
  });

  // Startup reconcile on a fresh instance (null record) is a clean no-op.
  test("reconcileTunnelOnStartup on a fresh instance returns idle/null", async () => {
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("idle");
    expect(state.selectedProvider).toBeNull();
  });

  // Startup reconcile leaves an error record untouched (it's not stale-live).
  test("reconcileTunnelOnStartup leaves an error record untouched", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "error",
        message: "boom",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = await reconcileTunnelOnStartup(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("boom");
  });

  // A persisted error record surfaces its message and no url via GET.
  test("getTunnel surfaces a persisted error message and hides url", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: config.instance,
        selectedProvider: "gini-relay",
        status: "error",
        message: "login failed",
        url: "https://should-not-show",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    });
    const state = getTunnel(config);
    expect(state.status).toBe("error");
    expect(state.message).toBe("login failed");
    expect(state.url).toBeUndefined();
  });

  // Metadata wins over the spread: a rebuilt record takes the authoritative
  // instance and a fresh updatedAt, while preserving the original createdAt —
  // even when the prior record carried stale instance/timestamps.
  test("createTunnelRecord refreshes instance/updatedAt and preserves createdAt", async () => {
    await mutateState(config.instance, (s) => {
      s.tunnel = {
        instance: "STALE-INSTANCE",
        selectedProvider: "gini-relay",
        status: "idle",
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z"
      };
    });
    await selectProvider(config, "gini-relay");
    const rec = readState(config.instance).tunnel;
    expect(rec?.instance).toBe(config.instance);
    expect(rec?.createdAt).toBe("2000-01-01T00:00:00.000Z");
    expect(rec?.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  // Shutdown teardown: stopAllTunnels stops the live frpc child so it isn't left
  // running past runtime exit.
  test("stopAllTunnels stops a live tunnel child", async () => {
    const child = fakeChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    await stopAllTunnels();
    expect(child.stopped).toBe(true);
    // Idempotent: a second call with nothing live still resolves.
    await stopAllTunnels();
  });

  // A connect that is superseded mid-handshake by a newer connect must abort
  // (stop the child it spawned) and never overwrite the winner's "connected".
  test("a superseded connect aborts without clobbering the winning connect", async () => {
    // childA's stop() rejects so this also exercises the abort path's best-effort
    // stop().catch (the older run stopping the child it spawned).
    const childA = rejectStopChild(true);
    const childB = fakeChild();
    let built = 0;
    setTunnelDeps(deps({ buildTunnel: () => (built++ === 0 ? childA : childB) }));
    await selectProvider(config, "gini-relay");

    // Connect A parks at childA.start() (gated); flush so it builds + registers
    // childA before the superseding connect tears it down.
    await connectTunnel(config, "gini-relay");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(built).toBe(1);

    // Connect B supersedes A and connects.
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Release A: it sees it's no longer current and aborts (no clobber).
    childA.releaseStart();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(getTunnel(config).status).toBe("connected");
    expect(childA.stopCalls).toBeGreaterThanOrEqual(1);
  });

  // stopAllTunnels is best-effort: a child whose stop() rejects must be swallowed.
  test("stopAllTunnels swallows a child.stop() rejection", async () => {
    setTunnelDeps(deps({ buildTunnel: () => rejectStopChild() }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");
    await stopAllTunnels();
  });

  // With auto-reconnect disabled, a live tunnel whose frpc child exits on its
  // own (crash/relay drop) flips "connected" -> "error" so the UI stops
  // advertising a dead tunnel. (The default behavior — auto-reconnect — is
  // covered in the reconnect tests below.)
  test("a tunnel child exiting on its own flips connected to error (reconnect disabled)", async () => {
    process.env.GINI_TUNNEL_RECONNECT_MAX_ATTEMPTS = "0"; // restored in afterEach
    const child = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    child.crash(7);
    await waitForStatus(config, "error");
    const state = getTunnel(config);
    expect(state.message).toContain("exited (code 7)");
    expect(state.url).toBeUndefined();
  });

  // The exit watcher must NOT fire after an intentional disconnect: disconnect
  // stops the child (resolving its exited), but the entry is gone, so the idle
  // record stands instead of being clobbered with a spurious "error".
  test("a child exiting via disconnect does not overwrite the idle record", async () => {
    const child = crashableChild();
    setTunnelDeps(deps({ buildTunnel: () => child }));
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    await disconnectTunnel(config);
    expect(getTunnel(config).status).toBe("idle");
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(getTunnel(config).status).toBe("idle");
  });

  // A connect that starts while disconnect is awaiting logout must NOT be
  // clobbered back to idle: disconnect's idle write skips when a newer connect
  // has claimed the instance.
  test("disconnect does not clobber a connect that starts during the logout await", async () => {
    const logoutGate = Promise.withResolvers<void>();
    const childB = fakeChild();
    let built = 0;
    setTunnelDeps(
      deps({
        logout: () => logoutGate.promise,
        buildTunnel: () => (built++ === 0 ? fakeChild() : childB)
      })
    );
    // Get to connected (childA).
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Begin disconnect; it tears down then parks on the gated logout.
    const disconnecting = disconnectTunnel(config);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // A new connect claims the instance while disconnect is mid-logout.
    await connectTunnel(config, "gini-relay");
    await awaitTunnelSettled(config.instance);
    expect(getTunnel(config).status).toBe("connected");

    // Release logout; disconnect must leave the new connect's record intact.
    logoutGate.resolve();
    await disconnecting;
    expect(getTunnel(config).status).toBe("connected");
  });
});

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
