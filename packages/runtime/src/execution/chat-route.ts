// Chat intake router (ADR chat-topics-tasks-subagents.md — Routing section,
// Resolved decisions 1 & 2).
//
// When a user posts in their Chat (a kind:"agent" session), this classifies the
// message at INTAKE — before any context loads, because the decision selects
// which transcript loads — into one of three routes:
//   - "chat"           trivial/conversational → answer in Chat as today.
//   - "new_topic"      a new substantive subject → mint a Topic, run the turn there.
//   - "existing_topic" continues an ongoing subject → run the turn in that Topic.
//
// The mechanism is a structured classifier (a small generateStructured call,
// modeled on generateChatTitleFromBlocks), NOT mid-turn agent control tools: a
// forced structured output is more reliable than hoping the agent calls a tool,
// and the decision must precede context loading. The new-vs-existing-vs-inline
// bias lives entirely in this router's own prompt.

import { generateStructured } from "../provider";
import { cosineSimilarity, getEmbeddingProvider } from "../embeddings";
import { listChatBlocks, readState, recordUsage } from "../state";
import type { AssistantTextBlock, ChatSessionRecord, RuntimeConfig, UserTextBlock } from "../types";
import { providerOverrideForRuntime } from "./effective-context";

export type RouteDecision =
  | { decision: "chat" }
  | { decision: "new_topic"; title: string }
  | { decision: "existing_topic"; topicId: string };

// A Topic the router can route into, surfaced to the model in the prompt.
interface RouteCandidate {
  topicId: string;
  title: string;
  topicSummary?: string;
}

// Pass every candidate to the model when there are at most this many topics.
// Beyond it, an embedding pre-filter narrows to the top-K most similar before
// the structured call so the prompt stays bounded.
const MAX_ROUTE_CANDIDATES = 12;

// How many of the Chat's most recent message-bearing blocks feed the
// recent-conversation context. Six covers the last few turns — enough to show
// the model the thread a follow-up continues — without bloating the prompt.
const RECENT_CONTEXT_BLOCKS = 6;

// Truncation cap for each assistant line in the recent-conversation transcript.
// User lines stay whole (they carry the routing signal); the agent's replies
// only need their gist to establish what subject was last discussed.
const RECENT_ASSISTANT_PREVIEW_CHARS = 160;

export async function routeChatMessage(
  config: RuntimeConfig,
  chatSessionId: string,
  content: string,
  options?: {
    // Block id of the message being routed itself (inserted as an echo before
    // routing under the echo-first ack). Excluded from the recent-conversation
    // section so the classifier doesn't see the message twice — once as the
    // final "User:" line and once as "Message:" — which would skew the
    // continuation signal.
    excludeBlockId?: string;
  }
): Promise<RouteDecision> {
  const state = readState(config.instance);
  const chatSession = state.chatSessions.find((item) => item.id === chatSessionId);
  if (!chatSession) return { decision: "chat" };
  const agentId = chatSession.agentId;

  const topics = state.chatSessions.filter(
    (session) =>
      session.agentId === agentId &&
      session.kind === "topic" &&
      !session.archivedAt &&
      // Headless containers (a watch job's invisible working thread) stay out
      // of ALL chrome, including the router's candidate list — a user message
      // must never be dispatched into one. See ADR task-containers-and-runs.md.
      !session.headless
  );
  const candidates = await selectCandidates(config, content, topics);
  // The Chat's recent transcript is the key follow-up signal: a question about
  // the same subject just discussed should continue that topic, not spawn a new
  // one. Best-effort — a block-read failure leaves the section empty.
  let recentConversation = "";
  try {
    recentConversation = buildRecentConversation(config, chatSessionId, options?.excludeBlockId);
  } catch {
    recentConversation = "";
  }

  const result = await generateStructured(
    config,
    {
      schemaName: "ChatRoute",
      echoTag: "chat-route",
      system: buildSystemPrompt(candidates.length > 0),
      user: buildUserPrompt(content, candidates, recentConversation),
      validator: {
        parse: (value: unknown) => coerceDecision(value, candidates, content)
      }
    },
    providerOverrideForRuntime(config)
  );
  void recordUsage(config.instance, { source: "chat-route", agentId }, result.cost).catch(() => {});
  return result.data;
}

