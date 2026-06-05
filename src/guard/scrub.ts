const KEYVALUE_RE =
  /(\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization)\b\s*[:=]\s*)['"]?[A-Za-z0-9._\-]{6,}['"]?/gi;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/g,        // Anthropic
  /\bsk-[A-Za-z0-9_\-]{20,}/g,            // OpenAI-style
  /\bgh[posru]_[A-Za-z0-9]{20,}/g,        // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bAKIA[0-9A-Z]{16}\b/g,                // AWS access key id
  /\bAIza[0-9A-Za-z_\-]{20,}/g,           // Google API key
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,     // Slack
  /\beyJ[A-Za-z0-9._\-]{20,}/g,           // JWT (header starts eyJ)
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,        // bearer tokens
];

/**
 * Redacts common secret/token shapes from a string before it is shown to a
 * model, written to a log, or placed in a thrown error. Conservative by design:
 * it targets recognisable key/token shapes and `key=value` secrets, and does NOT
 * touch ordinary file paths or prose. Pure; safe on any input.
 */
export function scrubText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input.replace(KEYVALUE_RE, "$1[REDACTED]");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}
