import type { McpServerRecord, RuntimeConfig } from "../types";
import { addAudit, appendEvent, createMcpServerRecord, mutateState, now, readState } from "../state";
import { spawn } from "bun";
import { bindingsForCredentials, envBindingsForProviders, resolveConnectorSecret } from "./connectors";
import { listProviders } from "./connectors/registry";
import { httpMcpCallTool, httpMcpInitialize, httpMcpListTools, resolveHeaderValue } from "./mcp-http";
import { captureMcpToolCall } from "./posthog";

export async function addMcpServer(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!name) throw new Error("MCP server name is required.");
  const transport: "stdio" | "http" = input.transport === "http" || (typeof input.url === "string" && input.url.length > 0) ? "http" : "stdio";
  if (transport === "http") {
    const url = String(input.url ?? "");
    if (!url) throw new Error("MCP http server requires a url.");
    const headers = sanitizeHeaders(input.headers);
    return mutateState(config.instance, (state) => createMcpServerRecord(state, {
      name,
      command: "",
      args: [],
      envKeys: [],
      exposedTools: Array.isArray(input.exposedTools) ? input.exposedTools.map(String) : [],
      transport: "http",
      url,
      headers
    }));
  }
  const command = String(input.command ?? "");
  if (!command) throw new Error("MCP stdio server requires a command.");
  return mutateState(config.instance, (state) => createMcpServerRecord(state, {
    name,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    envKeys: Array.isArray(input.envKeys) ? input.envKeys.map(String) : [],
    exposedTools: Array.isArray(input.exposedTools) ? input.exposedTools.map(String) : [],
    transport: "stdio"
  }));
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function checkMcpServer(config: RuntimeConfig, idOrName: string) {
  const server = readState(config.instance).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  let probe: { ok: boolean; message?: string; tools?: McpServerRecord["tools"]; stdout?: string; stderr?: string };
  if (server.status === "disabled") {
    probe = { ok: false, message: "MCP server is disabled." };
  } else if (server.transport === "http") {
    probe = await runHttpProbe(config, server);
  } else {
    probe = await runMcpProbe(config, server.command, server.args);
  }
  return mutateState(config.instance, (state) => {
    const next = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!next) throw new Error(`MCP server not found: ${idOrName}`);
    next.lastHealthAt = now();
    next.status = probe.ok ? "configured" : "error";
    next.message = probe.message;
    if (probe.tools) next.tools = probe.tools;
    next.updatedAt = next.lastHealthAt;
    addAudit(
      state,
      {
        actor: "runtime",
        action: "mcp.health",
        target: next.id,
        risk: "low",
        evidence: { status: next.status, transport: next.transport ?? "stdio", toolCount: next.tools?.length ?? 0, probe: { ok: probe.ok, message: probe.message } }
      },
      { system: true }
    );
    return next;
  });
}

export interface InvokeMcpToolOptions {
  taskId?: string;
}

