// Ambient types for Bun's `with { type: "file" }` import attribute. Bun bundles
// the file as an embedded asset and the import evaluates to a path string (a
// real on-disk path under `bun run`, a `/$bunfs` virtual path in a compiled
// binary) that Bun.file()/readFileSync can read. tsc has no built-in knowledge
// of these, so declare the specifiers we import this way. See
// system-prompt.ts's INSTRUCTIONS.md import and ADR compiled-runtime-binary.md.
declare module "*.md" {
  const path: string;
  export default path;
}
