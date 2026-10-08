import { describe, expect, it } from "vitest";
import { ReviewModel, cliFromCleanConfig, orphansOf, recordedScript, type ReviewComment } from "../src/review.js";

const comment = (file: string, line: number): ReviewComment => ({
  file,
  line,
  endLine: line,
  fingerprint: `${file}${line}`,
  score: 1,
  detectors: ["emoji"],
  text: `c${line}`,
  accept: true,
});

describe("ReviewModel", () => {
  const decisions = (model: ReviewModel) => model.files().map((f) => [f.file, f.comments.map((c) => [c.line, c.decision])]);

  it("groups by file in scan order with nothing decided", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("b.ts", 4), comment("a.py", 9)]);
    expect(decisions(model)).toEqual([
      ["a.py", [[1, undefined], [9, undefined]]],
      ["b.ts", [[4, undefined]]],
    ]);
    expect(model.decidedCount()).toBe(0);
    expect(model.toReview().comments).toEqual([]);
  });

  it("hands the CLI a mix of decisions in one pass, and leaves the undecided ones out", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("a.py", 9), comment("b.ts", 4), comment("c.cs", 2)]);
    model.decide("a.py", 1, "ai");
    model.decide("a.py", 9, "keep");
    model.decide("b.ts", undefined, "ai");
    expect(model.decidedCount()).toBe(3);
    expect(model.toReview()).toEqual({
      version: 1,
      comments: [
        { ...comment("a.py", 1), accept: true },
        { ...comment("a.py", 9), accept: false },
        { ...comment("b.ts", 4), accept: true },
      ],
    });
  });

  it("deciding again with the same decision clears it; a different one replaces it", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1)]);
    model.decide("a.py", 1, "ai");
    model.decide("a.py", 1, "keep");
    expect(decisions(model)).toEqual([["a.py", [[1, "keep"]]]]);
    model.decide("a.py", 1, "keep");
    expect(decisions(model)).toEqual([["a.py", [[1, undefined]]]]);
  });

  it("a file's decision sets every comment in it, and clears them only when all already had it", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("a.py", 9)]);
    model.decide("a.py", 1, "keep");
    model.decide("a.py", undefined, "keep");
    expect(decisions(model)).toEqual([["a.py", [[1, "keep"], [9, "keep"]]]]);
    model.decide("a.py", undefined, "keep");
    expect(decisions(model)).toEqual([["a.py", [[1, undefined], [9, undefined]]]]);
  });

  it("the bulk decision fills in only the undecided comments", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("a.py", 9), comment("b.ts", 4)]);
    model.decide("a.py", 9, "keep");
    expect(model.toReview("ai").comments.map((c) => [c.file, c.line, c.accept])).toEqual([
      ["a.py", 1, true],
      ["a.py", 9, false],
      ["b.ts", 4, true],
    ]);
  });

  it("a skipped comment leaves the review, and stays out of a reload unless the scan starts over", () => {
    const model = new ReviewModel();
    const all = [comment("a.py", 1), comment("a.py", 9), comment("b.ts", 4)];
    model.load(all);
    model.decide("b.ts", 4, "ai");
    model.skip("a.py", 9);
    model.skip("b.ts", undefined);
    expect(decisions(model)).toEqual([["a.py", [[1, undefined]]]]);
    expect(model.skippedCount()).toBe(2);
    expect(model.toReview("keep").comments.map((c) => [c.file, c.line])).toEqual([["a.py", 1]]);

    model.load(all, { keepSkipped: true });
    expect(decisions(model)).toEqual([["a.py", [[1, undefined]]]]);
    model.load(all);
    expect(model.skippedCount()).toBe(0);
    expect(decisions(model).map(([file]) => file)).toEqual(["a.py", "b.ts"]);
  });
});

it("recovers the CLI invocation from the clean filter config", () => {
  expect(cliFromCleanConfig('node "C:/x/main.js" clean %f\n')).toBe('node "C:/x/main.js"');
  expect(cliFromCleanConfig("something else")).toBeUndefined();
});

it("recordedScript reads the file a recorded launcher or node command runs, and nothing looked up on PATH", () => {
  expect(recordedScript('"C:/x/cli/cairn"')).toBe("C:/x/cli/cairn");
  expect(recordedScript("/x/cli/cairn")).toBe("/x/cli/cairn");
  expect(recordedScript('node "C:/x/main.js"')).toBe("C:/x/main.js");
  expect(recordedScript("node /x/main.js")).toBe("/x/main.js");
  expect(recordedScript("cairn")).toBeUndefined();
  expect(recordedScript("npx cairn-comments")).toBeUndefined();
});

describe("orphansOf", () => {
  it("keeps only the entries that no longer place, with their last declaration", () => {
    const report = {
      problems: [
        { kind: "expanded", file: "a.py", line: 3, text: "#~ left inline" },
        { kind: "unplaced", file: ".agents/comments/a.py.md", id: "r3cn", source: "a.py", scope: "reconcile", text: "runs after settle" },
        { kind: "unplaced", file: ".agents/comments/b.py.md", id: "x1y2", source: "b.py", text: "module note" },
      ],
    };
    expect(orphansOf(report)).toEqual([
      { source: "a.py", id: "r3cn", scope: "reconcile", text: "runs after settle" },
      { source: "b.py", id: "x1y2", scope: undefined, text: "module note" },
    ]);
  });
});
