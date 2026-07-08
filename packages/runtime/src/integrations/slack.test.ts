import { describe, expect, test } from "bun:test";
import { createSlackClient } from "./slack";

// Programmable fetch stub. Captures every request (url, headers, JSON
// body) and returns the scripted response — Slack's Web API always
// answers HTTP 200 and signals application failures via {ok:false},
// so the default response shape here is a 200 envelope.
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const next = responses.shift() ?? { body: { ok: true } };
    calls.push({
      url: String(input),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
      ),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("slack client", () => {
  test("requires a token", () => {
    expect(() => createSlackClient("")).toThrow(/token/);
  });

  test("authTest sends the bearer header and maps the identity fields", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { ok: true, user_id: "U123", user: "gini", team_id: "T9", team: "Acme" } }
    ]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    const me = await client.authTest();
    expect(me).toEqual({ userId: "U123", user: "gini", teamId: "T9", team: "Acme" });
    expect(calls[0]?.url).toBe("https://slack.com/api/auth.test");
    expect(calls[0]?.headers.authorization).toBe("Bearer xoxb-abc");
  });

  test("ok:false envelopes throw with the Slack error code (Slack signals failures on HTTP 200)", async () => {
    const { fetchImpl } = stubFetch([{ body: { ok: false, error: "invalid_auth" } }]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await expect(client.authTest()).rejects.toThrow(/invalid_auth/);
  });

  test("non-2xx transport failures throw with the HTTP status", async () => {
    const { fetchImpl } = stubFetch([{ status: 503, body: { ok: false } }]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await expect(client.authTest()).rejects.toThrow(/HTTP 503/);
  });

  test("postMessage passes channel, text, and thread_ts through to chat.postMessage", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { ok: true, channel: "D1", ts: "1700000000.000200" } }
    ]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    const result = await client.postMessage("D1", "hello", { threadTs: "1700000000.000100" });
    expect(result).toEqual({ channel: "D1", ts: "1700000000.000200" });
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.body).toEqual({
      channel: "D1",
      text: "hello",
      thread_ts: "1700000000.000100"
    });
  });

  test("postMessage omits thread_ts when no threadTs is supplied", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { ok: true, channel: "D1", ts: "1.2" } }]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await client.postMessage("D1", "hello");
    expect(calls[0]?.body).toEqual({ channel: "D1", text: "hello" });
  });

  test("postMessage truncates text at the 40,000-char chat.postMessage limit", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { ok: true, channel: "D1", ts: "1.2" } }]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await client.postMessage("D1", "x".repeat(40_001));
    expect((calls[0]?.body?.text as string).length).toBe(40_000);
  });

  test("postMessage rejects an empty channel id before any network call", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await expect(client.postMessage("", "hello")).rejects.toThrow(/channel id/);
    expect(calls.length).toBe(0);
  });

  test("addReaction posts the reactions.add payload", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { ok: true } }]);
    const client = createSlackClient("xoxb-abc", { fetchImpl });
    await client.addReaction("D1", "1700000000.000100", "eyes");
    expect(calls[0]?.url).toBe("https://slack.com/api/reactions.add");
    expect(calls[0]?.body).toEqual({ channel: "D1", timestamp: "1700000000.000100", name: "eyes" });
  });
});
