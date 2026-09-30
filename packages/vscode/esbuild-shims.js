/* global require, __filename */
/* eslint-disable @typescript-eslint/no-require-imports -- runs inside the CommonJS bundle */
// Injected by esbuild.mjs so `import.meta.url` in bundled ESM points at the bundle file.
export const import_meta_url = require("node:url").pathToFileURL(__filename).href;
