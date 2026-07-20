// Integration tests against the in-process OpenAI-compatible mock server.
//
// Unlike provider.test.ts (which stubs `globalThis.fetch`), these tests bind
// a real Bun.serve listener and exercise the full network round-trip:
// URL construction, header encoding, JSON serialization, SSE framing, and
// the captured request body. If a future patch breaks the wire shape, these
// catch it; the fetch-mock tests can't.
//
// Concurrency contract: every piece of mutable test state lives inside a
// per-test closure managed by `withMockServer`. There are NO module-level
// `server` or env-snapshot variables — sibling tests cannot stomp each
// other under `bun test --concurrent`. Each test gets its own server
// listener (Bun.serve startup is microseconds) and its own env-restore
// scope. Tests that need API keys use a per-test unique env-var name
// (`GINI_TEST_KEY_<pid>_<counter>`) so concurrent execution never has two
// tests racing on the same env slot.
//
// Anyone cloning the repo can run these without API keys, downloads, or a
// running model server — `bun install` is the only prerequisite.

import { describe, expect, test } from "bun:test";
import {
  generateStructured,
  generateTaskSummary,
  generateToolCallingResponse,
  generateVisionAnalysis,
  normalizeProvider,
  type ToolFunctionSpec
} from "./provider";
import { startOpenAIMockServer, type MockServerHandle } from "./test-utils/openai-mock-server";
import type { RuntimeConfig } from "./types";

interface MockTestContext {
  server: MockServerHandle;
  // Set or delete an env var; the original value is automatically restored
  // when the test closure resolves (or rejects). All restoration is local
  // to this `withMockServer` call so concurrent siblings don't trample.
  setEnv(key: string, value: string | undefined): void;
  // Generate a process-wide unique env-var name for this test. Safe to
  // call multiple times within the same test; each call yields a fresh
  // name so a single test can simulate multiple concurrent providers.
  uniqueEnvName(): string;
}

