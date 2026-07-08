import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import "./hooks/builtins"; // the email-watch routes provision a backing job, which validates isKnownHook("skill-script")
import { createHandler, resolveInlineUpload } from "./http";
import { logDir, uploadsDir, webPortPath } from "./paths";
import { clearWebTargetCache } from "./web-target";
import { dirname, join } from "node:path";
import { addAudit, appendEvent, insertChatBlock, isPlausibleMime, mutateState, readState, readTrace, recordProviderAuthFailure, sanitizeFilename, storeUpload, uploadStat } from "./state";
import { getOrCreateAgentChat } from "./execution/chat";
import { createScheduledJob } from "./jobs";
import { removeMemoryDb } from "./state/memory-db";
import { listProviders } from "./integrations/connectors/registry";
import { resetGoogleLoginWebState } from "./integrations/connectors/google-login-web";
import { awaitTunnelSettled, setTunnelDeps, type TunnelChild } from "./integrations/tunnel";
import type { RuntimeConfig } from "./types";
import type { LoginHandle, RelayDefaults, Session, Store, TunnelOptions } from "gini-relay";

// Stub a provider's host-environment `detect()` so the connector-detection
// endpoint test stays deterministic AND fast regardless of what's installed
// on the developer's PATH. The production `detect()` for claude-code / codex
// shells out via spawnSync (`which`, `claude auth status`), which on a machine
// with those CLIs installed dominates this test's wall time (the unstubbed
// detect endpoint test measured 1.524641s). Mirrors the same in-place
// swap-and-restore helper used by src/jobs/connector-detection.test.ts. The
// registry is a process-wide singleton, so the returned restore fn MUST run in
// a finally to avoid leaking the stub into sibling tests.
function stubProviderDetect(
  providerId: string,
  value: { detected: boolean; suggestedName?: string; message?: string }
): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.detect;
  provider.detect = async () => value;
  return () => {
    provider.detect = previous;
  };
}

// Companion to stubProviderDetect. After connector auto-detection creates a
// record for a provider that exposes a `probe()`, runConnectorDetection runs
// an initial checkConnector → provider.probe, which for claude-code shells out
// to `claude auth status` again. Stub the probe so the detection endpoint
// test never touches a real subprocess. Same swap-and-restore discipline.
function stubProviderProbe(providerId: string, value: { ok: boolean; message: string }): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.probe;
  provider.probe = async () => value;
  return () => {
    provider.probe = previous;
  };
}

