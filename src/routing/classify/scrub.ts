/**
 * Hardened scrubber for everything that may leave the machine (D14) and for
 * anything the classifier logs or keeps (`BackendResult.raw`, reasons).
 *
 * `src/guard/scrub.ts` (`scrubText`) only knows a handful of provider token
 * shapes and `key=value` pairs whose value is an alphanumeric run; QA-1.2-1
 * showed env-style names, quoted JSON keys, URL credentials, PEM blocks, more
 * provider tokens and bare high-entropy runs all pass through it. This module
 * layers the missing shapes on top of it (the guard module is not edited) and
 * adds the policy gate `hasCredentialSignal`.
 *
 * Pure. Every quantifier is bounded or linear: no pattern can backtrack
 * quadratically on a long run of word characters.
 */

import { scrubText } from "../../guard/scrub";

const REDACTED = "[REDACTED]";

/** Words that name a secret in an env-style or JSON-style assignment. */
const SECRET_NAME =
  "PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|TOKEN|API[_ -]?KEY|ACCESS[_ -]?KEY|PRIVATE[_ -]?KEY|CREDENTIALS?";

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `client_secret: value`.
 * Group 1 = the secret word, the rest of the name and the separator (kept; the
 * start of the name is left alone), group 2 = the value (replaced): an already
 * redacted marker (idempotence), a double- or single-quoted string, or
 * everything up to the next whitespace (so `secret=abc+def/ghi==` goes whole).
 */
const ASSIGNMENT_RE = new RegExp(
  `((?:${SECRET_NAME})[A-Z0-9_-]{0,48}["']?\\s*[:=]\\s*)(\\[REDACTED\\]|"(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|\\S+)`,
  "gi",
);

/**
 * Upper-case env-style names ending in `_KEY` (`OPENAI_KEY`, `MASTER_KEY`,
 * `ENCRYPTION_KEY`; QA-1.2-24). Case-sensitive on purpose: a lower-case `key` is
 * an ordinary word, `_KEY` in capitals is a configuration name. Same group
 * layout as ASSIGNMENT_RE.
 */
