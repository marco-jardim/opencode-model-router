/**
 * src/verify/pin.ts
 *
 * Cross-repo P2d.2 (docs/design/cross-repo.md, OD3 = fail closed): the pin of a linked repository. At dispatch each admitted
 * link target of W is snapshotted together with a bounded digest of its ignored files (`node_modules` excluded). At
 * materialize the link counts as exact when both are unchanged; it is `external-link` when the target changed, the digest is
 * over its bounds, the target is not admitted, or the target is not a git repository. A target's own external links are
 * followed one level; a link one level deeper makes the target's pin unusable.
 *
 * Pure apart from the injected deps: nothing here runs git.
 */
import type { TreeSnapshot } from "./dispatch";
import { perimeterKey } from "./git-top";
import { linkedTargets } from "./perimeter";

export type PinWhy = "not-observed" | "not-admitted" | "not-git" | "over-bounds" | "deep-link";

export type LinkPin =
  | {
      readonly kind: "pinned";
      readonly root: string;
      readonly head: string;
      readonly fingerprint: string;
      readonly ignored: string;
      readonly nested: readonly LinkPin[];
    }
  | { readonly kind: "unpinnable"; readonly root: string; readonly why: PinWhy };

/** What `pinTarget` needs; all injected so no git is run here. */
export interface PinDeps {
  snapshot(dir: string): Promise<TreeSnapshot | undefined>;
  admitted(dir: string): boolean;
  externalLinks(dir: string): string[];
}

/** The default link discovery: the external package links of `dir` (perimeter.ts linkedTargets). */
export const defaultExternalLinks: (dir: string) => string[] = linkedTargets;

function unpinnable(root: string, why: PinWhy): LinkPin {
  return { kind: "unpinnable", root, why };
}

/** The pin of one root from its dispatch-time snapshot (no links followed). */
export function pinOf(root: string, snapshot: TreeSnapshot | undefined, admitted: boolean): LinkPin {
  if (!admitted) return unpinnable(root, "not-admitted");
  if (snapshot === undefined) return unpinnable(root, "not-observed");
  if (snapshot.root === undefined) return unpinnable(root, "not-git");
  if (snapshot.ignored === "over-bounds") return unpinnable(root, "over-bounds");
  if (snapshot.ignored === undefined) return unpinnable(root, "not-observed");
  return { kind: "pinned", root, head: snapshot.head, fingerprint: snapshot.fingerprint, ignored: snapshot.ignored, nested: [] };
}

/** UNC and device paths (`\\host\share`, `//host/share`, `\\?\`, `\\.\`): never touched, decided by text alone. */
function isUncOrDevice(dir: string): boolean {
  return /^[\\/]{2}/.test(dir);
}

/** True only for a non-UNC directory that is admitted; checked before any snapshot or link discovery on it. */
function mayTouch(dir: string, deps: PinDeps): boolean {
  return !isUncOrDevice(dir) && deps.admitted(dir);
}

/** True only when both pins are pinned and identical, nested pins included (order-independent by root key). */
export function samePin(a: LinkPin, b: LinkPin): boolean {
  if (a.kind !== "pinned" || b.kind !== "pinned") return false;
  if (perimeterKey(a.root) !== perimeterKey(b.root)) return false;
  if (a.head !== b.head || a.fingerprint !== b.fingerprint || a.ignored !== b.ignored) return false;
  if (a.nested.length !== b.nested.length) return false;
  const byKey = new Map<string, LinkPin>();
  for (const pin of b.nested) {
    const key = perimeterKey(pin.root);
    if (byKey.has(key)) return false;
    byKey.set(key, pin);
  }
  const seen = new Set<string>();
  for (const pin of a.nested) {
    const key = perimeterKey(pin.root);
    const other = byKey.get(key);
    if (other === undefined || seen.has(key) || !samePin(pin, other)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Pins `root` and, one level deep, the targets of its own external links. A target that itself has external links makes the
 * whole root unpinnable (`deep-link`, OD3); an unpinnable nested pin makes the root unpinnable with its reason. A UNC or
 * device path, or a directory that is not admitted, is `not-admitted` before any snapshot or link discovery on it (I11/I12).
 * Never throws.
 */
export async function pinTarget(root: string, deps: PinDeps): Promise<LinkPin> {
  try {
    // I11/I12: refuse UNC/device paths by text and non-admitted directories before any fs or git call on them.
    if (!mayTouch(root, deps)) return unpinnable(root, "not-admitted");
    const own = pinOf(root, await deps.snapshot(root), true);
    if (own.kind !== "pinned") return own;
    const nested: LinkPin[] = [];
    for (const target of deps.externalLinks(root)) {
      if (!mayTouch(target, deps)) return unpinnable(root, "not-admitted");
      if (deps.externalLinks(target).length > 0) return unpinnable(root, "deep-link");
      const pin = pinOf(target, await deps.snapshot(target), true);
      if (pin.kind !== "pinned") return unpinnable(root, pin.why);
      nested.push(pin);
    }
    return { ...own, nested };
  } catch {
    return unpinnable(root, "not-observed");
  }
}
