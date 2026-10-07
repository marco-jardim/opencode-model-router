/** One filename policy for read approval, grep filtering and Git exclusions.
 * Patterns are relative suffixes, matched at any depth (not a content scanner). */
const SSH_KEY_NAMES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"] as const;
export const SENSITIVE_PATH_PATTERNS = [
  "*.env", "*.env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx",
  ...SSH_KEY_NAMES.flatMap(name => [name, `${name}.*`]),
  ".npmrc", ".netrc", ".pgpass", ".git-credentials", "credentials.json",
  ".aws/credentials", ".docker/config.json",
  ".envrc", "*.ppk", "*.jks", "*.keystore", ".kube/config", "*.tfvars", "*.tfstate",
  ".pypirc", ".vault-token", ".cargo/credentials*", ".config/gh/hosts.yml", "application_default_credentials.json",
] as const;
// Public SSH keys are intentionally readable; backups/extensions other than
// exactly .pub remain sensitive. Helpers like id_rsa_helpers are not key names.
export const SENSITIVE_PATH_EXCEPTIONS = ["*.env.example", ...SSH_KEY_NAMES.map(name => `${name}.pub`)] as const;
const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");

export function isSensitivePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalized = path.replaceAll("\\", "/").split("/").filter(part => part !== "." && part !== "").join("/");
  const matches = (pattern: string) => new RegExp(`(?:^|/)${escape(pattern)}$`, platform === "win32" ? "i" : "").test(normalized);
  return !SENSITIVE_PATH_EXCEPTIONS.some(matches) && SENSITIVE_PATH_PATTERNS.some(matches);
}

// Host wildcard '*' spans separators; include basename, slash and backslash
// forms for v1 too. V2 normalizes separators and folds case on Windows itself.
const hostGlobs = (pattern: string) => [...new Set([pattern, pattern.replaceAll("/", "\\"), `*/${pattern}`, `*\\${pattern.replaceAll("/", "\\")}`])];
export const SENSITIVE_PERMISSION_GLOBS = SENSITIVE_PATH_PATTERNS.flatMap(hostGlobs);
export const SENSITIVE_PERMISSION_EXCEPTIONS = SENSITIVE_PATH_EXCEPTIONS.flatMap(hostGlobs);

/** Expand prefix* minus prefix+suffix: Git cannot re-include an excluded file. */
function exceptSuffix(prefix: string, suffix: string): string[] {
  return [prefix, ...[...suffix].flatMap((char, i) => {
    const start = `${prefix}${suffix.slice(0, i)}`;
    return [`${start}[!${char}]*`, ...(i > 0 ? [start] : [])];
  }), `${prefix}${suffix}?*`];
}

/** Preserve env examples and public SSH keys without re-including private files. */
export function sensitiveGitPathspecs(platform: NodeJS.Platform = process.platform): string[] {
  return SENSITIVE_PATH_PATTERNS.flatMap(pattern => {
    const exception = SENSITIVE_PATH_EXCEPTIONS.find(value => pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)));
    return exception ? exceptSuffix(pattern.slice(0, -1), exception.slice(pattern.length - 1)) : [pattern];
  })
    .map(pattern => `:(exclude,glob${platform === "win32" ? ",icase" : ""})**/${pattern}`);
}

/** Native v1/v2 grep's grouped `path:\n  Line N: text` format. Drop entire
 * sensitive blocks, including continuations, rather than editing match text. */
export function filterSensitiveGrep(text: string): string {
  let blocked = false;
  let withheld = 0;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("(Results are truncated")) { kept.push(line); continue; }
    const header = /^(\S.*):$/.exec(line);
    if (header) blocked = isSensitivePath(header[1]!);
    if (blocked) {
      if (/^\s+Line \d+:/.test(line)) withheld++;
      continue;
    }
    kept.push(line);
  }
  if (!withheld) return text;
  return `${kept.join("\n").trimEnd()}\n${withheld} matches in sensitive files withheld; use read (asks for approval)`;
}

/** Decode Git's C-quoted UTF-8 filenames (including octal bytes). */
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length;) {
    const octal = /^\\([0-7]{1,3})/.exec(body.slice(i));
    if (octal) { bytes.push(parseInt(octal[1]!, 8)); i += octal[0].length; continue; }
    if (body[i] === "\\") {
      const next = body[i + 1] ?? "";
      const escaped: Record<string, string> = { t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07" };
      bytes.push(...Buffer.from(escaped[next] ?? next)); i += 2; continue;
    }
    const char = String.fromCodePoint(body.codePointAt(i)!);
    bytes.push(...Buffer.from(char)); i += char.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Backstop for rename/quoted-path diffs, including sections cut by the output
 * bound. Fixed a/b prefixes are imposed by the Git argv builder. */
export function filterSensitiveDiff(text: string): string {
  return text.split(/(?=^diff --(?:git|cc|combined) |^commit [0-9a-f]{40,64}(?:\s|$))/m).map(section => {
    if (!/^diff --(?:git|cc|combined) /.test(section)) return section;
    const header = section.split("\n", 1)[0]!;
    const paths: string[] = [];
    if (header.startsWith("diff --git ")) {
      const pair = /^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(header.slice(11));
      if (!pair) return "[router_git] unparseable diff section withheld; use read (asks for approval)\n";
      paths.push(gitPath(pair[1]!).slice(2), gitPath(pair[2]!).slice(2));
    } else paths.push(gitPath(header.replace(/^diff --(?:cc|combined) /, "")));
    for (const match of section.matchAll(/^(?:rename|copy) (?:from|to) (.*)$/gm)) paths.push(gitPath(match[1]!));
    return paths.some(path => isSensitivePath(path))
      ? "[router_git] sensitive diff section withheld; use read (asks for approval)\n" : section;
  }).join("");
}
