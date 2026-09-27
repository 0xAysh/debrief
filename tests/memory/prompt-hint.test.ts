import { describe, expect, test } from "vitest";
import { openMemory, type Memory } from "../../src/memory.js";
import { initRepo, onCleanup, tempDir } from "../helpers.js";

function open(cwd: string): Memory {
  const memory = openMemory({ cwd, home: tempDir(), host: "claude-code" });
  onCleanup(() => {
    memory.close();
  });
  return memory;
}

const HINT = "Debrief: the user's wording may state a lasting preference. If it does, propose it with memory_record kind preference at the end of the turn; never for a one-off instruction.";

describe("promptHint: one line for the agent when a prompt states a lasting preference", () => {
  const lasting = [
    "From now on, run the tests with --runInBand.",
    "Always use pnpm in this repo.",
    "Never commit directly to main.",
    "Fix the flaky test. And please never touch the lockfile.",
    "you should always squash before merging",
    "Remember to update the changelog when you touch the API.",
    "I prefer small commits with one change each.",
    "Going forward, write the failing test first.",
    "In future, ask before running migrations.",
  ];
  const oneOff = [
    "The build always fails on CI, find out why.",
    "This never worked on Windows?",
    "Do you remember what we decided about retries?",
    "Fix the retry loop in the gateway client.",
    "What does this do?\n```sh\n# Always run lint first\nnpm run lint\n```",
    "<private>From now on use yarn.</private> Fix the build.",
    "Never mind, fix the retry loop instead.",
    "Did you remember to push the branch?",
    "This breaks in the future when the key rotates.",
    "What would you prefer here, a map or a switch?",
  ];

  test.each(lasting)("hints on %j", (prompt) => {
    expect(open(initRepo()).promptHint({ prompt })).toBe(HINT);
  });

  test.each(oneOff)("stays quiet on %j", (prompt) => {
    expect(open(initRepo()).promptHint({ prompt })).toBeNull();
  });

  test("outside a Git repository it stays quiet", () => {
    expect(open(tempDir()).promptHint({ prompt: "From now on, use pnpm." })).toBeNull();
  });
});