async function withMockServer<T>(fn: (ctx: MockTestContext) => Promise<T>): Promise<T> {
  const server = startOpenAIMockServer();
  const envBackup = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  // Per-test unique env-var name source. Combines pid (cross-process),
  // server.port (cross-test, since each call gets a fresh OS-assigned port),
  // and a closure-local counter (intra-test). This keeps everything inside
  // the closure so the file truly has no cross-test mutable state — the
  // header comment's concurrency promise stays honest.
  let localEnvCounter = 0;
  const uniqueEnvName = (): string => {
    localEnvCounter += 1;
    return `GINI_TEST_KEY_${process.pid}_${server.port}_${localEnvCounter}`;
  };
  try {
    return await fn({ server, setEnv, uniqueEnvName });
  } finally {
    // Restore env first so a flaky server.stop() doesn't leak env mutations.
    for (const [key, value] of envBackup.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.stop();
  }
}

describe("provider integration (against in-process mock server)", () => {
  test("local tool-calling round-trips through real HTTP and forwards extraBody", async () => {
    await withMockServer(async ({ server }) => {
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        extraBody: { chat_template_kwargs: { preserve_thinking: false, enable_thinking: true } }
      });
      const result = await generateToolCallingResponse(
        cfg(provider),
        [{ role: "user", content: "hello" }],
        []
      );
      expect(result.text).toBe("mock-echo: hello");
      expect(result.finishReason).toBe("stop");
      expect(server.received).toHaveLength(1);
      const captured = server.received[0]!;
      expect(captured.method).toBe("POST");
      expect(captured.url.endsWith("/v1/chat/completions")).toBe(true);
      expect(captured.headers["content-type"]).toBe("application/json");
      const sent = captured.body as Record<string, unknown>;
      expect(sent.model).toBe("gemma-mock-1");
      expect(sent.chat_template_kwargs).toEqual({ preserve_thinking: false, enable_thinking: true });
    });
  });

  test("local tool-calling streaming reassembles tool_call argument deltas", async () => {
    await withMockServer(async ({ server }) => {
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        extraBody: { chat_template_kwargs: { enable_thinking: true } }
      });
      const tools: ToolFunctionSpec[] = [{
        type: "function",
        function: {
          name: "file_read",
          description: "read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      }];
      let streamed = "";
      // Mock honors the "call:<tool>:<json-args>" directive when tools are
      // present, returning a streamed tool_call response with the canned args.
      const result = await generateToolCallingResponse(
        cfg(provider),
        [{ role: "user", content: 'call:file_read:{"path":"/tmp/x.md"}' }],
        tools,
        (delta) => { streamed += delta; }
      );
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("file_read");
      expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({ path: "/tmp/x.md" });
      // No content text in tool-call streams — streamed buffer stays empty.
      expect(streamed).toBe("");
      const sent = server.received[0]!.body as Record<string, unknown>;
      expect(sent.stream).toBe(true);
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true });
    });
  });

  test("local structured chat-completions returns parsed JSON and forwards extraBody", async () => {
    await withMockServer(async ({ server }) => {
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        extraBody: { chat_template_kwargs: { enable_thinking: false } }
      });
      const result = await generateStructured(cfg(provider), {
        system: "be brief",
        user: "ping",
        schemaName: "Echo",
        validator: { parse: (v) => v as { echo: string } }
      });
      expect(result.data).toEqual({ echo: "ping\n\nReturn ONLY valid JSON matching the Echo schema." });
      const sent = server.received[0]!.body as Record<string, unknown>;
      expect(sent.response_format).toEqual({ type: "json_object" });
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    });
  });

  test("local vision chat-completions sends image_url part and forwards extraBody", async () => {
    await withMockServer(async ({ server }) => {
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        extraBody: { chat_template_kwargs: { enable_thinking: true } }
      });
      const result = await generateVisionAnalysis(cfg(provider), {
        prompt: "what is shown?",
        imageBase64: "AAAA",
        mimeType: "image/png"
      });
      expect(result.text).toBe("mock-echo: what is shown?");
      const sent = server.received[0]!.body as Record<string, unknown>;
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true });
      const messages = sent.messages as Array<{ content: Array<{ type: string }> }>;
      expect(messages[0]?.content[1]?.type).toBe("image_url");
    });
  });

  test("openrouter generateTaskSummary round-trips with extraBody", async () => {
    await withMockServer(async ({ server, setEnv, uniqueEnvName }) => {
      const keyEnv = uniqueEnvName();
      setEnv(keyEnv, "test-or-key");
      const provider = normalizeProvider({
        name: "openrouter",
        model: "or-mock",
        baseUrl: server.url,
        apiKeyEnv: keyEnv,
        extraBody: { chat_template_kwargs: { enable_thinking: true } }
      });
      const result = await generateTaskSummary(cfg(provider), "summarize me");
      expect(result.text).toBe("mock-echo: summarize me");
      const captured = server.received[0]!;
      expect(captured.headers["http-referer"]).toBe("http://127.0.0.1:7337");
      expect(captured.headers["x-title"]).toBe("Gini Agent");
      const sent = captured.body as Record<string, unknown>;
      expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true });
    });
  });

  test("atlascloud generateTaskSummary uses the OpenAI-compatible endpoint and bearer key", async () => {
    await withMockServer(async ({ server, setEnv, uniqueEnvName }) => {
      const keyEnv = uniqueEnvName();
      setEnv(keyEnv, "test-atlas-key");
      const provider = normalizeProvider({
        name: "atlascloud",
        model: "qwen/qwen3.5-flash",
        baseUrl: server.url,
        apiKeyEnv: keyEnv
      });
      const result = await generateTaskSummary(cfg(provider), "summarize via atlas");
      expect(result.text).toBe("mock-echo: summarize via atlas");
      expect(server.received).toHaveLength(1);
      const captured = server.received[0]!;
      expect(captured.method).toBe("POST");
      expect(captured.url.endsWith("/v1/chat/completions")).toBe(true);
      expect(captured.headers.authorization).toBe("[REDACTED]");
      const sent = captured.body as Record<string, unknown>;
      expect(sent.model).toBe("qwen/qwen3.5-flash");
    });
  });

  test("local provider sends no Authorization header when api key env is unset", async () => {
    await withMockServer(async ({ server, uniqueEnvName }) => {
      const keyEnv = uniqueEnvName();
      // Ensure the unique env var is unset — by definition it isn't.
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        apiKeyEnv: keyEnv
      });
      await generateToolCallingResponse(cfg(provider), [{ role: "user", content: "hi" }], []);
      const captured = server.received[0]!;
      expect(captured.headers.authorization).toBeUndefined();
    });
  });

  test("local provider sends Bearer header when api key env is set, and mock redacts it", async () => {
    await withMockServer(async ({ server, setEnv, uniqueEnvName }) => {
      const keyEnv = uniqueEnvName();
      setEnv(keyEnv, "mock-key-xyz");
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url,
        apiKeyEnv: keyEnv
      });
      await generateToolCallingResponse(cfg(provider), [{ role: "user", content: "hi" }], []);
      // The mock server intentionally redacts Authorization before recording so
      // a real bearer token never ends up in test output. The test asserts on
      // the sentinel rather than the raw value.
      expect(server.received[0]!.headers.authorization).toBe("[REDACTED]");
    });
  });

  test("/v1/models health probes do NOT pollute received[]", async () => {
    await withMockServer(async ({ server }) => {
      // Anyone wiring readiness polling against the mock server should be able
      // to hit /v1/models without inflating per-test request counts.
      const probe = await fetch(`${server.url}/models`);
      expect(probe.ok).toBe(true);
      expect(server.received).toHaveLength(0);
      // A real chat call should still record normally.
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        baseUrl: server.url
      });
      await generateToolCallingResponse(cfg(provider), [{ role: "user", content: "hi" }], []);
      expect(server.received).toHaveLength(1);
    });
  });

  test("baseUrl with trailing slash does not produce doubled '/v1//chat/completions'", async () => {
    // Some OpenAI-compatible servers reject `//`; trimBaseUrl normalizes
    // both forms. End-to-end test against the real socket so URL building
    // is exercised, not just the trim helper in isolation.
    await withMockServer(async ({ server }) => {
      const provider = normalizeProvider({
        name: "local",
        model: "gemma-mock-1",
        // Append a trailing slash to whatever the mock returned.
        baseUrl: `${server.url}/`
      });
      await generateToolCallingResponse(cfg(provider), [{ role: "user", content: "hi" }], []);
      expect(server.received).toHaveLength(1);
      expect(server.received[0]!.url.endsWith("/v1/chat/completions")).toBe(true);
      expect(server.received[0]!.url.includes("//chat/completions")).toBe(false);
    });
  });
});

function cfg(provider: RuntimeConfig["provider"]): RuntimeConfig {
  return {
    instance: "test",
    port: 7337,
    token: "test",
    provider,
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-provider-integration-test",
    logRoot: "/tmp/gini-provider-integration-test-logs"
  };
}
