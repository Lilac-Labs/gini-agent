// Bridge between connectors and the MCP-server registry.
//
// Some providers (today only Linear) expose an HTTP MCP endpoint that the
// agent loop reaches through `mcp_call(server: "<name>", …)`. Connectors
// and MCP servers live in separate state slices, so authenticating a
// connector by itself never makes the matching MCP server resolvable. This
// module is the glue: whenever a provider's connector becomes usable, we
// materialize the provider-declared MCP server record (if one isn't
// already present).
//
// Kept separate from `mcp.ts` to avoid an import cycle with
// `./connectors/index.ts` (which calls `syncProviderMcpServers` from
// `checkConnector`). `mcp.ts` itself depends on `./connectors`, so
// importing back from there would create the cycle.

import type { ConnectorRecord, RuntimeConfig } from "../types";
import { addAudit, createMcpServerRecord, mutateState, readState } from "../state";
import { getProvider } from "./connectors/registry";
import { connectorIsUsable } from "./connectors";

// Register an MCP server for every usable api-key credential that carries
// `metadata.mcp`. The server row is named by `mcp.name` when set, else the
// credential name (api-key name == env var) — this lets the LINEAR_API_KEY
// credential own the "linear" row that skills reference as `server: "linear"`.
// Its single auth header is built from the credential's mcp metadata:
// `{[headerName ?? "Authorization"]: "<scheme ?? Bearer> ${<credential-name>}"}`.
// The `${<credential-name>}` placeholder always resolves at invoke-time via
// `resolveMcpHeaders` against the credential (name-based, independent of the
// row name), so the token never lands in state.json. Idempotent and keyed by
// row name — never clobbers a user's manual `gini mcp add` config or an
// already-registered row.
async function syncCredentialMcpServers(config: RuntimeConfig, created: string[]): Promise<void> {
  const state = readState(config.instance);
  for (const credential of state.connectors) {
    if (credential.type !== "api-key") continue;
    const mcp = credential.metadata?.mcp;
    if (!mcp?.url) continue;
    if (!connectorIsUsable(credential)) continue;
    const serverName = mcp.name ?? credential.name;
    if (state.mcpServers.some((s) => s.name === serverName)) continue;
    const headerName = mcp.headerName ?? "Authorization";
    const scheme = mcp.scheme ?? "Bearer";
    const headers = { [headerName]: `${scheme} \${${credential.name}}` };
    const inserted = await mutateState(config.instance, (mutating): { id: string; name: string } | undefined => {
      // Re-check usability and existence inside the lock to lose cleanly to a
      // concurrent disable/delete or `gini mcp add` for the same name.
      const still = mutating.connectors.find((c) => c.id === credential.id);
      if (!still || still.type !== "api-key" || !connectorIsUsable(still)) return undefined;
      if (mutating.mcpServers.some((s) => s.name === serverName)) return undefined;
      const record = createMcpServerRecord(
        mutating,
        {
          name: serverName,
          command: "",
          args: [],
          envKeys: [],
          exposedTools: [],
          transport: "http",
          url: mcp.url,
          headers
        },
        { actor: "runtime" }
      );
      addAudit(
        mutating,
        {
          actor: "runtime",
          action: "mcp.auto_register",
          target: record.id,
          risk: "low",
          evidence: { provider: credential.provider, name: serverName, url: mcp.url }
        },
        { system: true }
      );
      return { id: record.id, name: record.name };
    });
    if (inserted) created.push(inserted.name);
  }
}

// Idempotently materialize an MCP server record for every usable api-key
// credential that carries `metadata.mcp`. The registry is keyed by row name:
// if a server with that name already exists (any status, including disabled),
// the upsert is a no-op so we never clobber a user's manual `gini mcp add`
// config.
//
// Called from:
//   - `checkConnector` (after a successful probe flips health to healthy)
//   - server startup (back-fill for credentials that pre-date this code)
//
// Returns the list of newly-created MCP server names so callers can log
// or audit the transition. Names only appear in the return list when the
// insert actually happened inside the lock (i.e. no concurrent CLI add /
// credential disable raced ahead between our read and the mutate).
export async function syncProviderMcpServers(config: RuntimeConfig): Promise<string[]> {
  const created: string[] = [];
  await syncCredentialMcpServers(config, created);
  return created;
}
