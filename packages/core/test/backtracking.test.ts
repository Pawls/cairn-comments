import { describe, expect, it } from "vitest";
import { analyzeSource, detectorNamed, recordComments, stripComments, type Sidecar } from "../src/index.js";

// Each input is a long run a backtracking regex would rescan from every position: quadratic
// time takes seconds at this size, linear time a few milliseconds.
const N = 100_000;
const LIMIT_MS = 1_000;
const EMPTY: Sidecar = { preamble: "", entries: [] };

async function elapsed(run: () => unknown): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("regexes stay linear on long runs", () => {
  const spacedLine = `const a = 1;${" ".repeat(N)}const b = 2; //~ note\n`;

  it("strips a trailing comment after a long run of inner spaces", async () => {
    expect(await elapsed(() => stripComments("a.ts", spacedLine))).toBeLessThan(LIMIT_MS);
  });

  it("records a trailing comment after a long run of inner spaces", async () => {
    expect(await elapsed(() => recordComments("a.ts", spacedLine, EMPTY))).toBeLessThan(LIMIT_MS);
  });

  it("hashes a body holding a long number literal that is not a plain decimal", async () => {
    const source = `function f() {\n  //~ note\n  return ${"1".repeat(N)}n;\n}\n`;
    expect(await elapsed(() => recordComments("a.ts", source, EMPTY))).toBeLessThan(LIMIT_MS);
  });

  it("tests narration on a first line with a long run of spaces", async () => {
    const narration = detectorNamed("narrates-steps")!;
    const firstLine = `first${" ".repeat(N)}x`;
    const input = { text: firstLine, firstLine, lineCount: 1, placement: "own-line" as const, context: "" };
    expect(await elapsed(() => narration.test(input))).toBeLessThan(LIMIT_MS);
  });

  it("classifies a TODO followed by a long run of spaces", async () => {
    const source = `// TODO${" ".repeat(N)}x\nconst a = 1;\n`;
    expect(await elapsed(() => analyzeSource("a.ts", source))).toBeLessThan(LIMIT_MS);
  });
});
