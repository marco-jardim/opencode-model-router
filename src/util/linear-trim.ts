/**
 * Linear-time trimming helpers.
 *
 * Regular expressions such as `/\/+$/` or `/^\s+|\s+$/` are polynomial on
 * uncontrolled input (CodeQL js/polynomial-redos): on a long run of the
 * repeated character that is not at the end, the engine retries the run from
 * every start position. These helpers scan once from the relevant end.
 */

/** Returns `value` without the trailing run of characters for which `isTrimmed` holds. */
export function trimEndWhile(value: string, isTrimmed: (char: string) => boolean): string {
  let end = value.length;
  while (end > 0 && isTrimmed(value[end - 1] as string)) end--;
  return end === value.length ? value : value.slice(0, end);
}

/** Returns `value` without the leading run of characters for which `isTrimmed` holds. */
export function trimStartWhile(value: string, isTrimmed: (char: string) => boolean): string {
  let start = 0;
  while (start < value.length && isTrimmed(value[start] as string)) start++;
  return start === 0 ? value : value.slice(start);
}

/** True for `/` and `\`. */
export function isPathSeparator(char: string): boolean {
  return char === "/" || char === "\\";
}

/** True for `/` only. */
export function isSlash(char: string): boolean {
  return char === "/";
}
