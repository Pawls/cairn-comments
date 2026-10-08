import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHER, parseSidecar } from "@cairn-comments/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentsSnippet } from "../src/init.js";
import { Sandbox } from "./harness.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/hooks");
const BASE = "def total(items):\n    # sum of line prices\n    return sum(i.price for i in items)\n";
const EDITED =
  "def total(items):\n    # sum of line prices\n    # Prices are already tax-inclusive\n    return sum(i.price for i in items)\n";

/** A recorded (claude-code) or documented (codex, cursor) payload, pointed at `root` and `file`. */
function payload(harness: string, root: string, file: string): string {
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v
        .replaceAll("{{root}}/src/app.py", path.join(root, file))
        .replaceAll("src/app.py", file)
        .replaceAll("{{root}}", root)
        .replaceAll("{{transcript}}", path.join(FIXTURES, "claude-code-transcript.jsonl"));
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return JSON.stringify(fill(JSON.parse(readFileSync(path.join(FIXTURES, `${harness}.json`), "utf8"))));
}

describe.each([false, true])("tag and hook adapters (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  let wt: string;
  const read = (...parts: string[]) => box.read(box.path(...parts));
  const entries = (dir: string, file: string) => parseSidecar(read(dir, `.agents/comments/${file}.md`)).entries;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    box.git(box.dir, "init", "-q", "main");
    for (const f of ["src/app.py", "src/claude-code.py", "src/codex.py", "src/cursor.py"])
      box.write(box.path("main", f), BASE);
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    wt = box.path("wt");
    box.cli(main, "worktree", "add", "-q", wt, "-b", "agent");
  });
  afterAll(() => box.dispose());

  it("tag --changed in the owner's checkout stashes only the new comment, with provenance", () => {
    box.write(box.path("main", "src/app.py"), EDITED);
    box.write(box.path("main", "src/new.py"), "# Now we compute the total\nx = 1\n");
    const out = box.cli(main, "tag", "--changed", "--by", "manual", "--model", "m-1", "--session", "s-1");
    expect(out).toBe("tagged 2 comment(s); synced 2 file(s)\n");
    expect(read("main", "src/app.py")).toBe(BASE);
    expect(read("main", "src/new.py")).toBe("x = 1\n");
    const [entry] = entries("main", "src/app.py");
    expect(entry!.body).toBe("Prices are already tax-inclusive");
    expect([...entry!.meta.keys()].slice(0, 5)).toEqual(["by", "model", "session", "at", "pos"]);
    expect(entry!.meta.get("by")).toBe("manual");
    expect(entry!.meta.get("at")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(read("main", ".agents/comments/src/app.py.md")).toMatch(
      /<!-- by=manual model=m-1 session=s-1 at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z pos=before scope=total /,
    );
    // A second run finds nothing new; app.py reads as committed again, so only the new file is changed.
    expect(box.cli(main, "tag", "--changed")).toBe("tagged 0 comment(s); synced 1 file(s)\n");
    if (autocrlf) expect(readFileSync(box.path("main", "src/app.py"), "utf8")).not.toMatch(/[^\r]\n/);
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "tagged");
    expect(box.status(main)).toBe("");
  });

  it.each(["claude-code", "codex", "cursor"])("the %s hook tags the edited file in an agent worktree", (harness) => {
    const file = `src/${harness}.py`;
    box.write(box.path("wt", file), EDITED);
    expect(box.cliWithInput(wt, payload(harness, wt, file), "hook", harness)).toBe("");
    // The agent keeps reading the comment inline; git sees the code unchanged.
    expect(read("wt", file)).toMatch(/\n {4}#~[0-9a-z]{4} Prices are already tax-inclusive\n/);
    expect(box.git(wt, "diff", "--no-color", file)).toBe("");
    const meta = Object.fromEntries(entries("wt", file)[0]!.meta);
    const expected = {
      "claude-code": {
        by: "claude-code",
        model: "claude-haiku-4-5-20251001",
        session: "4f5ee155-6738-4fd8-b6bc-110299f93d24",
      },
      codex: { by: "codex", model: "gpt-5.5-codex", session: "019a6f2c-7d1e-7b30-9c4a-3f5d2e8b1a60" },
      cursor: { by: "cursor", model: "claude-sonnet-5", session: "5c1d9a4e-2b7f-4e61-a3d8-0f9e6b2c7a14" },
    }[harness];
    expect(meta).toMatchObject({ ...expected, at: expect.stringMatching(/Z$/), pos: "before", scope: "total" });
  });

  it("a hook for a file outside any initialized repository does nothing", () => {
    const plain = box.path("plain");
    box.git(box.dir, "init", "-q", "plain");
    box.write(box.path("plain", "src/app.py"), EDITED);
    expect(box.cliWithInput(plain, payload("cursor", plain, "src/app.py"), "hook", "cursor")).toBe("");
    expect(read("plain", "src/app.py")).toBe(EDITED);
    expect(box.cliWithInput(box.dir, payload("cursor", box.dir, "loose.py"), "hook", "cursor")).toBe("");
  });

  it("init --hooks installs each adapter once and keeps the rest of the settings", () => {
    const settings = box.path("main", ".claude/settings.local.json");
    box.write(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n");
    const report = box.cli(main, "init", "--hooks", "claude-code,codex,cursor");
    expect(report).toContain(".claude/settings.local.json: set the claude-code hook");
    expect(report).toContain(".codex/hooks.json: create with the codex hook");
    expect(report).toContain(".cursor/hooks.json: create with the cursor hook");
    const claude = JSON.parse(readFileSync(settings, "utf8"));
    expect(claude.permissions).toEqual({ allow: ["Bash(ls)"] });
    // Agent hooks on Windows run `node "<home>/main.js"`; elsewhere the launcher (design.md § Packaging).
    const recorded = process.platform === "win32" ? String.raw`/main\.js"` : `/${LAUNCHER}"`;
    expect(claude.hooks.PostToolUse).toEqual([
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: expect.stringMatching(new RegExp(`${recorded} hook claude-code$`)) }],
      },
    ]);
    const cursor = JSON.parse(read("main", ".cursor/hooks.json"));
    expect(cursor).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: expect.stringMatching(/ hook cursor$/) }] },
    });
    expect(JSON.parse(read("main", ".codex/hooks.json")).hooks.PostToolUse[0].matcher).toBe("apply_patch|Edit|Write");

    expect(box.cli(main, "init", "--hooks", "claude-code")).toBe("nothing to change\n");
    box.cli(main, "init", "--hooks", "cursor", "--command", "cairn");
    expect(JSON.parse(read("main", ".cursor/hooks.json")).hooks.afterFileEdit).toEqual([
      { command: "cairn hook cursor" },
    ]);
    expect(() => box.cli(main, "init", "--hooks", "vim")).toThrow(/unknown harness "vim"/);
  });

  it("init --agents-md writes the convention once and updates it in place", () => {
    const agents = box.path("main", "AGENTS.md");
    box.write(agents, "# Project\n\nOur rules.\n");
    expect(box.cli(main, "init", "--agents-md")).toContain("AGENTS.md: add the sigil convention\n");
    const first = read("main", "AGENTS.md");
    expect(first).toMatch(/^# Project\n\nOur rules\.\n\n<!-- cairn:begin -->\n## AI comments\n/);
    expect(first).toContain("`#~ text` in Python; `//~ text` in TypeScript, JavaScript, C#, Java, and Kotlin");
    expect(box.cli(main, "init", "--agents-md")).toBe("nothing to change\n");
    writeFileSync(agents, readFileSync(agents, "utf8").replace("## AI comments", "## stale copy") + "More rules.\n");
    box.cli(main, "init", "--agents-md");
    expect(read("main", "AGENTS.md")).toBe(first + "More rules.\n");
  });
});

