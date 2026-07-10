// Pins the /api/crm/extraction gateway surface: status shape for an idle
// instance, the clean 400 when starting without any mail source, and the
// start → pause → status lifecycle against a fixture source.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "./http";
import { readState } from "./state";
import {
  __awaitCrmLoopExitForTests,
  __setCrmMailSourceForTests,
} from "./jobs/crm-extractor";
import { closeAllCrmExtractionDbs, setCrmMeta } from "./state/crm-extraction-db";
import { closeAllAgentDataDbs } from "./state/agent-data-db";
import { clearEchoToolCallingResponses, normalizeProvider, setEchoToolCallingResponse } from "./provider";
import { install } from "./runtime";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-http-crm-extraction-tests";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  process.env.GINI_RERANKER_PROVIDER = "none";
  process.env.GINI_CRM_WATCH_INTERVAL_MS = "50";
  delete process.env.GINI_CRM_FIXTURE_DIR;
});

afterAll(() => {
  closeAllCrmExtractionDbs();
  closeAllAgentDataDbs();
  clearEchoToolCallingResponses();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
  delete process.env.GINI_CRM_WATCH_INTERVAL_MS;
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  readState(instance);
  return {
    instance,
    port: 7343,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`,
  };
}

async function call(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return handler(
    new Request(`http://127.0.0.1:${config.port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, ...(init.headers ?? {}) },
    }),
  );
}

describe("/api/crm/extraction", () => {
  test("status is idle before any start", async () => {
    const config = buildConfig("crm-http-idle");
    const handler = createHandler(config);
    const response = await call(handler, config, "/api/crm/extraction");
    expect(response.status).toBe(200);
    const status = (await response.json()) as { runState: string; counts: { pending: number }; backfillSeeded: boolean };
    expect(status.runState).toBe("idle");
    expect(status.backfillSeeded).toBe(false);
    expect(status.counts.pending).toBe(0);
  });

  test("start without a mail source maps to a client error", async () => {
    const config = buildConfig("crm-http-nosource");
    await install(config);
    const handler = createHandler(config);
    const prevHome = process.env.HOME;
    process.env.HOME = `${ROOT}/fake-home`;
    try {
      const response = await call(handler, config, "/api/crm/extraction/start", { method: "POST" });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      const body = (await response.json()) as { error?: string };
      expect(String(body.error)).toContain("Google account");
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("start → status(running) → pause → status(paused)", async () => {
    const instance = "crm-http-run";
    const config = buildConfig(instance);
    await install(config);
    const handler = createHandler(config);
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
    });
    setCrmMeta(instance, "self_email", "me@corp.io");
    __setCrmMailSourceForTests(instance, {
      kind: "fixture",
      async listMessages() {
        return [];
      },
      async fetchThread() {
        return [];
      },
    });

    const started = await call(handler, config, "/api/crm/extraction/start", { method: "POST" });
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as { runState: string; selfEmail: string };
    expect(startedBody.runState).toBe("running");
    expect(startedBody.selfEmail).toBe("me@corp.io");

    const paused = await call(handler, config, "/api/crm/extraction/pause", { method: "POST" });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { runState: string }).runState).toBe("paused");
    await __awaitCrmLoopExitForTests(instance);

    const statusResponse = await call(handler, config, "/api/crm/extraction");
    expect(((await statusResponse.json()) as { runState: string }).runState).toBe("paused");

    // Master switch: disable → start is refused (400) → enable → idle.
    const disabled = await call(handler, config, "/api/crm/extraction/disable", { method: "POST" });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { runState: string }).runState).toBe("disabled");
    const refused = await call(handler, config, "/api/crm/extraction/start", { method: "POST" });
    expect(refused.status).toBe(400);
    expect(String(((await refused.json()) as { error?: string }).error)).toContain("disabled");
    const enabled = await call(handler, config, "/api/crm/extraction/enable", { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { runState: string }).runState).toBe("idle");
    __setCrmMailSourceForTests(instance, undefined);
  }, 30_000);
});
