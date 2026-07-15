import type { CliContext } from "../context";
import { flagValue, restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

export async function connector(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "list";

  if (sub === "providers") {
    print(await api(config, "/api/connectors/providers"));
    return;
  }

  if (sub === "add") {
    const name = flagValue(cliArgs, "--name") ?? "";
    const provider = flagValue(cliArgs, "--provider") ?? "";
    const scopesRaw = flagValue(cliArgs, "--scopes") ?? "";
    const token = flagValue(cliArgs, "--token");
    if (!name || !provider) {
      throw new Error("Usage: gini connector add --provider <id> --name <name> [--scopes a,b] [--token <value>]");
    }
    const secrets: Record<string, string> = {};
    if (token) secrets.token = token;
    const body = {
      name,
      provider,
      scopes: scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
      secrets
    };
    print(await api(config, "/api/connectors", { method: "POST", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "remove") {
    const id = restAfter(cliArgs, sub)[0];
    if (!id) throw new Error("Usage: gini connector remove <id>");
    print(await api(config, `/api/connectors/${id}`, { method: "DELETE" }));
    return;
  }

  if (sub === "rotate") {
    const id = restAfter(cliArgs, sub)[0];
    const token = flagValue(cliArgs, "--token");
    if (!id || !token) throw new Error("Usage: gini connector rotate <id> --token <value>");
    const body = { secrets: { token } };
    print(await api(config, `/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
    return;
  }

  if (sub === "health") {
    const id = restAfter(cliArgs, sub)[0] ?? "id_demo";
    print(await api(config, `/api/connectors/${id}/health`, { method: "POST" }));
    return;
  }

  if (sub === "accounts") {
    const action = cliArgs[2] ?? "list";

    if (action === "list") {
      print(await api(config, "/api/google/accounts"));
      return;
    }

    if (action === "retag") {
      const id = restAfter(cliArgs, action)[0];
      const tag = flagValue(cliArgs, "--tag");
      if (!id || id.startsWith("--") || !tag) {
        throw new Error("Usage: gini connector accounts retag <id> --tag <tag>");
      }
      const body = { tag };
      print(await api(config, `/api/google/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
      return;
    }

    if (action === "remove") {
      const id = restAfter(cliArgs, action)[0];
      if (!id) throw new Error("Usage: gini connector accounts remove <id>");
      print(await api(config, `/api/google/accounts/${id}`, { method: "DELETE" }));
      return;
    }

    if (action === "add") {
      // Google OAuth is a browser flow the CLI can't drive. Point the user at
      // the Integrations page in the web app (in chat, the agent surfaces a
      // button there via request_google_account).
      print({
        message:
          "The CLI can't drive the Google OAuth flow. To add or reconnect a Google account, open the Integrations page in the web app (in chat, the agent can surface a button there). On hosted, the primary Google account is connected at sign-in through the host."
      });
      return;
    }

    throw new Error("Usage: gini connector accounts [list|retag <id> --tag <tag>|remove <id>|add]");
  }

  print(await api(config, "/api/connectors"));
}
