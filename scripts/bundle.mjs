#!/usr/bin/env node
/**
 * Bundles the compiled CLI into the one file `debrief` runs (`dist/debrief.mjs`, the package's
 * bin). Every hook is a new process: unbundled it loads 339 modules (Node built-ins included),
 * bundled 38, which saves about 27 ms of in-process time and 45 ms of CPU per hook (p50,
 * `npm run measure:hooks`, #32). better-sqlite3 stays external: it loads a native binding.
 *
 * Inlined packages no longer ship their own license files, and their licenses (MIT, ISC, BSD)
 * require the notice to travel with the code, so this also writes `dist/THIRD_PARTY_NOTICES.md`
 * from esbuild's own record of what it inlined. A package without a license file fails the build.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const { metafile } = await build({
  entryPoints: ["dist/cli.js"],
  outfile: "dist/debrief.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["better-sqlite3"],
  // Bundled CommonJS dependencies call require(); an ES module has none of its own.
  banner: { js: 'import { createRequire as __debriefRequire } from "node:module"; const require = __debriefRequire(import.meta.url);' },
  metafile: true,
  logLevel: "warning",
});

/** Package directory (`node_modules/<name>`, innermost when nested) of every input that reached the output. */
const packages = new Map();
for (const [input, { bytesInOutput }] of Object.entries(metafile.outputs["dist/debrief.mjs"].inputs)) {
  const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (match !== null && bytesInOutput > 0) packages.set(match[1], match[2]);
}

const sections = [...packages]
  .sort(([, a], [, b]) => a.localeCompare(b))
  .map(([dir, name]) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry));
    if (file === undefined) throw new Error(`${name} is bundled into dist/debrief.mjs but has no license file to carry in THIRD_PARTY_NOTICES.md`);
    const text = readFileSync(join(dir, file), "utf8").trim();
    return `## ${name}@${manifest.version} (${manifest.license ?? "license below"})\n\n\`\`\`text\n${text}\n\`\`\`\n`;
  });

writeFileSync(
  "dist/THIRD_PARTY_NOTICES.md",
  `# Third-party notices\n\n\`dist/debrief.mjs\` inlines the packages below; each is listed with its license text, as its license requires. better-sqlite3 is installed as its own dependency and carries its own license.\n\n${sections.join("\n")}`,
);
