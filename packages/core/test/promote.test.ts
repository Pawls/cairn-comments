import { describe, expect, it } from "vitest";
import { clean, convertComments, demoteTarget, parseSidecar, promote, sync, type ScannedComment, type Sidecar } from "../src/index.js";

const empty: Sidecar = { preamble: "", entries: [] };

/** What `demote <file>:<line>` does in a normal checkout: convert, sync, collapse. */
async function demote(path: string, source: string, line: number, sidecar: Sidecar = empty): Promise<{ source: string; sidecar: Sidecar }> {
  const target = await demoteTarget(path, source, line);
  if (typeof target === "string") throw new Error(target);
  const synced = await sync(path, convertComments(path, source, [target]), sidecar);
  return { source: await clean(path, synced.source), sidecar: synced.sidecar };
}

const idOf = (source: string) => /[#/]~([0-9a-z]{4})/.exec(source)![1]!;

describe("promote", () => {
  it("replaces a bare marker with the stored body and drops the entry, anchor included", async () => {
    const sidecar = parseSidecar("## ab12\n<!-- anchor=0123abcd by=claude -->\nfirst line\n\nsecond line\n\n## cd34\nkept\n");
    const result = await promote("a.py", "def f():\n    #~ab12\n    x = 1  #~cd34\n", sidecar, ["ab12"]);
    expect(result.source).toBe("def f():\n    # first line\n    #\n    # second line\n    x = 1  #~cd34\n");
    expect(result.sidecar.entries.map((e) => e.id)).toEqual(["cd34"]);
    expect(result.missing).toEqual([]);
  });

  it("keeps each line's CRLF terminator and flattens a body onto a trailing marker", async () => {
    const sidecar = parseSidecar("## ab12\nsee\nthe ledger\n");
    expect((await promote("a.ts", "f();  //~ab12\r\ng();\r\n", sidecar, ["ab12"])).source).toBe("f();  // see the ledger\r\ng();\r\n");
    expect((await promote("a.ts", "  //~ab12\r\ng();\r\n", sidecar, ["ab12"])).source).toBe("  // see\r\n  // the ledger\r\ng();\r\n");
  });

  it("promotes an expanded marker's own text, stale tag stripped", async () => {
    const sidecar = parseSidecar("## ab12\nold text\n");
    const result = await promote("a.py", "#~ab12 [stale?] edited text\n#  indented continuation\nx = 1\n", sidecar, ["ab12"]);
    expect(result.source).toBe("# edited text\n#  indented continuation\nx = 1\n");
  });

  it("reports ids with no marker or no body and changes nothing for them", async () => {
    const source = "#~ab12\nx = 1\n";
    const result = await promote("a.py", source, parseSidecar("## zz99\norphan\n"), ["ab12", "zz99"]);
    expect(result.missing).toEqual(["ab12", "zz99"]);
    expect(result.source).toBe(source);
    expect(result.sidecar.entries.map((e) => e.id)).toEqual(["zz99"]);
  });
});

describe("demoteTarget", () => {
  it("finds the whole group around a line and overrides scan-only protection", async () => {
    const source = "x = 1\n# one\n# two\n\n# TODO(ab): JIRA-1 fix\ny = 2  # trailing\n";
    const group = (await demoteTarget("a.py", source, 3)) as ScannedComment;
    expect([group.line, group.endLine, group.text]).toEqual([2, 3, "one\ntwo"]);
    expect(await demoteTarget("a.py", source, 5)).toMatchObject({ text: "TODO(ab): JIRA-1 fix", protected: undefined });
    expect(((await demoteTarget("a.py", source, 6)) as ScannedComment).placement).toBe("trailing");
  });

  it("explains why a line has nothing to demote", async () => {
    expect(await demoteTarget("a.py", "x = 1\n", 1)).toBe("no comment on this line");
    expect(await demoteTarget("a.py", "#~ab12\nx = 1\n", 1)).toBe("already an AI comment");
    expect(await demoteTarget("a.py", "# noqa: E501\nx = 1\n", 1)).toBe("a pragma comment stays in the code");
    expect(await demoteTarget("a.ts", "/** Docs. */\nfunction f() {}\n", 1)).toBe("a doc comment stays in the code");
    expect(await demoteTarget("a.txt", "# x\n", 1)).toBe("not a supported language");
  });
});

describe("demote then promote", () => {
  const CASES: [string, string, number][] = [
    ["a.py", "def f():\n    # retry once: the proxy drops idle sockets\n    #\n    #  indented detail\n    call()\n", 2],
    ["a.py", "x = compute()  # cached upstream\r\ny = 2\r\n", 1],
    ["a.ts", "export function f() {\r\n  // guard: callers pass null\r\n  return g();\r\n}\r\n", 2],
    ["a.cs", "class C {\n    // keep: reflection reads this\n    int x;\n}\n", 2],
    ["a.java", "class C {\n  int x; // units: ms\n}", 2],
  ];

  it.each(CASES)("restores the original bytes (%s, %j)", async (path, original, line) => {
    const demoted = await demote(path, original, line);
    const id = idOf(demoted.source);
    expect(demoted.source).not.toBe(original);
    expect(demoted.sidecar.entries.map((e) => [e.id, e.meta.has("anchor")])).toEqual([[id, true]]);
    const promoted = await promote(path, demoted.source, demoted.sidecar, [id]);
    expect(promoted.source).toBe(original);
    expect(promoted.sidecar.entries).toEqual([]);
  });

  it("brings a block comment back as line comments", async () => {
    const demoted = await demote("a.ts", "/* two\n   lines */\nf();\n", 1);
    expect((await promote("a.ts", demoted.source, demoted.sidecar, [idOf(demoted.source)])).source).toBe("// two\n// lines\nf();\n");
  });
});
