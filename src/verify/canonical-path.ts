/**
 * src/verify/canonical-path.ts — the canonical spelling of a path (QA-2.1-8, moved here by QA-1.3-16).
 * A leaf module: it imports only node built-ins, so both the verify change-set store and the lease registry can use
 * it without a dependency cycle.
 */
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * QA-2.1-8: the canonical spelling of `path`, so a Windows 8.3 short name (`C:\Users\MARQUI~1\…`),
 * a junction or symlink alias, and the long real path of one file key the same change-set entry.
 * The native realpath of the path, or of its nearest existing ancestor with the missing tail
 * appended (a deleted file keeps its directory's canonical spelling); lexical `resolve` when no
 * ancestor resolves. A `realpath` that is not a function is replaced by the native one.
 */
export function canonicalPath(
  path: string,
  realpath: (p: string) => string = realpathSync.native,
): string {
  const real: (p: string) => string = typeof realpath === "function" ? realpath : realpathSync.native;
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const found = real(head);
      return tail.length === 0 ? found : join(found, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(basename(head));
      head = parent;
    }
  }
}
