// Pure activation-status logic for the Skills page. Extracted from page.tsx
// so it can be unit-tested without importing the client component (and its
// React/UI deps). page.tsx imports deriveActivation + Activation from here.

import type { ConnectorRecord, SkillRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";

export type Activation = {
  label: "active" | "needs setup" | "disabled" | "unsupported" | string;
  tone: "ok" | "warn" | "neutral" | "danger";
};

// Compute the effective activation status for the Skills page. The runtime
// is the source of truth for "is this skill in the agent's set"; we read the
// server-computed `usable` bit on each connector record so the client never
// reimplements the usability predicate (it lives in connectorIsUsable on the
// runtime). Mirrors src/integrations/connectors/index.ts isSkillActive: a
// skill is active when every required credential NAME maps to a connector
// whose `usable` bit is true. The absent-record fallthrough still applies:
// when NO connector record with the required name exists at all, the owning
    // provider's `externallySatisfied` bit (its credentialExternallySatisfied
    // hook, e.g. an instance-bound Google account) satisfies the
// credential. An existing record of any status (including disabled — explicit
// operator off) keeps the record-based gate.
export function deriveActivation(
  skill: SkillRecord,
  byName: Map<string, ConnectorRecord[]>,
  providersById: Map<string, ProviderDescriptor>,
  providerByCredentialName: Map<string, ProviderDescriptor>
): Activation {
  if (skill.validationStatus === "unsupported") return { label: "unsupported", tone: "danger" };
  if (skill.status === "disabled" || skill.status === "archived") return { label: "disabled", tone: "neutral" };

  const required = skill.requiredCredentials ?? [];
  if (required.length === 0) return { label: "active", tone: "ok" };
  for (const credentialName of required) {
    const matches = byName.get(credentialName) ?? [];
    // Use the server-computed `usable` bit. Falls back to the previous
    // client-side predicate when `usable` is absent (e.g. stale API
    // response during a rolling deploy).
    const satisfied = matches.some((c) => {
      if (c.usable !== undefined) return c.usable;
      // Fallback: mirror the runtime gate for backward compat.
      if (c.status !== "configured") return false;
      if (c.health === "healthy") return true;
      const hasProbe = Boolean(providersById.get(c.provider)?.hasProbe);
      if (!hasProbe && c.health === "unknown") return true;
      return false;
    });
    if (satisfied) continue;
    // Absent-record fallthrough (mirrors isSkillActive): the hook only
    // applies when no record with this name exists at all. A Google account
    // attached through Integrations flips `externallySatisfied` with no
    // connector record.
    if (
      matches.length === 0 &&
      providerByCredentialName.get(credentialName)?.externallySatisfied
    ) {
      continue;
    }
    return { label: "needs setup", tone: "warn" };
  }
  return { label: "active", tone: "ok" };
}