// Pick the candidate Topics to show the model. At or below the cap, pass them
// all, most-recently-updated first — recency is a strong continuation signal,
// so the topic just discussed leads the list. Above the cap, embed the message
// + each candidate's title/summary and take the top-MAX_ROUTE_CANDIDATES by
// cosine similarity. Any embedding failure falls back to the most-recently-
// updated topics so routing never hard-fails.
export async function selectCandidates(
  config: RuntimeConfig,
  content: string,
  topics: ChatSessionRecord[]
): Promise<RouteCandidate[]> {
  const toCandidate = (session: ChatSessionRecord): RouteCandidate => ({
    topicId: session.id,
    title: session.title,
    ...(session.topicSummary ? { topicSummary: session.topicSummary } : {})
  });
  if (topics.length <= MAX_ROUTE_CANDIDATES) {
    return [...topics]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map(toCandidate);
  }
  try {
    const provider = getEmbeddingProvider(config);
    const candidateTexts = topics.map(
      (session) => `${session.title}\n${session.topicSummary ?? ""}`
    );
    const [queryVector, ...candidateVectors] = await provider.embed([content, ...candidateTexts]);
    if (!queryVector) throw new Error("missing query embedding");
    return topics
      .map((session, index) => ({
        session,
        score: cosineSimilarity(queryVector, candidateVectors[index]!)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ROUTE_CANDIDATES)
      .map((entry) => toCandidate(entry.session));
  } catch {
    return [...topics]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, MAX_ROUTE_CANDIDATES)
      .map(toCandidate);
  }
}

function buildSystemPrompt(hasCandidates: boolean): string {
  const routes = [
    "You route a user's chat message to one of these destinations.",
    "Return JSON {decision, topicId?, title?} where decision is one of:",
    '- "chat": a one-liner, greeting, or quick factual ask. Prefer this for anything trivial or conversational.',
    '- "new_topic": a genuinely new piece of work or project worth its own thread. Set title to a short subject name (2 to 7 words).'
  ];
  if (hasCandidates) {
    routes.push(
      '- "existing_topic": the message clearly extends one of the listed topics. Set topicId to that topic\'s id.',
      "A message that continues the recent conversation — a follow-up question about the same subject just discussed — should route to that topic via existing_topic; recency is a strong continuation signal.",
      "Choose existing_topic only when the message plainly continues a listed topic; otherwise prefer chat or new_topic."
    );
  } else {
    routes.push(
      "There are no existing topics, so you may only choose \"chat\" or \"new_topic\"."
    );
  }
  return routes.join(" ");
}

export function buildUserPrompt(
  content: string,
  candidates: RouteCandidate[],
  recentConversation = ""
): string {
  const lines: string[] = [];
  if (recentConversation) {
    lines.push(`Recent conversation:\n${recentConversation}`);
  }
  lines.push(`Message:\n${content}`);
  if (candidates.length > 0) {
    const list = candidates
      .map((c) => `#${c.title} (id=${c.topicId}): ${c.topicSummary ?? ""}`)
      .join("\n");
    lines.push(`Existing topics:\n${list}`);
  }
  return lines.join("\n\n");
}

// Build a compact transcript of the Chat's recent message-bearing blocks so the
// router sees the conversational thread a follow-up continues — and which topic
// was most recently discussed. A forwarded answer (a Topic result mirrored into
// Chat) is labeled with its topic so the model can tie the follow-up back to it.
export function buildRecentConversation(
  config: RuntimeConfig,
  chatSessionId: string,
  excludeBlockId?: string
): string {
  const blocks = listChatBlocks(config.instance, chatSessionId)
    .filter((b): b is UserTextBlock | AssistantTextBlock =>
      (b.kind === "user_text" || b.kind === "assistant_text") && b.id !== excludeBlockId
    )
    .slice(-RECENT_CONTEXT_BLOCKS);
  return blocks.map(transcriptLine).join("\n");
}

function transcriptLine(block: UserTextBlock | AssistantTextBlock): string {
  if (block.kind === "user_text") {
    return `User: ${block.text}`;
  }
  const text = truncate(block.text, RECENT_ASSISTANT_PREVIEW_CHARS);
  if (block.forwardedFromTopicId) {
    return `Gini [in #${block.forwardedFromTopicTitle ?? ""}]: ${text}`;
  }
  return `Gini: ${text}`;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

// Coerce an arbitrary model result into a safe RouteDecision. Anything
// unparseable or unknown becomes "chat"; an existing_topic whose topicId isn't a
// real candidate downgrades to "chat"; a new_topic with an empty title falls
// back to a content-derived stub.
function coerceDecision(
  value: unknown,
  candidates: RouteCandidate[],
  content: string
): RouteDecision {
  if (!value || typeof value !== "object") return { decision: "chat" };
  const record = value as { decision?: unknown; topicId?: unknown; title?: unknown };
  if (record.decision === "existing_topic") {
    const topicId = typeof record.topicId === "string" ? record.topicId : "";
    if (candidates.some((c) => c.topicId === topicId)) {
      return { decision: "existing_topic", topicId };
    }
    return { decision: "chat" };
  }
  if (record.decision === "new_topic") {
    const title = sanitizeRouteTitle(record.title) ?? contentTitleStub(content);
    return { decision: "new_topic", title };
  }
  return { decision: "chat" };
}

// Trim and bound a model-supplied topic title; returns undefined when empty.
function sanitizeRouteTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^["'`*_#\s.?!:;,-]+|["'`*_#\s.?!:;,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : undefined;
}

// Fallback title when the model returns new_topic with no usable title: the
// first few words of the message, so a Topic is never minted untitled.
function contentTitleStub(content: string): string {
  const words = content.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.length > 0 ? words.join(" ") : "New topic";
}
