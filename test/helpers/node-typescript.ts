/** The plain-node stats CLI needs default TS stripping (22.18+, 23.6+, 24+).
 * Vitest still transpiles the module-level tests on older supported Node versions.
 */
export function supportsPlainNodeTypeScript(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}