export async function invokeMcpTool(
  config: RuntimeConfig,
  idOrName: string,
  toolName: string,
  input: Record<string, unknown> = {},
  options: InvokeMcpToolOptions = {}
) {
  const server = readState(config.instance).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  if (server.status !== "configured") throw new Error(`MCP server is not configured: ${idOrName}`);
  if (server.exposedTools.length > 0 && !server.exposedTools.includes(toolName)) throw new Error(`MCP tool is not exposed: ${toolName}`);
  let result: { ok: boolean; message?: string; stdout?: string; stderr?: string; exitCode?: number };
  const startedMs = performance.now();
  if (server.transport === "http") {
    if (!server.url) throw new Error(`MCP server has no url: ${idOrName}`);
    const headers = await resolveMcpHeaders(config, server, options.taskId);
    const tool = await httpMcpCallTool(server.url, headers, toolName, input);
    result = {
      ok: tool.ok,
      message: tool.error ?? (tool.isError ? "MCP tool reported an error." : "MCP tool invoked."),
      stdout: tool.content,
      stderr: tool.error
    };
  } else {
    // Legacy stdio path. Kept as a no-MCP-JSON-RPC stub: callers that wired
    // a stdio command before HTTP transport landed continue to see the old
    // "run command and capture stdout" behavior. A real stdio MCP client
    // is intentionally out of scope for this PR.
    result = await runMcpProbe(config, server.command, [...server.args, JSON.stringify(input)]);
  }
  // Masked MCP analytics. Only safe metadata and coarse size/count numbers are
  // passed in — the chat-derived `input` and `result.stdout` are reduced to a
  // parameter count and a byte length here so no chat content ever reaches the
  // analytics module. Best-effort and non-throwing. See ADR posthog-mcp-analytics.md.
  captureMcpToolCall({
    instance: config.instance,
    serverName: server.name,
    transport: server.transport ?? "stdio",
    toolName,
    ok: result.ok,
    durationMs: Math.round(performance.now() - startedMs),
    parameterCount: Object.keys(input).length,
    responseBytes: result.stdout ? result.stdout.length : 0,
    taskId: options.taskId
  });
  await mutateState(config.instance, (state) => {
    const ctx = options.taskId ? { taskId: options.taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: options.taskId ? "agent" : "runtime",
        action: "mcp.tool.invoked",
        target: server.id,
        risk: "medium",
        taskId: options.taskId,
        evidence: { toolName, ok: result.ok, transport: server.transport ?? "stdio", stdoutBytes: result.stdout?.length ?? 0 }
      },
      ctx
    );
    appendEvent(
      state,
      {
        kind: "mcp",
        action: "mcp.tool.invoked",
        target: server.id,
        risk: "medium",
        summary: result.ok ? `MCP tool ${toolName} invoked.` : `MCP tool ${toolName} failed.`,
        data: { toolName, ok: result.ok, bytes: result.stdout?.length ?? 0 }
      },
      ctx
    );
  });
  return { serverId: server.id, toolName, ...result };
}

export async function removeMcpServer(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.status = "disabled";
    server.updatedAt = now();
    addAudit(
      state,
      { actor: "user", action: "mcp.disabled", target: server.id, risk: "medium" },
      { system: true }
    );
    return server;
  });
}

