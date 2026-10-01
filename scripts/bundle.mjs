#!/usr/bin/env node
/**
 * Bundles the compiled CLI into the one file `debrief` runs (`dist/debrief.mjs`, the package's
 * bin). Every hook is a new process: unbundled it loads 339 modules (Node built-ins included),
 * bundled 38, which saves about 27 ms of in-process time and 45 ms of CPU per hook (p50,
 * `npm run measure:hooks`, #32). better-sqlite3 stays external: it loads a native binding.
 *
 * Meaning search (ADR 0001) ships beside it, and nothing of it is in `debrief.mjs`, so hooks load
 * none of it: `dist/embedder.mjs` (the model's process: ONNX Runtime Web and the tokenizer), the
 * runtime's WebAssembly build (`ort-wasm-simd-threaded.{wasm,mjs}`) and the model's files under
 * `dist/models/`. The model is fetched from Hugging Face at the revision `src/embedding/model.ts`
 * pins, into `.cache/models/` (gitignored), and every file is checked against its pinned SHA-256
 * before it is copied: a mismatch fails the build. This is the only place Debrief touches the
 * network; the package carries the files, so `debrief` never downloads anything.
 *
 * Inlined packages no longer ship their own license files, and their licenses (MIT, ISC, BSD,
 * Apache-2.0) require the notice to travel with the code, so this also writes
 * `dist/THIRD_PARTY_NOTICES.md` from esbuild's own record of what it inlined, plus the model's
 * license. A package without a license file (or one in `scripts/licenses/`) fails the build.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { MODEL, RUNTIME_FILES } from "../dist/embedding/model.js";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS dependencies call require(); an ES module has none of its own.
  banner: { js: 'import { createRequire as __debriefRequire } from "node:module"; const require = __debriefRequire(import.meta.url);' },
  metafile: true,
  logLevel: "warning",
};

const cli = await build({ ...shared, entryPoints: ["dist/cli.js"], outfile: "dist/debrief.mjs", external: ["better-sqlite3"] });
const embedder = await build({ ...shared, entryPoints: ["dist/embedding/process.js"], outfile: "dist/embedder.mjs" });

for (const name of RUNTIME_FILES) copyFileSync(join("node_modules/onnxruntime-web/dist", name), join("dist", name));
await copyModel();

/** Package directory (`node_modules/<name>`, innermost when nested) of every input that reached an output. */
const packages = new Map();
for (const [metafile, output] of [
  [cli.metafile, "dist/debrief.mjs"],
  [embedder.metafile, "dist/embedder.mjs"],
]) {
  for (const [input, { bytesInOutput }] of Object.entries(metafile.outputs[output].inputs)) {
    const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (match !== null && bytesInOutput > 0) packages.set(match[1], match[2]);
  }
}
// The runtime's WebAssembly build is copied, not inlined, but it is onnxruntime-web's code all the same.
packages.set("node_modules/onnxruntime-web", "onnxruntime-web");

const sections = [...packages]
  .sort(([, a], [, b]) => a.localeCompare(b))
  .map(([dir, name]) => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const text = licenseOf(dir, name);
    const extra =
      name === "onnxruntime-web"
        ? `\nIts WebAssembly build (\`ort-wasm-simd-threaded.wasm\`) compiles in third-party components listed in ONNX Runtime's notices: https://github.com/microsoft/onnxruntime/blob/v${manifest.version}/ThirdPartyNotices.txt\n`
        : "";
    return `## ${name}@${manifest.version} (${manifest.license ?? "license below"})\n\n\`\`\`text\n${text}\n\`\`\`\n${extra}`;
  });

// The model is not a package; its license is Apache-2.0, whose text @huggingface/tokenizers carries verbatim.
const apache = readFileSync("node_modules/@huggingface/tokenizers/LICENSE", "utf8").trim();
const model = `## ${MODEL.repository}@${MODEL.revision} (${MODEL.license})\n\n\`dist/${MODEL.directory}/\` holds ${MODEL.files.map((file) => `\`${file.source}\``).join(", ")} of [${MODEL.repository}](https://huggingface.co/${MODEL.repository}) at revision \`${MODEL.revision}\`, unmodified. Copyright Snowflake Inc. Licensed under the Apache License, Version 2.0:\n\n\`\`\`text\n${apache}\n\`\`\`\n`;

writeFileSync(
  "dist/THIRD_PARTY_NOTICES.md",
  `# Third-party notices\n\n\`dist/debrief.mjs\` and \`dist/embedder.mjs\` inline the packages below, and \`dist/\` carries ONNX Runtime's WebAssembly build and an embedding model; each is listed with its license text, as its license requires. better-sqlite3 is installed as its own dependency and carries its own license.\n\n${[...sections, model].join("\n")}`,
);

/** A package's license text: its own file, else the one kept in `scripts/licenses/` for packages published without one. */
function licenseOf(dir, name) {
  const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry));
  if (file !== undefined) return readFileSync(join(dir, file), "utf8").trim();
  const kept = { "onnxruntime-web": "onnxruntime.txt", "onnxruntime-common": "onnxruntime.txt" }[name];
  if (kept !== undefined) return readFileSync(join("scripts/licenses", kept), "utf8").trim();
  throw new Error(`${name} is bundled into dist/ but has no license file to carry in THIRD_PARTY_NOTICES.md`);
}

/** The pinned model files, from the cache (fetched once per revision), checked and copied to `dist/models/`. */
async function copyModel() {
  const cache = join(".cache/models", MODEL.repository, MODEL.revision);
  const target = join("dist", MODEL.directory);
  mkdirSync(cache, { recursive: true });
  mkdirSync(target, { recursive: true });
  for (const file of MODEL.files) {
    const cached = join(cache, file.name);
    if (!existsSync(cached) || sha256(cached) !== file.sha256) {
      const url = `https://huggingface.co/${MODEL.repository}/resolve/${MODEL.revision}/${file.source}`;
      process.stderr.write(`bundle: fetching ${url}\n`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
      const partial = `${cached}.partial`;
      writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
      const actual = sha256(partial);
      if (actual !== file.sha256) throw new Error(`${url} has sha256 ${actual}, not the pinned ${file.sha256}`);
      renameSync(partial, cached);
    }
    copyFileSync(cached, join(target, file.name));
    if (sha256(join(target, file.name)) !== file.sha256) throw new Error(`${join(target, file.name)} does not match its pinned sha256`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
