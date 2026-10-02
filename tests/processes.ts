import { spawnSync } from "node:child_process";

/**
 * What tests ask the operating system about processes: children, memory, liveness. `ps` on macOS
 * and Linux; on Windows, which has neither `ps` nor `pgrep`, PowerShell's process table.
 */

export interface ProcessEntry {
  pid: number;
  parent: number;
  command: string;
}

/** Every process whose command line contains `match`, with its parent. */
export function processesMatching(match: string): ProcessEntry[] {
  if (process.platform === "win32") {
    // Filtered by WMI itself, which is several times faster than listing every process.
    const like = match.replace(/[[\]%_']/g, (c) => (c === "'" ? "''" : `[${c}]`));
    const script = `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${like}%' AND ProcessId != $PID" | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }`;
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30_000 });
    return parse(run.stdout, match);
  }
  return parse(spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout, match);
}

function parse(table: string, match: string): ProcessEntry[] {
  return table
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && (m[3] ?? "").includes(match))
    .map((m) => ({ pid: Number(m[1]), parent: Number(m[2]), command: m[3] ?? "" }));
}

/** Children of `parent` whose command line contains `match`. */
export function childrenMatching(parent: number, match: string): ProcessEntry[] {
  return processesMatching(match).filter((entry) => entry.parent === parent);
}

/** Resident memory of `pid` in MB (the working set on Windows). */
export function rssMb(pid: number): number {
  if (process.platform === "win32") {
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" });
    return Number(run.stdout.trim()) / 1024 / 1024;
  }
  return Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) / 1024;
}

/** Whether `pid` is a running process. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
