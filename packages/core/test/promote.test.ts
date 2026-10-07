import { describe, expect, it } from "vitest";
import {
  analyzeSource,
  convertDemoted,
  demoteTarget,
  placeComments,
  promotePlaced,
  recordComments,
  recordLiterals,
  stripComments,
  type ScannedComment,
  type Sidecar,
} from "../src/index.js";

const empty: Sidecar = { preamble: "", entries: [] };

/** What `demote <file>:<line>` does in the owner's checkout: convert, record, strip. */
async function demote(path: string, source: string, line: number, sidecar: Sidecar = empty): Promise<{ source: string; sidecar: Sidecar; id: string }> {
  const target = await demoteTarget(path, source, line);
  if (typeof target === "string") throw new Error(target);
  const converted = convertDemoted(path, source, [target], new Set(sidecar.entries.map((e) => e.id)));
  const recorded = await recordComments(path, converted.source, sidecar);
  return { source: await stripComments(path, recorded.source), sidecar: recordLiterals(recorded.sidecar, converted.literals), id: recorded.ids[0]! };
}

async function promote(path: string, demoted: { source: string; sidecar: Sidecar; id: string }) {
  return promotePlaced(path, demoted.source, demoted.sidecar, [demoted.id]);
}

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

  it("finds a bare string statement that is not a docstring, on any of its lines", async () => {
    const source = 'def f():\n    """Doc."""\n    x = 1\n    """\n    Note about y.\n    """\n    y = 2\n';
    for (const line of [4, 5, 6]) {
      expect(await demoteTarget("a.py", source, line)).toMatchObject({ style: "string", line: 4, endLine: 6, text: "Note about y.", protected: undefined });
    }
    expect(await demoteTarget("a.py", 'def f():\n    x = 1\n    """After an assignment in a function."""\n    y = 2\n', 3)).toMatchObject({ style: "string" });
  });

  it("refuses docstrings, attribute docstrings, f-strings, and a string alone in its block", async () => {
    const docstring = "a docstring stays in the code";
    expect(await demoteTarget("a.py", '"""Module."""\nx = 1\n', 1)).toBe(docstring);
    expect(await demoteTarget("a.py", '#!/usr/bin/env python\n# header\n"""Module."""\nx = 1\n', 3)).toBe(docstring);
    expect(await demoteTarget("a.py", 'def f():\n    """Doc."""\n    return 1\n', 2)).toBe(docstring);
    expect(await demoteTarget("a.py", 'class C:\n    """Doc."""\n    x = 1\n', 2)).toBe(docstring);
    expect(await demoteTarget("a.py", "x = 1\n'''About x.'''\ny = 2\n", 2)).toBe(docstring);
    expect(await demoteTarget("a.py", 'class C:\n    x: int = 1\n    """About x."""\n    y = 2\n', 3)).toBe(docstring);
    expect(await demoteTarget("a.py", 'class C:\n    def __init__(self):\n        self.x = 1\n        """About x."""\n        self.y = 2\n', 4)).toBe(docstring);
    expect(await demoteTarget("a.py", 'def f():\n    x = 1\n    f"""{x}"""\n    y = 2\n', 3)).toBe("an f-string runs code, so it stays in the code");
    expect(await demoteTarget("a.py", 'def f(x):\n    y = 1\n    if x:\n        "only"\n', 4)).toBe("the only statement in its block stays in the code");
    expect(await demoteTarget("a.py", 'def f():\n    x = 1\n    "a" "b"\n    y = 2\n', 3)).toBe("no comment on this line");
    expect(await demoteTarget("a.py", 'def f():\n    x = 1\n    y = "text"\n', 3)).toBe("no comment on this line");
  });

  it("never offers a string to scan", async () => {
    expect(await analyzeSource("a.py", 'def f():\n    x = 1\n    """Note."""\n    y = 2\n')).toEqual([]);
  });
});

