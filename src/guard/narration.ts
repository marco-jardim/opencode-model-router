/** Regex patterns that flag progress narration without production. */
export const NARRATION_PATTERNS: RegExp[] = [
  // "Still writing the X", "Still implementing the Y"
  /\bstill\s+(writing|implementing|working on|adding|creating|fixing|building|refactoring|handling)\s+(the\s+)?\w+/gi,
  // "Now I'll write the X", "Now writing the Y"
  /\bnow\s+(i['']ll\s+)?(writ|implement|add|creat|work|fix|build|handl|refactor|updat|mov)\w*\s+(the\s+)?\w+/gi,
  // "Let me write X", "Let me implement Y"
  /\blet\s+me\s+(write|implement|add|create|fix|build|handle|refactor|work on|move|update|set up)\s+(the\s+)?\w+/gi,
  // "I'll write the X", "I'll now implement Y"
  /\bi['']ll\s+(now\s+)?(write|implement|add|create|fix|build|handle|refactor|set up|work on|move|update)\s+(the\s+)?\w+/gi,
  // "Going to fix the X"
  /\bgoing\s+to\s+(write|implement|add|create|fix|build|handle|refactor|set up|work on|move|update)\s+(the\s+)?\w+/gi,
  // "Continuing with X", "Continuing by adding Y"
  /\bcontinuing\s+(with|by\s+\w+ing)\s+(the\s+)?\w+/gi,
];

/** Returns matched narration phrases, deduped and capped. Empty array = no narration detected. */
export function detectNarration(text: string): string[] {
  if (text.length < 20) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of NARRATION_PATTERNS) {
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const m of matches) {
      const trimmed = m.trim().toLowerCase();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(m.trim());
      if (out.length >= 5) return out;
    }
  }
  return out;
}
