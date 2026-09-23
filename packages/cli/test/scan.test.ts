import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const APP = "src/app.py";
const APP_SOURCE = [
  "# Copyright (c) 2024 Example Corp.",
  "import os  # noqa: F401",
  "",
  "",
  "def load(path):",
  "    # Step 1: Read the file contents",
  "    with open(path) as f:",
  "        data = f.read()",
  "    # retry once; the proxy drops the first connection after idle",
  "    # print(data)",
  "    return data  # Updated to return the raw text",
  "",
  "",
  "def save(user):",
  "    # In a real application, you would hash the password here",
  "    user.password = password",
  "",
].join("\n");
const LIB = "src/lib.ts";
const LIB_SOURCE = [
  "/** Adds two numbers. */",
  "export function add(a: number, b: number) {",
  "  // eslint-disable-next-line no-console",
  "  console.log(a);",
  "  // sum them",
  "  return a + b;",
  "}",
  "",
].join("\n");

interface Entry {
  file: string;
  line: number;
  detectors: string[];
  text: string;
  accept: boolean;
}

describe.each([false, true])("scan (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  const read = (...parts: string[]) => box.read(box.path(...parts));
  const scanJson = (cwd: string, ...args: string[]) =>
    (JSON.parse(box.cli(cwd, "scan", "--json", ...args)) as { comments: Entry[] }).comments;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    box.write(box.path("main", APP), APP_SOURCE);
    box.write(box.path("main", LIB), LIB_SOURCE);
    box.git(box.dir, "init", "-q", "main");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "existing code");
  });
  afterAll(() => box.dispose());

  it("lists likely AI comments before init, and refuses to apply until init", () => {
    const comments = scanJson(main);
    expect(comments.map((c) => [c.file, c.line, c.detectors])).toEqual([
      [APP, 6, ["narrates-steps"]],
      [APP, 11, ["change-history"]],
      [APP, 15, ["hedging"]],
    ]);
    expect(comments.every((c) => c.accept)).toBe(true);
    expect(box.cli(main, "scan")).toMatch(/^src\/app\.py:6 {2}0\.81 {2}narrates-steps {2}Step 1: Read the file contents\n/);
    const review = box.path("review.json");
    writeFileSync(review, box.cli(main, "scan", "--json"));
    expect(() => box.cli(main, "scan", "--apply", review)).toThrow(/run `slopstash init` first/);
    expect(box.status(main)).toBe("");
  });

  it("applies a reviewed list: accepted comments become markers, the rejected one is ignored", () => {
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "init");
    const comments = scanJson(main);
    comments.find((c) => c.line === 11)!.accept = false;
    const review = box.path("review.json");
    writeFileSync(review, JSON.stringify({ version: 1, comments }));
    expect(box.cli(main, "scan", "--apply", review)).toBe(
      "converted 2 comment(s) in 1 file(s)\nignored 1 comment(s) in .agents/scan-ignore\n",
    );

    expect(box.git(main, "status", "--porcelain", "-uall").split("\n").filter(Boolean).sort()).toEqual([
      "?? .agents/comments/src/app.py.md",
      "?? .agents/scan-ignore",
      " M src/app.py",
    ].sort());
    // Only the two accepted comment lines changed, each to a bare marker at its place.
    const changed = box.git(main, "diff", "--no-color", "-U0", APP).split("\n").filter((l) => /^[-+][^-+]/.test(l));
    expect(changed).toEqual([
      "-    # Step 1: Read the file contents",
      expect.stringMatching(/^\+ {4}#~[0-9a-z]{4}$/),
      "-    # In a real application, you would hash the password here",
      expect.stringMatching(/^\+ {4}#~[0-9a-z]{4}$/),
    ]);
    expect(read("main", ".agents/comments/src/app.py.md")).toMatch(
      /^## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nStep 1: Read the file contents\n\n## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nIn a real application, you would hash the password here\n$/,
    );
    expect(read("main", ".agents/scan-ignore")).toMatch(/\nsrc\/app\.py\t[0-9a-f]{8}\tUpdated to return the raw text\n$/);
    if (autocrlf) expect(readFileSync(box.path("main", APP), "utf8")).not.toMatch(/[^\r]\n/);
  });

  it("is repeatable: a second scan proposes nothing", () => {
    expect(scanJson(main)).toEqual([]);
    expect(box.cli(main, "scan")).toBe("0 likely AI comment(s) in 0 file(s)\n");
  });

  it("round-trips: a committed apply expands back to the original text in an agent worktree", () => {
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "stash AI comments");
    expect(box.status(main)).toBe("");
    const wt = box.path("wt");
    box.cli(main, "worktree", "add", "-q", wt, "-b", "agent");
    const expanded = read("wt", APP);
    expect(expanded).toMatch(/\n {4}#~[0-9a-z]{4} Step 1: Read the file contents\n/);
    expect(expanded).toMatch(/\n {4}#~[0-9a-z]{4} In a real application, you would hash the password here\n/);
    expect(expanded).toContain("return data  # Updated to return the raw text\n");
    expect(box.status(wt)).toBe("");
  });

  it("mark-all converts every unprotected comment and leaves doc, pragma, and license comments", () => {
    expect(box.cli(main, "scan", "--mark-all", LIB)).toBe("converted 1 comment(s) in 1 file(s)\n");
    const lib = read("main", LIB);
    expect(lib).toMatch(/^\/\*\* Adds two numbers\. \*\/\n.*\n {2}\/\/ eslint-disable-next-line no-console\n {2}console\.log\(a\);\n {2}\/\/~[0-9a-z]{4}\n/);
    expect(read("main", ".agents/comments/src/lib.ts.md")).toMatch(/^## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nsum them\n$/);
    // Over the whole repo it still keeps the license header, the noqa pragma, and the ignored
    // comment; a group holding commented-out code stays whole, prose line included.
    expect(box.cli(main, "scan", "--mark-all")).toBe("converted 0 comment(s) in 0 file(s)\n");
    const app = read("main", APP);
    expect(app).toContain("# Copyright (c) 2024 Example Corp.\nimport os  # noqa: F401\n");
    expect(app).toContain("    # retry once; the proxy drops the first connection after idle\n    # print(data)\n");
    expect(app).toContain("return data  # Updated to return the raw text\n");
  });

  it("in an agent worktree, apply leaves the converted comments expanded", () => {
    const wt = box.path("wt");
    const file = box.path("wt", "src/new.py");
    box.write(file, "def f():\n    # Now we iterate over each row\n    pass\n");
    box.git(wt, "add", "src/new.py");
    const review = box.path("review-wt.json");
    writeFileSync(review, box.cli(wt, "scan", "--json", "src/new.py"));
    box.cli(wt, "scan", "--apply", review);
    expect(read("wt", "src/new.py")).toMatch(/^def f\(\):\n {4}#~[0-9a-z]{4} Now we iterate over each row\n/);
    expect(read("wt", ".agents/comments/src/new.py.md")).toMatch(/^## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nNow we iterate over each row\n$/);
  });
});
