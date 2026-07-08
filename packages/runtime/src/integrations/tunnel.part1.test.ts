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
