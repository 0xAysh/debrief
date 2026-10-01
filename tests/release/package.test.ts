import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { MODEL, RUNTIME_FILES, RUNTIME_NOTICES } from "../../src/embedding/model.js";
import type { ContextPack, StatusResult } from "../../src/memory.js";
import { initRepo, npmCommand, tempDir } from "../helpers.js";
import { CLAUDE_PINNED_VERSION } from "../mcp/claude.js";
import { CLI, spawnServer } from "../mcp/harness.js";
import { PAYMENTS_SERVICE } from "../memory/meaning-fixture.js";
import { childrenMatching } from "../processes.js";

const ROOT = resolve(import.meta.dirname, "../..");
/** The model's process, bundled beside the CLI. */
const EMBEDDER = join(dirname(CLI), "embedder.mjs");

/** The packages esbuild inlined, read from a shipped bundle itself: each inlined module keeps a `// node_modules/<package>/…` comment. */
function bundledPackages(bundle = CLI): string[] {
  const names = new Set<string>();
  for (const [line] of readFileSync(bundle, "utf8").matchAll(/^\/\/ node_modules\/.+$/gm)) {
    const last = line.slice(line.lastIndexOf("node_modules/") + "node_modules/".length).split("/");
    names.add(last[0]?.startsWith("@") === true ? `${last[0]}/${last[1] ?? ""}` : (last[0] ?? ""));
  }
  return [...names].sort();
}

/** A package's license text; ONNX Runtime publishes its packages without one, so the build keeps it in scripts/licenses/. */
function licenseText(name: string): string {
  const dir = join(ROOT, "node_modules", name);
  const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry));
  if (file !== undefined) return readFileSync(join(dir, file), "utf8").trim();
  if (name.startsWith("onnxruntime-")) return readFileSync(join(ROOT, "scripts/licenses/onnxruntime.txt"), "utf8").trim();
  throw new Error(`${name} has no license file`);
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Runs `scripts/bundle.mjs` in `dir` (a copy of this checkout's compiled `dist/`), fetching ONNX Runtime's notices from `noticesUrl`. */
function bundleIn(dir: string, noticesUrl: string): Promise<{ status: number; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [join(ROOT, "scripts/bundle.mjs")], { cwd: dir, env: { ...process.env, DEBRIEF_TEST_RUNTIME_NOTICES_URL: noticesUrl } }, (error, _stdout, stderr) => {
      done({ status: typeof error?.code === "number" ? error.code : error === null ? 0 : 1, stderr });
    });
  });
}

