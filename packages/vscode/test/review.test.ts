import { describe, expect, it } from "vitest";
import { ReviewModel, cliFromCleanConfig, type ReviewComment } from "../src/review.js";

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
  it("groups by file in scan order and accepts everything by default", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("b.ts", 4), comment("a.py", 9)]);
    expect(model.files().map((f) => [f.file, f.comments.map((c) => c.line)])).toEqual([
      ["a.py", [1, 9]],
      ["b.ts", [4]],
    ]);
    expect(model.toReview().comments.every((c) => c.accept)).toBe(true);
  });

  it("rejects one comment or a whole file, and hands the CLI every entry with its state", () => {
    const model = new ReviewModel();
    model.load([comment("a.py", 1), comment("a.py", 9), comment("b.ts", 4)]);
    model.setAccepted("a.py", 9, false);
    model.setAccepted("b.ts", undefined, false);
    expect(model.toReview()).toEqual({
      version: 1,
      comments: [
        { ...comment("a.py", 1), accept: true },
        { ...comment("a.py", 9), accept: false },
        { ...comment("b.ts", 4), accept: false },
      ],
    });
  });
});

it("recovers the CLI invocation from the clean filter config", () => {
  expect(cliFromCleanConfig('node "C:/x/main.js" clean %f\n')).toBe('node "C:/x/main.js"');
  expect(cliFromCleanConfig("something else")).toBeUndefined();
});
