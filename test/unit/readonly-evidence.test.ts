import { describe, expect, it } from "vitest";
import { scrubReadOnlyEvidence } from "../smoke/helpers/readonly-evidence";

describe("QA-77-P10 evidence redaction", () => {
  it("redacts long/short Windows paths, POSIX paths and embedded user paths", () => {
    const result = scrubReadOnlyEvidence({
      advertised: ["read", "router_git_status"],
      permissions: ["C:\\Users\\Marquinho\\data\\*", "C:/Users/MARQUI~1/data/*", "/home/alice/private/*", "*.env", "*\\id_*"],
      text: "path C:\\Users\\Alice\\data and MARQUI~1", allowed: true,
    });
    expect(result).toEqual({ advertised: ["read", "router_git_status"], permissions: ["<absolute-path>", "<absolute-path>", "<absolute-path>", "*.env", "*\\id_*"], text: "path <home>\\data and <short-name>", allowed: true });
    expect(JSON.stringify(result)).not.toMatch(/Marquinho|MARQUI~1|Alice|alice/);
  });
});
