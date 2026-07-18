import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RuntimeConfig } from "../../types";
import type { CliContext } from "../context";
import { onboarding } from "./onboarding";

describe("onboarding CLI", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("skip completes onboarding through the selected instance API", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined
      });
      return Promise.resolve(Response.json({ completed: true }));
    }) as unknown as typeof fetch;

    await onboarding(makeCtx(["onboarding", "skip"]));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/onboarding");
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ completed: true });
  });

  test("requires the explicit skip action", async () => {
    await expect(onboarding(makeCtx(["onboarding"]))).rejects.toThrow(
      "Usage: gini onboarding skip"
    );
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join("/tmp/gini-onboarding-cli-tests", `${process.pid}`, "instances", "test-instance");
  const config: RuntimeConfig = {
    instance: "test-instance",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(stateRoot, "workspace"),
    stateRoot,
    logRoot: join(stateRoot, "logs")
  };
  return {
    config,
    cliArgs,
    command: "onboarding",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: cliArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
