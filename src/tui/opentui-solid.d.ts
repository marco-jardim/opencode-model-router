/**
 * #90 P1.3 (amendment A2): the three `@opentui/solid` reconciler primitives the TUI entry uses, declared locally so the
 * repository needs neither `@opentui/solid` nor `@opentui/core` installed. At runtime the host serves the module (its
 * runtime plugin answers the bare import); nothing here is bundled.
 *
 * Mirrors `@opentui/solid@0.5.14` `src/reconciler.d.ts` (the `solid-js/universal` renderer functions), with the
 * `BaseRenderable` node type simplified to `unknown`.
 */
declare module "@opentui/solid" {
  /** Creates a host element (`"box"`, `"text"`, …). */
  export function createElement(tag: string): unknown;
  /** Inserts a value or a reactive accessor (string, node or array of nodes) as the children of `parent`. */
  export function insert(parent: unknown, accessor: unknown, marker?: unknown, initial?: unknown): unknown;
  /** Sets one property of a host element; returns `value`. */
  export function setProp<T>(node: unknown, name: string, value: T, prev?: T): T;
}
