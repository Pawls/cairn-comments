// The published CLI is one ESM file plus its WASM, so installing it pulls no dependencies
// (design.md § Packaging). Runs after `tsc -b`, which builds the core it bundles.
/* global URL */
import * as esbuild from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
// The CLI home installs a bundle over another only when it is newer; `build` orders two
// builds of one version, so each rebuild replaces the last (packages/core/src/home.ts).
const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
writeFileSync(new URL("bundle/version.json", import.meta.url), JSON.stringify({ version, build: Date.now() }) + "\n");
