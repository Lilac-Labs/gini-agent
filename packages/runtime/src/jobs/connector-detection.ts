// Connector auto-detection job.
//
// Walks every registered provider that exposes a `detect()` method (today
// claude-code and codex) and asks each whether the host environment has
// the underlying CLI/auth surface available. Detections that come back
// `{ detected: true }` materialize a connector record with `source:
// "auto"` and run an initial probe so dependent skills can activate
// without any user ceremony.
//
// Idempotent in two directions:
//   - A provider that already has any connector for it (regardless of
//     source) is skipped — the user shouldn't see a duplicate after
//     manually adding one.
//   - A provider that has a `disabled` tombstone is skipped — when the
//     user explicitly disconnects an auto-source connector we keep the
//     record around with `status: "disabled"` so this job doesn't
//     immediately re-create it.
//
// Runs once at gateway startup (src/server.ts) and on demand via the
// `POST /api/connectors/detect` endpoint exposed for the Skills page
// "Refresh detection" action.

import type { ConnectorRecord, RuntimeConfig } from "../types";
import { addAudit, id, mutateState, now, updateConnectorHealth } from "../state";
import { canonicalCredentialName, listProviders } from "../integrations/connectors/registry";
import { checkConnector } from "../integrations/connectors";

export interface DetectionReport {
  considered: number;
  created: Array<{ id: string; provider: string; name: string }>;
  skipped: Array<{ provider: string; reason: "exists" | "tombstoned" | "not-detected" | "no-detect" }>;
}

export async function runConnectorDetection(config: RuntimeConfig): Promise<DetectionReport> {
  const report: DetectionReport = { considered: 0, created: [], skipped: [] };
  const providers = listProviders();

  for (const provider of providers) {
    if (!provider.detect) {
      report.skipped.push({ provider: provider.id, reason: "no-detect" });
      continue;
    }
    report.considered += 1;

    let result;
    try {
      result = await provider.detect();
    } catch {
      // Detect is best-effort. A throw means we treat it as "not detected"
      // and move on; the user can still add the connector manually.
      report.skipped.push({ provider: provider.id, reason: "not-detected" });
      continue;
    }

    if (!result.detected) {
      report.skipped.push({ provider: provider.id, reason: "not-detected" });
      continue;
    }

    // Check exists/tombstoned inside the mutateState callback so a
    // concurrent create/delete can't slip past our pre-check.
    const created = await mutateState(config.instance, (state) => {
      const existing = state.connectors.find((candidate) => candidate.provider === provider.id);
      if (existing) {
        if (existing.status === "disabled") {
          report.skipped.push({ provider: provider.id, reason: "tombstoned" });
        } else {
          report.skipped.push({ provider: provider.id, reason: "exists" });
        }
        return undefined;
      }
      const at = now();
      const connector: ConnectorRecord = {
        id: id("id"),
        instance: state.instance,
        name: canonicalCredentialName(provider.id) ?? result.suggestedName ?? provider.label,
        provider: provider.id,
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "unknown",
        source: "auto"
      };
      state.connectors.unshift(connector);
      // Mirror createConnector: providers without a probe (claude-code
      // currently has one; codex has one too) get a synchronous health
      // set. For probe-based providers we leave health: "unknown" and
      // rely on the post-create checkConnector below.
      if (!provider.probe) {
        updateConnectorHealth(connector);
      }
      // Connectors live at the instance level; auto-detection happens
      // before any agent has been activated for this read.
      addAudit(
        state,
        {
          actor: "runtime",
          action: "connector.auto_create",
          target: connector.id,
          risk: "low",
          evidence: {
            provider: connector.provider,
            name: connector.name,
            source: connector.source,
            message: result.message
          }
        },
        { system: true }
      );
      return connector;
    });

    if (created) {
      report.created.push({ id: created.id, provider: created.provider, name: created.name });
      // Best-effort initial probe so dependent skills flip to active right
      // after detection. Probe failures land on the connector record itself
      // (health: "unhealthy" + message) — don't unwind the create.
      if (provider.probe) {
        try {
          await checkConnector(config, created.id);
        } catch {
          // Swallow — the failed probe already surfaced via mutateState
          // inside checkConnector if it got that far; anything thrown
          // before is best-effort.
        }
      }
    }
  }

  return report;
}
