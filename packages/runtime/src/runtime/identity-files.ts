// Runtime identity files: INSTRUCTIONS.md, SOUL.md, USER.md.
//
// Loads three optional markdown files from the instance directory and
// produces strings the system-prompt assembler can splice straight into
// the prompt. None of the files are mandatory — a missing file returns
// null and the caller falls back to defaults (for INSTRUCTIONS.md) or
// elides the block (for SOUL.md / USER.md).
//
// Trust boundary: all three files are user-controlled content that ends
// up in the system channel of every chat turn. We scan each file against
// a small set of prompt-injection patterns (ported from Hermes' context
// file scanner in agent/prompt_builder.py) before injection. A file that
// trips a pattern is replaced inline with a [BLOCKED: ...] notice; the
// gateway does not crash on a hostile file.
//
// Write path: `edit_soul` and `edit_user_profile` tool handlers route
// here. Agent-proposed edits land at `<file>.proposed`; approval renames
// the proposal over `<file>` atomically. The prompt assembler only reads
// the approved file — proposals never reach the model directly.
//
// See ADR runtime-identity-files.md for the full design.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { instanceRoot } from "../paths";
import { appendLog } from "../state/trace";
import { DEFAULT_INSTRUCTIONS_PATH, sanitizeAgentName } from "../system-prompt";
import type { Instance } from "../types";

// ---------------------------------------------------------------------------
// Path helpers. Centralized so future renames touch one place.
// ---------------------------------------------------------------------------

export function instructionsPath(instance: Instance): string {
  return join(instanceRoot(instance), "INSTRUCTIONS.md");
}

export function userProfilePath(instance: Instance): string {
  return join(instanceRoot(instance), "USER.md");
}

export function userProfileProposedPath(instance: Instance): string {
  return `${userProfilePath(instance)}.proposed`;
}

// Per-agent SOUL.md. Lives under a per-agent directory; the directory
// itself is created lazily on first write. Readers tolerate a missing
// directory and treat it as "no SOUL set".
export function agentDir(instance: Instance, agentId: string): string {
  return join(instanceRoot(instance), "agents", agentId);
}

export function soulPath(instance: Instance, agentId: string): string {
  return join(agentDir(instance, agentId), "SOUL.md");
}

export function soulProposedPath(instance: Instance, agentId: string): string {
  return `${soulPath(instance, agentId)}.proposed`;
}

// History snapshot directory next to the active file. Each successful
// write to USER.md or SOUL.md drops a copy of the file's PREVIOUS
// contents here under an ISO-8601 filename (colons replaced with dashes
// because some filesystems reject them in paths). Retention is capped at
// HISTORY_MAX_SNAPSHOTS — older entries are pruned on each write.
//
// The directory is per-file, not per-instance — keeps USER.md history
// separate from SOUL.md history and per-agent SOUL histories isolated
// from each other.
export function userProfileHistoryDir(instance: Instance): string {
  return `${userProfilePath(instance)}.history`;
}

export function soulHistoryDir(instance: Instance, agentId: string): string {
  return `${soulPath(instance, agentId)}.history`;
}

// ---------------------------------------------------------------------------
// Scaffold path. Materializes the three identity files at instance / agent
// creation so users see them on disk before they have anything specific to
// write. INSTRUCTIONS.md is seeded with the bytes of the bundled
// `src/runtime/defaults/INSTRUCTIONS.md` so a user opening the file has a
// working preamble to edit against; the seed has no header comment or
// other meta text because any byte in the file goes verbatim into the
// system prompt. USER.md stays zero-byte — no default exists for it.
// Per-agent SOUL.md is seeded with `Your name is <name>.` so a new agent
// self-identifies by its own name (see `seedAgentSoulFile`).
//
// Reads still go through the load-and-scan helpers, which treat a zero-byte
// (or whitespace-only) file as absent and fall back to defaults — so a
// zero-byte USER.md does not change prompt behavior.
//
// Filesystem errors on the user-instance write side are swallowed and
// logged through `appendLog` (a permission glitch on the instance dir
// must not crash the gateway). Missing or unreadable canonical bundle
// content, on the other hand, is unrecoverable — the runtime cannot
// scaffold against an absent baseline — and surfaces as a thrown error.
// They never overwrite an existing file.
// ---------------------------------------------------------------------------

// Touch a zero-byte file at `path` if and only if it does not already
// exist. Uses `openSync(..., "wx")` so the create is atomic against a
// concurrent writer racing the existence check (e.g. a user editing the
// file by hand during runtime startup). Returns true when this call
// actually created the file.
function touchIfMissing(path: string): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  // O_CREAT | O_EXCL: fail if the file appeared between the existsSync
  // and the open. We catch EEXIST and treat it as "someone else created
  // it" — which is the same outcome we wanted.
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    throw error;
  }
  closeSync(fd);
  return true;
}

// Create a file at `path` seeded with `content` iff it does not already
// exist. Same atomic O_CREAT|O_EXCL semantics as touchIfMissing — a
// concurrent writer that wins the race leaves their content intact and
// this call reports false. Used to seed INSTRUCTIONS.md with the bytes
// of the bundled defaults file so a fresh-install user can see what the
// defaults are and edit against them.
function writeIfMissing(path: string, content: string | Buffer): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface ScaffoldInstanceResult {
  created: string[];
}

