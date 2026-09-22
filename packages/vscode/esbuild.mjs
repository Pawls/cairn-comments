// VS Code loads extensions as CommonJS, so the ESM sources (and `@slopstash/core`) are
// bundled here; `tsc -b` only type-checks this package. `web-tree-sitter` stays external
// because it locates its own `.wasm` next to its module file.
/* global URL */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  absWorkingDir: here,
  external: ["vscode", "web-tree-sitter", "mocha"],
  // core resolves grammar WASM relative to `import.meta.url`; give the bundle one.
  define: { "import.meta.url": "import_meta_url" },
  inject: ["esbuild-shims.js"],
  logLevel: "warning",
};

await esbuild.build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs" });
await esbuild.build({ ...common, entryPoints: ["e2e/index.ts"], outfile: "dist/e2e/index.cjs" });