describe("AGENTS.md edits by init --agents-md and uninstall", () => {
  let box: Sandbox;
  const snippet = agentsSnippet();
  const crlfSnippet = snippet.replaceAll("\n", "\r\n");

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
  });
  afterAll(() => box.dispose());

  // Each row: AGENTS.md before init (undefined: no file), init's report and result, uninstall's report and result.
  it.each([
    [
      "no file",
      undefined,
      "create with the sigil convention",
      snippet,
      "delete (only the sigil convention was in it)",
      undefined,
    ],
    [
      "no final line break",
      "# A",
      "add the sigil convention",
      `# A\n\n${snippet}`,
      "remove the sigil convention",
      "# A\n",
    ],
    [
      "one final line break",
      "# A\n",
      "add the sigil convention",
      `# A\n\n${snippet}`,
      "remove the sigil convention",
      "# A\n",
    ],
    [
      "a blank last line",
      "# A\n\n",
      "add the sigil convention",
      `# A\n\n${snippet}`,
      "remove the sigil convention",
      "# A\n",
    ],
    [
      "CRLF",
      "# A\r\n",
      "add the sigil convention",
      `# A\r\n\r\n${crlfSnippet}`,
      "remove the sigil convention",
      "# A\r\n",
    ],
    [
      "text after the snippet",
      `# A\n\n${snippet}tail\n`,
      undefined,
      `# A\n\n${snippet}tail\n`,
      "remove the sigil convention",
      "# A\n\ntail\n",
    ],
  ])("%s", (name, before, initWhat, afterInit, uninstallWhat, afterUninstall) => {
    const repo = box.path(name.replaceAll(" ", "-"));
    box.git(box.dir, "init", "-q", repo);
    const agents = path.join(repo, "AGENTS.md");
    if (before !== undefined) writeFileSync(agents, before);
    const initOut = box.cli(repo, "init", "--agents-md");
    if (initWhat) expect(initOut).toContain(`AGENTS.md: ${initWhat}\n`);
    else expect(initOut).not.toContain("AGENTS.md");
    expect(readFileSync(agents, "utf8")).toBe(afterInit);
    expect(box.cli(repo, "uninstall")).toContain(`AGENTS.md: ${uninstallWhat}\n`);
    expect(existsSync(agents) ? readFileSync(agents, "utf8") : undefined).toBe(afterUninstall);
  });
});
