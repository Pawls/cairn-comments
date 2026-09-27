import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const SOURCE = "src/pay.py";
const SIDECAR = ".agents/comments/src/pay.py.md";
const ORIGINAL = [
  "def pay(order):",
  "    # the gateway retries on 502, so this must stay idempotent",
  "    #  (see the ledger contract)",
  "    charge(order)  # cents, not dollars",
  "    # noqa: E501",
  "    return order",
  "",
].join("\n");

describe.each([true, false])("promote and demote through git (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  let wt: string;
  let committed: Buffer;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    wt = box.path("wt");
    box.write(box.path("main", SOURCE), ORIGINAL);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    committed = readFileSync(box.path("main", SOURCE));
  });
  afterAll(() => box.dispose());

  const ids = (file: string) => [...box.read(file).matchAll(/#~([0-9a-z]{4})/g)].map((m) => m[1]!);

  it("demote moves the comments into the sidecar and leaves bare markers", () => {
    expect(box.cli(main, "demote", `${SOURCE}:3`, `${SOURCE}:4`, `${SOURCE}:2`)).toBe("demoted 2 comment(s) in 1 file(s)\n");
    const [own, trailing] = ids(box.path("main", SOURCE));
    expect(box.read(box.path("main", SOURCE))).toBe(
      `def pay(order):\n    #~${own}\n    charge(order)  #~${trailing}\n    # noqa: E501\n    return order\n`,
    );
    expect(box.read(box.path("main", SIDECAR))).toMatch(
      new RegExp(
        `^## ${own}\\n<!-- anchor=[0-9a-f]{8} -->\\nthe gateway retries on 502, so this must stay idempotent\\n {1}\\(see the ledger contract\\)\\n\\n` +
          `## ${trailing}\\n<!-- anchor=[0-9a-f]{8} -->\\ncents, not dollars\\n$`,
      ),
    );
    expect(box.status(main)).toBe(` M ${SOURCE}\n?? .agents/\n`);
  });

  it("demote refuses a pragma, a line without a comment, and a managed marker, writing nothing", () => {
    const before = readFileSync(box.path("main", SOURCE));
    expect(box.cliResult(main, "demote", `${SOURCE}:4`)).toMatchObject({ status: 1, stderr: `cairn: ${SOURCE}:4: a pragma comment stays in the code\n` });
    expect(box.cliResult(main, "demote", `${SOURCE}:5`).stderr).toBe(`cairn: ${SOURCE}:5: no comment on this line\n`);
    expect(box.cliResult(main, "demote", `${SOURCE}:2`).stderr).toBe(`cairn: ${SOURCE}:2: already an AI comment\n`);
    expect(box.cliResult(main, "demote", SOURCE).stderr).toBe(`cairn: expected <file>:<line>, got ${SOURCE}\n`);
    expect(readFileSync(box.path("main", SOURCE))).toEqual(before);
  });

  it("promote in an agent worktree turns an expanded comment back into an ordinary one", () => {
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "demote");
    box.cli(main, "worktree", "add", wt);
    const [, trailing] = ids(box.path("main", SOURCE));
    expect(box.cli(wt, "promote", trailing!)).toBe(`promoted ${trailing} in ${SOURCE}\n`);
    expect(box.read(box.path("wt", SOURCE))).toContain("    charge(order)  # cents, not dollars\n");
    expect(box.status(wt)).toBe(` M ${SIDECAR}\n M ${SOURCE}\n`);
    box.git(wt, "checkout", "--", SOURCE, SIDECAR);
  });

  it("promoting every comment restores the committed bytes and removes the sidecar", () => {
    const found = ids(box.path("main", SOURCE));
    expect(box.cli(main, "promote", ...found.map((id) => `${SOURCE}:${id}`))).toBe(`promoted ${found.join(", ")} in ${SOURCE}\n`);
    expect(readFileSync(box.path("main", SOURCE))).toEqual(committed);
    expect(existsSync(box.path("main", SIDECAR))).toBe(false);
    expect(box.status(main)).toBe(` D ${SIDECAR}\n M ${SOURCE}\n`);
    box.git(main, "commit", "-qam", "promote");
    expect(box.git(main, "diff", "HEAD~2", "--stat")).toBe("");
  });

  it("promote reports an unknown id", () => {
    expect(box.cliResult(main, "promote", "zz99")).toMatchObject({ status: 1, stderr: "cairn: no comment zz99\n" });
  });
});

// The extension applies these rewrites itself, as one edit the owner can undo in every file at once.
describe.each([true, false])("--print reports the rewrite instead of writing it (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    box.write(box.path("main", SOURCE), ORIGINAL);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init", "--markerless");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
  });
  afterAll(() => box.dispose());

  it("demote --print names each file's new contents and writes nothing", () => {
    const printed = JSON.parse(box.cli(main, "demote", "--print", `${SOURCE}:2`)) as { report: string; files: Record<string, string | null> };
    expect(box.status(main)).toBe("");
    expect(printed.report).toBe("demoted 1 comment(s) in 1 file(s)\n");
    expect(Object.keys(printed.files).sort()).toEqual([SIDECAR, SOURCE]);

    expect(box.cli(main, "demote", `${SOURCE}:2`)).toBe(printed.report);
    expect(box.read(box.path("main", SOURCE))).toBe(printed.files[SOURCE]);
    expect(box.read(box.path("main", SIDECAR))).toBe(printed.files[SIDECAR]);
    box.git(main, "checkout", "--", SOURCE);
    rmSync(box.path("main", ".agents"), { recursive: true, force: true });
  });

  it("scan --apply --print covers the sources, their sidecars, and the ignore file", () => {
    const review = JSON.parse(box.cli(main, "scan", "--json")) as { comments: { line: number; accept: boolean }[] };
    const own = review.comments.find((c) => c.line === 2)!;
    const trailing = review.comments.find((c) => c.line === 4)!;
    own.accept = true;
    trailing.accept = false;
    const input = JSON.stringify({ version: 1, comments: [own, trailing] });
    const printed = JSON.parse(box.cliWithInput(main, input, "scan", "--apply", "-", "--print")) as { report: string; files: Record<string, string | null> };
    expect(box.status(main)).toBe("");
    expect(printed.report).toBe("converted 1 comment(s) in 1 file(s)\nignored 1 comment(s) in .agents/scan-ignore\n");
    expect(Object.keys(printed.files).sort()).toEqual([".agents/scan-ignore", SIDECAR, SOURCE]);

    expect(box.cliWithInput(main, input, "scan", "--apply", "-")).toBe(printed.report);
    for (const [file, text] of Object.entries(printed.files)) expect(box.read(box.path("main", file))).toBe(text);
  });
});
