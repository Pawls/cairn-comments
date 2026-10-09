import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existingStorage, initArgs } from "../src/storage.js";

describe("existingStorage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cairn-storage-"));
    mkdirSync(path.join(root, ".git"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("leaves a fresh repository to the owner's choice", () => {
    expect(existingStorage(root)).toBeUndefined();
  });

  it("ignores the empty sidecar folder the scan view creates", () => {
    mkdirSync(path.join(root, ".agents", "comments"), { recursive: true });
    expect(existingStorage(root)).toBeUndefined();
  });

  it("keeps a repository whose comments are on the branch there", () => {
    mkdirSync(path.join(root, ".agents", "comments", "src"), { recursive: true });
    writeFileSync(path.join(root, ".agents", "comments", "src", "a.py.md"), "## a1b2\nnote\n");
    expect(existingStorage(root)).toBe("branch");
  });

  it("keeps a repository whose .gitattributes already names the filter on the branch", () => {
    writeFileSync(path.join(root, ".gitattributes"), "*.png binary\n*.py filter=cairn\n");
    expect(existingStorage(root)).toBe("branch");
  });

  it("keeps a private repository private", () => {
    mkdirSync(path.join(root, ".git", "cairn", "comments"), { recursive: true });
    expect(existingStorage(root)).toBe("private");
  });
});

describe("initArgs", () => {
  it("adds --private only for private storage", () => {
    expect(initArgs("branch")).toEqual(["init"]);
    expect(initArgs("private")).toEqual(["init", "--private"]);
  });
});
