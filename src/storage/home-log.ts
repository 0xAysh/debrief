import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A small JSON-lines log in `$MEMCHOR_HOME`, for what hooks must write before (or without) a
 * workspace database. Writers append without a lock: each append is one small write, and a full
 * log becomes `<name>.1.jsonl` by an atomic rename (replacing the previous one), so a trim never
 * races another writer's line. Two writers rotating at once can drop the older file early; what
 * these logs hold tolerates that.
 */
export interface HomeLog {
  /** Appends one entry. Never throws: callers are hooks that must not fail over it. */
  append(home: string, entry: object): boolean;
  /** Every line, oldest first (the rotated file, then the current one); a missing or unreadable file has none. */
  lines(home: string): string[];
}

export function homeLog(name: string, maxBytes: number): HomeLog {
  const file = `${name}.jsonl`;
  const rotated = `${name}.1.jsonl`;
  return {
    append(home, entry) {
      try {
        mkdirSync(home, { recursive: true });
        const path = join(home, file);
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        if (statSync(path).size > maxBytes) renameSync(path, join(home, rotated));
        return true;
      } catch {
        return false;
      }
    },
    lines(home) {
      const lines: string[] = [];
      for (const name of [rotated, file]) {
        try {
          lines.push(...readFileSync(join(home, name), "utf8").split("\n").filter(Boolean));
        } catch {
          // Missing or unreadable: nothing from it.
        }
      }
      return lines;
    },
  };
}