const ENV_KEY_ASSIGNMENT_RE =
  /(\b[A-Z][A-Z0-9_]{0,48}_KEY["']?\s*[:=]\s*)(\[REDACTED\]|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\S+)/g;

/** The name alone, without a value (`set OPENAI_KEY before running`): a credential mention. */
const ENV_KEY_NAME_RE = /\b[A-Z][A-Z0-9_]{0,48}_KEY\b/;

/** "password is hunter2", "the key is hunter2", "the token was abc123". Group 1 = words up to the value. */
const SPOKEN_RE =
  /\b((?:pass(?:word|wd|phrase)|secret|token|(?:api|access|private|signing|ssh|master|encryption)[_ -]?key|key|credentials?|pin)\s+(?:is|are|was|were|=)\s+)["'`]?[^\s"'`]+["'`]?/gi;

/** `mysql -u root -pSecret` (the password is glued to `-p`; a bare `-p` prompts and carries none). */
const MYSQL_PASSWORD_RE = /(\b(?:mysql|mysqladmin|mysqldump)\b[^\n]{0,200}?\s)-p\S+/gi;

/** `scheme://user:pass@host` and `scheme://token@host`. */
const URL_USER_PASS_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/]+@/gi;
const URL_USER_ONLY_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+@/gi;

/** `Authorization: Basic xxx` / `Bearer xxx` / bare value; group 1 = the header name and separator. */
const AUTH_HEADER_RE = /(\bAuthorization["']?\s*[:=]\s*)(?:(?:Basic|Digest|Bearer|Token)\s+)?[^\s"']+/gi;

/** `curl -u user:pass`, `--user user:pass`. */
const CURL_USER_RE = /(\s(?:-u|--user)[\s=]+)[^\s:]+:\S+/g;

/** PEM blocks; an unterminated block (truncated paste) runs to the end of the text. */
const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;

/** Provider token shapes `scrubText` does not know. */
const TOKEN_RES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/g, // Stripe
  /\brk_[A-Za-z0-9_]{10,}/g, // Stripe restricted / generic rk_
  /\bwhsec_[A-Za-z0-9]{10,}/g, // Stripe webhook
  /\bhf_[A-Za-z0-9]{12,}/g, // Hugging Face
  /\bglpat-[A-Za-z0-9_-]{10,}/g, // GitLab personal access token
  /\bnpm_[A-Za-z0-9]{12,}/g, // npm
  /\bpypi-[A-Za-z0-9_-]{16,}/g, // PyPI
  /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // SendGrid
  /\bya29\.[A-Za-z0-9_-]{16,}/g, // Google OAuth
  /\bdop_v1_[a-f0-9]{16,}/g, // DigitalOcean
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g, // GitHub fine-grained
];

/**
 * A hex run of 32+ characters is a key, token or hash whatever its entropy
 * (QA-1.2-24: `a1b2c3d4` repeated has low entropy and is still a 128-bit key).
 * It needs both a letter and a digit, so a run of zeros or a plain number stays.
 */
const HEX_RUN_RE = /(?<![0-9A-Za-z])[0-9A-Fa-f]{32,}(?![0-9A-Za-z])/g;

/**
 * A run this long that looks random is a key, hash or blob, not prose. `.` and
 * `\` are part of the run so a whole path is judged as a path (QA-1.2-26).
 */
const HIGH_ENTROPY_RUN_RE = /[A-Za-z0-9+/_=.\\-]{32,}/g;
const MIN_ENTROPY_BITS = 3.5;
/** A run whose characters belong to word-like segments this much (or more) is a path or identifier. */
const WORDLIKE_SHARE = 0.7;
const WORDLIKE_SEGMENT_RE = /^(?:[A-Z]?[a-z]{1,}\d{0,3}|\d{1,4})$/;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Share of the run's characters that sit in word-like segments (`docs`, `cost`,
 * `p12`, `2026`, `Classify`) when it is cut at `/ \ . _ - + =`. A path or a
 * kebab-case identifier is nearly all word-like; a base64 key almost never is.
 */
function wordlikeShare(run: string): number {
  let wordlike = 0;
  let total = 0;
  for (const segment of run.split(/[/\\._=+-]+/)) {
    if (segment === "") continue;
    total += segment.length;
    if (WORDLIKE_SEGMENT_RE.test(segment)) wordlike += segment.length;
  }
  return total === 0 ? 0 : wordlike / total;
}

function looksRandom(run: string): boolean {
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (wordlikeShare(run) >= WORDLIKE_SHARE) return false;
  return shannonEntropy(run) >= MIN_ENTROPY_BITS;
}

export interface ScrubOptions {
  /**
   * Also redact bare hex and high-entropy runs (default true). These are the
   * guesses of the scrubber: a commit hash or a minified blob looks the same as a
   * key. Everything else it redacts is a named or shaped secret.
   */
  readonly entropy?: boolean;
}

/**
 * Redact every secret shape known to the classifier. Idempotent
 * (`scrubState(scrubState(x)) === scrubState(x)`).
 */
export function scrubState(input: string, options: ScrubOptions = {}): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  out = out.replace(PEM_RE, `${REDACTED} (PEM block)`);
  out = out.replace(URL_USER_PASS_RE, `$1${REDACTED}@`);
  out = out.replace(URL_USER_ONLY_RE, `$1${REDACTED}@`);
  out = out.replace(CURL_USER_RE, `$1${REDACTED}`);
  out = out.replace(MYSQL_PASSWORD_RE, `$1-p${REDACTED}`);
  out = out.replace(AUTH_HEADER_RE, `$1${REDACTED}`);
  out = out.replace(ASSIGNMENT_RE, `$1${REDACTED}`);
  out = out.replace(ENV_KEY_ASSIGNMENT_RE, `$1${REDACTED}`);
  out = out.replace(SPOKEN_RE, `$1${REDACTED}`);
  for (const re of TOKEN_RES) out = out.replace(re, REDACTED);
  out = scrubText(out);
  if (options.entropy !== false) {
    out = out.replace(HEX_RUN_RE, (run) => (/\d/.test(run) && /[A-Fa-f]/.test(run) ? REDACTED : run));
    out = out.replace(HIGH_ENTROPY_RUN_RE, (run) => (looksRandom(run) ? REDACTED : run));
  }
  return out;
}

/**
 * How much more than the cut a slice is scrubbed (QA-1.2-32). It must exceed the
 * longest minimum a pattern needs to recognise a secret (a 32-character hex or
 * entropy run, a 20-character token body), so a secret that starts inside the
 * kept part and runs past the cut is still seen as a secret in the slice.
 */
const CUT_MARGIN_CHARS = 256;

/**
 * Scrub, then keep the first `max` characters. The scrubbing sees `max` plus a
 * margin, never only the kept part (a secret cut in half would no longer match
 * its pattern) and never the whole input (a megabyte answer would cost a megabyte
 * of regex work to keep a thousand characters).
 */
export function scrubAndCut(text: string, max: number, options: ScrubOptions = {}): string {
  if (typeof text !== "string") return "";
  const slice = text.length > max + CUT_MARGIN_CHARS ? text.slice(0, max + CUT_MARGIN_CHARS) : text;
  return scrubState(slice, options).slice(0, max);
}

/**
 * Words and shapes that mean the text is about, or contains, a credential.
 * Whole words only ("tokenizer" is not a hit); env-style names such as
 * `GITHUB_TOKEN` are.
 */
const CREDENTIAL_WORD_RE =
  /\b(?:passwords?|passwd|passphrases?|secrets?|credentials?|api[_ -]?keys?|access[_ -]?keys?|private[_ -]?keys?|ssh[_ -]?keys?|signing[_ -]?keys?|tokens?|bearer|authorization|oauth)\b|[A-Za-z0-9]_(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)\b|-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)|(?<![\w])\.env\b/i;

/**
 * Policy gate (QA-1.2-1, QA-1.2-26): no backend is consulted for a task that
 * names a credential (a credential word or an env-style `*_KEY` name) or
 * contains a named or shaped secret the scrubber had to redact. The rules facts
 * stand; nothing leaves the machine. A redaction that is only the scrubber's
 * entropy guess (a commit hash, a long identifier) does NOT skip the backend:
 * the redacted state is sent.
 */
export function hasCredentialSignal(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (CREDENTIAL_WORD_RE.test(text) || ENV_KEY_NAME_RE.test(text)) return true;
  return scrubState(text, { entropy: false }) !== text;
}
