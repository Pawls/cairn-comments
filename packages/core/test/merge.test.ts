import { describe, expect, it } from "vitest";
import { mergeSidecars, parseSidecar, serializeSidecar } from "../src/index.js";

const merge = (base: string, ours: string, theirs: string) => {
  const result = mergeSidecars(parseSidecar(base), parseSidecar(ours), parseSidecar(theirs));
  return { text: serializeSidecar(result.sidecar), conflicts: result.conflicts };
};

const BASE = "## ab12\n<!-- pos=before scope=settle node=11111111 -->\nretries are safe\n\n## cd34\n<!-- pos=trail scope=settle node=22222222 -->\nkeyed on order id\n";

describe("sidecar merge", () => {
  it("appends theirs' new entries after ours and keeps a one-sided edit with its metadata", () => {
    const ours = BASE.replace("keyed on order id", "keyed on order.id") + "\n## gh78\nours new\n";
    const theirs = BASE.replace("node=11111111", "node=33333333") + "\n## ef56\ntheirs new\n";
    expect(merge(BASE, ours, theirs)).toEqual({
      text:
        "## ab12\n<!-- pos=before scope=settle node=33333333 -->\nretries are safe\n\n## cd34\n<!-- pos=trail scope=settle node=22222222 -->\nkeyed on order.id\n\n" +
        "## gh78\nours new\n\n## ef56\ntheirs new\n",
      conflicts: [],
    });
  });

  it("takes the metadata that goes with the body that changed", () => {
    const ours = BASE.replace("node=11111111 -->\nretries are safe", "node=11111111 at=2026-09-02T00:00:00Z -->\nretries are safe; dedupes");
    const theirs = BASE.replace("node=11111111", "node=55555555");
    expect(merge(BASE, ours, theirs).text).toContain("## ab12\n<!-- pos=before scope=settle node=11111111 at=2026-09-02T00:00:00Z -->\nretries are safe; dedupes\n");
  });

  it("merges a placement as one unit, so a comment never mixes two recordings of where it goes", () => {
    const ours = BASE.replace("pos=before scope=settle node=11111111", "pos=before scope=settle node=44444444 nth=1");
    const theirs = BASE.replace("pos=before scope=settle node=11111111", "pos=after scope=refund node=11111111 by=codex");
    expect(merge(BASE, ours, theirs).text).toContain("## ab12\n<!-- pos=before scope=settle node=44444444 nth=1 by=codex -->\nretries are safe\n");
    expect(merge(BASE, BASE, theirs).text).toContain("## ab12\n<!-- pos=after scope=refund node=11111111 by=codex -->\n");
  });

  it("writes conflict markers into a body both sides changed differently", () => {
    const ours = BASE.replace("retries are safe", "retries are safe; the ledger dedupes");
    const theirs = BASE.replace("retries are safe", "retries are safe because writes are idempotent");
    const { text, conflicts } = merge(BASE, ours, theirs);
    expect(conflicts).toEqual(["ab12"]);
    expect(text).toContain(
      "## ab12\n<!-- pos=before scope=settle node=11111111 -->\n<<<<<<< ours\nretries are safe; the ledger dedupes\n=======\nretries are safe because writes are idempotent\n>>>>>>> theirs\n",
    );
    // What union merges did instead: the second metadata line and both bodies became one body.
    expect(parseSidecar(text).entries.map((e) => e.id)).toEqual(["ab12", "cd34"]);
  });

  it("an identical edit on both sides is not a conflict", () => {
    const both = BASE.replace("retries are safe", "retries are idempotent");
    expect(merge(BASE, both, both)).toEqual({ text: both, conflicts: [] });
  });

  it("a deletion wins over an unchanged entry and loses to an edit", () => {
    const withoutAb12 = "## cd34\n<!-- pos=trail scope=settle node=22222222 -->\nkeyed on order id\n";
    expect(merge(BASE, withoutAb12, BASE).text).toBe(withoutAb12);
    expect(merge(BASE, BASE, withoutAb12).text).toBe(withoutAb12);
    const edited = BASE.replace("retries are safe", "retries are safe now");
    expect(merge(BASE, withoutAb12, edited).text).toBe(withoutAb12 + "\n## ab12\n<!-- pos=before scope=settle node=11111111 -->\nretries are safe now\n");
    expect(merge(BASE, edited, withoutAb12).text).toBe(edited);
  });

  it("merges metadata other than the placement per key, and ours wins a key both sides changed", () => {
    const base = "## ab12\n<!-- by=codex model=a -->\nbody\n";
    const ours = "## ab12\n<!-- by=cursor model=a -->\nbody\n";
    const theirs = "## ab12\n<!-- by=claude model=b session=s1 -->\nbody\n";
    expect(merge(base, ours, theirs).text).toBe("## ab12\n<!-- by=cursor model=b session=s1 -->\nbody\n");
    const dropped = "## ab12\n<!-- by=codex -->\nbody\n";
    expect(merge(base, base, dropped).text).toBe(dropped);
  });

  it("merges the preamble: one side's edit wins, two different edits conflict", () => {
    const base = `note\n\n${BASE}`;
    const ours = base.replace("note", "ours note");
    const theirs = base.replace("note", "theirs note");
    expect(merge(base, ours, base)).toEqual({ text: ours, conflicts: [] });
    expect(merge(base, base, theirs)).toEqual({ text: theirs, conflicts: [] });
    const both = merge(base, ours, theirs);
    expect(both.conflicts).toEqual(["(preamble)"]);
    expect(both.text.startsWith("<<<<<<< ours\nours note\n=======\ntheirs note\n>>>>>>> theirs\n")).toBe(true);
  });

  it("an entry both sides added with one id merges when the bodies agree", () => {
    const added = BASE + "\n## zz11\n<!-- by=codex -->\nsame text\n";
    const addedToo = BASE + "\n## zz11\n<!-- by=cursor -->\nsame text\n";
    expect(merge(BASE, added, addedToo)).toEqual({ text: added, conflicts: [] });
  });
});
