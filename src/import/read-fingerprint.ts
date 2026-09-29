import { createHash } from "node:crypto";
import { linesFingerprint } from "../retrieval/freshness.js";
import type { FileRead, OutputFacts } from "./normalized-event.js";

/**
 * The fingerprint of the text an imported file read showed the model (#54), so the read's
 * reference can be labelled like a live one: `current` while the file still holds that text,
 * `stale` once it does not. The text is the tool result the model saw (Claude Code's
 * `message.content`, Codex's shell output), never a host's copy of the file, and only hashes
 * leave this module.
 *
 * The rebuild is exact or there is no fingerprint, and the reference stays `unknown`:
 * - **Line-number prefixes** (`Read`, `nl -ba`, `cat -n`) are stripped only when every line
 *   carries the number expected next, starting where the read started.
 * - **Whole file:** a `Read` whose window is the whole file (first line, and as many lines as
 *   the file has), or Codex `cat F`, gives the file's SHA-256 (`observedHash`), since the
 *   output is its bytes: Claude Code shows a final newline as a last, empty line.
 * - **A line range** gives the cited-lines fingerprint (`citedHash`), and only with at least
 *   {@link MIN_RANGE_LINES} non-blank lines: fewer name no place in a file reliably.
 * - **Claude Code trims shell output:** it drops leading blank lines and trims the end. A
 *   `sed -n 'a,bp'` / `head -n N` read is therefore placed by the range the command asked for:
 *   when lines are missing, the text is stored as lying within that range with only blank lines
 *   around it (`citedLines`), because which edge lost how many, or whether the file ended, cannot
 *   be told from a line count. A whole file printed through Claude Code's shell has lost its
 *   edges and gets nothing. Codex output is byte-exact and needs none of this.
 * - **Disqualified:** output the host did not deliver whole (truncated, persisted, an image,
 *   interrupted, with stderr or a host note; see `OutputFacts.intact`), a failed call, a `Read`
 *   line over {@link LONG_LINE} characters (Claude Code may cut those), and more lines than the
 *   command asked for. Shapes the adapters do not recognise (several files, `echo` separators,
 *   regex or step ranges, chained reads) never get a {@link FileRead} at all.
 *
 * Known limit: a range read shows only its lines, so unlike a live citation its text cannot be
 * checked to occur once in the file when read. Text found more than once at recall is never
 * current; text that occurred twice then and whose read copy was edited since reads as moved to
 * the other copy (the same class as the live rule's "text is identity" limit).
 */

export const MIN_RANGE_LINES = 3;
export const LONG_LINE = 2000;

export type ReadFingerprint =
  | { observedHash: string }
  | { lines: [number, number]; citedHash: string; citedBytes: number; citedLines?: number };

const BLANK = /^[\t\v\f\r ]*$/;
const NUMBERED = /^( *)(\d+)\t/;

/** The fingerprint of what `read` showed, from the result's text and the host's facts about it; null when it cannot be rebuilt exactly. */
export function readFingerprint(read: FileRead, text: string, output: OutputFacts | undefined): ReadFingerprint | null {
  if (output?.intact !== true) return null;
  if (read.format === "read_tool") return readTool(text, output.window);
  if (text === "") return null;
  return read.trimmed ? trimmedShell(read, text) : exactShell(read, text);
}

function readTool(text: string, window: OutputFacts["window"]): ReadFingerprint | null {
  if (window === undefined || window.numLines < 1) return null;
  const lines = unnumber(text.split("\n"), window.startLine);
  if (lines === null || lines.length !== window.numLines || lines.some((line) => line.length > LONG_LINE)) return null;
  if (window.startLine === 1 && window.numLines === window.totalLines) return whole(lines.join("\n"));
  return range(window.startLine, lines);
}

/** Byte-exact output: every printed line ends with a newline, except a file's last line without one. */
function exactShell(read: FileRead, text: string): ReadFingerprint | null {
  const printed = text.split("\n");
  if (text.endsWith("\n")) printed.pop();
  const first = read.lines?.[0] ?? 1;
  const lines = read.format === "numbered" ? unnumber(printed, first) : printed;
  if (lines === null || (read.lines !== undefined && lines.length > read.lines[1] - read.lines[0] + 1)) return null;
  if (read.format === "plain" && read.lines === undefined) return whole(text);
  return range(first, lines);
}

/** Claude Code's shell output: leading blank lines dropped, the end trimmed. */
function trimmedShell(read: FileRead, text: string): ReadFingerprint | null {
  const printed = text.split("\n");
  if (read.format === "numbered") {
    // Numbered lines are never blank, so nothing was dropped at the start; a last line whose
    // content was only whitespace lost it to trimming (and its tab with it), so it is left out.
    if (/^ *\d+$/.test(printed.at(-1) ?? "")) printed.pop();
    const first = read.lines?.[0] ?? 1;
    const lines = unnumber(printed, first);
    if (lines === null || (read.lines !== undefined && lines.length > read.lines[1] - read.lines[0] + 1)) return null;
    return range(first, lines);
  }
  if (read.lines === undefined) return null;
  const [start, end] = read.lines;
  const span = end - start + 1;
  if (printed.length > span) return null;
  return printed.length === span ? range(start, printed) : range(start, printed, read.lines);
}

/** The lines without their `N\t` prefixes (right-aligned in 6 columns, or not padded), numbered from `first`; null unless every number is the one expected. */
function unnumber(lines: readonly string[], first: number): string[] | null {
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const match = NUMBERED.exec(line);
    const digits = match?.[2] ?? "";
    const pad = match?.[1]?.length ?? -1;
    if (match === null || Number(digits) !== first + i || (pad !== 0 && pad !== Math.max(0, 6 - digits.length))) return null;
    out.push(line.slice(match[0].length));
  }
  return out;
}

function whole(text: string): ReadFingerprint {
  return { observedHash: `sha256:${createHash("sha256").update(text).digest("hex")}` };
}

/** Lines from `start`; with `within`, lines some blank edges of that range were trimmed from. */
function range(start: number, lines: readonly string[], within?: [number, number]): ReadFingerprint | null {
  if (lines.filter((line) => !BLANK.test(line)).length < MIN_RANGE_LINES) return null;
  const cited = linesFingerprint(lines);
  if (within !== undefined) return { lines: within, citedHash: cited.hash, citedBytes: cited.bytes, citedLines: lines.length };
  return { lines: [start, start + lines.length - 1], citedHash: cited.hash, citedBytes: cited.bytes };
}
