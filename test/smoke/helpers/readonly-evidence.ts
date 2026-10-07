/** Evidence contains tool names and permission rules, never local path identities. */
export function scrubReadOnlyEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(?:[a-z]:[\\/]|[\\/])/i.test(value)) return "<absolute-path>";
    return value.replace(/[a-z]:[\\/]+Users[\\/]+[^\\/\s]+/gi, "<home>")
      .replace(/\b[A-Za-z0-9_]{1,6}~\d+\b/g, "<short-name>");
  }
  if (Array.isArray(value)) return value.map(scrubReadOnlyEvidence);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubReadOnlyEvidence(item)]));
  return value;
}
