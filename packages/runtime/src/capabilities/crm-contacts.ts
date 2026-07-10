// Read surface for the People screen: the default agent's CRM contacts,
// shaped for listing (scalar columns + the one-line description, never the
// multi-KB profile) and for the detail panel (full row incl. profile). This
// is a deliberately narrow projection of the agent database — not a general
// query surface (see ADR agent-database.md) — so web/mobile clients can
// render the directory without agent SQL reaching the wire.
import { dbQuery } from "../state/agent-data-db";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

export interface CrmContactSummary {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  category: string | null;
  phone: string | null;
  url: string | null;
  description: string | null;
  lastSpokeAt: number | null;
  updatedAt: number | null;
  isSelf: boolean;
}

export interface CrmContactDetail extends CrmContactSummary {
  profile: string | null;
}

const SELF_MARKER = "You —";

function owningAgentId(config: RuntimeConfig): string {
  const state = readState(config.instance);
  return state.agents.find((a) => a.id === "agent_default")?.id ?? state.activeAgentId ?? "agent_default";
}

function toSummary(row: Record<string, unknown>): CrmContactSummary {
  const description = (row.description as string | null) ?? null;
  return {
    id: String(row.id),
    firstName: String(row.first_name ?? ""),
    lastName: (row.last_name as string | null) ?? null,
    email: (row.email_address as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    position: (row.position as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    description,
    lastSpokeAt: (row.last_spoke_at as number | null) ?? null,
    updatedAt: (row.updated_at as number | null) ?? null,
    isSelf: description?.startsWith(SELF_MARKER) ?? false,
  };
}

const SUMMARY_COLUMNS =
  "id, first_name, last_name, email_address, company, position, category, phone, url, description, last_spoke_at, updated_at";

export function listCrmContacts(config: RuntimeConfig): { contacts: CrmContactSummary[] } {
  const rows = dbQuery(
    config.instance,
    owningAgentId(config),
    `SELECT ${SUMMARY_COLUMNS} FROM contacts ORDER BY lower(first_name), lower(COALESCE(last_name, ''))`,
  ).rows;
  return { contacts: rows.map(toSummary) };
}

export function getCrmContact(config: RuntimeConfig, id: string): CrmContactDetail | undefined {
  const rows = dbQuery(
    config.instance,
    owningAgentId(config),
    `SELECT ${SUMMARY_COLUMNS}, profile FROM contacts WHERE id = ?`,
    [id],
  ).rows;
  const row = rows[0];
  if (!row) return undefined;
  return { ...toSummary(row), profile: (row.profile as string | null) ?? null };
}
