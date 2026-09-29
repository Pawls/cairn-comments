import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bodyMarkdown, findSidecarRoot, labelFor, provenanceLine } from "../src/overlay.js";

describe("labelFor", () => {
  it("shows the first line, with a count of the remaining lines", () => {
    expect(labelFor("keyed on order.id")).toBe("keyed on order.id");
    expect(labelFor("first\n\nthird")).toBe("first (+2)");
  });
});

describe("provenanceLine", () => {
  it("renders the provenance recorded, leaving other keys out", () => {
    const meta = new Map([
      ["by", "claude-code"],
      ["model", "claude-opus-5-5"],
      ["session", "f6bed7e6-3bc6-42d8-97d2-f936a01f4077"],
      ["at", "2026-09-22T20:25:55Z"],
      ["pos", "before"],
    ]);
    expect(provenanceLine(meta)).toBe("claude-code · claude-opus-5-5 · 2026-09-22 20:25 UTC · session f6bed7e6");
  });

  it("is undefined for an entry without any", () => {
    expect(provenanceLine(new Map([["pos", "trail"]]))).toBeUndefined();
  });
});
describe("bodyMarkdown", () => {
  it("ends each line followed by another with a hard break, since Markdown would join them with a space", () => {
    expect(bodyMarkdown("First\nSecond\nThird")).toBe("First  \nSecond  \nThird");
  });

  it("leaves paragraph breaks and a one-line body alone", () => {
    expect(bodyMarkdown("one\n\ntwo\nthree")).toBe("one\n\ntwo  \nthree");
    expect(bodyMarkdown("just one")).toBe("just one");
  });
});

describe("findSidecarRoot", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stops at the nearest sidecar folder even inside a larger repository", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cairn-root-"));
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "ws/.agents/comments"), { recursive: true });
    mkdirSync(path.join(dir, "ws/src"), { recursive: true });
    writeFileSync(path.join(dir, "ws/src/a.py"), "");
    expect(findSidecarRoot(path.join(dir, "ws/src"), "fallback")).toBe(path.join(dir, "ws"));
  });

  it("uses the git root when no sidecar folder exists yet, and the fallback outside any repo", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cairn-root-"));
    mkdirSync(path.join(dir, "repo/.git/x"), { recursive: true });
    mkdirSync(path.join(dir, "repo/pkg"), { recursive: true });
    expect(findSidecarRoot(path.join(dir, "repo/pkg"), "fallback")).toBe(path.join(dir, "repo"));
    mkdirSync(path.join(dir, "loose"));
    // The temp dir's ancestors hold no `.git` on a normal machine, so the walk ends at the fallback.
    expect(findSidecarRoot(path.join(dir, "loose"), path.join(dir, "loose"))).toBe(path.join(dir, "loose"));
  });
});