// Materialize INSTRUCTIONS.md and USER.md at the instance root if absent.
// INSTRUCTIONS.md is seeded from the bytes of the bundled defaults file
// at `src/runtime/defaults/INSTRUCTIONS.md`; USER.md stays zero-byte.
// Never overwrites. Returns the list of paths created (possibly empty).
// Per-instance filesystem errors are caught and logged so the gateway
// keeps running on a permission glitch; a missing bundle file is
// unrecoverable and throws (the runtime cannot scaffold against a
// nonexistent baseline).
export function scaffoldInstanceIdentityFiles(instance: Instance): ScaffoldInstanceResult {
  const created: string[] = [];
  // INSTRUCTIONS.md gets seeded with the bundled default rules so the user
  // has a concrete baseline to edit against. Read the canonical file once
  // per call and copy its bytes verbatim — no re-derivation from the
  // memoized runtime constant, so the file is the single source of truth.
  // A missing bundle file at this point means the runtime is incorrectly
  // packaged; let the error propagate so the install fails loudly.
  let defaultInstructionsBytes: Buffer;
  try {
    defaultInstructionsBytes = readFileSync(DEFAULT_INSTRUCTIONS_PATH);
  } catch (error) {
    throw new Error(
      `default INSTRUCTIONS.md missing from bundle at ${DEFAULT_INSTRUCTIONS_PATH}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const instructionsTarget = instructionsPath(instance);
  try {
    if (writeIfMissing(instructionsTarget, defaultInstructionsBytes)) {
      created.push(instructionsTarget);
    }
  } catch (error) {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "INSTRUCTIONS.md",
        path: instructionsTarget,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Logging itself failed (state root unwritable etc.). Swallow —
      // scaffolding is purely opportunistic, the load path tolerates
      // missing files.
    }
  }
  // USER.md has no defaults — it's a personal profile the user fills in.
  // Zero-byte placeholder so it's discoverable on disk.
  const userTarget = userProfilePath(instance);
  try {
    if (touchIfMissing(userTarget)) created.push(userTarget);
  } catch (error) {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "USER.md",
        path: userTarget,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // See the INSTRUCTIONS.md branch above — best-effort logging only.
    }
  }
  return { created };
}

// First-line identity sentences shipped by earlier bundled defaults.
// Existing instances seeded INSTRUCTIONS.md first-write-wins, so they keep
// one of these on disk even after the bundled default changed — and that
// on-disk file overrides the bundled default at load time. The agent's
// name now lives in its SOUL.md, so the shared operating-rules file must
// not carry a name (a stale "You are Gini, a personal agent." otherwise
// bleeds into a non-default agent's self-description as "your Gini ...").
const LEGACY_INSTRUCTIONS_IDENTITY_LINES = new Set<string>([
  "You are Gini, a personal agent.",
  "You are a personal assistant running on the gini-agent framework.",
  "You are a personal agent."
]);
const CURRENT_INSTRUCTIONS_IDENTITY_LINE = "You are a personal agent running on the gini-agent framework.";

// One-time, per-boot migration: when the on-disk INSTRUCTIONS.md leads with
// a known legacy identity sentence, rewrite ONLY that first line to the
// current generic preamble and leave the rest of the file (any user edits)
// intact. Idempotent — the current line isn't in the legacy set — and
// best-effort. A user who replaced the first line with their own wording
// is left untouched. Returns true when it rewrote the file.
export function migrateInstructionsIdentityLine(instance: Instance): boolean {
  const path = instructionsPath(instance);
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const newlineIdx = raw.indexOf("\n");
  // trimEnd drops a trailing \r so a CRLF file still matches.
  const firstLine = (newlineIdx === -1 ? raw : raw.slice(0, newlineIdx)).trimEnd();
  if (!LEGACY_INSTRUCTIONS_IDENTITY_LINES.has(firstLine)) return false;
  const rest = newlineIdx === -1 ? "" : raw.slice(newlineIdx);
  try {
    writeFileSafe(path, `${CURRENT_INSTRUCTIONS_IDENTITY_LINE}${rest}`);
    return true;
  } catch (error) {
    try {
      appendLog(instance, "identity.migrate.error", {
        file: "INSTRUCTIONS.md",
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Best-effort — see scaffoldInstanceIdentityFiles.
    }
    return false;
  }
}

// sha256 hex digests of every bundled default INSTRUCTIONS.md previously
// shipped on main, plus — for each default whose first line is one of the
// legacy identity sentences above — the variant
// `migrateInstructionsIdentityLine` produces from it (first line replaced
// with CURRENT_INSTRUCTIONS_IDENTITY_LINE). The current bundled content's
// own hash is deliberately absent: a file matching the current default
// needs no rewrite.
//
// Regenerate when the bundled default changes: for each distinct content of
// src/runtime/defaults/INSTRUCTIONS.md across main history
// (`git log origin/main --format=%H -- src/runtime/defaults/INSTRUCTIONS.md`,
// then `git show <sha>:src/runtime/defaults/INSTRUCTIONS.md`), emit
// sha256-hex of the utf8 bytes; when the first line is in
// LEGACY_INSTRUCTIONS_IDENTITY_LINES, also emit sha256-hex of the content
// with that first line swapped for CURRENT_INSTRUCTIONS_IDENTITY_LINE.
// A content version introduced by a merge commit may not appear in that
// pathspec log, so also hash the current tip blob directly
// (`git cat-file -p origin/main:src/runtime/defaults/INSTRUCTIONS.md`).
// Drop the hash of the current bundled content, dedupe, sort.
const HISTORICAL_DEFAULT_INSTRUCTIONS_HASHES = new Set<string>([
  "016cdcc38a2bf933d931d72a2204e5b0ddc5afe322763ce49083457f0997b8c1",
  "047e7fcd44054c3899e087acb8482174d59ac21da261fbbfe214febbb2015cd3",
  "05aecabda22bdb9df89a88221a928ea99cf14a77f9b1f12748f73487f8e5c2de",
  "14219c3167226bc332afe917fd97064ea0e2efa2aa1ce004c8f6ec6e1e11fadb",
  "1430ef558e32d1cd399c34e538e82fb24da512684a93a8b4a350761bfe221647",
  "1a3c01d366433b3bcecc67943f6bd3666bd250f2519c85cc0e807c8fd2b25325",
  "1fa936ebd64830d83818b34e6b442a3daf970975c94ed0ff94586d9f60102359",
  "1fdc700abcb81b8cac6c996451e0ce0ff73f1c6383b2481a54b81b1438278aa1",
  "22cf12abce1f65b6e5bd38fc981f529d79e58141a8244663d76ce821790d6dda",
  "23dbb03635d0dd95ef8deb3d5e24b40eb3fff22c2653d84b529703fbf300c979",
  "2637d187459fb12aa6a90c3f1cd835b17721f9da90596cbec1d4fd9b83e64a5d",
  "284e00bc2cada20ba749c154a8fa3965c59aae71b8635a0642095b8fa8a90043",
  "292123985ff3137214d6253272b9b14113b07f911a820bfc488ee7e7c0359d6a",
  "2b10545301663e82deeb9691d27328ec1ec63a4255b58a91e65cb142908ff940",
  "2c85923ca2d3c8017ca51644588a37dab6a36f23b6bd456d573772b299759128",
  "2d71f9b9bfb8f9ee47df492369545fc5bf37b64b50eae76088bf1a6f731fd840",
  "3edee3cd2db7aa8bb0692b51a1b198b5842ab4fddb73a9a461833006e70f1428",
  "4218e1fb225d3eefdd7ba8591317af483e60cc45a58301649131b0d07a9f88b4",
  "5034605999a947426e87bf882fa16989aa075ecb5dd7d9346694786c02c913be",
  "55686a8de9253869eaf09278fa858890535a9347854b3a938fb77831f4385a37",
  "580b678bc3685f09bc8b6dce3a3ce250508f6bdc70ac18cf4ccdc42b25fa9274",
  "588f6b120a1d877779695fcddefd46a0417b5609ef7e241ca14caac47fdb519b",
  "5a5d8d1e96ba68b2f87cb8696e5b43402ba4428800b2f5f47655394e01f3a18a",
  "6298dbafa1d222945cad9f0ec0136acc8219f207da394691dcd2847d0cf3c3de",
  "629afc94728b8ad2d144bc7d1e88f492de2a2571eddfdec778fbfc9fb05733ff",
  "673e06e729d76bdd9de79564478a410e311657a3db20ba010dae4b1c3dd90150",
  "6f0d18222be3e92e514c8627a21f4f7374bb9c98bcbcf0686c761bfe0864473c",
  "71f177d9bba7d5cd29c12c0eb0f5a56721a7021418b4b84fe22dcc950cf84979",
  "738d1779b069ad0b82d188faedcf57121d3f79b55de72218f387b396aa0976bf",
  "7fa65d0ffc78d2e1351f8e0e962ac8582688f407ec36a59a184ea138eda0e285",
  "81cbd07859ddd42a31dc5ba580e4fd32bf1e1e81cfa8239f3d02e780a5c46c1d",
  "83ce3943888247f370514aeb861f582c7c2a7c9c41b7376ae598cd42dda4c4b2",
  "861f8f1c18bdf94c0ac88675962efab43c3cc77c2a0a25e111230a9127c10c01",
  "8956033161bfcea520b44bc3d9b48f15505a85c6fc7de6438aa640d3eb497f80",
  "8b5ac3ead1ed75c6d587878eaff6758a6633bfc305d12cd92b8e9883a905cc26",
  "8efff9dfcc8993e0a748442cad98c37abd53252de84f826cd9f71e8e88700f83",
  "91bff143c82fe59725801aca89b9058df69e2b2754615d1b55af3edc4bb0441d",
  "9e39c4ba3eac94d69481fe642eef9291b3bd8a55ccc34401a99c6d0547c1b7c4",
  "a16fd01605c1038260b8ac3f1907b2d7a4afd329526db8747da38838fab7291f",
  "a23677a293faa1b4be7ecb11a23d441c4e2dbc092318a2b37934c69a3e6fdb1a",
  "a80bfe7c714a4048fd82a7eb59ec26c84fae766a00ccf407fd17b54038effd9e",
  "b7f6fd68bfd77af01d99a51a0f063286de7f0eecfedfad6872a39ea684fe7c11",
  "b8671923cc45e8aaed6eff41299db173f6363bfe4f226f34a18b19be9e47c836",
  "bf6fbb6c4dfedc0b264f07cb95bfdcaf4b19739e03da2e998213b74b31ebeee0",
  "cf56032e4ad28a2ba4744747f5c537e71d25004f020b5c18c15b4c67f69d515b",
  "d74e287c6174b6f5a03febb7ea692e998704abdb6f882bc692705728f501a746",
  "d81840ab119a479811974ce06ecfdd0bc343ab37a10bd1b94de99d1eaa1f7a74",
  "dedc9f3746d315698174b0d0f9af9ecd0e206f07bce99044bd4f2219c0699c82",
  "e6b429bc417ada29d609f6cbc2c66914280798619b5c7b364290dc40e14f1b82",
  "e74c1a398a061cc9db5fe92c0cadb0862a499742a9260db6ce51aabd667bef39",
  "e7e8dbf433b72b4259219a25539e04ba3873864856e07e43e092c914e8fbb809",
  "f174c8636952bbaff8b26f6ffeab08f1f76abb46cebcf668dec95fc88e24f5ae",
  "f3bf7709632500f127862a6b4bdc4ffa2f512ff767fd97b5e07fe6ab86f8e3da",
  "fab01269576b80abde4b8de742c3bc1afac7bd71c51f4fdb4e180f615953333d",
  "fe1d4847d92a520406e4ea05524ac62b7c267efba8d93c4411eda72b75daa4c1",
  "fe7f9f4967dc44f1bebeafcd92ee0fd2735404086d9683d61386bfa1d533535f"
]);

// Per-boot reseed of an unedited default INSTRUCTIONS.md. install() seeds
// each instance's INSTRUCTIONS.md with the bundled default bytes and the
// on-disk copy shadows the bundled file from then on (see ADR
// runtime-identity-files.md, "Drift cost") — so without intervention an
// instance created before a defaults change never receives it. This closes
// the gap for the common case (the user never touched the file) while
// guaranteeing a user-edited file is NEVER clobbered: the on-disk bytes are
// hashed and overwritten ONLY when the digest matches a known
// previously-shipped default. Any user edit changes the digest, so it can
// never match. A file already byte-identical to the current default is left
// alone (idempotent — no spurious rewrite or mtime churn). Best-effort:
// filesystem errors log via `appendLog` and never crash boot. Returns true
// when it rewrote the file.
export function reseedDefaultInstructions(instance: Instance): boolean {
  const path = instructionsPath(instance);
  if (!existsSync(path)) return false;
  let currentDefault: Buffer;
  try {
    currentDefault = readFileSync(DEFAULT_INSTRUCTIONS_PATH);
  } catch {
    // Missing bundle file. scaffoldInstanceIdentityFiles already surfaces
    // a packaging error loudly at install; the reseed stays quiet.
    return false;
  }
  let onDisk: Buffer;
  try {
    onDisk = readFileSync(path);
  } catch {
    return false;
  }
  if (onDisk.equals(currentDefault)) return false;
  const digest = createHash("sha256").update(onDisk).digest("hex");
  if (!HISTORICAL_DEFAULT_INSTRUCTIONS_HASHES.has(digest)) return false;
  try {
    writeFileSafe(path, currentDefault.toString("utf8"));
    return true;
  } catch (error) {
    try {
      appendLog(instance, "identity.reseed.error", {
        file: "INSTRUCTIONS.md",
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Best-effort — see scaffoldInstanceIdentityFiles.
    }
    return false;
  }
}

export interface ScaffoldAgentResult {
  created: string | null;
}

// Seed agents/<agentId>/SOUL.md with `Your name is <name>.` so a freshly
// created agent self-identifies by its own name (INSTRUCTIONS.md is
// generic — it carries no name). The name lives in SOUL.md, the per-agent
// "about the agent" file, so it flows through the same load→scan→budget
// pipeline as any other persona content. See ADR runtime-identity-files.md.
//
// Guards:
//   - No-op when the name sanitizes to empty (never write "Your name is .").
//   - NEVER clobber an existing SOUL — only seeds when the file is absent
//     or empty/whitespace-only (e.g. the legacy zero-byte scaffold). A
//     user/agent-authored body is left untouched.
//
// Best-effort: a per-instance filesystem error is swallowed and logged
// via `appendLog`; the load path tolerates a missing SOUL. Returns the
// seeded path or null (already populated, empty name, or write failed).
//
// The only callers are `createAgent` (a brand-new agent — no SOUL author
// can exist yet) and the `install()` boot loop (runs before the gateway
// serves traffic, so no `edit_soul` write is in flight). Even so, the
// absent-file path creates atomically (O_CREAT|O_EXCL) so a racing writer
// is never clobbered, and an unreadable existing file is left untouched
// rather than treated as empty.
export function seedAgentSoulFile(instance: Instance, agentId: string, name: string | undefined): ScaffoldAgentResult {
  const clean = sanitizeAgentName(name);
  if (!clean) return { created: null };
  const path = soulPath(instance, agentId);
  const seed = `Your name is ${clean}.`;
  const logError = (error: unknown): void => {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "SOUL.md",
        agentId,
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // See scaffoldInstanceIdentityFiles — best-effort logging only.
    }
  };
  if (!existsSync(path)) {
    // Absent: atomic create. If a writer wins the race the file now exists
    // with their content (EEXIST) — leave it rather than clobber.
    try {
      ensureDir(dirname(path));
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, seed);
      } finally {
        closeSync(fd);
      }
      return { created: path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return { created: null };
      logError(error);
      return { created: null };
    }
  }
  // File exists: only reseed a genuinely empty/whitespace body (the legacy
  // zero-byte scaffold). An unreadable file is treated as "has content" —
  // never overwrite a SOUL we cannot inspect.
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { created: null };
  }
  if (body.trim().length > 0) return { created: null };
  try {
    writeFileSync(path, seed);
    return { created: path };
  } catch (error) {
    logError(error);
    return { created: null };
  }
}

// Keep the seeded SOUL.md name line in sync when an agent is renamed. The
// name lives both in `AgentRecord.name` (the authoritative label) and in
// the per-agent SOUL.md seed line `Your name is <name>.`. A rename rewrites
// the SOUL line ONLY when the file is EXACTLY the untouched seed for the
// old name — the same never-clobber rule `seedAgentSoulFile` enforces. A
// SOUL the user/agent has customized (any other content) is left alone; the
// model/operator owns updating the name reference inside a real persona.
//
// Best-effort: an absent file, an empty new name, or a customized body all
// return false (nothing rewritten); a filesystem error is swallowed and
// logged via `appendLog`. Returns true only when it rewrote the seed line.
export function renameSeededSoulName(
  instance: Instance,
  agentId: string,
  oldName: string | undefined,
  newName: string | undefined
): boolean {
  const path = soulPath(instance, agentId);
  if (!existsSync(path)) return false;
  const cleanOld = sanitizeAgentName(oldName);
  const cleanNew = sanitizeAgentName(newName);
  if (!cleanNew) return false;
  const logError = (error: unknown): void => {
    try {
      appendLog(instance, "identity.rename.error", {
        file: "SOUL.md",
        agentId,
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Best-effort — see seedAgentSoulFile.
    }
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    logError(error);
    return false;
  }
  if (raw.trim() !== `Your name is ${cleanOld}.`) return false;
  try {
    writeFileSafe(path, `Your name is ${cleanNew}.`);
    return true;
  } catch (error) {
    logError(error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Injection scan. Ported from Hermes' agent/prompt_builder.py.
// ---------------------------------------------------------------------------

interface ThreatPattern {
  pattern: RegExp;
  id: string;
}

// Each entry pairs a regex with a stable id we surface in the BLOCKED
// notice and the audit/trace log. The patterns deliberately mirror Hermes
// so behavior stays comparable; new patterns belong in this list rather
// than in scattered call sites.
const CONTEXT_THREAT_PATTERNS: ThreatPattern[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection" },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div" },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: "read_secrets" }
];

// Invisible Unicode characters that attackers use to hide payloads from
// human reviewers. We block on presence — there is no legitimate reason
// for any of these to appear in user-curated markdown.
const CONTEXT_INVISIBLE_CHARS = new Set<string>([
  "​", "‌", "‍", "⁠", "﻿",
  "‪", "‫", "‬", "‭", "‮"
]);

export interface InjectionScanResult {
  ok: boolean;
  sanitized: string;
  findings: string[];
}

// Scan `content` for known threats. When clean, returns the original
// content with `ok: true`. When dirty, returns a single-line BLOCKED
// notice the caller can drop straight into the prompt, plus a findings
// list the caller can record in audit / trace.
export function scanForInjection(content: string, filename: string): InjectionScanResult {
  const findings: string[] = [];
  for (const char of CONTEXT_INVISIBLE_CHARS) {
    if (content.includes(char)) {
      const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      findings.push(`invisible unicode U+${code}`);
    }
  }
  for (const { pattern, id } of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(content)) findings.push(id);
  }
  if (findings.length === 0) {
    return { ok: true, sanitized: content, findings: [] };
  }
  return {
    ok: false,
    sanitized: `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`,
    findings
  };
}

// ---------------------------------------------------------------------------
// Read path. Each loader returns either the scanned content, a BLOCKED
// notice, or null when the file is absent.
// ---------------------------------------------------------------------------

interface LoadOptions {
  // Optional callback invoked when the scan finds threats. Used by the
  // call sites to record an appendTrace warning. Failures inside the
  // hook never propagate — the loader stays best-effort.
  onBlocked?: (filename: string, findings: string[]) => void;
}

function loadAndScan(path: string, displayName: string, opts: LoadOptions | undefined): string | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Unreadable file (permissions, race with concurrent write) — treat
    // as absent. The gateway must not crash on a transient filesystem
    // error in a user-editable file.
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const result = scanForInjection(trimmed, displayName);
  if (!result.ok && opts?.onBlocked) {
    try {
      opts.onBlocked(displayName, result.findings);
    } catch {
      // Hook errors must never break the load.
    }
  }
  return result.sanitized;
}

// INSTRUCTIONS.md — instance-scoped operating rules. The system-prompt
// assembler falls back to `getDefaultGiniInstructions()` (which reads the
// bundled `src/runtime/defaults/INSTRUCTIONS.md`) when this returns null.
export function loadInstructions(instance: Instance, opts?: LoadOptions): string | null {
  return loadAndScan(instructionsPath(instance), "INSTRUCTIONS.md", opts);
}

// SOUL.md — per-agent persona. Returns null when no active agent or no
// file is present; callers elide the block in that case.
export function loadSoul(instance: Instance, agentId: string | undefined, opts?: LoadOptions): string | null {
  if (!agentId) return null;
  return loadAndScan(soulPath(instance, agentId), "SOUL.md", opts);
}

// USER.md — instance-scoped user profile.
export function loadUserProfile(instance: Instance, opts?: LoadOptions): string | null {
  return loadAndScan(userProfilePath(instance), "USER.md", opts);
}

// ---------------------------------------------------------------------------
// Write path. Used by edit_soul / edit_user_profile and by the approval
// API to promote a proposal to the approved file.
// ---------------------------------------------------------------------------

// In-process per-path async mutex for identity-file edits. The edit_soul /
// edit_user_profile handlers read the current body (loadSoul/loadUserProfile),
// compute a new body (append concatenation, section removal), then write —
// a read-modify-write that is NOT atomic on its own. Concurrent sibling
// subagents (which now overlap, since contiguous spawn_subagent batches
// dispatch under Promise.all) can both read the same body and last-write-wins,
// silently dropping one append. USER.md is per-instance and SOUL.md is shared
// by same-parent siblings (they inherit the parent's agentId), so the
// contention is real. A single gateway process owns every task in an instance
// (subagents run in-process via fire-and-forget runTask), so an in-process
// mutex keyed by the absolute file path is sufficient — there is no
// cross-process writer to coordinate with.
//
// The lock is a promise chain per path: each caller awaits the previous
// holder (success or failure) before running, and the tail entry is pruned
// once no one is queued behind it so the map stays bounded.
const identityFileLocks = new Map<string, Promise<void>>();

export async function withIdentityFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = identityFileLocks.get(path) ?? Promise.resolve();
  // Run fn after the previous holder settles, regardless of how it settled.
  const result = prev.then(fn, fn);
  const guard = result.then(() => undefined, () => undefined);
  identityFileLocks.set(path, guard);
  try {
    return await result;
  } finally {
    // Drop the map entry only if we're still the tail (nobody chained after
    // us), so a long-lived instance doesn't accumulate one entry per path.
    if (identityFileLocks.get(path) === guard) identityFileLocks.delete(path);
  }
}

export type IdentityFileStatus = "proposed" | "approved";

export interface IdentityFileWriteResult {
  // Final path written. For status: "proposed" this is `<file>.proposed`;
  // for status: "approved" this is `<file>`.
  path: string;
  status: IdentityFileStatus;
  // Whether the write blew through the injection scan. We always write —
  // the proposed-file gate is what keeps a hostile body out of the
  // prompt — but the caller can record the result for audit visibility.
  scanFindings: string[];
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeFileSafe(path: string, content: string): void {
  ensureDir(dirname(path));
  // Write through a sibling temp file so a crash mid-write cannot leave
  // a half-written file in place of either the proposed or approved
  // target. Matches the pattern state/store.ts uses for state.json.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// History snapshots. Every successful write to an approved identity file
// (USER.md or SOUL.md) copies the file's PREVIOUS body to a per-file
// `<file>.history/` directory under an ISO-8601 filename. Lets the user
// recover from an over-eager edit (model collapsed a section, dropped a
// fact) without manual backups. See ADR runtime-identity-files.md.
//
// Filename format: `YYYY-MM-DDTHH-MM-SS.sssZ.md`. Colons aren't legal in
// some filesystems, so we replace them with dashes; the ISO timestamp
// stays sortable as a string regardless.
//
// Retention cap is enforced after each snapshot: directory entries are
// sorted by mtime descending and anything beyond HISTORY_MAX_SNAPSHOTS is
// deleted. Set deliberately high enough (50) that a typical year of edits
// doesn't lose history, but bounded enough that an accidental loop
// doesn't fill the disk.
//
// Snapshot creation is best-effort: a filesystem failure (permissions,
// disk full) is logged via `appendLog` and the write proceeds. The
// snapshot exists for human recovery, not for system correctness.
// ---------------------------------------------------------------------------

export const HISTORY_MAX_SNAPSHOTS = 50;

// Render an ISO timestamp into a path-safe filename. Replace the colons
// (illegal in some filesystems) and keep the rest of the ISO string
// intact so the names sort lexicographically by recency. If the base
// name (sans suffix) collides with an existing entry — two writes in the
// same millisecond — append a small ascending suffix so each snapshot is
// distinct on disk.
function snapshotFilename(historyDir: string, at: Date): string {
  const base = at.toISOString().replace(/:/g, "-");
  let candidate = `${base}.md`;
  let suffix = 0;
  while (existsSync(join(historyDir, candidate))) {
    suffix += 1;
    candidate = `${base}-${suffix}.md`;
  }
  return candidate;
}

// Drop a copy of `sourcePath`'s current contents into `historyDir` under
// an ISO-named filename. No-op when the source file does not exist (first
// write — nothing to snapshot). Prunes the directory back to
// HISTORY_MAX_SNAPSHOTS entries after a successful copy.
//
// Returns the snapshot path on success, or `null` when no snapshot was
// taken (source missing, or the copy/prune step failed). Failures audit
// via `appendLog` and never throw — the write path must not break on a
// snapshot error.
function snapshotIdentityFile(
  instance: Instance,
  sourcePath: string,
  historyDir: string,
  displayName: string
): string | null {
  if (!existsSync(sourcePath)) return null;
  try {
    ensureDir(historyDir);
    // Use a per-process suffix on the tmp name so two writes landing in
    // the same millisecond don't fight for the same path. The final
    // filename is the ISO timestamp (with a distinguishing suffix when
    // names collide); rename is atomic.
    const at = new Date();
    const targetPath = join(historyDir, snapshotFilename(historyDir, at));
    const tmp = `${targetPath}.tmp-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
    copyFileSync(sourcePath, tmp);
    renameSync(tmp, targetPath);
    pruneSnapshotHistory(historyDir);
    return targetPath;
  } catch (error) {
    try {
      appendLog(instance, "identity.history.snapshot.error", {
        file: displayName,
        source: sourcePath,
        historyDir,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Logging itself failed (state root unwritable, etc.). Swallow —
      // the snapshot is purely a recovery convenience.
    }
    return null;
  }
}

// Drop oldest snapshots until the directory holds at most
// HISTORY_MAX_SNAPSHOTS entries. Sort by mtime descending so the newest
// are retained when ISO names collide (sub-millisecond writes can produce
// duplicate filenames; mtime breaks the tie).
function pruneSnapshotHistory(historyDir: string): void {
  if (!existsSync(historyDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(historyDir);
  } catch {
    return;
  }
  // Filter to .md files so an accidental sibling artifact (a half-
  // written tmp, a stray editor swap file) doesn't get pruned alongside
  // legitimate snapshots.
  const snapshots = entries.filter((name) => name.endsWith(".md"));
  if (snapshots.length <= HISTORY_MAX_SNAPSHOTS) return;
  const annotated: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of snapshots) {
    const path = join(historyDir, name);
    try {
      annotated.push({ name, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // Stat failure — skip; another sweep will pick it up next time.
    }
  }
  annotated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = annotated.slice(HISTORY_MAX_SNAPSHOTS);
  for (const entry of toDelete) {
    try {
      unlinkSync(join(historyDir, entry.name));
    } catch {
      // Permission glitch or race with another writer. Leave the file;
      // the next sweep will retry.
    }
  }
}

// List snapshots for a USER.md or SOUL.md history directory, newest
// first. Returns an empty array when the directory doesn't exist or is
// empty. Each entry is the bare filename (no path) so callers can
// pretty-print as `<file>.history/<name>` and pass the name back into
// `restoreUserProfileFromHistory` / `restoreSoulFromHistory`.
export interface SnapshotEntry {
  name: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export function listUserProfileHistory(instance: Instance): SnapshotEntry[] {
  return listHistoryEntries(userProfileHistoryDir(instance));
}

export function listSoulHistory(instance: Instance, agentId: string): SnapshotEntry[] {
  return listHistoryEntries(soulHistoryDir(instance, agentId));
}

function listHistoryEntries(historyDir: string): SnapshotEntry[] {
  if (!existsSync(historyDir)) return [];
  let names: string[];
  try {
    names = readdirSync(historyDir);
  } catch {
    return [];
  }
  const entries: SnapshotEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = join(historyDir, name);
    try {
      const stat = statSync(path);
      entries.push({ name, path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // Stat failure — skip silently; the entry will reappear next call
      // if the filesystem recovers.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

// Restore a USER.md or SOUL.md from a named snapshot. The pre-restore
// contents are snapshotted first so the rollback is itself reversible.
// Returns the restored body on success, or null when the snapshot does
// not exist. Throws on filesystem failure during the restore write
// itself — at that point the rollback was requested explicitly and the
// caller wants to know.
export type RestoreResult =
  | { ok: true; restoredBytes: number; from: string; preRestoreSnapshot: string | null }
  | { ok: false; reason: "no snapshot" | "no source" };

export function restoreUserProfileFromHistory(
  instance: Instance,
  snapshotName: string
): RestoreResult {
  return restoreIdentityFromHistory(
    instance,
    snapshotName,
    userProfilePath(instance),
    userProfileHistoryDir(instance),
    "USER.md"
  );
}

export function restoreSoulFromHistory(
  instance: Instance,
  agentId: string,
  snapshotName: string
): RestoreResult {
  return restoreIdentityFromHistory(
    instance,
    snapshotName,
    soulPath(instance, agentId),
    soulHistoryDir(instance, agentId),
    "SOUL.md"
  );
}

function restoreIdentityFromHistory(
  instance: Instance,
  snapshotName: string,
  approvedPath: string,
  historyDir: string,
  displayName: string
): RestoreResult {
  // Defense: don't accept a snapshotName that escapes the history dir.
  // The CLI / API caller hands us this value; treat it as untrusted.
  const safeName = basename(snapshotName);
  if (safeName !== snapshotName || safeName.length === 0 || !safeName.endsWith(".md")) {
    return { ok: false, reason: "no snapshot" };
  }
  const snapshotPath = join(historyDir, safeName);
  if (!existsSync(snapshotPath)) return { ok: false, reason: "no snapshot" };
  let body: string;
  try {
    body = readFileSync(snapshotPath, "utf8");
  } catch {
    return { ok: false, reason: "no snapshot" };
  }
  // Snapshot the pre-restore body so the restore is itself reversible.
  // Best-effort — see snapshotIdentityFile.
  const preRestoreSnapshot = snapshotIdentityFile(instance, approvedPath, historyDir, displayName);
  writeFileSafe(approvedPath, body);
  return {
    ok: true,
    restoredBytes: Buffer.byteLength(body, "utf8"),
    from: snapshotPath,
    preRestoreSnapshot
  };
}

function writeIdentityFile(
  instance: Instance,
  targetApproved: string,
  targetProposed: string,
  historyDir: string,
  content: string,
  status: IdentityFileStatus,
  displayName: string
): IdentityFileWriteResult {
  const scan = scanForInjection(content, displayName);
  const path = status === "approved" ? targetApproved : targetProposed;
  // Snapshot the previous approved body before overwriting. Only meaningful
  // when we're writing the approved path — proposals aren't part of the
  // canonical history (they may never be approved). First write is a no-op
  // because the file doesn't exist yet.
  if (status === "approved") {
    snapshotIdentityFile(instance, targetApproved, historyDir, displayName);
  }
  writeFileSafe(path, content);
  return { path, status, scanFindings: scan.findings };
}

export function writeSoul(
  instance: Instance,
  agentId: string,
  content: string,
  status: IdentityFileStatus
): IdentityFileWriteResult {
  return writeIdentityFile(
    instance,
    soulPath(instance, agentId),
    soulProposedPath(instance, agentId),
    soulHistoryDir(instance, agentId),
    content,
    status,
    "SOUL.md"
  );
}

export function writeUserProfile(
  instance: Instance,
  content: string,
  status: IdentityFileStatus
): IdentityFileWriteResult {
  return writeIdentityFile(
    instance,
    userProfilePath(instance),
    userProfileProposedPath(instance),
    userProfileHistoryDir(instance),
    content,
    status,
    "USER.md"
  );
}

// Promote a proposed file over the approved file in one atomic step.
// Returns true when a proposal existed and was promoted; false when no
// proposal was found (no-op).
export function approveSoul(instance: Instance, agentId: string): boolean {
  return promote(
    instance,
    soulProposedPath(instance, agentId),
    soulPath(instance, agentId),
    soulHistoryDir(instance, agentId),
    "SOUL.md"
  );
}

export function approveUserProfile(instance: Instance): boolean {
  return promote(
    instance,
    userProfileProposedPath(instance),
    userProfilePath(instance),
    userProfileHistoryDir(instance),
    "USER.md"
  );
}

function promote(
  instance: Instance,
  proposedPath: string,
  approvedPath: string,
  historyDir: string,
  displayName: string
): boolean {
  if (!existsSync(proposedPath)) return false;
  ensureDir(dirname(approvedPath));
  // Snapshot the pre-promotion approved body so the user can rollback
  // out of an approved-but-regretted edit. First approval is a no-op
  // because the approved file doesn't exist yet.
  snapshotIdentityFile(instance, approvedPath, historyDir, displayName);
  renameSync(proposedPath, approvedPath);
  return true;
}

// ---------------------------------------------------------------------------
// Append-with-dedupe. Belt-and-suspenders: when the model picks
// `action: "append"` and re-emits content that already lives in the
// existing body (a known model overshoot — the dispatch surfaces the
// current file to the prompt every turn but weaker models still
// re-include it), the storage layer drops the duplicates so USER.md and
// SOUL.md stay clean.
//
// Comparison unit is the trimmed line. We split both sides on newlines,
// drop empty-after-trim lines from the to-append side, and keep only
// to-append lines whose trimmed form does not appear verbatim (trimmed)
// anywhere in `existing`. The split deliberately uses individual lines
// rather than paragraph blocks because the most common duplicate pattern
// the model produces is "append the same paragraph again" — line-level
// dedupe handles that AND also catches partial overlaps (existing has
// lines A,B,C; model appends A,B,C,D → only D lands).
//
// Returns the residual content (joined with `\n`) and a boolean flag.
// When the residual is empty, the caller should no-op the write.
// ---------------------------------------------------------------------------

export interface AppendDedupeResult {
  // Lines from `toAppend` that were not already present in `existing`.
  // Joined with `\n`. Empty string when everything was a duplicate.
  residual: string;
  // Convenience flag: true iff `residual` is empty (after trim).
  // Callers branch on this to suppress the write entirely.
  empty: boolean;
  // Number of lines from the input that were dropped as duplicates.
  // Surfaced so the dispatch layer can audit/trace the no-op detail.
  droppedLineCount: number;
}

export function dedupeAppendLines(existing: string, toAppend: string): AppendDedupeResult {
  // Build a set of trimmed lines from the existing body. Trimming each
  // line lets us match against a re-emit that adds different leading
  // whitespace. Case-sensitive (deliberate — `Name: Alex` should not
  // suppress `name: alex`; different facts).
  const existingSet = new Set<string>();
  for (const line of existing.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) existingSet.add(trimmed);
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of toAppend.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    // Drop a wholly empty line only if it's a duplicate-by-design (the
    // line separator between the existing body and the appended body).
    // Otherwise blank lines inside the appended body are preserved so a
    // multi-paragraph append stays readable.
    if (trimmed.length === 0) {
      kept.push(line);
      continue;
    }
    if (existingSet.has(trimmed)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
    // Also add to the set so a within-batch duplicate (model emits the
    // same line twice in one append) drops the second copy.
    existingSet.add(trimmed);
  }
  // Strip any leading/trailing blank lines from the residual — they only
  // existed as separators between content that's now gone.
  const residual = kept.join("\n").replace(/^\s*\n|\n\s*$/g, "");
  return {
    residual,
    empty: residual.trim().length === 0,
    droppedLineCount: dropped
  };
}

// ---------------------------------------------------------------------------
// Remove path. Drop a paragraph (block delimited by blank lines) that
// contains a substring from the approved file body. Writes the result
// through the same propose/approve gate as `writeSoul` / `writeUserProfile`,
// so a remove never reaches the prompt until the user approves it.
// ---------------------------------------------------------------------------

// Discriminated success/failure result. On success the caller gets the
// usual write result (path + status + scanFindings); on failure the
// reason is enumerated so the dispatch layer can surface a clean message
// to the model instead of guessing at why nothing changed.
export type IdentityFileRemoveResult =
  | ({ ok: true } & IdentityFileWriteResult)
  | { ok: false; reason: "no source" | "no match" };

// Split the body on blank lines, drop the first paragraph that contains
// the needle, and rejoin. The needle match is a plain substring check
// (no regex) so callers don't have to escape user input. A "paragraph"
// is one or more non-blank lines bounded by blank lines or the file
// edges — the same unit the `append` action separates with `\n\n`.
function dropParagraphContaining(body: string, needle: string): { changed: boolean; result: string } {
  if (needle.length === 0) return { changed: false, result: body };
  // Normalize line endings so we can scan paragraph blocks without
  // worrying about CRLF mixed input from a user edit on Windows.
  const normalized = body.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/);
  let dropped = false;
  const kept: string[] = [];
  for (const para of paragraphs) {
    if (!dropped && para.includes(needle)) {
      dropped = true;
      continue;
    }
    kept.push(para);
  }
  if (!dropped) return { changed: false, result: body };
  return { changed: true, result: kept.join("\n\n").trim() };
}

function removeIdentityFileSection(
  instance: Instance,
  approvedPath: string,
  proposedPath: string,
  historyDir: string,
  needle: string,
  status: IdentityFileStatus,
  displayName: string
): IdentityFileRemoveResult {
  if (!existsSync(approvedPath)) {
    return { ok: false, reason: "no source" };
  }
  let raw: string;
  try {
    raw = readFileSync(approvedPath, "utf8");
  } catch {
    // Treat an unreadable approved file the same as a missing one. The
    // gateway must not crash on a transient filesystem error.
    return { ok: false, reason: "no source" };
  }
  const { changed, result } = dropParagraphContaining(raw, needle);
  if (!changed) {
    return { ok: false, reason: "no match" };
  }
  const scan = scanForInjection(result, displayName);
  const targetPath = status === "approved" ? approvedPath : proposedPath;
  // Snapshot the pre-remove approved body when this is going to land at
  // the approved path. Proposals don't snapshot (the approved file isn't
  // being touched yet).
  if (status === "approved") {
    snapshotIdentityFile(instance, approvedPath, historyDir, displayName);
  }
  writeFileSafe(targetPath, result);
  return { ok: true, path: targetPath, status, scanFindings: scan.findings };
}

export function removeSoulSection(
  instance: Instance,
  agentId: string,
  needle: string,
  status: IdentityFileStatus
): IdentityFileRemoveResult {
  return removeIdentityFileSection(
    instance,
    soulPath(instance, agentId),
    soulProposedPath(instance, agentId),
    soulHistoryDir(instance, agentId),
    needle,
    status,
    "SOUL.md"
  );
}

export function removeUserProfileSection(
  instance: Instance,
  needle: string,
  status: IdentityFileStatus
): IdentityFileRemoveResult {
  return removeIdentityFileSection(
    instance,
    userProfilePath(instance),
    userProfileProposedPath(instance),
    userProfileHistoryDir(instance),
    needle,
    status,
    "USER.md"
  );
}

// Preview a remove against the approved USER.md without writing. Used by
// the dispatch layer to decide whether a hostile residue body should
// route through the propose-gate instead of auto-approving. Mirrors the
// success/failure shape of removeUserProfileSection but never touches
// disk.
export function previewRemoveUserProfileSection(
  instance: Instance,
  needle: string
):
  | { ok: true; scanFindings: string[]; nextBody: string }
  | { ok: false; reason: "no source" | "no match" } {
  const approvedPath = userProfilePath(instance);
  if (!existsSync(approvedPath)) return { ok: false, reason: "no source" };
  let raw: string;
  try {
    raw = readFileSync(approvedPath, "utf8");
  } catch {
    return { ok: false, reason: "no source" };
  }
  const { changed, result } = dropParagraphContaining(raw, needle);
  if (!changed) return { ok: false, reason: "no match" };
  const scan = scanForInjection(result, "USER.md");
  return { ok: true, scanFindings: scan.findings, nextBody: result };
}

// Preview a remove against the active agent's SOUL.md without writing.
// Same role as previewRemoveUserProfileSection: lets the dispatch layer
// route a hostile residue body through the propose-gate instead of
// auto-approving. Never touches disk.
export function previewRemoveSoulSection(
  instance: Instance,
  agentId: string,
  needle: string
):
  | { ok: true; scanFindings: string[]; nextBody: string }
  | { ok: false; reason: "no source" | "no match" } {
  const approvedPath = soulPath(instance, agentId);
  if (!existsSync(approvedPath)) return { ok: false, reason: "no source" };
  let raw: string;
  try {
    raw = readFileSync(approvedPath, "utf8");
  } catch {
    return { ok: false, reason: "no source" };
  }
  const { changed, result } = dropParagraphContaining(raw, needle);
  if (!changed) return { ok: false, reason: "no match" };
  const scan = scanForInjection(result, "SOUL.md");
  return { ok: true, scanFindings: scan.findings, nextBody: result };
}

export const __testing = { HISTORICAL_DEFAULT_INSTRUCTIONS_HASHES };
