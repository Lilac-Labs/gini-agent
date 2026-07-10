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
import { closeAllAgentDataDbs, dbExecute } from "./state/agent-data-db";
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
  test("all extraction routes require the bearer token", async () => {
    const config = buildConfig("crm-http-auth");
    const handler = createHandler(config);
    for (const [method, path] of [
      ["GET", "/api/crm/extraction"],
      ["POST", "/api/crm/extraction/start"],
      ["POST", "/api/crm/extraction/pause"],
      ["POST", "/api/crm/extraction/enable"],
      ["POST", "/api/crm/extraction/disable"],
    ] as const) {
      const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, { method }));
      expect(response.status).toBe(401);
    }
  });

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

  test("contacts list is profile-less; the detail carries the dossier; unknown id 404s", async () => {
    const instance = "crm-http-contacts";
    const config = buildConfig(instance);
    await install(config);
    const handler = createHandler(config);
    dbExecute(
      instance,
      "agent_default",
      "INSERT INTO contacts (first_name, last_name, email_address, company, category, description, profile, last_spoke_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["Ada", "Lovelace", "ada@x.io", "Analytical Engines", "Work", "First programmer", "# Ada\n\n## Who They Are\n- Mathematician", 1_700_000_000_000],
    );
    dbExecute(
      instance,
      "agent_default",
      "INSERT INTO contacts (first_name, email_address, description) VALUES (?, ?, ?)",
      ["You", "me@corp.io", "You — the user's own reserved row."],
    );

    const listResponse = await call(handler, config, "/api/crm/contacts");
    expect(listResponse.status).toBe(200);
    const { contacts } = (await listResponse.json()) as { contacts: Array<Record<string, unknown>> };
    expect(contacts.length).toBe(2);
    const ada = contacts.find((c) => c.email === "ada@x.io")!;
    expect(ada.firstName).toBe("Ada");
    expect(ada.lastName).toBe("Lovelace");
    expect(ada.company).toBe("Analytical Engines");
    expect(ada.category).toBe("Work");
    expect(ada.description).toBe("First programmer");
    expect(ada.lastSpokeAt).toBe(1_700_000_000_000);
    expect(ada.isSelf).toBe(false);
    expect("profile" in ada).toBe(false); // list never ships the dossier
    const you = contacts.find((c) => c.email === "me@corp.io")!;
    expect(you.isSelf).toBe(true);

    const detailResponse = await call(handler, config, `/api/crm/contacts/${ada.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as Record<string, unknown>;
    expect(detail.profile).toContain("## Who They Are");

    const missing = await call(handler, config, "/api/crm/contacts/nope");
    expect(missing.status).toBe(404);
    // And the routes are token-gated like the rest of the surface.
    const anon = await handler(new Request(`http://127.0.0.1:${config.port}/api/crm/contacts`));
    expect(anon.status).toBe(401);

    // Manual creation: normalized insert, schema violations surface as 400s.
    const created = await call(handler, config, "/api/crm/contacts", {
      method: "POST",
      body: JSON.stringify({ firstName: "Grace", lastName: "Hopper", email: "Grace@Navy.mil", category: "Work", description: "Compiler pioneer" }),
    });
    expect(created.status).toBe(201);
    const grace = (await created.json()) as Record<string, unknown>;
    expect(grace.email).toBe("grace@navy.mil"); // lowercased before insert
    expect(grace.category).toBe("Work");
    const noName = await call(handler, config, "/api/crm/contacts", { method: "POST", body: JSON.stringify({ email: "x@y.io" }) });
    expect(noName.status).toBe(400);
    const badCategory = await call(handler, config, "/api/crm/contacts", {
      method: "POST",
      body: JSON.stringify({ firstName: "Zed", category: "Vendor" }),
    });
    expect(badCategory.status).toBe(400);
    expect(String(((await badCategory.json()) as { error?: string }).error)).toContain("category");
    const dupEmail = await call(handler, config, "/api/crm/contacts", {
      method: "POST",
      body: JSON.stringify({ firstName: "Dup", email: "grace@navy.mil" }),
    });
    expect(dupEmail.status).toBe(400); // UNIQUE arbitration surfaces cleanly
    const badType = await call(handler, config, "/api/crm/contacts", {
      method: "POST",
      body: JSON.stringify({ firstName: "T", company: 42 }),
    });
    expect(badType.status).toBe(400);
  });
});
