import { describe, expect, it } from "vitest";
import { parseSidecar, serializeSidecar, sidecarPathFor } from "../src/index.js";

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

  it("keeps the later copy of a heading duplicated by a union merge, in the earlier position", () => {
    const sidecar = parseSidecar("## a1b2\nours\n\n## c3d4\nother\n\n## a1b2\ntheirs\n");
    expect(sidecar.entries.map((e) => [e.id, e.body])).toEqual([
      ["a1b2", "theirs"],
      ["c3d4", "other"],
    ]);
  });
});
