import { describe, expect, it } from "vitest";
import {
  carryComments,
  confirmPlaced,
  convertDemoted,
  demoteTarget,
  placeComments,
  promotePlaced,
  recordComments,
  recordLiterals,
  stripComments,
  type Sidecar,
} from "../src/index.js";

const EMPTY: Sidecar = { preamble: "", entries: [] };

const WORKING = [
  "def settle(order):",
  "    #~ retries are safe",
  "    #~ second line",
  "    ledger.write(order.id)  #~ keyed on order.id",
  "    notify(order)",
  "",
  "",
  "def refund(order):",
  "    #~ refunded by hand",
  "    return None",
  "",
].join("\n");

/** The owner's view of WORKING: its code and the sidecar `sync` wrote for it. */
async function owner(working = WORKING, path = "a.py") {
  const recorded = await recordComments(path, working, EMPTY);
  return { code: await stripComments(path, recorded.source), sidecar: recorded.sidecar, ids: recorded.sidecar.entries.map((e) => e.id) };
}

describe("confirmPlaced", () => {
  it("clears the stale flag of the named comment only", async () => {
    const { code, sidecar, ids } = await owner();
    const edited = code.replace("notify(order)", "notify(order, loud=True)");
    const before = await placeComments("a.py", edited, sidecar);
    expect(before.stale.map((s) => s.id).sort()).toEqual([ids[0], ids[1]].sort());

    const result = await confirmPlaced("a.py", edited, sidecar, [ids[0]!]);
    expect(result.missing).toEqual([]);
    expect(result.changed).toBe(true);
    const after = await placeComments("a.py", edited, result.sidecar);
    expect(after.stale.map((s) => s.id)).toEqual([ids[1]]);
  });

  it("changes nothing when an id does not place", async () => {
    const { code, sidecar } = await owner();
    const result = await confirmPlaced("a.py", code, sidecar, ["zzzz"]);
    expect(result).toEqual({ sidecar, changed: false, missing: ["zzzz"] });
  });
});

describe("promotePlaced", () => {
  it("writes the body in as an ordinary comment and drops the entry", async () => {
    const { code, sidecar, ids } = await owner();
    const result = await promotePlaced("a.py", code, sidecar, [ids[0]!]);
    expect(result.missing).toEqual([]);
    expect(result.source).toBe(code.replace("    ledger.write", "    # retries are safe\n    # second line\n    ledger.write"));
    expect(result.sidecar.entries.map((e) => e.id)).toEqual(ids.slice(1));
    const placed = await placeComments("a.py", result.source, result.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.stale).toEqual([]);
  });

  it("promotes a trailing comment onto its line", async () => {
    const { code, sidecar, ids } = await owner();
    const result = await promotePlaced("a.py", code, sidecar, [ids[1]!]);
    expect(result.source).toContain("    ledger.write(order.id)  # keyed on order.id\n");
  });

  it("writes a demoted string back as the same string", async () => {
    const original = 'def settle(order):\n    ledger.write(order.id)\n    """\n    Idempotent: keyed on order.id.\n    """\n    notify(order)\n';
    const target = await demoteTarget("a.py", original, 4);
    if (typeof target === "string") throw new Error(target);
    const converted = convertDemoted("a.py", original, [target], new Set());
    const recorded = await recordComments("a.py", converted.source, EMPTY);
    const sidecar = recordLiterals(recorded.sidecar, converted.literals);
    const code = await stripComments("a.py", recorded.source);
    expect(code).toBe("def settle(order):\n    ledger.write(order.id)\n    notify(order)\n");

    const result = await promotePlaced("a.py", code, sidecar, [sidecar.entries[0]!.id]);
    expect(result.missing).toEqual([]);
    expect(result.source).toBe(original);
    expect(result.sidecar.entries).toEqual([]);
  });

  it("keeps a stale comment stale", async () => {
    const { code, sidecar, ids } = await owner();
    const edited = code.replace("notify(order)", "notify(order, loud=True)");
    const result = await promotePlaced("a.py", edited, sidecar, [ids[2]!]);
    const placed = await placeComments("a.py", result.source, result.sidecar);
    expect(placed.stale.map((s) => s.id).sort()).toEqual([ids[0], ids[1]].sort());
  });
});