describe("the published package", () => {
  test("ships the MIT license and a notice carrying the license text of every package bundled into the CLI", () => {
    const [packed] = JSON.parse(execFileSync(...npmCommand(["pack", "--dry-run", "--json", "--ignore-scripts"]), { cwd: ROOT, encoding: "utf8" })) as [{ files: { path: string }[] }];
    expect(packed.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "README.md",
      `dist/${RUNTIME_NOTICES.name}`,
      "dist/THIRD_PARTY_NOTICES.md",
      "dist/debrief.mjs",
      "dist/embedder.mjs",
      ...MODEL.files.map((file) => `dist/${MODEL.directory}/${file.name}`).sort(),
      ...RUNTIME_FILES.map((name) => `dist/${name}`).sort(),
      "package.json",
    ]);

    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { license?: string };
    expect(manifest.license).toBe("MIT");
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Ayush Rangrej\n/);

    const bundled = [...new Set([...bundledPackages(CLI), ...bundledPackages(EMBEDDER)])].sort();
    expect(bundled).toEqual(expect.arrayContaining(["@modelcontextprotocol/sdk", "zod", "onnxruntime-web", "@huggingface/tokenizers"]));
    // What every hook loads carries nothing of the model's runtime.
    expect(bundledPackages(CLI).filter((name) => name.startsWith("onnxruntime") || name.startsWith("@huggingface/"))).toEqual([]);
    const notices = readFileSync(join(ROOT, "dist/THIRD_PARTY_NOTICES.md"), "utf8");
    const sections = notices.split(/^(?=## )/m).slice(1);
    expect(sections.map((section) => /^## (\S+?)@/.exec(section)?.[1]).sort()).toEqual([...bundled, MODEL.repository].sort());
    for (const name of bundled) {
      const section = sections.find((s) => s.startsWith(`## ${name}@`)) ?? "";
      expect(section, name).toContain(licenseText(name));
    }
    // The model: Apache-2.0, at the pinned revision.
    const model = sections.find((s) => s.startsWith(`## ${MODEL.repository}@${MODEL.revision} (Apache-2.0)`)) ?? "";
    expect(model).toContain("Apache License\n                           Version 2.0, January 2004");
    // better-sqlite3 is installed as its own package with its own license, never inlined.
    expect(bundled).not.toContain("better-sqlite3");
  });

  test("M21: the tarball carries the pinned model and the runtime's WebAssembly, runs no install script, and its debrief mcp searches by meaning with only better-sqlite3 installed", async () => {
    const dir = tempDir("debrief-tarball-");
    const tarball = execFileSync(...npmCommand(["pack", "--pack-destination", dir, "--silent"]), { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
    // Run in `dir` with a bare name: GNU tar reads `C:\…` as a remote host.
    execFileSync("tar", ["-xzf", tarball], { cwd: dir });
    const pkg = join(dir, "package");
    for (const file of MODEL.files) expect(sha256(join(pkg, "dist", MODEL.directory, file.name)), file.name).toBe(file.sha256);
    for (const name of RUNTIME_FILES) expect(sha256(join(pkg, "dist", name)), name).toBe(sha256(join(ROOT, "node_modules/onnxruntime-web/dist", name)));
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies: Record<string, string> };
    expect(Object.keys(manifest.scripts ?? {}).filter((name) => /^(pre|post)?install$/.test(name))).toEqual([]);
    expect(Object.keys(manifest.dependencies)).toEqual(["better-sqlite3"]);

    mkdirSync(join(pkg, "node_modules"));
    symlinkSync(join(ROOT, "node_modules/better-sqlite3"), join(pkg, "node_modules/better-sqlite3"), "junction");
    const networkLog = join(tempDir(), "network.log");
    const server = await spawnServer({ cwd: initRepo(), home: tempDir(), host: "claude-code", meaning: true, cli: join(pkg, "dist/debrief.mjs"), networkLog });
    await server.ok("memory_bootstrap", { importChoice: "none" });
    for (const record of PAYMENTS_SERVICE.slice(0, 16)) await server.ok("memory_record", { kind: record.kind, body: record.body, attribution: "agent_inference" });
    for (const deadline = Date.now() + 60_000; ; ) {
      const { meaning } = await server.ok<StatusResult>("memory_status");
      if (meaning?.coverage?.percent === 100) break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 100));
    }
    const pack = await server.ok<ContextPack>("memory_recall", { query: "socket resets" });
    expect(pack.items[0]).toMatchObject({ why: "meaning", excerpt: expect.stringMatching(/^ECONNRESET/) as unknown });
    // The model ran from the unpacked package, not from this checkout.
    expect(childrenMatching(server.pid, "embedder.mjs").map((entry) => entry.command)).toEqual([expect.stringContaining(join(pkg, "dist", "embedder.mjs"))]);
    await server.close();
    expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
  });

  test("L1: the tarball carries ONNX Runtime's third-party notices, matching their pin", () => {
    const dir = tempDir("debrief-tarball-");
    const tarball = execFileSync(...npmCommand(["pack", "--pack-destination", dir, "--silent"]), { cwd: ROOT, encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
    execFileSync("tar", ["-xzf", tarball], { cwd: dir });
    const shipped = join(dir, "package/dist", RUNTIME_NOTICES.name);
    expect(sha256(shipped)).toBe(RUNTIME_NOTICES.sha256);
    expect(readFileSync(shipped, "utf8")).toMatch(/^THIRD PARTY SOFTWARE NOTICES AND INFORMATION\n/);
  });

  test("L2: THIRD_PARTY_NOTICES.md's onnxruntime-web section names the notices file shipped beside it, not a link to GitHub", () => {
    const notices = readFileSync(join(ROOT, "dist/THIRD_PARTY_NOTICES.md"), "utf8");
    const section = notices.split(/^(?=## )/m).find((s) => s.startsWith("## onnxruntime-web@")) ?? "";
    expect(section).toContain(`\`dist/${RUNTIME_NOTICES.name}\``);
    expect(section).not.toMatch(/https?:\/\/\S*ThirdPartyNotices/);
    expect(notices).not.toContain("github.com/microsoft/onnxruntime/blob/");
  });

  test("L3: a corrupted cached copy of ONNX Runtime's notices is fetched again, and a fetched copy that does not match its pin fails the build", async () => {
    const real = readFileSync(join(ROOT, "dist", RUNTIME_NOTICES.name));
    let body: Buffer = Buffer.concat([real, Buffer.from("\ntampered\n")]);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end(body);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ThirdPartyNotices.txt`;
    try {
      // A build directory: this checkout's compiled dist/ (without the notices), its packages and its cached model.
      const dir = tempDir("debrief-build-");
      cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
      rmSync(join(dir, "dist", RUNTIME_NOTICES.name));
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
      symlinkSync(join(ROOT, "scripts"), join(dir, "scripts"));
      mkdirSync(join(dir, ".cache"));
      symlinkSync(join(ROOT, ".cache/models"), join(dir, ".cache/models"));
      const cached = join(dir, ".cache/onnxruntime", RUNTIME_NOTICES.tag, RUNTIME_NOTICES.source);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, real.subarray(0, 1000));

      // The corrupted cache is fetched again; what arrives does not match the pin, so the build fails and ships nothing.
      const tampered = await bundleIn(dir, url);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain(`not the pinned ${RUNTIME_NOTICES.sha256}`);
      expect(requests).toBe(1);
      expect(existsSync(join(dir, "dist", RUNTIME_NOTICES.name))).toBe(false);
      expect(readFileSync(cached)).toEqual(real.subarray(0, 1000));

      // The pinned file arrives: the cache is repaired and the file shipped.
      body = real;
      const fixed = await bundleIn(dir, url);
      expect(fixed.stderr).toBe(`bundle: fetching ${url}\n`);
      expect(fixed.status).toBe(0);
      expect(requests).toBe(2);
      expect(sha256(cached)).toBe(RUNTIME_NOTICES.sha256);
      expect(sha256(join(dir, "dist", RUNTIME_NOTICES.name))).toBe(RUNTIME_NOTICES.sha256);

      // A good cached copy is used as it is: no network.
      expect(await bundleIn(dir, url)).toEqual({ status: 0, stderr: "" });
      expect(requests).toBe(2);
    } finally {
      server.close();
    }
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

  test("V5: the docs name the Claude Code build the driven tests pin, wherever they say what was verified", () => {
    // Every "Claude Code <version>" (or "Claude Code `<version>`") in these docs is a claim the
    // driven suites back, as is the last column of the hosts table; a bump must carry all of them.
    const claimed = (file: string): (string | undefined)[] => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const prose = [...text.matchAll(/Claude Code `?(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      const table = [...text.matchAll(/^\| Claude Code[^\n]*\| `?(\d+\.\d+\.\d+)`? \|$/gm)].map((m) => m[1]);
      return [...prose, ...table];
    };
    for (const file of ["README.md", "docs/hosts.md", "docs/development.md"]) {
      const versions = claimed(file);
      expect(versions.length, `${file} names no Claude Code version`).toBeGreaterThan(0);
      expect(new Set(versions), file).toEqual(new Set([CLAUDE_PINNED_VERSION]));
    }
    // The hosts table links to the by-hand section, whose heading (and so its anchor) carries the version.
    const hosts = readFileSync(join(ROOT, "docs/hosts.md"), "utf8");
    expect(hosts).toContain(`## Connect Claude Code by hand (verified with Claude Code ${CLAUDE_PINNED_VERSION})`);
    expect(hosts).toContain(`(#connect-claude-code-by-hand-verified-with-claude-code-${CLAUDE_PINNED_VERSION.replaceAll(".", "")})`);
  });
});
