import { describe, expect, test } from "bun:test";
import { dossierDisplayMarkdown } from "./dossier";

describe("dossierDisplayMarkdown", () => {
  test("bullets bare one-claim-per-line legacy sections", () => {
    const input = [
      "## Claims / Citations",
      '[1] Claim: met at dinner · Confidence: high · Observed at: 2026-01-05 · Source: email "intro"',
      '[2] Claim: works at Acme · Confidence: medium · Observed at: 2026-02-01 · Source: email "hello"',
    ].join("\n");
    expect(dossierDisplayMarkdown(input)).toBe(
      [
        "## Claims / Citations",
        '- [1] Claim: met at dinner · Confidence: high · Observed at: 2026-01-05 · Source: email "intro"',
        '- [2] Claim: works at Acme · Confidence: medium · Observed at: 2026-02-01 · Source: email "hello"',
      ].join("\n"),
    );
  });

  test("splits a fully collapsed single-line claims blob into bullets", () => {
    const input =
      '## Claims / Citations\n[1] Claim: name and role · Confidence: high · Source: email "a" [2] Claim: helped migrate the site · Confidence: high · Source: thread "b"';
    expect(dossierDisplayMarkdown(input)).toBe(
      [
        "## Claims / Citations",
        '- [1] Claim: name and role · Confidence: high · Source: email "a"',
        '- [2] Claim: helped migrate the site · Confidence: high · Source: thread "b"',
      ].join("\n"),
    );
  });

  test("leaves already-bulleted claims and inline citation refs alone", () => {
    const input = [
      "## Who They Are",
      "- Offered a custom tab key gift. [1]",
      "",
      "## Claims / Citations",
      "- [1] Claim: already bulleted · Confidence: high · Source: email",
    ].join("\n");
    expect(dossierDisplayMarkdown(input)).toBe(input);
  });

  test("re-attaches star/numbered/quote markers instead of leaving empty items", () => {
    const input = [
      "## Claims / Citations",
      "* [1] Claim: star bulleted · Confidence: high · Source: email [2] Claim: second · Confidence: low · Source: email",
    ].join("\n");
    expect(dossierDisplayMarkdown(input)).toBe(
      [
        "## Claims / Citations",
        "* [1] Claim: star bulleted · Confidence: high · Source: email",
        "- [2] Claim: second · Confidence: low · Source: email",
      ].join("\n"),
    );
  });

  test("does not rewrite claim markers outside a Claims/Citations section", () => {
    const input = [
      "## Who They Are",
      "The dossier format uses [1] Claim: entries per line.",
      "",
      "## Claims / Citations",
      "[1] Claim: real entry · Confidence: high · Source: email",
    ].join("\n");
    expect(dossierDisplayMarkdown(input)).toBe(
      [
        "## Who They Are",
        "The dossier format uses [1] Claim: entries per line.",
        "",
        "## Claims / Citations",
        "- [1] Claim: real entry · Confidence: high · Source: email",
      ].join("\n"),
    );
  });

  test("passes fenced code through untouched even inside the claims section", () => {
    const input = [
      "## Claims / Citations",
      "```text",
      "[1] Claim: inside fence",
      "",
      "    [2] Claim: indented inside fence",
      "```",
      "[3] Claim: outside fence · Confidence: high · Source: email",
    ].join("\n");
    expect(dossierDisplayMarkdown(input)).toBe(
      [
        "## Claims / Citations",
        "```text",
        "[1] Claim: inside fence",
        "",
        "    [2] Claim: indented inside fence",
        "```",
        "- [3] Claim: outside fence · Confidence: high · Source: email",
      ].join("\n"),
    );
  });

  test("normalizes indented bare claim lines", () => {
    const input = "## Claims / Citations\n  [1] Claim: indented · Confidence: high · Source: email";
    expect(dossierDisplayMarkdown(input)).toBe(
      "## Claims / Citations\n- [1] Claim: indented · Confidence: high · Source: email",
    );
  });

  test("passes through dossiers with no claims section", () => {
    const input = "# Jane Doe\n\n## Contact\n- Email: jane@example.com";
    expect(dossierDisplayMarkdown(input)).toBe(input);
  });
});
