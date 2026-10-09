import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import { assembleSystemPrompt, buildDelegationProtocol } from "../../src/router/protocol";
it("measures shipped prompts", () => {
  const cfg = validateConfig(JSON.parse(readFileSync("tiers.json", "utf8")));
  expect({ base: buildDelegationProtocol(cfg).length, claude: assembleSystemPrompt(cfg, "anthropic/claude-sonnet-4-6").length, enforcement: assembleSystemPrompt(cfg, "anthropic/claude-sonnet-4-6", true).length }).toEqual({ base: 3249, claude: 4021, enforcement: 6357 });
});
