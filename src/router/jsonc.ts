// ---------------------------------------------------------------------------
// src/router/jsonc.ts — minimal JSONC support (comments + trailing commas).
//
// PURE, zero-dependency. `stripJsonc` removes `//` line comments, `/* */` block
// comments, and trailing commas before `}`/`]` — all string-aware, so a `//`,
// `/*`, or `,` inside a string value is preserved. `parseJsonc` then hands the
// cleaned text to JSON.parse. JSON is a subset of JSONC, so plain-JSON input
// passes through unchanged.
// ---------------------------------------------------------------------------

/** Remove comments and trailing commas from JSONC text (string-aware). */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;

  while (i < n) {
    const c = input[i]!;

    if (inString) {
      if (c === "\\" && i + 1 < n) {
        out += c + input[i + 1]; // copy the escape pair verbatim
        i += 2;
        continue;
      }
      out += c;
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < n && input[i] !== "\n") i++; // keep the newline
      continue;
    }

    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      if (i >= n) throw new Error("jsonc: unterminated block comment");
      i += 2; // skip the closing */
      continue;
    }

    if (c === ",") {
      // Drop the comma if the next significant token (skipping whitespace and
      // comments) closes an object or array.
      let j = i + 1;
      while (j < n) {
        const d = input[j]!;
        if (d === " " || d === "\t" || d === "\n" || d === "\r") {
          j++;
        } else if (d === "/" && input[j + 1] === "/") {
          j += 2;
          while (j < n && input[j] !== "\n") j++;
        } else if (d === "/" && input[j + 1] === "*") {
          j += 2;
          while (j < n && !(input[j] === "*" && input[j + 1] === "/")) j++;
          j += 2;
        } else {
          break;
        }
      }
      if (j < n && (input[j] === "}" || input[j] === "]")) {
        i++; // trailing comma — skip it
        continue;
      }
      out += c;
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** Parse JSONC text (comments + trailing commas tolerated) into a value. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
