# Agent notes

Slopstash keeps AI-written comments out of committed code: sigil comments collapse to id
markers through a git filter, bodies live in `.agents/comments/`. Start with
[docs/design.md](docs/design.md) (decisions and every settled rule) and
[docs/plans/v1.md](docs/plans/v1.md) (vertical slices; all v1 work lands on branch `v1`).

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | `tsc -b`, bundle the CLI and the extension, then every vitest suite. The CLI integration tests run the published bundle `packages/cli/bundle/main.js`, so a stale build tests old code; `package.test.ts` packs and installs it. `npm run test:unit` skips the build and covers only `core` and `vscode`. |
| `npm run test:vscode` | Extension e2e in a downloaded VS Code (first run downloads it into `.vscode-test/`). With `SLOPSTASH_E2E_EXTENSION=<unzipped .vsix>/extension` it tests the packaged extension instead. |
| `npm run package -w packages/vscode` | Build `packages/vscode/slopstash.vsix` (after `npm run build`). Packaging only; nothing is published. |
| `npm run lint` | eslint over the whole workspace. |
| `npm run bench` | 2,000-file checkout benchmark (design.md § Filter process). Slow; run only when touching the filter path. |

A change is signed off on Windows (`autocrlf=true` scenarios included) and on an LF
platform (WSL Ubuntu so far). The integration suites already run each scenario under both
`autocrlf` settings.

## Invariants the tests do not fully guard

- **`clean` is pure in (path, source).** Git calls it on status, diff, and add; it never
  reads or writes a sidecar. Sidecar writes happen only in `sync`.
- **Every rewrite keeps each line's terminator.** Build output with `applySplices`
  (`packages/core/src/lines.ts`); never normalize a whole source file.
- **A tool rewrite of a working file ends with the guarded re-stat** (`restat` in
  `packages/cli/src/git.ts`, design.md § Git behavior, item 5). Going through `rewriteFiles` in
  `packages/cli/src/files.ts` gets this for free.
- **The brand lives in one constant** (`packages/core/src/brand.ts`). The CLI `bin` key
  and the extension manifest repeat it; `packages/cli/test/brand.test.ts` guards them.
- **Integration tests use the `Sandbox` harness** (`packages/cli/test/harness.ts`), which
  isolates `GIT_CONFIG_GLOBAL` and `XDG_CONFIG_HOME` (git's global ignore file). Never let
  a test touch the developer's git config or hooks.
- **Packages have no runtime dependencies.** Both bundle core and web-tree-sitter, and
  `scripts/bundle-assets.mjs` copies the WASM beside them; a new runtime import must bundle
  too (design.md § Packaging).
- **Detector changes move measured numbers.** `scan.corpus.test.ts` pins each detector's
  score and enabled flag; update the table in design.md § Scan detectors with them.

## Known noise

- The `clean undoes smudge` property in `packages/core/test/filter.test.ts` fails on some
  seeds: a known grammar ambiguity (design.md § Known gaps, "A lone sigil line below a
  bare marker"). A failure there is not caused by an unrelated change.
- This repository does not run Slopstash on itself; there is no filter in its
  `.gitattributes`, so write ordinary comments here.
