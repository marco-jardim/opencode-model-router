/**
 * Fenced code block scanner (CommonMark subset), shared by the route-line parser
 * (a `[route …]` inside a fence is example text, never a directive — QA-1.2-2)
 * and the D14 state builder (code blocks never leave the machine — QA-1.2-12).
 *
 * Line based and linear: no regex backtracks over the whole text.
 *  - an opener is 0–3 spaces, then a run of at least three backticks or tildes;
 *    a backtick opener's info string may not contain a backtick (so inline
 *    ```code``` is not a fence);
 *  - a closer is 0–3 spaces, then a run of the SAME character at least as long
 *    as the opener (and so at least three), then only whitespace;
 *  - an unclosed fence runs to the end of the text.
 */

const OPENER_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSER_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * For every line, whether it belongs to a fenced block (the opener and closer
 * lines included). `lines` must not carry line terminators.
 */
export function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array<boolean>(lines.length).fill(false);
  let open: { readonly char: string; readonly length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === null) {
      const m = OPENER_RE.exec(line);
      if (m === null) continue;
      const run = m[1]!;
      if (run[0] === "`" && (m[2] ?? "").includes("`")) continue;
      open = { char: run[0]!, length: run.length };
      mask[i] = true;
      continue;
    }
    mask[i] = true;
    const m = CLOSER_RE.exec(line);
    if (m !== null && m[1]![0] === open.char && m[1]!.length >= open.length) open = null;
  }
  return mask;
}

/** Replace every fenced block (unclosed ones to the end) by `placeholder`, one per block. */
export function replaceFences(text: string, placeholder: string): string {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  if (!mask.includes(true)) return text;
  const out: string[] = [];
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) {
      if (!inside) out.push(placeholder);
      inside = true;
    } else {
      inside = false;
      out.push(lines[i]!);
    }
  }
  return out.join("\n");
}
