import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Enumerate the OS process table once and return descendants of the given
 * root PIDs (children, grandchildren, …). Used by the scheduler's periodic
 * snapshot so a hard-killed server can still reap agent tool processes whose
 * immediate parents have already died (ADR-0005).
 *
 * Windows: one CIM query. POSIX: one `ps` call. Both are best-effort; a
 * failure returns an empty map (the recorded session PID is still swept).
 */
export async function snapshotDescendants(rootPids: number[]): Promise<Map<number, number[]>> {
  const roots = rootPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  const result = new Map<number, number[]>();
  if (roots.length === 0) return result;

  const parentOf = await readProcessTable();
  if (parentOf.size === 0) return result;

  const childrenOf = new Map<number, number[]>();
  for (const [pid, ppid] of parentOf) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid)?.push(pid);
  }

  for (const root of roots) {
    const found: number[] = [];
    const queue = [...(childrenOf.get(root) ?? [])];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      found.push(pid);
      for (const child of childrenOf.get(pid) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    result.set(root, found);
  }
  return result;
}

/** pid → parent pid for the whole machine. */
async function readProcessTable(): Promise<Map<number, number>> {
  const table = new Map<number, number>();
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
        ],
        { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim() || "[]") as
        | Array<{ ProcessId: number; ParentProcessId: number }>
        | { ProcessId: number; ParentProcessId: number };
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      for (const row of rows) {
        if (typeof row.ProcessId === "number" && typeof row.ParentProcessId === "number") {
          table.set(row.ProcessId, row.ParentProcessId);
        }
      }
      return table;
    }
    const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid="], { timeout: 8000 });
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
    }
    return table;
  } catch {
    return table;
  }
}
