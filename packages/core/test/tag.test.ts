import { describe, expect, it } from "vitest";
import { convertComments, newComments, parseSidecar, serializeSidecar, sync } from "../src/index.js";

const texts = async (path: string, source: string, baseline: string) => (await newComments(path, source, baseline)).map((c) => c.text);

describe("newComments", () => {
  const baseline = "def f(x):\n    # human note\n    # second human line\n    return x  # keep\n";

  it("finds comments the baseline lacks and ignores the ones it has", async () => {
    const source = "def f(x):\n    # human note\n    # second human line\n    # agent: x is never None here\n    return x  # keep\n";
    expect(await texts("a.py", source, baseline)).toEqual(["agent: x is never None here"]);
  });

  it("splits new lines out of an existing group, leaving the human lines as written", async () => {
    const source = "def f(x):\n    # human note\n    # second human line\n    # agent line one\n    # agent line two\n    return x  # keep\n";
    const found = await newComments("a.py", source, baseline);
    expect(found.map((c) => [c.text, c.line, c.endLine])).toEqual([["agent line one\nagent line two", 4, 5]]);
    expect(convertComments("a.py", source, found)).toBe(
      "def f(x):\n    # human note\n    # second human line\n    #~ agent line one\n    #~ agent line two\n    return x  # keep\n",
    );
  });

  it("counts an edited line as new and matches duplicates as a multiset", async () => {
    const source = "def f(x):\n    # human note, reworded\n    # second human line\n    return x  # keep\ny = 1  # keep\n";
    expect(await texts("a.py", source, baseline)).toEqual(["human note, reworded", "keep"]);
  });

  it("treats every unprotected comment of an untracked file as new, and never a protected one", async () => {
    const source = "#!/usr/bin/env python\n# Copyright 2026 Example\nimport os  # noqa: F401\n# print(os)\n\n# Now we load the config\n";
    expect(await texts("a.py", source, "")).toEqual(["Now we load the config"]);
  });

  it("skips sigil comments, which are already managed", async () => {
    expect(await texts("a.ts", "//~ agent text\nconst a = 1; //~ab12 more\n", "")).toEqual([]);
  });

  it("matches a block comment as a whole", async () => {
    const before = "/* the cache is per request */\nconst a = 1;\n";
    expect(await texts("a.ts", before, before)).toEqual([]);
    expect(await texts("a.ts", "/* the cache is per process */\nconst a = 1;\n", before)).toEqual(["the cache is per process"]);
  });
});

describe("sync provenance", () => {
  const meta = new Map([
    ["by", "claude-code"],
    ["model", "claude-haiku-4-5"],
    ["at", "2026-09-22T20:33:22Z"],
  ]);

  it("stamps new and edited entries and leaves untouched ones alone", async () => {
    const stored = parseSidecar("## ab12\n<!-- hash=x -->\nold text\n\n## cd34\nsame\n");
    const source = "#~ab12 new text\n#~cd34 same\nx = 1\n#~ fresh\n";
    const { sidecar } = await sync("a.py", source, stored, { meta });
    const byId = new Map(sidecar.entries.map((e) => [e.id, e]));
    expect([...byId.get("ab12")!.meta.keys()]).toEqual(["hash", "by", "model", "at", "anchor"]);
    // An unchanged body gains only its anchor (A7), never provenance.
    expect([...byId.get("cd34")!.meta.keys()]).toEqual(["anchor"]);
    expect(new Map([...sidecar.entries[2]!.meta].filter(([k]) => k !== "anchor"))).toEqual(meta);
    expect(stored.entries[0]!.meta.size).toBe(1);
  });

  it("writes timestamps and model names readably and reads them back", () => {
    const meta = new Map([
      ["model", "gpt-5.5 codex/high"],
      ["at", "2026-09-22T20:33:22Z"],
      ["odd", "a --> b=c%"],
    ]);
    const text = serializeSidecar({ preamble: "", entries: [{ id: "ab12", meta, body: "x" }] });
    expect(text).toBe("## ab12\n<!-- model=gpt-5.5%20codex/high at=2026-09-22T20:33:22Z odd=a%20--%3E%20b%3Dc%25 -->\nx\n");
    expect(parseSidecar(text).entries[0]!.meta).toEqual(meta);
  });
});