describe("runtime api", () => {
  test("POST /api/setup-requests/<id>/complete vs cancel on the same grant card: Cancel prevents the grant+enable", async () => {
    const config = testConfig("setup-complete-skill-grant-cancel-race");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill, createTask, upsertTask } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-linear-cancel-race",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredConnectors: [{ provider: "linear" }]
      })
    );
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "grant cancel race");
      task.status = "completed";
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "skill.grant_connector",
        target: "Linear",
        reason: "Skill needs-linear-cancel-race requests access to your Linear credential.",
        payload: {
          skillId: skill.id,
          skillName: skill.name,
          credentialName: "LINEAR_API_KEY",
          credentialLabel: "Linear",
          toolCallId: "call_grant_cancel_race"
        }
      })
    );

    // Race a complete against a cancel on the SAME card. The per-instance
    // mutateState lock serializes the two pending→terminal transitions, so
    // exactly one wins. The consent gate must be honored: whichever side wins,
    // a grant+enable happens ONLY if complete won — a winning cancel leaves the
    // skill disabled and ungranted.
    const [completeRes, cancelRes] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({})
      }, config.token)
    ]);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    const updated = state.skills.find((s) => s.id === skill.id);
    const granted = state.audit.some((a) => a.action === "skill.connector.granted");
    const enabled = state.audit.some((a) => a.action === "skill.enabled");

    if (resolved?.status === "cancelled") {
      // Cancel won — the consent gate is honored: NO grant, NO enable.
      expect(completeRes.ok).toBe(false);
      expect(updated?.status).toBe("disabled");
      expect(updated?.grantedConnectors ?? []).toEqual([]);
      expect(granted).toBe(false);
      expect(enabled).toBe(false);
    } else {
      // Complete won — cancel is a no-op against the now-completed row, and
      // the skill is granted+enabled.
      expect(resolved?.status).toBe("completed");
      expect(cancelRes.ok).toBe(false);
      expect(updated?.status).toBe("enabled");
      expect(updated?.grantedConnectors).toEqual(["LINEAR_API_KEY"]);
      expect(granted).toBe(true);
      expect(enabled).toBe(true);
    }
  });


  test("POST /api/setup-requests/<id>/complete returns ok:false, claims the request, and cleans up the connector on probe failure", async () => {
    const config = testConfig("setup-requests-complete-probe-fail");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "linear",
        reason: "fetch issues",
        payload: {
          provider: "linear",
          providerLabel: "Linear",
          providerDescription: "Linear",
          reason: "fetch issues",
          fields: [],
          toolCallId: "call_linear_fail"
        }
      })
    );
    // Stub the Linear GraphQL probe with a 401 so the probe fails.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{\"errors\":[{\"message\":\"Unauthorized\"}]}", {
      status: 401,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    try {
      const response = await call(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { token: "not-a-real-token" } })
      });
      expect(response.ok).toBe(false);
      expect(response.message).toBeString();
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The row was claimed BEFORE the create (claim-first race safety), so a
    // probe failure cannot bounce it back to pending — it stays completed
    // with a persisted failure outcome, and the orphaned unhealthy connector
    // is cleaned up so it never lingers as a half-configured record.
    const state = readState(config.instance);
    const after = state.setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("completed");
    expect(after?.connectOutcome?.ok).toBe(false);
    expect(state.connectors.some((c) => c.provider === "linear")).toBe(false);
  });


  test("POST /api/setup-requests/<id>/complete: an UNEXPECTED post-claim throw resumes the task instead of stranding it", async () => {
    // Strand-the-task regression: after the winning claim, createConnector /
    // grant / enable / resume can still throw (here: a duplicate credential
    // name). The route's catch-all would return 500 while the setup row sits
    // `completed` and the task stays `waiting_approval` — orphaned. The fix
    // wraps the whole post-claim block: any throw persists a failure outcome
    // and resumes the task. We seed a genuine waiting_approval task with a
    // resumable toolCallState (one pending request_connector call) so the
    // resume re-enters the echo loop and the task settles terminally.
    const config = testConfig("setup-complete-postclaim-throw");
    const handler = createHandler(config);
    const { createSetupRequest, createTask, upsertTask } = await import("./state");

    // Pre-seed a connector under the requested name so createConnector throws
    // on instance-wide name uniqueness AFTER the claim.
    await seedTypedCredential(config, "DUP_API_KEY", "generic");

    const toolCallId = "call_postclaim_throw";
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "needs dup key");
      task.status = "waiting_approval";
      task.toolCallState = {
        messages: [
          { role: "system", content: "you are gini" },
          { role: "user", content: "connect dup" },
          { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "request_connector", arguments: "{}" } }] }
        ],
        toolsHash: "test",
        pending: [{ toolCallId, toolName: "request_connector", approvalId: "" }],
        iterations: 1
      };
      upsertTask(state, task);
      return task.id;
    });

    const approval = await mutateState(config.instance, (state) => {
      const a = createSetupRequest(state, {
        taskId,
        action: "connector.request",
        target: "DUP_API_KEY",
        reason: "Enter your Dup API key",
        payload: {
          credentialName: "DUP_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Dup",
          reason: "Enter your Dup API key",
          toolCallId
        }
      });
      // Bind the approval to the task so the pending entry resolves on resume.
      const item = state.tasks.find((t) => t.id === taskId)!;
      item.toolCallState!.pending[0]!.approvalId = a.id;
      item.approvalIds.push(a.id);
      return a;
    });

    const raw = await rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { DUP_API_KEY: "dup-secret" } })
    }, config.token);
    const response = await raw.json();
    // The route returned a structured failure body (the outcome + resume ran;
    // it is NOT the bare catch-all 500 that bypasses both).
    expect(response.ok).toBe(false);
    expect(response.message).toBeString();

    const settled = await waitForTask(handler, config, taskId);
    // The task RESUMED — it is no longer stranded at waiting_approval.
    expect(settled.task.status).not.toBe("waiting_approval");

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    // The setup row is claimed (resolved) with a persisted failure outcome.
    expect(resolved?.status).toBe("completed");
    expect(resolved?.connectOutcome?.ok).toBe(false);
    // No duplicate connector was created — only the pre-seeded one remains.
    expect(state.connectors.filter((c) => c.name === "DUP_API_KEY").length).toBe(1);
  });


  test("POST /api/setup-requests/<id>/complete: a double-submit of a connector.request resolves once with no extra mutations", async () => {
    // Claim-first race safety for connector.request: two concurrent completes
    // of the same card — the mutateState lock serializes the atomic claim, so
    // exactly one wins and creates exactly one connector; the loser produces
    // zero side effects.
    const config = testConfig("setup-complete-connector-double");
    const handler = createHandler(config);
    const { createSetupRequest, createSkill } = await import("./state");
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-race-key",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["RACE_API_KEY"]
      })
    );
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "connector.request",
        target: "RACE_API_KEY",
        reason: "Enter your Race API key",
        payload: {
          credentialName: "RACE_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Race",
          skillId: skill.id,
          reason: "Enter your Race API key",
          toolCallId: "call_race"
        }
      })
    );

    const [a, b] = await Promise.all([
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { RACE_API_KEY: "race-secret" } })
      }, config.token),
      rawCall(handler, config, `/api/setup-requests/${approval.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ secrets: { RACE_API_KEY: "race-secret" } })
      }, config.token)
    ]);
    // Exactly one winner.
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === approval.id);
    expect(resolved?.status).toBe("completed");
    // Exactly one connector created — the loser created nothing.
    expect(state.connectors.filter((c) => c.name === "RACE_API_KEY").length).toBe(1);
    // The skill was granted the credential exactly once and enabled.
    const updated = state.skills.find((s) => s.id === skill.id);
    expect(updated?.grantedConnectors).toEqual(["RACE_API_KEY"]);
    expect(updated?.status).toBe("enabled");
    // Exactly one grant audit row from the single winner.
    expect(state.audit.filter((au) => au.action === "skill.connector.granted").length).toBe(1);
  });


  test("POST /api/setup-requests/<id>/complete 404s for an authorization id", async () => {
    const config = testConfig("setup-requests-complete-wrong-collection");
    const handler = createHandler(config);
    const { createAuthorization } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createAuthorization(state, {
        action: "file.write",
        target: "/tmp/x",
        risk: "high",
        reason: "stub",
        payload: { path: "/tmp/x", content: "hi" }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      { method: "POST", body: JSON.stringify({ secrets: {} }) },
      config.token
    );
    // Authorization ids never appear in the setupRequests collection, so
    // /complete returns 404 — the two endpoint families are independent.
    expect(response.status).toBe(404);
  });


  test("POST /api/setup-requests/<id>/complete creates a messaging bridge and resolves the setup request", async () => {
    // Happy-path pin for the chat-side Add Telegram flow. The card's
    // Submit button POSTs the name + bot token under `secrets`; the
    // gateway routes them into addMessagingBridge (the same code path
    // the CLI and the settings page already call) and resolves the
    // setup request so the chat-task loop can resume.
    const config = testConfig("setup-complete-bridge-happy");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "chat-test-bridge", toolCallId: "call_bridge_happy" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { name: "chat-test-bridge", botToken: "1234:ABCDEFGHIJKLMNOPQR" } })
    });
    expect(response.ok).toBe(true);
    expect(response.bridge?.name).toBe("chat-test-bridge");
    expect(response.bridge?.kind).toBe("telegram");

    const state = readState(config.instance);
    const resolved = state.setupRequests.find((s) => s.id === setup.id);
    expect(resolved?.status).toBe("completed");
    const bridge = state.messagingBridges.find((b) => b.name === "chat-test-bridge");
    expect(bridge).toBeDefined();
    expect(bridge?.kind).toBe("telegram");

    // Audit-row traceability pin: the chat-card create writes a
    // dedicated audit row with the originating setup-request id AND the
    // resulting bridge.id so operators can reconstruct
    // "setup X via chat-card → bridge Y" from the activity feed.
    // Without this row the chat path is indistinguishable from the
    // CLI / settings dialog in the audit log (both write the same
    // generic messaging.configured row via createMessagingBridgeRecord).
    const chatAddRow = state.audit.find(
      (e) => e.action === "messaging.add_bridge" && e.approvalId === setup.id
    );
    expect(chatAddRow).toBeDefined();
    expect(chatAddRow?.target).toBe(bridge?.id);
    expect((chatAddRow?.evidence as { kind?: string } | undefined)?.kind).toBe("telegram");
    expect((chatAddRow?.evidence as { bridgeName?: string } | undefined)?.bridgeName).toBe("chat-test-bridge");

    // Durable outcome pin: the /complete handler writes
    // setup.connectOutcome so a post-reload render of the resolved
    // card reads the truthful past-tense summary. Without this, the
    // React component's sticky state evaporates on reload and the
    // card would fall back to "Bridge added." even when the side
    // effect actually failed.
    expect(resolved?.connectOutcome?.ok).toBe(true);
    expect(resolved?.connectOutcome?.message).toContain("chat-test-bridge");
  });


  test("POST /api/setup-requests/<id>/complete refuses messaging.add_bridge that was already cancelled, and creates no bridge", async () => {
    // Race-safety pin: the messaging.add_bridge branch must resolve the
    // setup request BEFORE addMessagingBridge so a concurrent /cancel
    // (or cancel cascade) cannot leave an orphan bridge + encrypted
    // secret on disk after the user has already abandoned the prompt.
    // Mirrors the resolve-first contract in
    // src/execution/browser-fill-secrets.ts. We simulate the race by
    // pre-cancelling the setup request and then hitting /complete — the
    // handler must short-circuit at the "already !pending" guard,
    // return 410, and never touch addMessagingBridge.
    const config = testConfig("setup-complete-bridge-cancel-race");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "race-bridge", toolCallId: "call_bridge_race" }
      })
    );
    // Pre-cancel the setup request as if a concurrent operator had
    // clicked Cancel between the user's typing and the Submit landing
    // on the server.
    await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
    const beforeBridges = readState(config.instance).messagingBridges.length;

    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${setup.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { name: "race-bridge", botToken: "1234:ABCDEFGHIJKL" } })
      },
      config.token
    );
    // 410 Gone — the resolution-before-creation contract is upheld by
    // the outer "already !pending" guard. The load-bearing invariant
    // is the absence of any bridge / orphan secret on the other side.
    expect(response.status).toBe(410);

    const after = readState(config.instance);
    expect(after.messagingBridges.length).toBe(beforeBridges);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
  });


  test("POST /api/setup-requests/<id>/complete rejects malformed messaging.add_bridge tokens BEFORE resolving the setup request", async () => {
    // Token-format pre-check: addMessagingBridge runs
    // assertHeaderSafeToken internally, and the chat card disappears
    // once the setup request flips out of pending state. Without
    // pre-resolve token validation, a malformed token would burn the
    // request and the user could not retype from the same card.
    // The bounded module calls assertHeaderSafeToken BEFORE resolving;
    // this test pins that ordering by submitting a token with a control
    // character and asserting the request stays pending.
    const config = testConfig("setup-complete-bridge-bad-token-stays-pending");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "bad-token", toolCallId: "call_bridge_bad_token" }
      })
    );
    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      // Control character in the token — assertHeaderSafeToken
      // refuses any byte outside printable ASCII [\x21-\x7E].
      body: JSON.stringify({ secrets: { name: "bad-token", botToken: "1234:abc\ndef" } })
    });
    expect(response.ok).toBe(false);
    expect(typeof response.message).toBe("string");

    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
    expect(after.messagingBridges.length).toBe(0);
  });


  test("POST /api/setup-requests/<id>/complete returns ok:false when messaging.add_bridge is missing a name or token", async () => {
    // The chat card disables Submit until both inputs are non-empty,
    // but a CLI/API caller could POST a partial body. The gateway
    // mirrors the same readiness gate as the card so a partial
    // submission can't silently create a half-configured bridge.
    const config = testConfig("setup-complete-bridge-missing");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.add_bridge",
        target: "telegram",
        reason: "Add a Telegram bridge",
        payload: { kind: "telegram", suggestedName: "missing-fields", toolCallId: "call_bridge_missing" }
      })
    );
    const missingToken = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { name: "missing-fields" } })
    });
    expect(missingToken.ok).toBe(false);
    expect(missingToken.message).toContain("Bot token");

    const missingName = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ secrets: { botToken: "1234:ABCDEFGHIJ" } })
    });
    expect(missingName.ok).toBe(false);
    expect(missingName.message).toContain("name");

    // Both rejections must leave the setup request pending — otherwise
    // the chat card would flip out of pending state and the user
    // couldn't retry.
    const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
    expect(after?.status).toBe("pending");
  });


  test("screencast frames + input endpoints 404 for an unknown setup request", async () => {
    const config = testConfig("screencast-404");
    const handler = createHandler(config);
    const frames = await rawCall(handler, config, "/api/browser/screencast/nope/frames", {}, config.token);
    expect(frames.status).toBe(404);
    const input = await rawCall(handler, config, "/api/browser/screencast/nope/input", {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(input.status).toBe(404);
  });


  test("screencast frames returns 409 when no spawned browser is running", async () => {
    // A real browser.connect setup exists, but there's no live spawned Chrome
    // in this unit-test context, so the bridge fails to start and the endpoint
    // surfaces 409 rather than opening an empty stream.
    const config = testConfig("screencast-no-browser");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in to continue",
        payload: { toolCallId: "call_sc", signInStarted: true, screencast: true }
      })
    );
    const frames = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(frames.status).toBe(409);
    const input = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/input`, {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(input.status).toBe(409);
  });


  test("open-browser 409s with the no-URL message when no browser is live and no page URL is recorded", async () => {
    // A pending browser.connect with no live spawned Chrome AND no recorded url
    // can't relaunch anything to screencast, so it 409s with the distinct
    // no-URL message rather than attempting a blind navigate.
    const config = testConfig("open-browser-no-url-no-browser");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_no_url" }
      })
    );
    const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no page URL is recorded");
    // The row stays pending so a later retry (once a browser is live) works.
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });


  test("open-browser attempts a headless relaunch+navigate when a URL is recorded but no browser is live", async () => {
    // Restart/crash/disconnect drops the in-process spawned handle while the
    // durable card survives. With a recorded url, open-browser relaunches the
    // headless Chrome and navigates to it (the spawn-only replacement for the
    // removed managed relaunch) instead of stranding the user. We STUB the spawn
    // launcher to throw so the relaunch fails deterministically (no dependence
    // on ambient "is real Chrome installed?"), proving the recovery path was
    // taken and surfaces a 409 with the row left pending for a later real retry.
    const config = testConfig("open-browser-relaunch-attempt");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const browserMod = await import("./tools/browser");
    const browserTest = browserMod.__test;
    browserMod.setBrowserInstance(config.instance);
    browserTest.setSpawnChromeForTest(async () => {
      throw new Error("stubbed: no Chrome in this unit test");
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "Sign in",
          reason: "Sign in",
          payload: { toolCallId: "call_relaunch", url: "https://example.com/login" }
        })
      );
      const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      expect(res.status).toBe(409);
      const body = await res.json();
      // Distinct from the no-URL message: this 409 came from the relaunch attempt.
      expect(body.error).not.toContain("no page URL is recorded");
      expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
    } finally {
      browserTest.setSpawnChromeForTest(null);
      browserTest.uninstallFakeBrowserForTest();
      browserTest.resetBrowserInstanceForTest();
    }
  });


  test("open-browser refuses (no relaunch/navigate) when the user's Chrome is attached over CDP", async () => {
    // A stale Connect card racing a later cdp attach: the screencast streams the
    // SPAWNED Chrome, but the user is on cdp. /open-browser must NOT relaunch +
    // navigate the user's external Chrome to the recorded URL — it refuses with
    // the cdp-specific 409 BEFORE any navigation. (The dispatch guard stops NEW
    // cards on cdp; this covers an already-minted card hitting /open-browser.)
    const config = testConfig("open-browser-cdp-refuse");
    const handler = createHandler(config);
    const { createSetupRequest, now } = await import("./state");
    const setup = await mutateState(config.instance, (state) => {
      // Active cdp transport + a stale card carrying a recorded URL.
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: now() };
      return createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_cdp_stale", url: "https://example.com/login" }
      });
    });
    const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain("attached over CDP");
    // The card was NOT stamped as a live screencast (no navigation happened).
    const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
    expect(after?.status).toBe("pending");
    expect(after?.payload.signInStarted).toBeUndefined();
    expect(after?.payload.screencast).toBeUndefined();
  });


  test("frames reconnect on an already-stamped card relaunches the browser when none is live", async () => {
    // After a gateway/Chrome restart, an already-stamped sign-in card (screencast
    // + signInStarted, still pending) skips /open-browser — the modal reconnects
    // straight to /frames. So /frames must itself attempt the headless relaunch
    // when no browser is live and a URL is recorded, or the user is stuck on a
    // permanent 409. In this unit context there's no real Chrome, so the relaunch
    // fails fast and 409s — but via the relaunch path (distinct from the no-URL
    // message), proving the reconnect recovery is wired through /frames.
    const config = testConfig("frames-reconnect-relaunch");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        // Already stamped (the pre-restart open-browser ran); URL recorded.
        payload: { toolCallId: "call_frames_relaunch", url: "https://example.com/login", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).not.toContain("no page URL is recorded");
    // Row stays pending so a real retry (with a live browser) can recover.
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });


  test("frames reconnect on a stamped card with NO recorded URL 409s with the no-URL message", async () => {
    // The relaunch needs a target page; without a recorded URL there's nothing
    // to navigate to, so /frames 409s with the distinct no-URL message rather
    // than blindly relaunching.
    const config = testConfig("frames-reconnect-no-url");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in",
        reason: "Sign in",
        payload: { toolCallId: "call_frames_no_url", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/frames`, {}, config.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no page URL is recorded");
  });


  test("screencast endpoints reject a setup that isn't an active sign-in (lifecycle gate)", async () => {
    // A browser.connect setup that is NOT pending, OR not stamped screencast +
    // signInStarted, must be refused so a stale EventSource reconnect after
    // complete/cancel can't rebuild a live drive channel.
    const config = testConfig("screencast-lifecycle");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    // Pending, but never went through open-browser (no screencast/signInStarted).
    const notStarted = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ls" }
      })
    );
    const r1 = await rawCall(handler, config, `/api/browser/screencast/${notStarted.id}/frames`, {}, config.token);
    expect(r1.status).toBe(404);
    // Stamped screencast but cancelled — no longer pending.
    const cancelled = await mutateState(config.instance, (state) => {
      const s = createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ls2", signInStarted: true, screencast: true }
      });
      const row = state.setupRequests.find((x) => x.id === s.id);
      if (row) row.status = "cancelled";
      return s;
    });
    const r2 = await rawCall(handler, config, `/api/browser/screencast/${cancelled.id}/input`, {
      method: "POST",
      body: JSON.stringify({ kind: "move", x: 1, y: 1 })
    }, config.token);
    expect(r2.status).toBe(404);
  });


  test("open-browser refuses a row cancelled before the stamp mutation (in-mutation status recheck)", async () => {
    // /open-browser checks pending on a pre-read, then stamps screencast +
    // signInStarted inside mutateState. A /cancel that commits in that window
    // must not get a live sign-in stamped on top: the in-mutation status
    // recheck returns 410 and leaves the cancelled row untouched.
    const config = testConfig("open-browser-raced-cancel");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const { __test: browserTest } = await import("./tools/browser");
    // A live spawned handle so getScreencastPort is non-null (we get past the
    // 409 no-browser gate and reach the stamp mutation).
    browserTest.installFakeSpawnedHandleForTest(9333, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com",
          reason: "Sign in to continue",
          payload: { toolCallId: "call_race" }
        })
      );
      // Cancel the row first — this is the racer that wins.
      await mutateState(config.instance, (state) => {
        const row = state.setupRequests.find((s) => s.id === setup.id);
        if (row) row.status = "cancelled";
      });
      const res = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      // The pre-read pending gate already 410s here; the in-mutation recheck is
      // the backstop for a cancel that lands AFTER that gate. Either way the
      // contract is: no live sign-in stamped on a terminal row.
      expect(res.status).toBe(410);
      const after = readState(config.instance).setupRequests.find((s) => s.id === setup.id);
      expect(after?.status).toBe("cancelled");
      expect(after?.payload.signInStarted).toBeUndefined();
      expect(after?.payload.screencast).toBeUndefined();
    } finally {
      browserTest.uninstallFakeBrowserForTest();
    }
  });


  test("browser.connect /complete claims the row BEFORE writing the audit row (no duplicate on double-submit)", async () => {
    // The non-screencast fallback must resolve (claim pending->completed) before
    // writing the rich browser.connect audit row. A second /complete loses the
    // claim (ApprovalRaceLostError) and writes ZERO side effects, so exactly one
    // browser.connect audit row exists no matter how many completes race.
    const config = testConfig("browser-connect-complete-claim-first");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "Sign in to the store",
        reason: "Sign in to the store",
        // No screencast marker → the non-screencast fallback path.
        payload: { toolCallId: "call_complete", reason: "Sign in to the store" }
      })
    );
    const first = await rawCall(handler, config, `/api/setup-requests/${setup.id}/complete`, { method: "POST" }, config.token);
    expect(first.status).toBe(200);
    // Second complete on the now-terminal row loses the claim.
    const second = await rawCall(handler, config, `/api/setup-requests/${setup.id}/complete`, { method: "POST" }, config.token);
    expect(second.status).toBeGreaterThanOrEqual(400);
    const browserConnectAudits = readState(config.instance).audit.filter((a) => a.action === "browser.connect");
    expect(browserConnectAudits).toHaveLength(1);
  });


  test("open-browser is idempotent: a second open on an already-stamped row writes no duplicate audit", async () => {
    // /open-browser keeps the row pending, so two opens (double-click / retry)
    // both pass the pending check. The in-mutation already-stamped guard makes
    // the second a no-op so exactly one stage:open-browser audit row exists.
    const config = testConfig("open-browser-idempotent");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSpawnedHandleForTest(9333, {
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    try {
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com",
          reason: "Sign in to continue",
          payload: { toolCallId: "call_idem", url: "https://example.com/login" }
        })
      );
      const first = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      expect(first.status).toBe(200);
      const second = await rawCall(handler, config, `/api/setup-requests/${setup.id}/open-browser`, { method: "POST" }, config.token);
      // The second open succeeds (idempotent) but writes no extra audit/trace.
      expect(second.status).toBe(200);
      const openAudits = readState(config.instance).audit.filter(
        (a) => a.action === "browser.connect" && (a.evidence as Record<string, unknown> | undefined)?.stage === "open-browser"
      );
      expect(openAudits).toHaveLength(1);
    } finally {
      browserTest.uninstallFakeBrowserForTest();
    }
  });


  test("screencast frames stream a frame and input dispatches with a live bridge", async () => {
    // HTTP success path: install a fake bridge (no real Chrome) so the SSE
    // envelope + input dispatch wiring is exercised end to end at the gateway.
    const config = testConfig("screencast-success");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_ok", signInStarted: true, screencast: true }
      })
    );
    // A minimal fake bridge: replays one frame to each subscriber and records
    // dispatched input. Installed as the live activeBridge so the no-factory
    // getOrStartBridge inside http.ts reuses it.
    const dispatched: unknown[] = [];
    const fakeBridge = {
      isClosed: () => false,
      subscribe(
        onFrame: (f: { data: string; meta: Record<string, unknown> }) => void,
        _onClose?: () => void,
        onUrl?: (url: string) => void
      ) {
        onUrl?.("https://signin.example.com/login");
        onFrame({ data: "QUJD", meta: { deviceWidth: 800 } });
        return () => undefined;
      },
      dispatchInput: async (m: { kind?: string }) => {
        dispatched.push(m);
        // Mirror the real bridge: selection-causing kinds return a selection.
        return m.kind === "copy" ? { selection: "picked text" } : {};
      },
      start: async () => undefined,
      stop: async () => undefined
    };
    sc.__setActiveBridgeForTest(fakeBridge as never, setup.id);
    try {
      const framesRes = await handler(
        new Request(`http://127.0.0.1:${config.port}/api/browser/screencast/${setup.id}/frames`, {
          headers: { authorization: `Bearer ${config.token}` }
        })
      );
      expect(framesRes.status).toBe(200);
      expect(framesRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = framesRes.body!.getReader();
      // onUrl and onFrame enqueue separate chunks; read both.
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      const second = decoder.decode((await reader.read()).value);
      const text = first + second;
      // The gateway-sourced origin is streamed as an `event: url` so the modal
      // can show the operator which site they're signing into.
      expect(text).toContain("event: url");
      expect(text).toContain("https://signin.example.com/login");
      expect(text).toContain("event: frame");
      expect(text).toContain("QUJD");
      await reader.cancel();

      const inputRes = await call(handler, config, `/api/browser/screencast/${setup.id}/input`, {
        method: "POST",
        body: JSON.stringify({ kind: "click", x: 10, y: 20, clickCount: 1 })
      });
      expect(inputRes.ok).toBe(true);
      expect(dispatched).toEqual([{ kind: "click", x: 10, y: 20, clickCount: 1 }]);

      // A copy relays the remote selection back in the response body so the
      // modal can serve it to the operator's clipboard.
      const copyRes = await call(handler, config, `/api/browser/screencast/${setup.id}/input`, {
        method: "POST",
        body: JSON.stringify({ kind: "copy" })
      });
      expect(copyRes.ok).toBe(true);
      expect(copyRes.selection).toBe("picked text");
    } finally {
      sc.__resetActiveBridgeForTest();
    }
  });


  test("the frames SSE stream closes when the bridge dies (no dangling keepalives)", async () => {
    const config = testConfig("screencast-frames-close-on-death");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_close", signInStarted: true, screencast: true }
      })
    );
    // A fake bridge that captures the onClose callback so the test can fire it,
    // simulating the CDP socket dropping.
    let fireClose: (() => void) | undefined;
    const fakeBridge = {
      isClosed: () => false,
      subscribe(onFrame: (f: { data: string; meta: Record<string, unknown> }) => void, onClose?: () => void) {
        onFrame({ data: "QUJD", meta: { deviceWidth: 800 } });
        fireClose = onClose;
        return () => undefined;
      },
      dispatchInput: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined
    };
    sc.__setActiveBridgeForTest(fakeBridge as never, setup.id);
    try {
      const framesRes = await handler(
        new Request(`http://127.0.0.1:${config.port}/api/browser/screencast/${setup.id}/frames`, {
          headers: { authorization: `Bearer ${config.token}` }
        })
      );
      expect(framesRes.status).toBe(200);
      const reader = framesRes.body!.getReader();
      await reader.read(); // first frame
      expect(fireClose).toBeDefined();
      fireClose!(); // bridge dies → route should close the stream
      const next = await reader.read();
      expect(next.done).toBe(true); // stream ended, not dangling on keepalives
    } finally {
      sc.__resetActiveBridgeForTest();
    }
  });


  test("completing a screencast browser.connect resolves the setup without a managed relaunch", async () => {
    // The screencast path keeps the agent on its headless Chrome the whole
    // time, so /complete just stops the bridge (a no-op here, no live bridge)
    // and resolves the setup — no connectBrowser relaunch.
    const config = testConfig("screencast-complete");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc3", signInStarted: true, screencast: true }
      })
    );
    const res = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(res.ok).toBe(true);
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("completed");
  });


  test("cancelling a screencast browser.connect stops the bridge and cancels the setup", async () => {
    const config = testConfig("screencast-cancel");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc4", signInStarted: true, screencast: true }
      })
    );
    await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
    expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
  });


  test("cancel stops the owner's bridge unconditionally, even if the row isn't yet stamped screencast", async () => {
    // /cancel must not gate the bridge teardown on a pre-claim screencast read:
    // payload.screencast can flip true (via /open-browser) in the window between
    // that read and the atomic claim. Install a live bridge owned by the setup
    // on a row that is NOT yet stamped screencast, cancel it, and assert the
    // bridge is torn down anyway — the unconditional owner-scoped stop.
    const config = testConfig("screencast-cancel-unstamped");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const sc = await import("./execution/browser-screencast");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        // Deliberately NOT stamped screencast/signInStarted yet.
        payload: { toolCallId: "call_sc_unstamped" }
      })
    );
    let stopped = false;
    const fakeBridge = {
      isClosed: () => false,
      stop: async () => {
        stopped = true;
      }
    } as unknown as import("./execution/browser-screencast").ScreencastBridge;
    sc.__setActiveBridgeForTest(fakeBridge, setup.id);
    try {
      await call(handler, config, `/api/setup-requests/${setup.id}/cancel`, { method: "POST" });
      expect(readState(config.instance).setupRequests.find((s) => s.id === setup.id)?.status).toBe("cancelled");
      expect(stopped).toBe(true);
    } finally {
      await sc.stopActiveBridge();
    }
  });


  test("a frames request after a screencast complete is rejected (no bridge recreation)", async () => {
    // /complete marks the setup terminal BEFORE stopping the bridge, so a
    // frames/input request racing the completion sees status!=="pending" and
    // 404s instead of recreating an orphaned bridge in the teardown gap.
    const config = testConfig("screencast-complete-then-frames");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc_race", signInStarted: true, screencast: true }
      })
    );
    const done = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(done.ok).toBe(true);
    const framesRes = await rawCall(
      handler,
      config,
      `/api/browser/screencast/${setup.id}/frames`,
      { method: "GET" },
      config.token
    );
    expect(framesRes.status).toBe(404);
  });


  test("screencast input rejects a malformed JSON body with 400", async () => {
    const config = testConfig("screencast-bad-body");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "browser.connect",
        target: "https://example.com",
        reason: "Sign in",
        payload: { toolCallId: "call_sc2", signInStarted: true, screencast: true }
      })
    );
    const res = await rawCall(handler, config, `/api/browser/screencast/${setup.id}/input`, {
      method: "POST",
      body: "{not json"
    }, config.token);
    expect(res.status).toBe(400);
  });


  test("POST /api/setup-requests/<id>/complete refuses a code-less messaging.approve_pairing approve and keeps the request pending", async () => {
    // allowChat's pending-row presence check is gated on `expectedCode`
    // being defined (the legacy CLI's "operator knows what they're
    // doing" trust model). If a chat-card pairing payload arrives
    // without verificationCode (group chat: groups intentionally never
    // mint a code, or a stale request whose pending row was cleared and
    // recreated), a no-code allowChat call would bypass the pending-row
    // check and enroll a chat that is no longer pending. Pin that
    // messaging-pairing-connect refuses the approve branch up-front when
    // verificationCode is missing.
    const config = testConfig("setup-complete-pairing-codeless-refuses");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.approve_pairing",
        target: "bridge_codeless:7",
        reason: "Confirm pairing",
        // Deliberately omit verificationCode — the chat card normally
        // carries one for private chats, but a stale or group-chat
        // payload would not.
        payload: { bridgeId: "bridge_codeless", chatId: 7, toolCallId: "call_codeless" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(false);
    expect(response.message).toContain("code-less");
    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("pending");
  });


  test("POST /api/setup-requests/<id>/complete removes a messaging bridge through the setup-request flow", async () => {
    // Happy path for the chat-side Remove bridge card. The /complete
    // handler delegates to runMessagingRemoveConnect, which resolves
    // the setup request atomically then calls removeMessagingBridge.
    const config = testConfig("setup-complete-remove-bridge-happy");
    const handler = createHandler(config);

    // Create a real bridge via the existing endpoint so its
    // encrypted secret + state record exist before we try to remove it.
    const created = await call(handler, config, `/api/messaging`, {
      method: "POST",
      body: JSON.stringify({ name: "remove-me", kind: "telegram", botToken: "1234:ABCDEFGHIJKLMNOPQR" })
    });
    expect(created.id).toBeString();

    const { createSetupRequest } = await import("./state");
    const setup = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        action: "messaging.remove_bridge",
        target: created.id,
        reason: "Remove bridge",
        payload: { bridgeId: created.id, bridgeName: "remove-me", kind: "telegram", toolCallId: "call_remove" }
      })
    );

    const response = await call(handler, config, `/api/setup-requests/${setup.id}/complete`, {
      method: "POST",
      body: JSON.stringify({})
    });
    expect(response.ok).toBe(true);
    expect(response.removed).toBe(true);
    expect(response.bridgeId).toBe(created.id);

    const after = readState(config.instance);
    expect(after.setupRequests.find((s) => s.id === setup.id)?.status).toBe("completed");
    expect(after.messagingBridges.find((b) => b.id === created.id)).toBeUndefined();

    // Chat-card lineage audit row pin: the chat-card remove path
    // writes a dedicated audit row carrying the setup-request id +
    // bridgeId, so a chat-card remove is distinguishable from a CLI /
    // settings remove in the activity feed.
    const chatRemoveRow = after.audit.find(
      (e) => e.action === "messaging.remove_bridge" && e.approvalId === setup.id
    );
    expect(chatRemoveRow).toBeDefined();
    expect(chatRemoveRow?.target).toBe(created.id);
    expect((chatRemoveRow?.evidence as { bridgeName?: string } | undefined)?.bridgeName).toBe("remove-me");
  });


  test("POST /api/setup-requests/<id>/complete refuses partial browser.fill_secret submissions", async () => {
    // fillReady in BlockSetupRequested.tsx only disables the web
    // Submit button; CLI / mobile / direct API clients can still POST a
    // partial body. The gateway must enforce that every declared slot
    // has a non-empty value before any DOM fill happens — otherwise
    // /complete would resolve with some slots silently unfilled and the
    // agent would be told (in agent.ts:runApprovedAction) that every
    // declared slot was filled.
    const config = testConfig("complete-rejects-partial-fill-secret");
    const handler = createHandler(config);
    const { createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const { createTask, upsertTask } = require("./state") as typeof import("./state");
      const task = createTask(state.instance, "partial-test");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl so the origin guard's "no live page" refusal
    // doesn't fire before the missing-slot check; this test is about
    // partial submission, not origin binding.
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // Origin only — sanitizeUrlForAuditTarget strips pathname.
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      // The live URL can be on any path within the approved origin;
      // the equality check is on origin only after the SEC-C fix.
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("password");
    expect(body.message).toContain("Missing");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });


  test("POST /api/setup-requests/<id>/complete: submitted fill_secret values never appear in state.json, trace JSONL, or runtime.jsonl", async () => {
    // End-to-end absence pin for the ADR's secret-handling guarantee:
    // submitted credential values must flow request-scope only and
    // never reach any persisted artifact. Without this test the only
    // protection is manual code review of every audit/trace/log write
    // touching the fill_secret path. Distinct marker strings let us
    // grep the raw bytes after the request — partial matches would
    // catch even an attempt to serialize a wrapper object containing
    // the value.
    const config = testConfig("fill-secret-no-state-leak");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "fill secret leak guard");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl on the payload AND install a matching fake
    // session so the origin guard passes and the fill loop actually
    // runs. The fills will error per-slot because the fake page's
    // .locator() returns nothing useful — what we care about is that
    // the audit row is written with redacted: true and the markers
    // never reach state/trace/log even when the runtime tries to
    // record what happened.
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      // Fake locator that no-ops on fill; the audit-row write still
      // happens regardless of whether the fill succeeded. Cast as
      // Partial<Page> since the fake only implements what
      // browserFillByLocator touches.
      locator: ((_sel: string) => ({
        fill: async () => { throw new Error("fake session, no real DOM"); }
      })) as unknown as import("playwright-core").Page["locator"],
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const USERNAME_MARKER = "tomsmith-LEAK-MARKER-zzzzz";
    const PASSWORD_MARKER = "SuperSecretPassword-LEAK-MARKER-zzzzz";
    await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: USERNAME_MARKER, password: PASSWORD_MARKER } })
      },
      config.token
    );
    // No browser session exists, so browserFillByLocator returns
    // errors for both slots and the audit row evidence carries
    // `errors[]` (no values) + filledSlots = []. The approval is
    // still resolved atomically before the fill loop so the deny
    // race is closed; the agent gets a partial-fill error result
    // via resumeChatTask.

    // Raw state.json bytes must not contain either marker.
    const stateJsonPath = `${config.stateRoot}/state.json`;
    const rawState = readFileSync(stateJsonPath, "utf8");
    expect(rawState).not.toContain(USERNAME_MARKER);
    expect(rawState).not.toContain(PASSWORD_MARKER);

    // Trace JSONL (per-task) must not contain either marker. The
    // file may not exist if no trace events fired for this task —
    // an empty file is fine, the test only fails on a leak.
    const traceJsonlPath = `${config.stateRoot}/traces/${taskId}.jsonl`;
    if (existsSync(traceJsonlPath)) {
      const rawTrace = readFileSync(traceJsonlPath, "utf8");
      expect(rawTrace).not.toContain(USERNAME_MARKER);
      expect(rawTrace).not.toContain(PASSWORD_MARKER);
    }

    // runtime.jsonl is the cross-task log file — also greppable.
    const runtimeLogPath = `${config.logRoot}/runtime.jsonl`;
    if (existsSync(runtimeLogPath)) {
      const rawLog = readFileSync(runtimeLogPath, "utf8");
      expect(rawLog).not.toContain(USERNAME_MARKER);
      expect(rawLog).not.toContain(PASSWORD_MARKER);
    }

    // The audit row itself: defense-in-depth. Both `evidence` (would
    // be undefined after redaction) and `target` must not contain
    // the markers. `target` is preserved across redaction; this pin
    // catches a future regression that would forget to sanitize URL
    // query strings or stuff secrets into the target field.
    const auditRows = readState(config.instance).audit.filter(
      (a) => a.action === "browser.fill_secret" && a.approvalId === approval.id
    );
    expect(auditRows.length).toBe(1);
    const row = auditRows[0]!;
    expect(row.redacted).toBe(true);
    expect(row.evidence).toBeUndefined();
    expect(row.target ?? "").not.toContain(USERNAME_MARKER);
    expect(row.target ?? "").not.toContain(PASSWORD_MARKER);
  });


  test("POST /api/setup-requests/<id>/complete refuses fill_secret when page navigated away from approved origin", async () => {
    // The approval.target encodes the origin the user consented
    // to fill into (protocol+host+port; pathname is stripped by
    // sanitizeUrlForAuditTarget). If the page has navigated to a
    // different origin (agent action, user click, JS redirect,
    // phishing redirect) between approval creation and Submit,
    // the live URL no longer matches and we refuse with 409 so a
    // fresh approval is required for the new destination. In
    // this test the browser session was never opened so
    // peekCurrentBrowserUrl returns undefined,
    // which the handler treats as "no live page to fill" — same
    // refusal path.
    const config = testConfig("complete-fill-secret-origin-mismatch");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // The /connect origin guard reads from the structural
          // approvedUrl on payload — peer approval actions carry
          // their contract fields under payload too. Stored as
          // origin only (no pathname) since reset/magic-link
          // URLs can carry tokens in the path.
          approvedUrl: "https://example.com"
        }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    // The browser session was never opened, so peekCurrentBrowserUrl
    // returns undefined and the /complete handler takes the
    // "session expired" branch (distinct from the "page navigated"
    // branch where a live session exists but its URL differs from
    // approvedUrl). Without that split the operator would see
    // "page navigated" after a 5-minute walk-away — misleading.
    expect(body.message).toContain("Browser session expired");
    expect(body.message).toContain("https://example.com");
    // Approval stayed pending — no resolveApproval call ran.
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });


  test("POST /api/setup-requests/<id>/complete refuses sub-floor password-kind slot values", async () => {
    // The snapshot post-redactor uses literal substring replacement;
    // single-character (and other very short) values would shred
    // structural tokens like [@e1] in snapshot text. The 4-char
    // floor in src/tools/browser.ts:recordFilledSecret keeps the
    // redactor safe. For a password-kind slot a sub-floor value is
    // both a near-certain typo AND an un-redactable leak risk, so
    // /connect refuses it (the registry-skip-for-short-values would
    // otherwise let the value escape via a later unredacted tool
    // result). Non-password slots take the opposite path — see the
    // short-PII test below.
    const config = testConfig("complete-fill-secret-too-short");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "short value test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "pin", locator: "@e1", label: "PIN", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { pin: "12" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("too short");
    expect(body.message).toContain("pin");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });


  test("POST /api/setup-requests/<id>/complete accepts a sub-floor non-password (PII) slot value", async () => {
    // fill_secret also collects identity/PII fields — a real call
    // asks for date of birth + last name. Short last names ("Shi",
    // "Ng", "Li") are valid and must fill. The redaction floor is a
    // redactor-safety constraint, not an input-validation gate, so a
    // text-kind slot below the floor is accepted and filled (it is
    // simply not redaction-registered, which is fine for a non-
    // credential). Pin the boundary so the floor never silently
    // re-broadens to block PII again.
    const config = testConfig("complete-fill-secret-short-pii");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "short PII test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Look up account",
        payload: {
          slots: [
            { name: "lastname", locator: "@e43", label: "Last Name", kind: "text" }
          ],
          reason: "Look up account",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const filled: Array<{ locator: string; value: string }> = [];
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com",
      close: () => Promise.resolve(),
      // browserFillByLocator resolves an @-ref to a literal
      // [data-gini-ref] selector, then calls page.locator(sel).fill().
      locator: (selector: string) => ({
        fill: (value: string) => {
          filled.push({ locator: selector, value });
          return Promise.resolve();
        },
        evaluate: () => Promise.resolve()
      })
    } as unknown as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { lastname: "Shi" } })
      },
      config.token
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.filledSlots).toEqual(["lastname"]);
    expect(filled).toEqual([{ locator: '[data-gini-ref="e43"]', value: "Shi" }]);
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("completed");
  });


  test("POST /api/setup-requests/<id>/complete: distinct 409 when live session exists but page navigated to a different origin", async () => {
    // Pin the OTHER 409 branch: a live session whose current URL no
    // longer matches the approved origin. This is the genuine
    // page-navigated case (agent click, JS redirect, phishing
    // redirect), distinct from the session-expired idle-sweep case
    // covered by the previous test.
    const config = testConfig("complete-fill-secret-real-navigation");
    const handler = createHandler(config);
    const { createTask, upsertTask, createSetupRequest } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "real navigation test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createSetupRequest(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    // Live session exists but the page URL is on a different origin
    // than what the approval captured — should take the "page
    // navigated" branch, NOT the "session expired" branch.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://evil.example.org/phishing",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/setup-requests/${approval.id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Page navigated");
    expect(body.message).toContain("https://example.com");
    expect(body.message).toContain("https://evil.example.org");
    const after = readState(config.instance).setupRequests.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  // Default transport (issue #420): /api/browser/connect with NO cdpUrl is a
  // no-op acknowledgement — the spawned Chrome launches lazily on the first
  // browser tool call, not at connect time, and carries no record.

  test("browser connect with no cdpUrl returns the stable disconnected status", async () => {
    const config = testConfig("browser-connect-empty-body");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      { method: "POST", body: JSON.stringify({}) },
      config.token
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  // A cdpUrl with an unsupported protocol is user-input error → 400, and no
  // record is written. (Validation happens before any probe/attach.)

  test("browser connect rejects an unsupported cdpUrl protocol with 400", async () => {
    const config = testConfig("browser-connect-bad-protocol");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      { method: "POST", body: JSON.stringify({ cdpUrl: "file:///etc/passwd" }) },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(String(body.error ?? body.message)).toContain("Unsupported cdpUrl protocol");
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  // An unreachable (but well-formed) loopback CDP endpoint surfaces as 400 with
  // a clear "Could not reach CDP endpoint" message, and writes no record. The
  // server-side env knobs shrink the probe deadline so the test doesn't burn
  // the full 15s budget (they are NOT plumbed from the POST body).

  test("browser connect surfaces an unreachable cdp endpoint as 400", async () => {
    const config = testConfig("browser-connect-unreachable-cdp");
    const handler = createHandler(config);
    const prevTimeout = process.env.GINI_CDP_PROBE_TIMEOUT_MS;
    const prevInterval = process.env.GINI_CDP_PROBE_INTERVAL_MS;
    process.env.GINI_CDP_PROBE_TIMEOUT_MS = "40";
    process.env.GINI_CDP_PROBE_INTERVAL_MS = "10";
    try {
      const response = await rawCall(
        handler,
        config,
        "/api/browser/connect",
        // Port 1 is reserved and never listening, so the probe always fails.
        { method: "POST", body: JSON.stringify({ cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc" }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(String(body.error ?? body.message)).toContain("Could not reach CDP endpoint");
      expect(readState(config.instance).browser ?? null).toBeNull();
    } finally {
      if (prevTimeout === undefined) delete process.env.GINI_CDP_PROBE_TIMEOUT_MS;
      else process.env.GINI_CDP_PROBE_TIMEOUT_MS = prevTimeout;
      if (prevInterval === undefined) delete process.env.GINI_CDP_PROBE_INTERVAL_MS;
      else process.env.GINI_CDP_PROBE_INTERVAL_MS = prevInterval;
    }
  });


  test("PATCH /api/settings/auto-approve rejects out-of-union approvalMode with 400", async () => {
    // An invalid value previously mapped to undefined and the PATCH
    // silently no-op'd while returning 200 — the client thought it
    // succeeded. Mirror job-level strict validation at the HTTP
    // boundary so misconfigured clients get a loud failure.
    const config = testConfig("settings-bad-approval-mode");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/settings/auto-approve",
      {
        method: "PATCH",
        body: JSON.stringify({ approvalMode: "bogus" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/approvalMode must be one of/);
    expect(body.validValues).toEqual(["strict", "auto", "yolo"]);
    // Original value on the config object must not have changed.
    expect(config.approvalMode).toBe("strict");
  });


  test("POST /api/browser/wipe-profile is no longer routed", async () => {
    const config = testConfig("browser-wipe-removed");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/wipe-profile",
      { method: "POST" },
      config.token
    );
    expect(response.status).toBe(404);
  });


  test("GET /api/browser reports the stable disconnected status", async () => {
    const config = testConfig("browser-status");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/browser", {}, config.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connected).toBe(false);
  });


  test("stamps the active agent on records and filters listings by agentId", async () => {
    const config = testConfig("records-agentid");
    const handler = createHandler(config);

    // Two agents — submit a task under each so we have heterogeneous rows.
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });

    // Task under the default agent. We use `read README.md` so runTask
    // dispatches a real low-risk file tool and the task lands in a terminal
    // state before the test ends — avoids a background failTask firing
    // after the test's state file has been cleaned up by the next test.
    config.workspaceRoot = process.cwd();
    const defaultTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(defaultTask.agentId).toBe(defaultAgentId);
    await waitForTask(handler, config, defaultTask.id);

    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const scoutTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(scoutTask.agentId).toBe(second.id);
    await waitForTask(handler, config, scoutTask.id);

    // Unfiltered listing includes both rows.
    const all = await call(handler, config, "/api/tasks");
    expect(all.some((task: { id: string }) => task.id === defaultTask.id)).toBe(true);
    expect(all.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);

    // Filtered listing returns only the matching agent's rows.
    const scoutOnly = await call(handler, config, `/api/tasks?agentId=${encodeURIComponent(second.id)}`);
    expect(scoutOnly.every((task: { agentId?: string }) => task.agentId === second.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === defaultTask.id)).toBe(false);

    // Empty string is treated as "no filter" — preserves legacy behavior.
    const empty = await call(handler, config, "/api/tasks?agentId=");
    expect(empty.length).toBe(all.length);
  });


  test("stamps the active agent on chat sessions and filters by agentId", async () => {
    const config = testConfig("records-agentid-chat");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const sessionA = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under default" })
    });
    expect(sessionA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const sessionB = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under scout" })
    });
    expect(sessionB.agentId).toBe(second.id);
    const scopedDefault = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionA.id)).toBe(true);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionB.id)).toBe(false);
    const scopedScout = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionB.id)).toBe(true);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionA.id)).toBe(false);
  });


  test("stamps the active agent on jobs and filters job listings", async () => {
    const config = testConfig("records-agentid-jobs");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const jobA = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "default-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(jobA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const jobB = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "scout-job", prompt: "hi", intervalSeconds: 3600 })
    });
    expect(jobB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/jobs?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scoped.every((j: { agentId?: string }) => j.agentId === defaultAgentId)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobA.id)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobB.id)).toBe(false);
  });


  test("stamps the active agent on subagents and filters by agentId", async () => {
    const config = testConfig("records-agentid-subagents");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const subA = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-default", prompt: "report" })
    });
    expect(subA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const subB = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-scout", prompt: "report" })
    });
    expect(subB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/subagents?agentId=${encodeURIComponent(second.id)}`);
    expect(scoped.every((s: { agentId?: string }) => s.agentId === second.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subB.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subA.id)).toBe(false);
  });


  test("subagent inherits the parent task's agent even when the active agent switched", async () => {
    const config = testConfig("records-agentid-subagent-inherit");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a parent task under the default agent so the resulting parent
    // task carries agentId=default.
    const parentTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "echo parent" })
    });
    await waitForTask(handler, config, parentTask.id);
    // Switch the active agent *before* spawning the subagent. The child
    // should still inherit the parent's agent id (default), not the active
    // agent (scout). Regression test for the inheritance bug where
    // spawnSubagent read `resolveEffectiveContext(...).agentId` directly.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const child = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({
        name: "child",
        prompt: "echo child",
        parentTaskId: parentTask.id
      })
    });
    expect(child.agentId).toBe(defaultAgentId);
    // The child task spawned by the subagent path should also carry the
    // parent's agent — not the active agent at the moment of spawn.
    await waitForTask(handler, config, child.taskId);
    const childDetail = await call(handler, config, `/api/tasks/${child.taskId}`);
    expect(childDetail.task.agentId).toBe(defaultAgentId);
  });


  test("approvals inherit agentId from the originating task and filter by agentId", async () => {
    const config = testConfig("records-agentid-approvals");
    // The patch flow writes through workspaceRoot; point at the repo so the
    // pre-image read in `patch README.md ::` succeeds.
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a patch task under the default agent — the agent loop blocks
    // on file.patch until approval, and createApproval inherits agentId
    // from the originating task.
    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    await waitForTask(handler, config, task.id);
    // Switch the active agent *before* asserting. The approval was already
    // created under the originating task, so it must carry the default
    // agent's id regardless of whoever is active now.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const approvals = readState(config.instance).authorizations.filter((a) => a.taskId === task.id);
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.agentId === defaultAgentId)).toBe(true);
    const scopedDefault = await call(handler, config, `/api/authorizations?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.every((a: { agentId?: string }) => a.agentId === defaultAgentId)).toBe(true);
    expect(scopedDefault.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(true);
    const scopedScout = await call(handler, config, `/api/authorizations?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(false);
  });


  test("stamps the active agent on events and audit and filters listings", async () => {
    const config = testConfig("records-agentid-events");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // The agent.activated audit/event for the second agent should be tagged
    // with its id — the runtime stamps the active agent via inferAgentId.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const events = await call(handler, config, `/api/events?agentId=${encodeURIComponent(second.id)}`);
    expect(events.every((e: { agentId?: string }) => e.agentId === second.id)).toBe(true);
    expect(events.some((e: { action: string }) => e.action === "agent.activated")).toBe(true);
    const defaultEvents = await call(handler, config, `/api/events?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(defaultEvents.every((e: { agentId?: string }) => e.agentId === defaultAgentId)).toBe(true);
    const audit = await call(handler, config, `/api/audit?agentId=${encodeURIComponent(second.id)}`);
    expect(audit.every((a: { agentId?: string }) => a.agentId === second.id)).toBe(true);
  });


  test("migrateRecordAgentIds is idempotent across repeated reads", async () => {
    const config = testConfig("records-agentid-idempotent");
    const handler = createHandler(config);
    // Seed an unstamped task to force a backfill on the first read.
    await mutateState(config.instance, (state) => {
      state.tasks.unshift({
        id: "task_legacy_one",
        title: "legacy",
        input: "legacy task",
        status: "completed",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Trigger reads to run normalizeState multiple times.
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    const audit = await call(handler, config, "/api/audit");
    const backfills = audit.filter((row: { action: string }) => row.action === "records.agentid.backfill");
    // Exactly one backfill row should exist regardless of how many reads.
    expect(backfills.length).toBe(1);
  });


  test("scheduled job fired after agent switch attributes the task to the originating agent", async () => {
    const config = testConfig("records-agentid-job-fire");
    const handler = createHandler(config);
    config.workspaceRoot = process.cwd();
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Create the job under the default agent. Use a read tool so the
    // spawned task can settle into a terminal state inside the test window
    // — keeps the runtime from logging a "Task not found" against a stale
    // state file after the next test cleans up.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "owner-test", prompt: "read README.md", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* the job fires.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    // Fire the job manually (the dispatch path is shared with the scheduler).
    const fired = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(fired.taskId).toBeString();
    // Wait for the resulting task to settle so its async tail doesn't
    // outlive the test and trip a "Task not found" failure on a later
    // test's state-file cleanup.
    await waitForTask(handler, config, fired.taskId);
    const detail = await call(handler, config, `/api/tasks/${fired.taskId}`);
    expect(detail.task.agentId).toBe(defaultAgentId);
    expect(detail.task.jobId).toBe(job.id);
  });


  test("POST /api/jobs ignores agentId in the request body", async () => {
    // Regression: the public input bag previously honored a caller-supplied
    // `agentId`, letting a malicious or buggy client attribute new jobs to
    // any agent. Now the HTTP path strips it and the runtime falls back to
    // the active agent.
    const config = testConfig("records-agentid-job-untrusted-input");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // While the active agent is still the default, post a job whose body
    // tries to spoof attribution to the scout agent.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "spoof-job",
        prompt: "hello",
        intervalSeconds: 3600,
        agentId: second.id
      })
    });
    expect(job.agentId).toBe(defaultAgentId);
    expect(job.agentId).not.toBe(second.id);
  });


  test("job lifecycle audits carry the originating job's agent across a switch", async () => {
    // Regression: addAudit's inferAgentId previously had no jobId fallback
    // and the lifecycle audit writes in src/jobs/index.ts didn't pass
    // agentId, so a paused/updated/removed audit after an agent switch
    // misattributed the row to the new active agent.
    const config = testConfig("records-agentid-job-audits");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "audit-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* exercising the lifecycle transitions.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/resume`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ intervalSeconds: 7200 })
    });
    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });
    const state = readState(config.instance);
    const targeted = state.audit.filter((a) => a.target === job.id);
    const lifecycle = targeted.filter((a) =>
      a.action === "job.paused"
      || a.action === "job.active"
      || a.action === "job.updated"
      || a.action === "job.removed"
    );
    expect(lifecycle.length).toBeGreaterThanOrEqual(4);
    expect(lifecycle.every((a) => a.agentId === defaultAgentId)).toBe(true);
  });


  test("chat message under a session keeps the session's agent across all emitted events", async () => {
    // Regression: createRun and createPlanStep previously emitted events
    // without an agentId. With the session bound to agent A, sending a
    // message after switching the active agent to B would mis-stamp the
    // run/step events to B even though the task itself inherits A.
    const config = testConfig("records-agentid-chat-message");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "owned by default" })
    });
    expect(session.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "read README.md" })
    });
    await waitForTask(handler, config, submitted.taskId);
    const task = (await call(handler, config, `/api/tasks/${submitted.taskId}`)).task;
    expect(task.agentId).toBe(defaultAgentId);
    // Every event for this run should carry the original session's agent —
    // not the now-active scout agent.
    const state = readState(config.instance);
    const runEvents = state.events.filter((e) => e.runId === submitted.runId);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.every((e) => e.agentId === defaultAgentId)).toBe(true);
    // The run.created and run.step.created events should specifically be
    // present and tagged.
    expect(runEvents.some((e) => e.action === "run.created")).toBe(true);
    expect(runEvents.some((e) => e.action === "run.step.created")).toBe(true);
  });


  describe("identity-files routes", () => {
    test("GET /api/identity-files returns INSTRUCTIONS.md, USER.md, and SOULs with budget metadata", async () => {
      const config = testConfig("identity-show");
      const handler = createHandler(config);
      // Seed USER.md so the budget snapshot is meaningful.
      const { writeUserProfile, scaffoldInstanceIdentityFiles } = await import("./runtime/identity-files");
      scaffoldInstanceIdentityFiles(config.instance);
      writeUserProfile(config.instance, "## Identity\n- Name: TestUser", "approved");
      const dump = await call(handler, config, "/api/identity-files");
      expect(dump.instance).toBe(config.instance);
      expect(dump.userProfile.content).toContain("Name: TestUser");
      expect(dump.userProfile.cap).toBe(1500);
      expect(dump.userProfile.budget.used).toBeGreaterThan(0);
      expect(dump.userProfile.budget.overCap).toBe(false);
      // INSTRUCTIONS.md is materialized by scaffold; the route returns
      // its content trimmed.
      expect(dump.instructions.content).toMatch(/You are a personal agent running on the gini-agent framework\./);
    });

    test("GET /api/identity-files/history?kind=user returns snapshots newest-first", async () => {
      const config = testConfig("identity-history");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      writeUserProfile(config.instance, "v2", "approved");
      writeUserProfile(config.instance, "v3", "approved");
      const out = await call(handler, config, "/api/identity-files/history?kind=user");
      expect(out.kind).toBe("user");
      // Three writes → two snapshots in history (first write has nothing
      // to roll back to).
      expect(out.entries.length).toBe(2);
      // Each entry carries a path-safe name and a positive size.
      for (const entry of out.entries) {
        expect(entry.name).toMatch(/\.md$/);
        expect(entry.sizeBytes).toBeGreaterThan(0);
      }
    });

    test("POST /api/identity-files/rollback restores from a snapshot and emits an audit row", async () => {
      const config = testConfig("identity-rollback");
      const handler = createHandler(config);
      const { writeUserProfile, listUserProfileHistory, userProfilePath } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1 body", "approved");
      writeUserProfile(config.instance, "v2 body", "approved");
      writeUserProfile(config.instance, "v3 body", "approved");
      const history = listUserProfileHistory(config.instance);
      const v1Snap = history.find((e) => readFileSync(e.path, "utf8") === "v1 body");
      expect(v1Snap).toBeDefined();
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: v1Snap!.name })
      });
      expect(result.ok).toBe(true);
      expect(result.restoredBytes).toBe(Buffer.byteLength("v1 body", "utf8"));
      // The active USER.md now holds the rolled-back body.
      expect(readFileSync(userProfilePath(config.instance), "utf8")).toBe("v1 body");
      // Audit row recorded the rollback.
      const state = readState(config.instance);
      const audit = state.audit.find((a) => a.action === "identity.user_profile.rollback");
      expect(audit).toBeDefined();
      // Pre-rollback snapshot was created so the rollback is itself
      // reversible.
      expect(result.preRestoreSnapshot).not.toBeNull();
    });

    test("POST /api/identity-files/rollback rejects an unknown snapshot name with reason='no snapshot'", async () => {
      const config = testConfig("identity-rollback-unknown");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: "2099-01-01T00-00-00.000Z.md" })
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no snapshot");
    });
  });

  describe("push preview endpoint", () => {
    test("GET /api/push/preview returns the latest assistant reply for a completed message", async () => {
      const config = testConfig("push-preview-message");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Morning briefing" })
      });
      const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "what's up" })
      });
      await waitForTask(handler, config, submitted.taskId);

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`
      );
      expect(preview.title).toBe("Morning briefing");
      // The echo provider replies with the user's text; the body must be
      // the actual reply, NOT a generic "Tap to read" string.
      expect(typeof preview.body).toBe("string");
      expect(preview.body.length).toBeGreaterThan(0);
      expect(preview.body).not.toBe("Tap to read");
    });

    test("GET /api/push/preview 404s when the session has no assistant message yet", async () => {
      const config = testConfig("push-preview-empty");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Empty chat" })
      });
      const res = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`,
        {},
        config.token
      );
      expect(res.status).toBe(404);
    });

    test("GET /api/push/preview surfaces a pending authorization's risk + summary", async () => {
      const config = testConfig("push-preview-approval");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Deploy bot" })
      });
      const { createAuthorization } = await import("./state");
      const approval = await mutateState(config.instance, (state) =>
        createAuthorization(state, {
          action: "terminal.exec",
          target: "rm -rf build",
          risk: "high",
          reason: "Clear the stale build cache",
          payload: {}
        })
      );

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=authorization_requested&approvalId=${approval.id}`
      );
      expect(preview.title).toBe("Approve in Deploy bot?");
      expect(preview.body).toBe("[high] Clear the stale build cache");
    });

    test("GET /api/push/preview surfaces a pending setup request's ask", async () => {
      const config = testConfig("push-preview-setup");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Email watch" })
      });
      const { createSetupRequest } = await import("./state");
      const setup = await mutateState(config.instance, (state) =>
        createSetupRequest(state, {
          action: "browser.connect",
          target: "https://example.com/login",
          reason: "Sign in to your email provider",
          payload: {}
        })
      );

      const preview = await call(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=setup_requested&approvalId=${setup.id}`
      );
      expect(preview.title).toBe("Finish a step in Email watch");
      expect(preview.body).toBe("Sign in to your email provider");
    });

    test("GET /api/push/preview validates inputs and auth", async () => {
      const config = testConfig("push-preview-validation");
      const handler = createHandler(config);
      const session = await call(handler, config, "/api/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Validation chat" })
      });

      // Unauthenticated.
      const noAuth = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=message_completed`
      );
      expect(noAuth.status).toBe(401);

      // Missing sessionId.
      const noSession = await rawCall(
        handler,
        config,
        `/api/push/preview?event=message_completed`,
        {},
        config.token
      );
      expect(noSession.status).toBe(400);

      // Unknown event.
      const badEvent = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=${session.id}&event=bogus`,
        {},
        config.token
      );
      expect(badEvent.status).toBe(400);

      // Unknown session.
      const badSession = await rawCall(
        handler,
        config,
        `/api/push/preview?sessionId=chat_nope&event=message_completed`,
        {},
        config.token
      );
      expect(badSession.status).toBe(404);
    });

    test("POST /api/push/unwatch (no sessionId) clears the whole device bucket", async () => {
      const config = testConfig("push-unwatch");
      const handler = createHandler(config);
      // Register the device so requireDeviceToken accepts the header.
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_unwatch", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Seed two watched sessions for this device (as if it had opened
        // two chats), plus one for a different device that must survive.
        addSseSubscription(config.instance, "tok_unwatch", "chat_a");
        addSseSubscription(config.instance, "tok_unwatch", "chat_b");
        addSseSubscription(config.instance, "tok_other", "chat_a");
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_a")).toBe(true);

        // No sessionId → background beacon → clear everything for the device.
        const res = await call(handler, config, "/api/push/unwatch", {
          method: "POST",
          headers: { "x-device-token": "tok_unwatch" }
        });
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(2);
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_a")).toBe(false);
        expect(isDeviceWatching(config.instance, "tok_unwatch", "chat_b")).toBe(false);
        // The other device is untouched.
        expect(isDeviceWatching(config.instance, "tok_other", "chat_a")).toBe(true);
      } finally {
        // Don't leak seeded entries into the process-wide registry.
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch?sessionId clears only that session", async () => {
      const config = testConfig("push-unwatch-session");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_nav", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Device watches two chats; navigating away from chat_a must leave
        // chat_b watched (the just-opened chat mustn't be race-cleared).
        addSseSubscription(config.instance, "tok_nav", "chat_a");
        addSseSubscription(config.instance, "tok_nav", "chat_b");

        const res = await call(handler, config, "/api/push/unwatch?sessionId=chat_a", {
          method: "POST",
          headers: { "x-device-token": "tok_nav" }
        });
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(1);
        expect(isDeviceWatching(config.instance, "tok_nav", "chat_a")).toBe(false);
        expect(isDeviceWatching(config.instance, "tok_nav", "chat_b")).toBe(true);
      } finally {
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch?sessionId&streamId clears only that stream, not a sibling on the same session", async () => {
      const config = testConfig("push-unwatch-stream");
      const handler = createHandler(config);
      await call(handler, config, "/api/push/devices", {
        method: "POST",
        body: JSON.stringify({ token: "tok_stream", platform: "ios", bundleId: "ai.lilaclabs.gini.mobile" })
      });
      const { addSseSubscription, isDeviceWatching } = await import("./state");
      const { __resetSseSubscriptionsForTests } = await import("./state/sse-subscriptions");
      try {
        // Thread View (card over the main chat) and the main chat both open
        // a stream on the SAME session, each with its own streamId. Tearing
        // down the thread must leave the main chat's watch intact.
        addSseSubscription(config.instance, "tok_stream", "chat_a", "stream_main");
        addSseSubscription(config.instance, "tok_stream", "chat_a", "stream_thread");

        const res = await call(
          handler,
          config,
          "/api/push/unwatch?sessionId=chat_a&streamId=stream_thread",
          { method: "POST", headers: { "x-device-token": "tok_stream" } }
        );
        expect(res.ok).toBe(true);
        expect(res.cleared).toBe(1);
        // The main chat's stream is still registered → session still watched.
        expect(isDeviceWatching(config.instance, "tok_stream", "chat_a")).toBe(true);
      } finally {
        __resetSseSubscriptionsForTests();
      }
    });

    test("POST /api/push/unwatch requires auth + a registered device token", async () => {
      const config = testConfig("push-unwatch-auth");
      const handler = createHandler(config);
      // Unauthenticated.
      const noAuth = await rawCall(handler, config, "/api/push/unwatch", { method: "POST" });
      expect(noAuth.status).toBe(401);
      // Authenticated but no X-Device-Token header.
      const noDevice = await rawCall(handler, config, "/api/push/unwatch", { method: "POST" }, config.token);
      expect(noDevice.status).toBe(400);
      // Authenticated with an unregistered device token.
      const badDevice = await rawCall(
        handler,
        config,
        "/api/push/unwatch",
        { method: "POST", headers: { "x-device-token": "tok_ghost" } },
        config.token
      );
      expect(badDevice.status).toBe(403);
    });
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  }));
  return response;
}

