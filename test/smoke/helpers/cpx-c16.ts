/** Test-only parsers for C16's process observation and stored tool-call evidence. */
export interface C16Process {
  pid: number; ppid: number; pgid: number | null; name: string; createdAt: string; commandLine: string;
}

export function parseC16Processes(text: string, platform: NodeJS.Platform): C16Process[] {
  if (platform === "win32") {
    const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return (Array.isArray(json) ? json : [json]).map(value => {
      const row = value as Record<string, unknown>;
      if (!row || !Number.isSafeInteger(row.ProcessId) || !Number.isSafeInteger(row.ParentProcessId) || typeof row.CreationDate !== "string" || !row.CreationDate) {
        throw new Error("incomplete Win32_Process identity");
      }
      return { pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), pgid: null,
        name: String(row.Name ?? ""), createdAt: row.CreationDate, commandLine: String(row.CommandLine ?? "") };
    });
  }
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) throw new Error(`invalid ps identity row: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      name: match[5]!.split(/\s/)[0]!.split("/").at(-1)!, createdAt: match[4]!.replace(/\s+/g, " "), commandLine: match[5]! };
  });
}

/** Match the executing call, not text in a prompt or an unrelated open tool. Missing status stays missing (never inferred). */
export function c16StoredTool(history: unknown, tool: string, callID?: string): { visible: boolean; status: string | null; entry: unknown } {
  const walk = (value: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) { const found = walk(item); if (found) return found; }
    } else if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if ((row.tool === tool || row.name === tool || row.toolName === tool) &&
        (callID === undefined || [row.id, row.callID, row.toolCallId, row.toolCallID].includes(callID))) return row;
      for (const key of ["parts", "content"]) { const found = walk(row[key]); if (found) return found; }
    }
    return undefined;
  };
  const entry = walk(history);
  const state = entry?.state as Record<string, unknown> | undefined;
  const status = state?.status ?? entry?.status;
  return { visible: entry !== undefined, status: typeof status === "string" ? status : null, entry: entry ?? null };
}
