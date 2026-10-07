// Copies the WASM a bundled build loads at runtime next to the bundle: `web-tree-sitter.wasm`
// (web-tree-sitter looks beside its own module, which the bundle now is) and each grammar in
// core's LANGUAGES table (core's `resolveWasm` looks in `grammars/`). Run after `tsc -b`.
/* global URL */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LANGUAGES } from "../packages/core/dist/index.js";

const require = createRequire(new URL("../packages/core/package.json", import.meta.url));

export function copyWasmAssets(dir) {
  mkdirSync(path.join(dir, "grammars"), { recursive: true });
  copyFileSync(require.resolve("web-tree-sitter/web-tree-sitter.wasm"), path.join(dir, "web-tree-sitter.wasm"));
  for (const { wasm } of LANGUAGES)
    copyFileSync(require.resolve(wasm), path.join(dir, "grammars", path.posix.basename(wasm)));
}
