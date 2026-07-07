// Push-device registry. Persists APNs tokens per credential so the
// APNs dispatcher (src/integrations/apns/dispatcher.ts) can fan an
// `approval_requested` chat block out to every iOS install that
// belongs to the same paired credential.
//
// Backing store: the `devices` SQLite table created in
// src/state/memory-db.ts:applyMigrations step 5. Each row is keyed by
// the raw APNs token (a hex string, ~64 chars). One token can only be
// registered to one credential at a time — re-registering rebinds the
// row.
//
// "credential_id" semantics: the caller's identity as resolved by the
// owner-token bearer gate in src/http.ts — always the literal string
// "owner" (one runtime, one human; see ADR owner-token-auth.md). The
// APNs dispatcher uses this to scope a fan-out to all iOS installs of
// the same human.

import type { Instance } from "../types";
import { now } from "./ids";
import { getMemoryDb } from "./memory-db";

// Network path the registration arrived over. Always `loopback` — the
// operator's local browser or a paired device reaching the gateway over
// the LAN.
export type DeviceOrigin = "loopback";

export interface PushDevice {
  token: string;
  credentialId: string;
  platform: "ios";
  bundleId: string;
  registeredAt: string;
  lastSeenAt: string;
  origin: DeviceOrigin;
}

interface PushDeviceRow {
  token: string;
  credential_id: string;
  platform: "ios";
  bundle_id: string;
  registered_at: string;
  last_seen_at: string;
  origin: DeviceOrigin;
}

function rowToDevice(row: PushDeviceRow): PushDevice {
  return {
    token: row.token,
    credentialId: row.credential_id,
    platform: row.platform,
    bundleId: row.bundle_id,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    origin: row.origin
  };
}

export interface UpsertDeviceInput {
  token: string;
  credentialId: string;
  platform: "ios";
  bundleId: string;
  // Optional; "loopback" is the only origin, so callers may omit it and
  // upsertDevice fills the default.
  origin?: DeviceOrigin;
}

// Idempotent: if the same token re-registers, rebind it to the
// latest credential + bundle and bump last_seen_at. registered_at is
// preserved on existing rows so callers can audit when the device
// first registered. The PRIMARY KEY on `token` makes this safe under
// concurrent inserts — SQLite serializes writes through the per-DB
// lock, and the INSERT OR REPLACE clobbers any prior row.
export function upsertDevice(instance: Instance, input: UpsertDeviceInput): PushDevice {
  const db = getMemoryDb(instance);
  const at = now();
  const existing = db
    .query<PushDeviceRow, [string]>("SELECT * FROM devices WHERE token = ?")
    .get(input.token);
  const registeredAt = existing ? existing.registered_at : at;
  const origin: DeviceOrigin = input.origin ?? "loopback";
  db.run(
    `INSERT INTO devices (token, credential_id, platform, bundle_id, registered_at, last_seen_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       credential_id = excluded.credential_id,
       platform = excluded.platform,
       bundle_id = excluded.bundle_id,
       last_seen_at = excluded.last_seen_at,
       origin = excluded.origin`,
    [input.token, input.credentialId, input.platform, input.bundleId, registeredAt, at, origin]
  );
  return {
    token: input.token,
    credentialId: input.credentialId,
    platform: input.platform,
    bundleId: input.bundleId,
    registeredAt,
    lastSeenAt: at,
    origin
  };
}

export function listDevicesForCredential(instance: Instance, credentialId: string): PushDevice[] {
  const db = getMemoryDb(instance);
  return db
    .query<PushDeviceRow, [string]>(
      "SELECT * FROM devices WHERE credential_id = ? ORDER BY registered_at ASC"
    )
    .all(credentialId)
    .map(rowToDevice);
}

// Returns every registered device on this instance. The runtime is
// single-tenant — chat sessions don't carry a per-credential owner —
// so the APNs dispatcher fans `approval_requested` out to every iOS
// install on this instance regardless of which credential registered
// it. Kept distinct from listDevicesForCredential so future multi-
// tenant work has a clear place to narrow the broadcast.
export function listAllDevices(instance: Instance): PushDevice[] {
  const db = getMemoryDb(instance);
  return db
    .query<PushDeviceRow, []>(
      "SELECT * FROM devices ORDER BY registered_at ASC"
    )
    .all()
    .map(rowToDevice);
}

export function getDevice(instance: Instance, token: string): PushDevice | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<PushDeviceRow, [string]>("SELECT * FROM devices WHERE token = ?")
    .get(token);
  return row ? rowToDevice(row) : null;
}

// Returns true when a row was deleted. Used by the DELETE /api/push/devices/:token
// endpoint and by the APNs dispatcher's 410 Unregistered handler.
export function removeDevice(instance: Instance, token: string): boolean {
  const db = getMemoryDb(instance);
  const result = db.run("DELETE FROM devices WHERE token = ?", [token]);
  return (result.changes ?? 0) > 0;
}

// Variant scoped to a credential — the HTTP DELETE handler uses this so
// a credential can only remove its own tokens. Returns true when a row
// was deleted (token existed AND belonged to credentialId), false
// otherwise (token missing, OR token belongs to a different credential).
export function removeDeviceForCredential(
  instance: Instance,
  token: string,
  credentialId: string
): boolean {
  const db = getMemoryDb(instance);
  const result = db.run(
    "DELETE FROM devices WHERE token = ? AND credential_id = ?",
    [token, credentialId]
  );
  return (result.changes ?? 0) > 0;
}
