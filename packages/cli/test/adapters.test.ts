import { describe, expect, it } from "vitest";
import { ADAPTERS, patchedFiles } from "../src/adapters.js";

const FOREIGN = { matcher: "Bash", hooks: [{ type: "command", command: "lint --fix" }] };

describe("hook adapter settings", () => {
  it.each(["claude-code", "codex"])(
    "%s installs beside foreign hooks and updates its own command in place",
    (harness) => {
      const adapter = ADAPTERS[harness]!;
      const settings: Record<string, unknown> = { theme: "dark", hooks: { PostToolUse: [structuredClone(FOREIGN)] } };
      adapter.install(settings, "old");
      adapter.install(settings, "new");
      const groups = (settings.hooks as { PostToolUse: { matcher: string; hooks: { command: string }[] }[] })
        .PostToolUse;
      expect(groups).toHaveLength(2);
      expect(groups[0]).toEqual(FOREIGN);
      expect(groups[1]!.hooks).toEqual([{ type: "command", command: `new hook ${harness}` }]);

      adapter.uninstall(settings);
      expect(settings).toEqual({ theme: "dark", hooks: { PostToolUse: [FOREIGN] } });
    },
  );

  it.each(["claude-code", "codex"])("%s uninstall prunes the containers it empties", (harness) => {
    const adapter = ADAPTERS[harness]!;
    const settings: Record<string, unknown> = {};
    adapter.install(settings, "cairn");
    adapter.uninstall(settings);
    expect(settings).toEqual({});
  });

  it("an uninstall keeps a group that still holds a foreign hook beside ours", () => {
    const adapter = ADAPTERS["claude-code"]!;
    const shared = {
      matcher: "Edit",
      hooks: [
        { type: "command", command: "x hook claude-code" },
        { type: "command", command: "fmt" },
      ],
    };
    const settings: Record<string, unknown> = { hooks: { PostToolUse: [shared] } };
    adapter.uninstall(settings);
    expect(settings).toEqual({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }] },
    });
  });

  it("cursor installs with a version, updates in place, and removes the version it added", () => {
    const adapter = ADAPTERS.cursor!;
    const settings: Record<string, unknown> = {};
    adapter.install(settings, "old");
    adapter.install(settings, "new");
    expect(settings).toEqual({ version: 1, hooks: { afterFileEdit: [{ command: "new hook cursor" }] } });
    adapter.uninstall(settings);
    expect(settings).toEqual({});
  });

  it("cursor keeps foreign entries and settings, empty ones included", () => {
    const adapter = ADAPTERS.cursor!;
    const settings: Record<string, unknown> = { version: 1, hooks: { afterFileEdit: [{ command: "fmt" }], stop: [] } };
    adapter.install(settings, "cairn");
    adapter.uninstall(settings);
    expect(settings).toEqual({ version: 1, hooks: { afterFileEdit: [{ command: "fmt" }], stop: [] } });
  });
});

describe("patchedFiles", () => {
  it("collects added, updated, and moved paths from every string in the input, once each", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.py",
      "*** Update File: src/old.py",
      "*** Move to: src/moved.py  ",
      "*** Delete File: src/gone.py",
      "*** End Patch",
    ].join("\n");
    const input = { command: patch, nested: [{ again: "*** Update File: src/old.py" }, 7, null] };
    expect(patchedFiles(input)).toEqual(["src/new.py", "src/old.py", "src/moved.py"]);
  });

  it("finds nothing in an input without strings", () => {
    expect(patchedFiles({ a: [1, { b: true }] })).toEqual([]);
    expect(patchedFiles(undefined)).toEqual([]);
  });
});
