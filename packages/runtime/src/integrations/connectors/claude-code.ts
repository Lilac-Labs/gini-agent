import { spawnSync } from "node:child_process";
import type { ProviderModule } from "./types";

// Claude Code CLI provider. No managed secrets — auth lives in the host's
// `claude` install. Probe verifies the CLI is on PATH and reports whether
// the user is signed in. `detect()` powers the "we noticed claude on your
// PATH" hint in the Add Connector dialog.

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

export const claudeCodeProvider: ProviderModule = {
  id: "claude-code",
  label: "Claude Code",
  description: "Delegate coding work to the Claude Code CLI. No secrets stored — auth lives in your host `claude` install.",
  // Credential name so canonicalCredentialName resolves and skills with
  // `requires: connectors: claude-code` gate on this connector's health.
  credentialName: "claude-code",
  fields: [],
  async probe() {
    const path = which("claude");
    if (!path) return { ok: false, message: "claude not found on PATH. Install with `npm install -g @anthropic-ai/claude-code`." };
    const auth = spawnSync("claude", ["auth", "status", "--text"], { encoding: "utf8", timeout: 10_000 });
    if (auth.status === 0) {
      const summary = (auth.stdout || "").trim().split("\n")[0] ?? "signed in";
      return { ok: true, message: summary };
    }
    // Some older builds don't have `claude auth status --text`. Fall back to
    // `claude --version` so PATH-only presence still reads healthy.
    const version = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (version.status === 0) {
      return { ok: true, message: (version.stdout || "").trim() || "claude available" };
    }
    return { ok: false, message: `claude found at ${path} but neither auth status nor --version succeeded.` };
  },
  async detect() {
    // Stricter than `probe`: detection materializes a connector record
    // automatically, so we only return `detected: true` when both the
    // binary is on PATH AND the auth surface reports authenticated.
    // Without the auth check, a fresh `claude` install (binary present
    // but unsigned-in) would seed an unhealthy auto-connector.
    const path = which("claude");
    if (!path) return { detected: false };
    const auth = spawnSync("claude", ["auth", "status", "--text"], { encoding: "utf8", timeout: 10_000 });
    if (auth.status !== 0) return { detected: false, message: `claude found at ${path} but auth status not OK.` };
    return { detected: true, suggestedName: "Claude Code", message: `Found claude at ${path}; signed in.` };
  }
};