describe("demote then promote", () => {
  const CASES: [string, string, number][] = [
    ["a.py", "def f():\n    # retry once: the proxy drops idle sockets\n    #\n    #  indented detail\n    call()\n", 2],
    ["a.py", "x = compute()  # cached upstream\r\ny = 2\r\n", 1],
    ["a.ts", "export function f() {\r\n  // guard: callers pass null\r\n  return g();\r\n}\r\n", 2],
    ["a.cs", "class C {\n    // keep: reflection reads this\n    int x;\n}\n", 2],
    ["a.java", "class C {\n  int x; // units: ms\n}", 2],
    ["a.kt", "class C {\n    // keep: reflection reads this\n    val x = 1\n}\n", 2],
  ];

  it.each(CASES)("restores the original bytes (%s, %j)", async (path, original, line) => {
    const demoted = await demote(path, original, line);
    expect(demoted.source).not.toBe(original);
    expect(demoted.sidecar.entries.map((e) => [e.id, e.meta.has("pos")])).toEqual([[demoted.id, true]]);
    const promoted = await promote(path, demoted);
    expect(promoted.source).toBe(original);
    expect(promoted.sidecar.entries).toEqual([]);
  });

  it("reports an id that does not place and changes nothing", async () => {
    const demoted = await demote("a.py", CASES[0]![1], 2);
    const promoted = await promotePlaced("a.py", demoted.source, demoted.sidecar, ["zz99"]);
    expect(promoted).toEqual({ source: demoted.source, sidecar: demoted.sidecar, missing: ["zz99"] });
  });

  const STRINGS: [string, string, number][] = [
    ["a.py", 'def f():\n    x = 1\n    """\n    Note about y.\n\n      indented more\n    """\n    y = 2\n', 4],
    ["a.py", "def f():\r\n    x = 1\r\n    r'''Raw \\d note,\r\n    second line.'''\r\n    y = 2\r\n", 3],
    ["a.py", 'def f():\n    x = 1\n    "short note"\n    y = 2\n', 3],
    ["a.py", '"""Module."""\nimport os\n\n"""Helpers below.\n"""\ndef g():\n    pass\n', 4],
    ["a.py", 'def f():\n    x = 1\n    """Last statement."""\n', 3],
  ];

  it.each(STRINGS)("restores a demoted string's bytes (%s, %j)", async (path, original, line) => {
    const demoted = await demote(path, original, line);
    expect(demoted.source).not.toContain(original.split("\n")[line - 1]!.trim());
    expect(demoted.sidecar.entries.map((e) => e.meta.has("literal"))).toEqual([true]);
    expect((await promote(path, demoted)).source).toBe(original);
  });

  it("stores a demoted string's text without its quotes or indentation", async () => {
    const demoted = await demote("a.py", STRINGS[0]![1], 5);
    expect(demoted.sidecar.entries[0]!.body).toBe("Note about y.\n\n  indented more");
  });

  it("promotes an edited string body that no longer fits its quotes as comments", async () => {
    const demoted = await demote("a.py", STRINGS[2]![1], 3);
    demoted.sidecar.entries[0]!.body = 'now "quoted"\nand two lines';
    expect((await promote("a.py", demoted)).source).toBe(
      'def f():\n    x = 1\n    # now "quoted"\n    # and two lines\n    y = 2\n',
    );
  });

  it("brings a block comment back as line comments", async () => {
    const demoted = await demote("a.ts", "/* two\n   lines */\nf();\n", 1);
    expect((await promote("a.ts", demoted)).source).toBe("// two\n// lines\nf();\n");
  });
});

describe("a string comment moved in or out of a function", () => {
  const METHOD = 'class C:\n    def m(self):\n        x = 1\n        """Note about y."""\n        y = 2\n        return y\n';
  const WITH_TRAILING = METHOD.replace("y = 2\n", "y = 2  #~ trailing note\n");

  /** Records the trailing comment in `source` (the agent's file) into a fresh sidecar. */
  async function recordTrailing(source: string): Promise<Sidecar> {
    return (await recordComments("a.py", source, empty)).sidecar;
  }

  it("leaves a neighbor recorded before the demote exact", async () => {
    const sidecar = await recordTrailing(WITH_TRAILING);
    // The owner's checkout shows no AI comments, so the demote records only the string.
    const demoted = await demote("a.py", METHOD, 4, sidecar);
    const placed = await placeComments("a.py", demoted.source, demoted.sidecar);
    expect(placed.placed).toContain(sidecar.entries[0]!.id);
    expect(placed.stale).toEqual([]);
  });

  it("leaves a neighbor recorded while the string was demoted exact once it is promoted", async () => {
    const demoted = await demote("a.py", METHOD, 4);
    // The trailing comment is written on another branch, where the string is still in the sidecar.
    const trailing = await recordTrailing(demoted.source.replace("y = 2\n", "y = 2  #~ trailing note\n"));
    const promoted = await promote("a.py", demoted);
    const placed = await placeComments("a.py", promoted.source, trailing);
    expect(placed.placed).toEqual([trailing.entries[0]!.id]);
    expect(placed.stale).toEqual([]);
  });

  it("keeps a neighbor stale across the promote when its function changed before it", async () => {
    const demoted = await demote("a.py", METHOD, 4, await recordTrailing(WITH_TRAILING));
    // The owner edits the method; the trailing comment was written for the old code.
    const edited = { ...demoted, source: demoted.source.replace("x = 1", "x = 3") };
    const trailingId = demoted.sidecar.entries.find((e) => !e.meta.has("literal"))!.id;
    expect((await placeComments("a.py", edited.source, edited.sidecar)).stale.map((s) => s.id)).toContain(trailingId);
    const promoted = await promote("a.py", edited);
    expect((await placeComments("a.py", promoted.source, promoted.sidecar)).stale.map((s) => s.id)).toEqual([trailingId]);
  });

  it("re-records the neighbors a promote can see", async () => {
    const demoted = await demote("a.py", METHOD, 4, await recordTrailing(WITH_TRAILING));
    const promoted = await promote("a.py", demoted);
    expect(promoted.source).toBe(METHOD);
    expect((await placeComments("a.py", promoted.source, promoted.sidecar)).stale).toEqual([]);
  });
});
