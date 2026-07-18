import type { RuntimeConfig } from "../types";
import { addAudit, createNotificationRecord, createRelayRecord, mutateState, now, readState } from "../state";

export function listRelays(config: RuntimeConfig) {
  return readState(config.instance).relays;
}

export async function configureRelay(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "local");
  const endpoint = String(input.endpoint ?? "local://localhost");
  const mode = input.mode === "lan" ? input.mode : "local-only";
  return mutateState(config.instance, (state) => createRelayRecord(state, { name, endpoint, mode }));
}

export async function checkRelay(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => {
    const relay = state.relays.find((item) => item.id === idOrName || item.name === idOrName);
    if (!relay) throw new Error(`Relay not found: ${idOrName}`);
    relay.lastHealthAt = now();
    relay.updatedAt = relay.lastHealthAt;
    relay.status = relay.mode === "local-only" ? "degraded" : "configured";
    relay.message = relay.mode === "local-only"
      ? "Local-only relay mode is available; remote reachability is not configured."
      : "LAN relay record is configured. Remote transport implementation is deferred.";
    // Relay health is an instance-level probe; the relay endpoint serves
    // every agent.
    addAudit(
      state,
      {
        actor: "runtime",
        action: "relay.health",
        target: relay.id,
        risk: "low",
        evidence: { status: relay.status, mode: relay.mode }
      },
      { system: true }
    );
    return relay;
  });
}

export async function queueNotification(config: RuntimeConfig, input: Record<string, unknown>) {
  return mutateState(config.instance, (state) => createNotificationRecord(state, {
    kind: input.kind === "approval" || input.kind === "job" || input.kind === "task" || input.kind === "promotion" ? input.kind : "runtime",
    title: String(input.title ?? "Gini notification"),
    body: String(input.body ?? ""),
    target: String(input.target ?? "local"),
    taskId: typeof input.taskId === "string" ? input.taskId : undefined
  }));
}

export async function sendQueuedNotifications(config: RuntimeConfig) {
  return mutateState(config.instance, (state) => {
    for (const notification of state.notifications.filter((item) => item.status === "queued")) {
      notification.status = "sent";
      notification.sentAt = now();
      notification.updatedAt = notification.sentAt;
      addAudit(
        state,
        {
          actor: "runtime",
          action: "notification.sent",
          target: notification.id,
          risk: "low",
          taskId: notification.taskId,
          evidence: { target: notification.target, kind: notification.kind }
        },
        notification.taskId ? { taskId: notification.taskId } : { system: true }
      );
    }
    return state.notifications;
  });
}

export async function acknowledgeNotification(config: RuntimeConfig, notificationId: string) {
  return mutateState(config.instance, (state) => {
    const notification = state.notifications.find((item) => item.id === notificationId);
    if (!notification) throw new Error(`Notification not found: ${notificationId}`);
    notification.status = "acknowledged";
    notification.updatedAt = now();
    addAudit(
      state,
      { actor: "user", action: "notification.acknowledged", target: notification.id, risk: "low" },
      notification.taskId ? { taskId: notification.taskId } : { system: true }
    );
    return notification;
  });
}
