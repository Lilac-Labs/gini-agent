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

  test("labels use the catalog displayLabel and output follows the curated toolset order", async () => {
    const config = testConfig("job-tools-labels");
    const job = await createScheduledJob(config, { name: "digest", prompt: "p", intervalSeconds: 60 });
    const { tools } = listJobTools(config, job.id);
    expect(tools.find((tool) => tool.name === "file_read")?.label).toBe("Read file");
    // Curated display order: high-signal clusters (email, file) lead so the
    // collapsed first slice isn't a wall of the large browser cluster.
    const firstOf = (toolset: string) => tools.findIndex((tool) => tool.toolset === toolset);
    expect(firstOf("email")).toBeGreaterThanOrEqual(0);
    expect(firstOf("browser")).toBeGreaterThanOrEqual(0);
    expect(firstOf("email")).toBeLessThan(firstOf("browser"));
    expect(firstOf("file")).toBeLessThan(firstOf("browser"));
    // Rows stay clustered by toolset (no toolset appears in two runs), and
    // labels sort within each cluster.
    const seen = new Set<string>();
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]!;
      const prev = i > 0 ? tools[i - 1] : undefined;
      if (!prev || prev.toolset !== tool.toolset) {
        expect(seen.has(tool.toolset)).toBe(false);
        seen.add(tool.toolset);
      } else {
        expect(prev.label.localeCompare(tool.label)).toBeLessThanOrEqual(0);
      }
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
