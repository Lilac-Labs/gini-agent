import { describe, expect, test } from "bun:test";
import { highlightedTextParts } from "./HomeComposer";

describe("highlightedTextParts", () => {
  test("splits the routine creation seed around the highlighted word", () => {
    expect(highlightedTextParts("Create a routine that ", "routine")).toEqual([
      "Create a ",
      "routine",
      " that "
    ]);
  });

  test("matches case-insensitively while preserving source text", () => {
    expect(highlightedTextParts("Create a Routine that ", "routine")).toEqual([
      "Create a ",
      "Routine",
      " that "
    ]);
  });

  test("returns null when no requested word is present", () => {
    expect(highlightedTextParts("Create a task that ", "routine")).toBeNull();
  });
});
