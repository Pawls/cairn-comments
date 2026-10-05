import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patchedFiles } from "../src/adapters.js";
import { Sandbox } from "./harness.js";

// Long runs a backtracking regex would rescan from every position; see
// packages/core/test/backtracking.test.ts.
const N = 100_000;

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("regexes stay linear on long runs", () => {
  let box: Sandbox;
  let main: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    main = box.path("main");
    box.git(box.dir, "init", "-q", "main");
  });

  afterAll(() => box.dispose());

  it("reads a patch header whose path holds a long run of spaces", () => {
    const patch = `*** Begin Patch\n*** Add File: a${" ".repeat(N)}b\n*** End Patch\n`;
    let files: string[] = [];
    expect(elapsed(() => (files = patchedFiles({ input: patch })))).toBeLessThan(1_000);
    expect(files).toEqual([`a${" ".repeat(N)}b`]);
  });

  it("uninstall plans the AGENTS.md removal when the text before the snippet has a long run of line breaks", () => {
    box.write(box.path("main", "AGENTS.md"), `x${"\n".repeat(N)}y\n<!-- cairn:begin -->\nrules\n<!-- cairn:end -->\n`);
    let out = "";
    // One CLI process with git calls costs a few hundred milliseconds; the quadratic trim took over ten seconds.
    expect(elapsed(() => (out = box.cli(main, "uninstall", "--dry-run")))).toBeLessThan(3_000);
    expect(out).toContain("AGENTS.md: remove the sigil convention");
  });
});
