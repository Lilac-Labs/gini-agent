import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, targetPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${targetPath}`);
  }
  return target;
}

// Lexical check + realpath validation of the deepest existing ancestor.
// `assertInsideWorkspace` only resolves paths textually, so a symlink
// inside the workspace pointing outside (e.g. `workspace/escape ->
// /tmp/outside`) lets a model-issued write to `escape/foo.txt` land at
// `/tmp/outside/foo.txt`. Used for write-style operations (file.write,
// file.patch) where the gap can land bytes outside the workspace; the
// read-style callers can keep using the cheaper `assertInsideWorkspace`
// because reading-through-symlinks is the existing intentional behavior
// for those tools. Mirrors `resolveUploadPath` in `src/tools/browser.ts`.
export function assertInsideWorkspaceNoSymlinkEscape(workspaceRoot: string, targetPath: string): string {
  const target = assertInsideWorkspace(workspaceRoot, targetPath);
  const realWorkspace = realpathSync(resolve(workspaceRoot));
  // Walk up until we find a path component that physically exists.
  // lstatSync (NOT existsSync) is critical here — existsSync follows
  // symlinks and would treat a workspace-internal symlink pointing at a
  // *nonexistent* outside file (e.g. `workspace/out -> /tmp/x/new.txt`)
  // as "missing leaf", letting the parent realpath pass and the
  // subsequent writeFileSync materialize the file outside the
  // workspace. lstat on a broken symlink returns the symlink's own
  // stat, so we stop the walk at the symlink, realpath that, and
  // detect that the symlink's target is outside.
  let probe = target;
  let probeIsSymlink = false;
  while (true) {
    try {
      const st = lstatSync(probe);
      probeIsSymlink = st.isSymbolicLink();
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  // realpath resolves any symlinks in `probe` itself. Three cases:
  //   1. realpath succeeds and falls inside the workspace → safe.
  //   2. realpath succeeds and falls outside → reject below.
  //   3. realpath throws AND `probe` is itself a (broken) symlink →
  //      reject. A broken symlink's target is by definition unknown
  //      and writeFileSync will create the file at the target path,
  //      which we cannot validate without resolving. Reject closed.
  //   4. realpath throws because `probe` is a normal (non-symlink)
  //      path we walked up to past everything → treat as in-workspace
  //      (assertInsideWorkspace already passed).
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    if (probeIsSymlink) {
      throw new Error(`Path escapes workspace via broken symlink: ${targetPath}`);
    }
    realProbe = probe;
  }
  const rel = relative(realWorkspace, realProbe);
  // An empty `rel` means the probe IS the workspace root — allowed.
  // A leading `..` means we walked out of the workspace via a symlink.
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error(`Path escapes workspace via symlink: ${targetPath}`);
  }
  return target;
}

