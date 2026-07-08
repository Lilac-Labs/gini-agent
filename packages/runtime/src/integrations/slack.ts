// Slack Web API client used by the messaging bridge runtime.
//
// We talk to slack.com/api directly over fetch — no SDK dependency,
// matching the local-first shape of the Telegram and Discord clients.
// Outbound calls are short request/response (authTest, postMessage,
// addReaction) authenticated with the bot token (xoxb-). Inbound does
// NOT go through this client: Slack's non-Marketplace rate limits cap
// conversations.history at ~1 request/minute, so REST polling is
// unusable — the bridge receives events over a Socket Mode WebSocket
// instead (see `./slack-socket.ts`, which authenticates with the
// separate app-level xapp- token).

const SLACK_API_BASE = "https://slack.com/api";

// Slack caps chat.postMessage `text` at 40,000 characters. We truncate
// on the client so callers don't have to pre-check — the cap is
// unlikely to bite for chat-task summaries, but a long transcript
// would otherwise fail the whole send with msg_too_long.
const TEXT_LIMIT = 40_000;

// auth.test response fields the bridge consumes: the bot's own user id
// (used to drop self-authored inbound events) and the human-readable
// handle + workspace for the health-check message.
export interface SlackAuthTestResult {
  userId: string;
  user: string;
  teamId: string;
  team: string;
}

export interface SlackPostMessageResult {
  channel: string;
  ts: string;
}

// Options bag for the outbound send. `threadTs` is the thread ROOT ts
// the reply lands under — Slack forks a broken second thread if a
// caller passes a reply's own ts here, which is why every call site
// threads `session.source.threadTs` (never lastInboundMessageId).
// `signal` lets the supervisor's stopAll cancel a hung POST instead of
// waiting it out.
export interface SlackPostMessageOptions {
  threadTs?: string;
  signal?: AbortSignal;
}

export interface SlackClient {
  authTest(signal?: AbortSignal): Promise<SlackAuthTestResult>;
  postMessage(channel: string, text: string, options?: SlackPostMessageOptions): Promise<SlackPostMessageResult>;
  // Add an emoji reaction to a message. The bridge uses "eyes" as the
  // inbound ack (Slack has no bot typing indicator). Best-effort at
  // the call site — a failure is logged, never gates the reply.
  addReaction(channel: string, timestamp: string, name: string, signal?: AbortSignal): Promise<true>;
}

export type SlackFetch = typeof fetch;

export interface SlackClientOptions {
  fetchImpl?: SlackFetch;
  apiBase?: string;
}

// Slack's Web API always returns HTTP 200 with `{ok: false, error}` on
// application-level failures — the HTTP status only reflects transport
// problems. Both layers are folded into a thrown Error here.
interface SlackEnvelope {
  ok: boolean;
  error?: string;
}

export function createSlackClient(token: string, options: SlackClientOptions = {}): SlackClient {
  if (!token) throw new Error("Slack bot token is required.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.apiBase ?? SLACK_API_BASE).replace(/\/$/, "");
  const authHeader = `Bearer ${token}`;

  async function call<T extends SlackEnvelope>(
    method: string,
    payload: Record<string, unknown> | undefined,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      signal,
      headers: {
        authorization: authHeader,
        "content-type": "application/json; charset=utf-8"
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    });
    if (!response.ok) {
      throw new Error(`Slack ${method} failed: HTTP ${response.status}`);
    }
    let parsed: T;
    try {
      parsed = (await response.json()) as T;
    } catch {
      throw new Error(`Slack ${method} returned a non-JSON body (HTTP ${response.status}).`);
    }
    if (!parsed.ok) {
      throw new Error(`Slack ${method} failed: ${parsed.error ?? "unknown_error"}`);
    }
    return parsed;
  }

  return {
    authTest: async (signal) => {
      const result = await call<SlackEnvelope & {
        user_id?: string;
        user?: string;
        team_id?: string;
        team?: string;
      }>("auth.test", undefined, signal);
      return {
        userId: typeof result.user_id === "string" ? result.user_id : "",
        user: typeof result.user === "string" ? result.user : "",
        teamId: typeof result.team_id === "string" ? result.team_id : "",
        team: typeof result.team === "string" ? result.team : ""
      };
    },
    postMessage: async (channel, text, opts) => {
      if (!channel) throw new Error("Slack channel id is required.");
      const trimmed = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text;
      const result = await call<SlackEnvelope & { channel?: string; ts?: string }>(
        "chat.postMessage",
        {
          channel,
          text: trimmed,
          ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {})
        },
        opts?.signal
      );
      return {
        channel: typeof result.channel === "string" ? result.channel : channel,
        ts: typeof result.ts === "string" ? result.ts : ""
      };
    },
    addReaction: async (channel, timestamp, name, signal) => {
      if (!channel) throw new Error("Slack channel id is required.");
      await call<SlackEnvelope>("reactions.add", { channel, timestamp, name }, signal);
      return true as const;
    }
  };
}
