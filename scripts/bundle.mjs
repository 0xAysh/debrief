#!/usr/bin/env node
/**
 * Bundles the compiled CLI into the one file `debrief` runs (`dist/debrief.mjs`, the package's
 * bin). Every hook is a new process: unbundled it loads 339 modules (Node built-ins included),
 * bundled 38, which saves about 27 ms of in-process time and 45 ms of CPU per hook (p50,
 * `npm run measure:hooks`, #32). better-sqlite3 stays external: it loads a native binding.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["dist/cli.js"],
  outfile: "dist/debrief.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["better-sqlite3"],
  // Bundled CommonJS dependencies call require(); an ES module has none of its own.
  banner: { js: 'import { createRequire as __debriefRequire } from "node:module"; const require = __debriefRequire(import.meta.url);' },
  logLevel: "warning",
});