// Opens a chat SSE stream, pumps frames until the initial `chat_session`
// frame lands (which only happens inside the stream's start() — i.e. AFTER
// presence registration), runs the caller's `whileOpen` assertions, then
// ALWAYS cancels the reader in a finally so a thrown assertion can't leak
// the stream (its keepalive interval and presence entry would otherwise
// survive the test). Returns after the reader is cancelled.
async function withChatStream(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  sessionId: string,
  init: RequestInit,
  whileOpen: () => void
): Promise<void> {
  const response = await rawCall(handler, config, `/api/chat/${sessionId}/stream`, init, config.token);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: undefined }), 50)
        )
      ]);
      if (done) break;
      if (value) buffer += decoder.decode(value);
      if (buffer.includes("event: chat_session")) break;
    }
    expect(buffer).toContain("event: chat_session");
    whileOpen();
  } finally {
    await reader.cancel();
  }
  // cancel() runs the stream's cleanup synchronously in-process; give the
  // microtask queue one turn to settle before the caller asserts the
  // post-close registry state.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function testConfig(instance: string): RuntimeConfig {
  const root = `/tmp/gini-http-tests-${import.meta.file}`;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  // Drop the cached SQLite handle for this instance before nuking the
  // directory. Without this, a prior test that opened the per-instance
  // memory DB leaves an open `bun:sqlite` handle pointing at the now-
  // unlinked file. The next call to getMemoryDb returns that cached
  // handle (the cache key is the instance name) and any write fails
  // because the inode is gone. removeMemoryDb closes the cached handle
  // AND unlinks the file + WAL/SHM siblings in one shot.
  removeMemoryDb(instance);
  // resumeChatTask polls for the loop's flip to waiting_approval before
  // staging a tool result. In-process the flip lands within a couple of
  // mutateState boundaries, and several fill_secret / approval tests seed a
  // task that never reaches waiting_approval at all — so the production
  // 1000ms/100ms budget is pure dead wall here (the fill_secret leak test
  // measured 1079.00ms in isolation, nearly all of it this poll). Shrink the
  // budget via the server-side env knob the production code reads (default
  // preserved at 1000/100); the race still resolves well within 40ms over 5ms
  // ticks in-process.
  process.env.GINI_RESUME_WAIT_BUDGET_MS = "40";
  process.env.GINI_RESUME_WAIT_TICK_MS = "5";
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    // These tests predate the approval-mode flip and rely on the
    // gated path. Force "strict" to keep them honest; new defaults
    // are exercised in approval-mode.test.ts.
    approvalMode: "strict"
  };
}

