import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMarkers, languageForPath, parseSidecar, sync, type SidecarEntry } from "@slopstash/core";
import { STALE_NOTICE, findSidecarRoot, hoverMarkdown, labelFor, planOverlay } from "../src/overlay.js";

const python = languageForPath("x.py")!;
const entriesOf = (text: string) => new Map(parseSidecar(text).entries.map((e) => [e.id, e]));

describe("labelFor", () => {
  it("shows a dim tilde when the overlay is off", () => {
    expect(labelFor("anything\nmore", "off")).toBe("~");
  });

  it("shows the first line, with a count of the remaining lines", () => {
    expect(labelFor("keyed on order.id", "on")).toBe("keyed on order.id");
    expect(labelFor("first\n\nthird", "on")).toBe("first (+2)");
  });
});

describe("planOverlay", () => {
  const source = "def f():\n    #~a1b2\n    x = 1  #~c3d4\n    #~e5f6\n    #~ still inline\n";
  const sidecar = "## a1b2\nretries are safe\n\nsecond paragraph\n\n## c3d4\nkeyed on order.id\n\n## e5f6\n";

  it("hides bare markers with bodies, warns on bodyless ones, and skips inline text", async () => {
    const markers = await findMarkers(python, source);
    const plan = planOverlay(markers, entriesOf(sidecar), "on", () => false);
    expect(plan.map((p) => [p.kind, p.id, p.label, source.slice(p.start, p.end)])).toEqual([
      ["hidden", "a1b2", "retries are safe (+2)", "#~a1b2"],
      ["hidden", "c3d4", "keyed on order.id", "#~c3d4"],
      ["missing", "e5f6", "no comment body", "#~e5f6"],
    ]);
  });

  it("keeps the token visible on a line the cursor is on, with the body alongside", async () => {
    const markers = await findMarkers(python, source);
    const plan = planOverlay(markers, entriesOf(sidecar), "off", (m) => m.id === "c3d4");
    expect(plan.map((p) => [p.kind, p.label])).toEqual([
      ["hidden", "~"],
      ["revealed", "keyed on order.id"],
      ["missing", "no comment body"],
    ]);
  });

  it("badges a body whose anchored code changed, in both modes", async () => {
    const { sidecar } = await sync("a.py", "#~a1b2 retries are safe\nledger.write(x)\n", { preamble: "", entries: [] });
    const entries = new Map(sidecar.entries.map((e) => [e.id, e]));
    const current = await findMarkers(python, "#~a1b2\nledger.write( x )\n", { anchors: true });
    expect(planOverlay(current, entries, "on", () => false)[0]).toMatchObject({ stale: false, label: "retries are safe" });
    const changed = await findMarkers(python, "#~a1b2\nledger.append(x)\n", { anchors: true });
    expect(planOverlay(changed, entries, "on", () => false)[0]).toMatchObject({ kind: "hidden", stale: true, label: "[stale?] retries are safe" });
    expect(planOverlay(changed, entries, "off", () => false)[0]).toMatchObject({ stale: true, label: "~?" });
    expect(planOverlay(changed, entries, "off", () => true)[0]).toMatchObject({ kind: "revealed", label: "[stale?] retries are safe" });
    // Without anchors (markers found the plain way) nothing reads as stale.
    expect(planOverlay(await findMarkers(python, "#~a1b2\nledger.append(x)\n"), entries, "on", () => false)[0]!.stale).toBe(false);
  });

  it("treats a marker with no sidecar at all as missing", async () => {
    const markers = await findMarkers(python, "#~a1b2\n");
    expect(planOverlay(markers, new Map(), "on", () => false)[0]?.kind).toBe("missing");
  });
});

describe("hoverMarkdown", () => {
  it("renders the body and the provenance tag recorded", () => {
    const meta = new Map([
      ["by", "claude-code"],
      ["model", "claude-opus-5-5"],
      ["session", "f6bed7e6-3bc6-42d8-97d2-f936a01f4077"],
      ["at", "2026-09-22T20:25:55Z"],
      ["hash", "ignored"],
    ]);
    const entry: SidecarEntry = { id: "a1b2", meta, body: "line one\n\nline two" };
    expect(hoverMarkdown("a1b2", entry, ".agents/comments/x.py.md")).toBe(
      "line one\n\nline two\n\n*claude-code · claude-opus-5-5 · 2026-09-22 20:25 UTC · session f6bed7e6*",
    );
  });

  it("shows no provenance line for an entry without any", () => {
    const entry: SidecarEntry = { id: "a1b2", meta: new Map([["hash", "x"]]), body: "body" };
    expect(hoverMarkdown("a1b2", entry, ".agents/comments/x.py.md")).toBe("body");
  });

  it("leads with a notice when the comment is possibly stale", () => {
    const entry: SidecarEntry = { id: "a1b2", meta: new Map([["anchor", "0badc0de"]]), body: "body" };
    expect(hoverMarkdown("a1b2", entry, ".agents/comments/x.py.md", true)).toBe(`${STALE_NOTICE}\n\nbody`);
  });

  it("says where the missing body should live", () => {
    expect(hoverMarkdown("a1b2", undefined, ".agents/comments/x.py.md")).toContain("`.agents/comments/x.py.md`");
  });
});

describe("findSidecarRoot", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stops at the nearest sidecar folder even inside a larger repository", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "slopstash-root-"));
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "ws/.agents/comments"), { recursive: true });
    mkdirSync(path.join(dir, "ws/src"), { recursive: true });
    writeFileSync(path.join(dir, "ws/src/a.py"), "");
    expect(findSidecarRoot(path.join(dir, "ws/src"), "fallback")).toBe(path.join(dir, "ws"));
  });

  it("uses the git root when no sidecar folder exists yet, and the fallback outside any repo", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "slopstash-root-"));
    mkdirSync(path.join(dir, "repo/.git/x"), { recursive: true });
    mkdirSync(path.join(dir, "repo/pkg"), { recursive: true });
    expect(findSidecarRoot(path.join(dir, "repo/pkg"), "fallback")).toBe(path.join(dir, "repo"));
    mkdirSync(path.join(dir, "loose"));
    // The temp dir's ancestors hold no `.git` on a normal machine, so the walk ends at the fallback.
    expect(findSidecarRoot(path.join(dir, "loose"), path.join(dir, "loose"))).toBe(path.join(dir, "loose"));
  });
});
