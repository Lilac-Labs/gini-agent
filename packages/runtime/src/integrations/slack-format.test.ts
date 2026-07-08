import { describe, expect, test } from "bun:test";
import { formatSlackMrkdwn } from "./slack-format";

describe("formatSlackMrkdwn", () => {
  test("empty input passes through", () => {
    expect(formatSlackMrkdwn("")).toBe("");
  });

  test("plain prose passes through untouched (no escaping pass)", () => {
    const input = "Hello there. Costs $5 & takes 2 > 1 steps!";
    expect(formatSlackMrkdwn(input)).toBe(input);
  });

  test("double-asterisk bold converts to single-asterisk mrkdwn bold", () => {
    expect(formatSlackMrkdwn("this is **important** stuff")).toBe("this is *important* stuff");
  });

  test("double-underscore bold converts to single-asterisk mrkdwn bold", () => {
    expect(formatSlackMrkdwn("this is __important__ stuff")).toBe("this is *important* stuff");
  });

  test("bold does not match across newlines", () => {
    const input = "a **first\nsecond** b";
    expect(formatSlackMrkdwn(input)).toBe(input);
  });

  test("markdown links convert to <url|text>", () => {
    expect(formatSlackMrkdwn("see [the docs](https://example.com/a?b=c) for details")).toBe(
      "see <https://example.com/a?b=c|the docs> for details"
    );
  });

  test("heading lines convert to bold lines", () => {
    expect(formatSlackMrkdwn("# Title\nbody\n## Sub heading\nmore")).toBe(
      "*Title*\nbody\n*Sub heading*\nmore"
    );
  });

  test("a mid-line hash is not a heading", () => {
    const input = "issue #42 is fixed";
    expect(formatSlackMrkdwn(input)).toBe(input);
  });

  test("inline code passes through verbatim, including markers inside it", () => {
    expect(formatSlackMrkdwn("run `foo **bar** [x](y)` now")).toBe("run `foo **bar** [x](y)` now");
  });

  test("fenced code passes through verbatim, including heading-shaped lines", () => {
    const input = "```\n# not a heading\n**not bold**\n```";
    expect(formatSlackMrkdwn(input)).toBe(input);
  });

  test("prose around a code span still converts", () => {
    expect(formatSlackMrkdwn("**bold** then `code **x**` then **more**")).toBe(
      "*bold* then `code **x**` then *more*"
    );
  });
});
