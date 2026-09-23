// The published CLI is one ESM file plus its WASM, so installing it pulls no dependencies
// (design.md § Packaging). Runs after `tsc -b`, which builds the core it bundles.
/* global URL */
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { copyWasmAssets } from "../../scripts/bundle-assets.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
rmSync(new URL("bundle", import.meta.url), { recursive: true, force: true });
await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "bundle/main.js",
  absWorkingDir: here,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
copyWasmAssets(fileURLToPath(new URL("bundle", import.meta.url)));
