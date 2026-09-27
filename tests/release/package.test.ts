import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { initRepo, tempDir } from "../helpers.js";
import { CLAUDE_PINNED_VERSION } from "../mcp/claude.js";
import { CLI, spawnServer } from "../mcp/harness.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** The packages esbuild inlined, read from the shipped bundle itself: each inlined module keeps a `// node_modules/<package>/…` comment. */
function bundledPackages(): string[] {
  const names = new Set<string>();
  for (const [line] of readFileSync(CLI, "utf8").matchAll(/^\/\/ node_modules\/.+$/gm)) {
    const last = line.slice(line.lastIndexOf("node_modules/") + "node_modules/".length).split("/");
    names.add(last[0]?.startsWith("@") === true ? `${last[0]}/${last[1] ?? ""}` : (last[0] ?? ""));
  }
  return [...names].sort();
}

function licenseText(name: string): string {
  const dir = join(ROOT, "node_modules", name);
  const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry));
  if (file === undefined) throw new Error(`${name} has no license file`);
  return readFileSync(join(dir, file), "utf8").trim();
}

describe("the published package", () => {
  test("ships the MIT license and a notice carrying the license text of every package bundled into the CLI", () => {
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" })) as [{ files: { path: string }[] }];
    expect(packed.files.map((file) => file.path).sort()).toEqual(["LICENSE", "README.md", "dist/THIRD_PARTY_NOTICES.md", "dist/debrief.mjs", "package.json"]);

    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { license?: string };
    expect(manifest.license).toBe("MIT");
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Ayush Rangrej\n/);

    const bundled = bundledPackages();
    expect(bundled).toEqual(expect.arrayContaining(["@modelcontextprotocol/sdk", "zod"]));
    const notices = readFileSync(join(ROOT, "dist/THIRD_PARTY_NOTICES.md"), "utf8");
    const sections = notices.split(/^(?=## )/m).slice(1);
    expect(sections.map((section) => /^## (\S+?)@/.exec(section)?.[1]).sort()).toEqual(bundled);
    for (const name of bundled) {
      const section = sections.find((s) => s.startsWith(`## ${name}@`)) ?? "";
      expect(section, name).toContain(licenseText(name));
    }
    // better-sqlite3 is installed as its own package with its own license, never inlined.
    expect(bundled).not.toContain("better-sqlite3");
  });

  test("is ready to publish: public, one version in the package, the plugin and the MCP server, and a support matrix that matches what the tests pin", async () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown> & { version: string; dependencies: Record<string, string>; engines: { node: string } };
    expect(manifest["private"]).toBeUndefined();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).not.toBe("0.0.0");
    expect(manifest).toMatchObject({
      name: "debrief-cli",
      repository: { type: "git", url: "git+https://github.com/0xAysh/debrief.git" },
      homepage: "https://github.com/0xAysh/debrief#readme",
      bugs: { url: "https://github.com/0xAysh/debrief/issues" },
    });
    expect(manifest["keywords"]).toEqual(expect.arrayContaining(["claude-code", "mcp", "memory"]));
    // npm publish ships whatever dist/ holds: it must be rebuilt from this checkout first.
    expect((manifest["scripts"] as Record<string, string>)["prepublishOnly"]).toBe("npm run build");

    const plugin = JSON.parse(readFileSync(join(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
    expect(plugin.version).toBe(manifest.version);
    const server = await spawnServer({ cwd: initRepo(), home: tempDir() });
    expect(server.client.getServerVersion()).toMatchObject({ name: "debrief", version: manifest.version });
    await server.close();

    // The README's support matrix names exactly the versions the package and the driven tests pin.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const nodePin = readFileSync(join(ROOT, ".node-version"), "utf8").trim();
    expect(readme).toContain(`| Node.js | \`${manifest.engines.node}\` | ${nodePin} |`);
    expect(readme).toContain(`| better-sqlite3 | \`${manifest.dependencies["better-sqlite3"]}\` (installed with the package) | ${manifest.dependencies["better-sqlite3"]} |`);
    expect(readme).toContain(`| Claude Code | \`${CLAUDE_PINNED_VERSION}\` | ${CLAUDE_PINNED_VERSION} |`);
  });
});
