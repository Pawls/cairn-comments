import { describe, expect, it } from "vitest";
import { normalizeBody, parseSidecar, serializeSidecar, sidecarPathFor } from "../src/index.js";

describe("sidecar", () => {
  it("mirrors the source path under the tracked folder", () => {
    expect(sidecarPathFor("src\\pkg/settle.py")).toBe(".agents/comments/src/pkg/settle.py.md");
  });

  it("reads the design.md sample and writes it back byte for byte", () => {
    const text = "## a1b2\nretries are safe: ledger write is idempotent\n\n## c3d4\nkeyed on order.id\n";
    const sidecar = parseSidecar(text);
    expect(sidecar.entries.map((e) => [e.id, e.body])).toEqual([
      ["a1b2", "retries are safe: ledger write is idempotent"],
      ["c3d4", "keyed on order.id"],
    ]);
    expect(serializeSidecar(sidecar)).toBe(text);
  });

  it("round-trips a preamble, the reserved metadata line, and multi-paragraph bodies", () => {
    const text = [
      "# Comments for settle.py",
      "",
      "## a1b2",
      "<!-- model=fable%205.1 session=abc -->",
      "first paragraph",
      "",
      "second paragraph",
      "",
      "## c3d4",
      "plain",
      "",
    ].join("\n");
    const sidecar = parseSidecar(text);
    expect(sidecar.preamble).toBe("# Comments for settle.py");
    expect([...sidecar.entries[0]!.meta]).toEqual([
      ["model", "fable 5.1"],
      ["session", "abc"],
    ]);
    expect(sidecar.entries[0]!.body).toBe("first paragraph\n\nsecond paragraph");
    expect(serializeSidecar(sidecar)).toBe(text);
  });

  it("reads CRLF sidecars and always writes LF", () => {
    const sidecar = parseSidecar("## a1b2\r\nbody\r\n");
    expect(serializeSidecar(sidecar)).toBe("## a1b2\nbody\n");
  });

  it("escapes body lines that would read back as structure", () => {
    const body = "<!-- looks like metadata -->\n## zz99\n\\## zz99\n## not an id heading";
    const text = serializeSidecar({ preamble: "", entries: [{ id: "a1b2", meta: new Map(), body }] });
    const back = parseSidecar(text);
    expect(back.entries).toHaveLength(1);
    expect(back.entries[0]!.body).toBe(body);
    expect(back.entries[0]!.meta.size).toBe(0);
  });

  it("keeps text before the first heading as the preamble and reads a bare heading as an empty entry", () => {
    const sidecar = parseSidecar("note\n\n## a1b2\n## c3d4\nbody\n");
    expect(sidecar.preamble).toBe("note");
    expect(sidecar.entries.map((e) => [e.id, e.body, e.meta.size])).toEqual([
      ["a1b2", "", 0],
      ["c3d4", "body", 0],
    ]);
  });

  it("reads a metadata line only as the first line under a heading", () => {
    const later = parseSidecar("## a1b2\nfirst\n<!-- k=v -->\n");
    expect(later.entries[0]!.meta.size).toBe(0);
    expect(later.entries[0]!.body).toBe("first\n<!-- k=v -->");

    const afterBlank = parseSidecar("## a1b2\n\n<!-- k=v -->\nbody\n");
    expect(afterBlank.entries[0]!.meta.size).toBe(0);
    expect(afterBlank.entries[0]!.body).toBe("<!-- k=v -->\nbody");
  });

  it("decodes metadata values and skips pairs without a key", () => {
    const sidecar = parseSidecar("## a1b2\n<!-- ok=a%20b bad=%E0%A4%A =orphan flag -->\nbody\n");
    expect([...sidecar.entries[0]!.meta]).toEqual([
      ["ok", "a b"],
      ["bad", "%E0%A4%A"],
    ]);
  });

  it("round-trips an entry that has metadata and no body", () => {
    const text = "## a1b2\n<!-- by=codex -->\n";
    expect(serializeSidecar(parseSidecar(text))).toBe(text);
  });

  it("trims trailing spaces and blank edges from a body", () => {
    expect(normalizeBody("\r\n\n  keep indent  \r\n\nsecond \n\n")).toBe("  keep indent\n\nsecond");
    expect(normalizeBody("\n \n")).toBe("");
  });

  it("drops the metadata of the earlier copy of a duplicated heading, even when the later copy has none", () => {
    const earlierHasMeta = parseSidecar("## a1b2\n<!-- by=codex -->\nours\n\n## a1b2\ntheirs\n");
    expect(earlierHasMeta.entries).toEqual([{ id: "a1b2", meta: new Map(), body: "theirs" }]);
    const laterHasMeta = parseSidecar("## a1b2\nours\n\n## a1b2\n<!-- by=cursor -->\ntheirs\n");
    expect(laterHasMeta.entries).toEqual([{ id: "a1b2", meta: new Map([["by", "cursor"]]), body: "theirs" }]);
  });

  it("keeps the later copy of a heading duplicated by a union merge, in the earlier position", () => {
    const sidecar = parseSidecar("## a1b2\nours\n\n## c3d4\nother\n\n## a1b2\ntheirs\n");
    expect(sidecar.entries.map((e) => [e.id, e.body])).toEqual([
      ["a1b2", "theirs"],
      ["c3d4", "other"],
    ]);
  });
});
