// Tests for listJobTools (src/capabilities/toolsets.ts): the effective tool
// catalog a job's runs dispatch with, shown on the routine detail pages. The
// hot spots are the agent-whitelist intersection (must mirror
// resolveEffectiveContext's nonempty condition), the always-on bypasses in
// buildToolCatalog surviving a narrow whitelist, and the server-owned
// label/ordering contract clients render verbatim.

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listJobTools } from "./toolsets";
import { createScheduledJob } from "../jobs";
import { mutateState } from "../state";
import type { RuntimeConfig } from "../types";

describe("listJobTools", () => {
  test("throws Job not found for an unknown job id", () => {
    const config = testConfig("job-tools-unknown");
    expect(() => listJobTools(config, "job_missing")).toThrow("Job not found: job_missing");
  });

  test("returns the default agent's catalog including always-on tools", async () => {
    const config = testConfig("job-tools-default");
    const job = await createScheduledJob(config, { name: "digest", prompt: "p", intervalSeconds: 60 });
    const { tools } = listJobTools(config, job.id);
    const names = tools.map((tool) => tool.name);
    // web_fetch bypasses toolset gating entirely; file_read passes via the
    // default agent's whitelist ∩ enabled "file" toolset.
    expect(names).toContain("web_fetch");
    expect(names).toContain("file_read");
    // Every row carries the full display contract.
    for (const tool of tools) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.toolset.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(0);
    }
  });

  test("agent toolsets whitelist narrows the catalog but keeps always-on tools", async () => {
    const config = testConfig("job-tools-whitelist");
    const job = await createScheduledJob(config, { name: "watch", prompt: "p", intervalSeconds: 60 });
    await mutateState(config.instance, (state) => {
      const agent = state.agents.find((item) => item.id === job.agentId);
      if (!agent) throw new Error("owning agent missing");
      agent.toolsets = ["file"];
    });
    const names = listJobTools(config, job.id).tools.map((tool) => tool.name);
    expect(names).toContain("file_read");
    expect(names).not.toContain("browser_navigate");
    // Always-on bypasses survive the narrow whitelist.
    expect(names).toContain("web_fetch");
  });

  test("labels use the catalog displayLabel and output sorts by toolset then label", async () => {
    const config = testConfig("job-tools-labels");
    const job = await createScheduledJob(config, { name: "digest", prompt: "p", intervalSeconds: 60 });
    const { tools } = listJobTools(config, job.id);
    expect(tools.find((tool) => tool.name === "file_read")?.label).toBe("Read file");
    // Each adjacent pair honors the (toolset, label) ordering the endpoint
    // promises — same comparator as the implementation.
    for (let i = 1; i < tools.length; i++) {
      const prev = tools[i - 1]!;
      const curr = tools[i]!;
      expect(prev.toolset.localeCompare(curr.toolset) || prev.label.localeCompare(curr.label)).toBeLessThanOrEqual(0);
    }
  });
});

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-job-tools-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7338,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}
