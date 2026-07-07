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
// is the source of truth for "is this skill in the agent's set"; we replay
// the same dependency check here so users see the badge that matches what
// the agent loop sees. Mirrors src/integrations/connectors/index.ts
// isSkillActive: a skill is active when every required credential NAME maps to
// a connector that is healthy OR (when its provider has no probe) configured
// with unknown health. Without the provider info we'd diverge from the runtime
// gate for demo / generic providers, which sit at health: "unknown" at rest.
// Also mirrored: the absent-record fallthrough — when NO connector record
// with the required name exists at all, the owning provider's live
// `externallySatisfied` bit (its credentialExternallySatisfied hook, e.g.
// the boot-registered hosted Google account) satisfies the credential. This
// is the path that keeps the Google Workspace API skills ACTIVE in hosted,
// where the guest ships with its Google credential already in place and no
// connector record is ever created. An existing record of any status
// (including disabled — explicit operator off) keeps the record-based gate.
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
    const satisfied = matches.some((c) => {
      // Mirror the runtime gate exactly: only configured records ever
      // satisfy. Disabled (tombstoned) and error-status records are
      // excluded even if they carry a stale `health: "healthy"` from
      // a prior probe. A typed credential whose provider has no probe is
      // presence-healthy at unknown (no remote signal to refute it).
      if (c.status !== "configured") return false;
      if (c.health === "healthy") return true;
      const hasProbe = Boolean(providersById.get(c.provider)?.hasProbe);
      if (!hasProbe && c.health === "unknown") return true;
      return false;
    });
    if (satisfied) continue;
    // Absent-record fallthrough (mirrors isSkillActive): the hook only
    // applies when no record with this name exists at all. In hosted this
    // is how the Google Workspace credential is satisfied — the boot-
    // registered account flips `externallySatisfied` true with no connector.
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