// Write a log file under the test config's instance log dir so the /api/logs
// route reads it. testConfig nukes the instance state dir and points
// GINI_LOG_ROOT at a sibling tree, so this lands in a clean per-instance dir.
function seedLogFile(config: RuntimeConfig, filename: string, body: string): void {
  const dir = logDir(config.instance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
}

// Seed a typed api-key credential so the per-(skill, credential) consent gate
// (firstUngrantedCredential) treats it as carrying a secret that needs consent.
async function seedTypedCredential(config: RuntimeConfig, name: string, provider: string) {
  const at = new Date().toISOString();
  await mutateState(config.instance, (state) => {
    state.connectors.push({
      id: `id_${name}`,
      instance: state.instance,
      name,
      provider,
      type: "api-key",
      status: "configured",
      scopes: [],
      secretRefs: [{ purpose: name, path: `/tmp/${name}.json` }],
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "user"
    });
  });
}

async function waitForTask(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  taskId: string,
  // The approve endpoint returns at decision durability while the side
  // effect + resume run detached, so a post-approve wait must exclude
  // the still-parked waiting_approval status or it returns the
  // pre-approve park immediately.
  statuses: string[] = ["completed", "failed", "waiting_approval"]
) {
  // Phase 5 added auto-recall + auto-retain to runTask. The retain side is
  // fire-and-forget so it can't block, but the inline recall + a few extra
  // mutateState audits push runTask completion past the original 500ms
  // budget on slower hosts. A 200-iteration / 10ms loop = 2s ceiling is
  // still well under any reasonable test timeout.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (statuses.includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}