describe("carryComments", () => {
  it("anchors a pasted function's comments to the copy, with new ids and the copy's provenance", async () => {
    const { code, sidecar, ids } = await owner();
    sidecar.entries[2]!.meta.set("by", "claude-code");
    const pasted = code + "\ndef refund(order):\n    return None\n";
    const row = pasted.split("\n").indexOf("    return None", pasted.split("\n").indexOf("    return None") + 1);
    const result = await carryComments("a.py", pasted, sidecar, [
      { row, kind: "own", body: "refunded by hand", meta: sidecar.entries[2]!.meta, from: ids[2]! },
    ]);
    const id = result.ids[0]!;
    expect(id).toMatch(/^[0-9a-z]{4}$/);
    expect(ids).not.toContain(id);
    const entry = result.sidecar.entries.at(-1)!;
    expect(entry.id).toBe(id);
    expect(entry.meta.get("by")).toBe("claude-code");
    expect(entry.meta.get("copied-from")).toBe(ids[2]);
    expect(entry.meta.get("scope")).toBe("refund@1");

    const placed = await placeComments("a.py", pasted, result.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.sites.filter((s) => s.id === id)).toEqual([{ id, row, kind: "own" }]);
    expect(placed.sites.filter((s) => s.id === ids[2])).toEqual([{ id: ids[2], row: 6, kind: "own" }]);
  });

  it("a moved comment keeps its id and provenance, without copied-from", async () => {
    const { code, sidecar } = await owner();
    const original = sidecar.entries[2]!;
    original.meta.set("by", "claude-code");
    // `refund` cut from below `settle` and pasted above it; the caller drops the original entry.
    // `q0q0` is not the id the body would generate, so keeping it is not a coincidence.
    const refund = "def refund(order):\n    return None\n\n\n";
    const moved = refund + code.replace(/def refund[^]*$/, "");
    const rest: Sidecar = { preamble: sidecar.preamble, entries: sidecar.entries.filter((e) => e !== original) };
    const result = await carryComments("a.py", moved, rest, [{ row: 1, kind: "own", body: "refunded by hand", meta: original.meta, from: "q0q0", moved: true }]);
    expect(result.ids).toEqual(["q0q0"]);
    const entry = result.sidecar.entries.find((e) => e.id === "q0q0")!;
    expect(entry.meta.get("by")).toBe("claude-code");
    expect(entry.meta.has("copied-from")).toBe(false);
    expect(result.sidecar.entries).toHaveLength(sidecar.entries.length);

    const placed = await placeComments("a.py", moved, result.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.sites.filter((s) => s.id === "q0q0")).toEqual([{ id: "q0q0", row: 1, kind: "own" }]);
  });

  it("a moved comment takes a new id when the target file already uses its id", async () => {
    const code = "def f():\n    x = 1\n";
    const taken: Sidecar = { preamble: "", entries: [{ id: "aaaa", meta: new Map(), body: "unrelated" }] };
    const result = await carryComments("b.py", code, taken, [{ row: 1, kind: "own", body: "note", meta: new Map(), from: "aaaa", moved: true }]);
    expect(result.ids[0]).not.toBe("aaaa");
    expect(result.sidecar.entries.map((e) => e.body)).toEqual(["unrelated", "note"]);
  });

  it("carries multi-line and trailing comments, and two comments on one line stay apart", async () => {
    const code = "def f():\n    x = 1\n    y = 2\n";
    const meta = new Map<string, string>();
    const result = await carryComments("a.py", code, EMPTY, [
      { row: 1, kind: "own", body: "first\n\nsecond paragraph", meta, from: "aaaa" },
      { row: 1, kind: "own", body: "another note", meta, from: "bbbb" },
      { row: 2, kind: "trail", body: "tail", meta, from: "cccc" },
    ]);
    expect(result.ids.every(Boolean)).toBe(true);
    expect(result.sidecar.entries.map((e) => e.body)).toEqual(["first\n\nsecond paragraph", "another note", "tail"]);
    const placed = await placeComments("a.py", code, result.sidecar);
    expect(placed.source).toBe(
      `def f():\n    #~${result.ids[0]} first\n    #~\n    #~ second paragraph\n    #~${result.ids[1]} another note\n    x = 1\n    y = 2  #~${result.ids[2]} tail\n`,
    );
  });
});