// Resolve each header value's `${VAR}` placeholders against the union of:
//  - live typed-credential secrets (resolved BY NAME), and
//  - process.env (fallback ONLY for vars no credential or provider claims as
//    a secret).
// Throws when any placeholder can't resolve so the caller surfaces a
// "missing credential" error before the request goes out.
//
// Two trust properties this function preserves:
//
//  1. Probe-based credentials (e.g. the LINEAR_API_KEY credential) must have
//     `health === "healthy"` to contribute their secret. A freshly-created,
//     never-probed second connector with a bad token must not supply
//     credentials to an MCP row that an older healthy credential originally
//     enabled. (`bindingsForCredentials` applies the same usability guard as
//     `isSkillActive` and `resolveSkillEnv`.)
//
//  2. Variables that any credential OR provider claims as a secret can ONLY be
//     supplied by a live credential. Falling back to `process.env` for these
//     would silently keep an MCP row authenticated after the credential is
//     deleted/disabled (the user's shell still exports `LINEAR_API_KEY`),
//     bypassing the `connector.secret.use` audit. The provider-declared set is
//     kept in the block-list (not as a resolution source) so a deleted
//     credential can never be quietly replaced by the operator's shell. We
//     still permit `process.env` for vars nothing owns (e.g.
//     `MCP-Protocol-Version`-style passthrough wired into the header by hand).
export async function resolveMcpHeaders(
  config: RuntimeConfig,
  server: McpServerRecord,
  taskId?: string
): Promise<Record<string, string>> {
  const raw = server.headers ?? {};
  if (Object.keys(raw).length === 0) return {};
  const state = readState(config.instance);
  // The `${VAR}` placeholders this server's headers actually reference. We only
  // resolve secrets for THESE — resolving every typed credential's secret would
  // emit spurious `connector.secret.use` audits for unrelated credentials, and
  // a single unrelated credential failing to resolve would break the call.
  const referencedVars = new Set<string>();
  for (const value of Object.values(raw)) {
    for (const m of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) referencedVars.add(m[1] as string);
  }

  // Block-list: every env var ANY typed credential owns — INCLUDING
  // disabled/error/tombstoned records — plus any provider-declared secret var.
  // These can ONLY be supplied by a live (configured + healthy) credential,
  // never by process.env, so deleting/disabling a credential can't leave an
  // MCP row authenticated from the operator's shell (which would bypass the
  // connector.secret.use audit). A credential whose status excludes it from
  // resolution therefore yields a "missing credential" error rather than
  // silently falling back. The provider-declared set is a defense-in-depth
  // guard, NOT a resolution source.
  const claimedVars = new Set<string>(Object.keys(envBindingsForProviders(listProviders().map((p) => p.id))));
  // Map each typed credential's owned env vars → its name, for ALL typed
  // records regardless of status. The same loop seeds the block-list.
  const envVarToCredentialName = new Map<string, string>();
  for (const connector of state.connectors) {
    if (!connector.type) continue;
    const ownedVars = connector.type === "oauth2"
      ? Object.values(connector.metadata?.envMap ?? {})
      : [connector.name];
    for (const envVar of ownedVars) {
      claimedVars.add(envVar);
      // Only the first owner of an env var maps (names are unique
      // instance-wide once migrated; this just keeps the map deterministic).
      if (!envVarToCredentialName.has(envVar)) envVarToCredentialName.set(envVar, connector.name);
    }
  }

  // Resolve ONLY the referenced placeholders, name-based. Collect the typed
  // credential names that own a referenced var, then resolve through
  // `bindingsForCredentials` (which applies the configured + healthy guard so
  // a disabled/never-probed credential contributes nothing). api-key env var ==
  // credential name; oauth2 materializes each metadata.envMap entry.
  const referencedNames = new Set<string>();
  for (const envVar of referencedVars) {
    const name = envVarToCredentialName.get(envVar);
    if (name) referencedNames.add(name);
  }
  const credentialBindings = bindingsForCredentials(state, Array.from(referencedNames));
  const env: Record<string, string> = {};
  for (const [envName, binding] of Object.entries(credentialBindings)) {
    if (!referencedVars.has(envName)) continue;
    const value = await resolveConnectorSecret(config, binding.credentialId, binding.purpose, taskId);
    if (value) env[envName] = value;
  }
  // Build the resolution env per header: connector-bound vars come ONLY
  // from `env` (above); other `${VAR}` placeholders may fall back to
  // process.env so users can wire in non-secret values like
  // `MCP-Protocol-Version` by hand. The fallback never overrides a
  // connector-bound value because the env map shadows process.env for
  // any claimed var.
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const headerVars = Array.from(value.matchAll(/\$\{([A-Z0-9_]+)\}/g)).map((m) => m[1] as string);
    let usedEnv: Record<string, string> = env;
    const fallbackCandidates = headerVars.filter((name) => !claimedVars.has(name));
    if (fallbackCandidates.length > 0) {
      const fallback: Record<string, string> = {};
      for (const name of fallbackCandidates) {
        const v = process.env[name];
        if (typeof v === "string") fallback[name] = v;
      }
      usedEnv = { ...fallback, ...env };
    }
    const out = resolveHeaderValue(value, usedEnv);
    if (out === undefined) {
      throw new Error(`Missing credential for MCP header '${key}'. Configure the connector that supplies it via 'gini connectors add'.`);
    }
    resolved[key] = out;
  }
  return resolved;
}

async function runHttpProbe(config: RuntimeConfig, server: McpServerRecord): Promise<{ ok: boolean; message?: string; tools?: McpServerRecord["tools"] }> {
  if (!server.url) return { ok: false, message: "MCP http server has no url." };
  let headers: Record<string, string>;
  try {
    headers = await resolveMcpHeaders(config, server);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const init = await httpMcpInitialize(server.url, headers);
  if (!init.ok) return { ok: false, message: init.error ?? "MCP initialize failed." };
  const list = await httpMcpListTools(server.url, headers);
  if (!list.ok) return { ok: false, message: list.error ?? "MCP tools/list failed." };
  return { ok: true, message: `MCP http server reachable (${list.tools?.length ?? 0} tools).`, tools: list.tools };
}

async function runMcpProbe(config: RuntimeConfig, command: string, args: string[]) {
  try {
    const proc = spawn([command, ...args], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), 3000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    return {
      ok: exitCode === 0,
      message: exitCode === 0 ? "MCP server command completed health probe." : `MCP command exited ${exitCode}.`,
      exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
