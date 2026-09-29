import { spawn } from "node:child_process";

/**
 * A process spoken to in stream-json: one JSON message per line in, one per line out, where each
 * prompt ends with a `result` message. `claudeStream` drives `claude -p` with it. It imports only
 * Node built-ins, so a plain `node` child can load it (type stripping) to test it in isolation.
 */

export interface StreamRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface StreamJson {
  /** Sends a prompt without waiting for its result (it may never come: see `kill`). */
  post: (text: string) => void;
  /** Sends a prompt and resolves with its result. */
  send: (text: string) => Promise<Record<string, unknown>>;
  /** Closes stdin and resolves when the process exits. */
  end: () => Promise<StreamRun>;
  /** Kills the process (sandbox-exec execs Claude Code in place, so no hook runs after this). */
  kill: (signal: NodeJS.Signals) => Promise<StreamRun>;
}

export function streamJson(bin: string, argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): StreamJson {
  const child = spawn(bin, argv, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let seen = 0;
  /**
   * One slot per prompt written, oldest first; each result settles the oldest. A `post` holds a
   * slot that drops its result, and a `send` that timed out keeps its slot, so a late result is
   * never handed to the next prompt.
   */
  const waiting: ((result: Record<string, unknown>) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    lines.pop(); // the line still being written
    const results = lines.filter((line) => line.includes('"type":"result"')).map((line) => JSON.parse(line) as Record<string, unknown>).filter((message) => message["type"] === "result");
    while (seen < results.length) {
      const result = results[seen] ?? {};
      // Advanced outside the call: `waiting.shift()?.(results[seen++])` skipped its argument,
      // `seen++` included, when no slot was left, and spun here forever (46 hours, twice).
      seen++;
      waiting.shift()?.(result);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<StreamRun>((resolve) => child.on("close", (code) => { resolve({ code, stdout, stderr }); }));
  const write = (text: string): void => {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
  };
  return {
    post: (text) => {
      waiting.push(() => undefined);
      write(text);
    },
    send: (text) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`no result for ${JSON.stringify(text)}; stderr: ${stderr}`)); }, options.timeoutMs ?? 60_000);
        waiting.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
        write(text);
      }),
    end: () => {
      child.stdin.end();
      return closed;
    },
    kill: (signal) => {
      child.kill(signal);
      return closed;
    },
  };
}
