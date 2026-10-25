# Agent notes

Cairn Comments keeps AI-written comments out of committed code: a git filter removes sigil
comments whole, and their bodies live in `.agents/comments/` with a record of where each
goes (the anchor), from which agent worktrees get them back. Start with
[docs/design.md](docs/design.md) (decisions and every settled rule) and
[docs/plans/v2.md](docs/plans/v2.md) (vertical slices; each lands on `main` through a pull request).
Finished plans, v1 included, are in `docs/plans/archived/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | `tsc -b`, bundle the CLI and the extension, then every vitest suite. The CLI integration tests run the published bundle `packages/cli/bundle/main.js`, so a stale build tests old code; `package.test.ts` packs and installs it. `npm run test:unit` skips the build and covers only `core` and `vscode`. |
| `npm run test:vscode` | Extension e2e in a downloaded VS Code (first run downloads it into `.vscode-test/`). With `CAIRN_E2E_EXTENSION=<unzipped .vsix>/extension` it tests the packaged extension instead. On Linux (WSL included) it runs under `xvfb-run`, so no window reaches the desktop; `CAIRN_E2E_VISIBLE=1` shows it. On Windows the window opens and takes focus, so tell the user before running it. |
| `npm run test:native` | Real keystrokes in a real VS Code window, driven by Playwright (`packages/vscode/native/run.ts`): native Ctrl+X/Ctrl+V and Ctrl+Z's undo-across-files prompt, which the unfocused e2e window never sees. A stand-in for Pylance's paste provider (`native/competitor`) runs beside the extension. Windows only so far; `npm run native -w packages/vscode -- <name part>` runs one test. It needs the foreground and the keyboard, so the user must stay off the machine while it runs. |
| `npm run package -w packages/vscode` | Build `packages/vscode/cairn-comments.vsix` (after `npm run build`). Packaging only; nothing is published. |
| `npm run lint` | eslint over the whole workspace. |
| `npm run bench` | 2,000-file checkout benchmark (design.md § Filter process). Slow; run only when touching the filter path. |
| `npm run benchmark -- <annotate\|run\|status\|report\|loop\|loop-report> --work <dir> ...` | Paired agent runs with and without AI comments ([docs/benchmark.md](docs/benchmark.md)); `loop` is the notes loop (a writer, then readers with and without its notes). Takes hours and holds the GPUs (local model) or spends API money; never run it unasked. Overnight batches follow [docs/plans/archived/benchmark-runs.md](docs/plans/archived/benchmark-runs.md). |
| `node scripts/benchmark/verify-probes.ts --work <dir> [--source <clone>] [--only <probe,...>]` | Checks the deep-context probes ([benchmark/deep-tasks.json](benchmark/deep-tasks.json)) in both arms: each prediction's script prints its expected answer, and each change probe fails at its start and passes on its reference. Prepares the start commit and installs both checkouts' virtualenvs, so it takes a few minutes; it runs no model. Run it after changing a probe. |
| `npm run replay -- --repo <path>` | Comment placement replayed over a repository's history (design.md § Anchoring, "Measured"). Minutes per repository; run when changing placement. |

A change is signed off on Windows (`autocrlf=true` scenarios included) and on an LF
platform (WSL Ubuntu so far). The integration suites already run each scenario under both
`autocrlf` settings.

## Invariants the tests do not fully guard

- **`clean` is pure in (path, source).** Git calls it on status, diff, and add;
  `stripComments` never reads or writes a sidecar. Sidecar writes happen only in `sync`
  (`recordComments`) and in the commands built on it.
- **Placement is exact or it is refused.** A comment goes back only on the node its
  anchor names, or through the documented fallbacks (design.md § Anchoring, "When it is
  placed"); anything else is an orphan, kept in the sidecar. Never add a best-guess
  placement: a confident wrong one attaches a true comment to the wrong code.
- **Deletion needs the seen record.** A comment counts as deleted only when the tool last
  wrote it into that worktree's file and it is gone now (design.md § Anchoring,
  "Deleting"); a sidecar entry absent from a file proves nothing.
- **Every rewrite keeps each line's terminator.** Build output with `applySplices`
  (`packages/core/src/lines.ts`); never normalize a whole source file.
- **A tool rewrite of a working file ends with the guarded re-stat** (`restat` in
  `packages/cli/src/git.ts`, design.md § Git behavior, item 5). Going through `rewriteFiles` in
  `packages/cli/src/files.ts` gets this for free. Under `--print` the CLI writes nothing
  and the extension applies the rewrite as one undoable edit (design.md § Promote and demote).
- **The brand lives in one constant** (`packages/core/src/brand.ts`). The CLI `bin` key
  and the extension manifest repeat it; `packages/cli/test/brand.test.ts` guards them.
- **Integration tests use the `Sandbox` harness** (`packages/cli/test/harness.ts`), which
  isolates `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME` (git's global ignore file), and
  `CAIRN_CLI_HOME` (where `init` installs the CLI); the e2e scratch repositories do the same.
  Never let a test touch the developer's git config, hooks, or CLI home.
- **Packages have no runtime dependencies.** Both bundle core and web-tree-sitter, and
  `scripts/bundle-assets.mjs` copies the WASM beside them; a new runtime import must bundle
  too (design.md § Packaging).
- **Detector changes move measured numbers.** `scan.corpus.test.ts` pins each detector's
  score and enabled flag; update the table in design.md § Scan detectors with them.
- **A benchmark tests the product's claim, and a failed gate stops it.** Cairn's claim is a
  loop: an agent writes notes as it works out the code, Cairn keeps them, and later agents
  (including one lost deep in a long session) read them instead of working the same thing out
  again. Before building tasks, say which steps of that loop the benchmark exercises and which
  it leaves out, write the condition that produces the claim, and show the tasks reproduce it.
  A benchmark where no agent writes notes, or where no note reaches a later agent, tests only
  pre-existing comments (docs/plans/benchmark-deep-context.md § D7). A fresh agent on a small fix does not. Calibration must
  show the control arm can fail; if it passes at ceiling, redesign the tasks and do not run
  the matrix (docs/plans/benchmark-deep-context.md § What this benchmark must be able to detect).

## Known noise

- This repository does not run Cairn Comments on itself; there is no filter in its
  `.gitattributes`, so write ordinary comments here.
