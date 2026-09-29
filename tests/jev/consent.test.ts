import { debrief } from "./cli.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { startJevStub } from "./stub.js";

describe("turning Jev on", () => {
  test("J2: the enable step shows what is sent, to whom and TypeSafe's retention; consent is recorded; a repository can opt out", async () => {
    const stub = await startJevStub();
    const repo = initRepo();
    const other = initRepo();
    const home = tempDir();
    const env = { TYPESAFE_API_KEY: "test-key-J2", DEBRIEF_JEV_ENDPOINT: stub.url };

    // Off by default.
    expect((await debrief(env, repo, home, "jev")).stdout).toMatch(/jev +off/);

    // Without a terminal and without --yes nothing is recorded, and nothing is sent anywhere.
    const asked = await debrief(env, repo, home, "jev", "enable");
    expect(asked.code).toBe(64);
    const screen = asked.stdout;
    expect(screen).toContain("TypeSafe AI");
    expect(screen).toContain(stub.url);
    expect(screen).toContain("jev-1.13.0");
    expect(screen).toMatch(/what is sent/);
    expect(screen).toMatch(/memory's title and text/);
    expect(screen).toMatch(/git diff <commit> -- <file>/);
    expect(screen).toMatch(/never sent/);
    expect(screen).toMatch(/private sessions/);
    expect(screen).toMatch(/sensitive paths/);
    expect(screen).toMatch(/withheld/);
    expect(screen).toMatch(/redacted/);
    expect(screen).toMatch(/retention/);
    expect(screen).toMatch(/as long as necessary/);
    expect(screen).toMatch(/zero data retention/i);
    expect(screen).toMatch(/not train/);
    expect(screen).toContain("$0.042");
    expect(asked.stderr).toMatch(/--yes/);
    expect(existsSync(join(home, "jev.json"))).toBe(false);
    expect(stub.requests).toEqual([]);

    // Without a key there is nothing to enable with.
    const keyless = await debrief({ DEBRIEF_JEV_ENDPOINT: stub.url }, repo, home, "jev", "enable", "--yes");
    expect(keyless.code).toBe(1);
    expect(keyless.stderr).toMatch(/TYPESAFE_API_KEY/);
    expect(existsSync(join(home, "jev.json"))).toBe(false);

    // Confirmed: the key is checked once (the enable step's only request), then consent is recorded.
    const enabled = await debrief(env, repo, home, "jev", "enable", "--yes");
    expect(enabled.code, enabled.stderr).toBe(0);
    expect(stub.requests.map((r) => `${r.method} ${r.path} ${r.key}`)).toEqual(["GET /v1/models test-key-J2"]);
    const consent = JSON.parse(readFileSync(join(home, "jev.json"), "utf8")) as Record<string, unknown>;
    expect(consent).toMatchObject({ enabled: true, endpoint: stub.url, model: "jev-1.13.0", excluded: [] });
    expect(typeof consent["consentedAt"]).toBe("string");
    for (const out of [asked, enabled]) expect(out.stdout + out.stderr).not.toContain("test-key-J2");
    expect(readFileSync(join(home, "jev.json"), "utf8")).not.toContain("test-key-J2");

    expect((await debrief(env, repo, home, "jev")).stdout).toMatch(/jev +on/);
    // Consent is for the endpoint shown: another endpoint is off until enabled for it.
    expect((await debrief({ ...env, DEBRIEF_JEV_ENDPOINT: "http://127.0.0.1:9" }, repo, home, "jev")).stdout).toMatch(/jev +off/);

    // Per-repository opt-out: this repository only.
    expect((await debrief(env, repo, home, "jev", "disable", "--here")).code).toBe(0);
    expect((await debrief(env, repo, home, "jev")).stdout).toMatch(/jev +off in this repository/);
    expect((await debrief(env, other, home, "jev")).stdout).toMatch(/jev +on/);
    expect((await debrief(env, repo, home, "jev", "enable", "--here")).code).toBe(0);
    expect((await debrief(env, repo, home, "jev")).stdout).toMatch(/jev +on/);

    // Off everywhere.
    expect((await debrief(env, repo, home, "jev", "disable")).code).toBe(0);
    expect((await debrief(env, other, home, "jev")).stdout).toMatch(/jev +off/);
    // Re-including a repository needs consent first.
    const include = await debrief(env, repo, home, "jev", "enable", "--here");
    expect(include.code).toBe(1);
    expect(include.stderr).toMatch(/debrief jev enable/);
    // Only the one key check ever connected.
    expect(stub.requests).toHaveLength(1);
  });
});
