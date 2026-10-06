import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI, Sandbox } from "./harness.js";

const bundleVersion = () =>
  JSON.parse(readFileSync(path.join(path.dirname(CLI), "version.json"), "utf8")) as { version: string; build: number };
const packageVersion = () =>
  (JSON.parse(readFileSync(path.join(path.dirname(CLI), "..", "package.json"), "utf8")) as { version: string }).version;

describe("the CLI home", () => {
  let box: Sandbox;
  let repo: string;
  const homeMain = () => path.join(box.home, "main.js").split(path.sep).join("/");

  beforeEach(() => {
    box = new Sandbox({ autocrlf: false });
    repo = box.path("repo");
    box.git(box.dir, "init", "-q", "repo");
  });
  afterEach(() => box.dispose());

  it("the bundle carries the package's version", () => {
    expect(bundleVersion().version).toBe(packageVersion());
  });

  it("init installs the bundle into the home and records the home's copy, which then runs every commit", () => {
    const report = box.cli(repo, "init");
    expect(report).toContain(`${box.home}: install ${bundleVersion().version}`);
    expect(box.git(repo, "config", "--get", "filter.cairn.clean").trim()).toBe(`node "${homeMain()}" clean %f`);
    expect(readFileSync(path.join(box.home, "version.json"), "utf8")).toContain(bundleVersion().version);

    box.write(path.join(repo, "a.py"), "def f():\n    #~ explains f\n    return 1\n");
    box.git(repo, "add", "-A");
    box.git(repo, "commit", "-qm", "one");
    expect(box.git(repo, "show", "HEAD:a.py")).not.toContain("explains f");
    expect(box.cli(repo, "init")).toBe("nothing to change\n");
  });

  it("init --dry-run reports the install without making it", () => {
    const report = box.cli(repo, "init", "--dry-run");
    expect(report).toContain(`  ${box.home}: install ${bundleVersion().version}`);
    expect(existsSync(box.home)).toBe(false);
  });

  it("an older bundle's init keeps the newer copy in the home and still records the home", () => {
    box.cli(repo, "init");
    const older = box.path("older");
    cpSync(path.dirname(CLI), older, { recursive: true });
    writeFileSync(path.join(older, "version.json"), JSON.stringify({ version: "0.0.1", build: 0 }));
    const other = box.path("other");
    box.git(box.dir, "init", "-q", "other");
    expect(box.cliFrom(path.join(older, "main.js"), other, "init")).not.toContain(box.home + ":");
    expect(JSON.parse(readFileSync(path.join(box.home, "version.json"), "utf8"))).toEqual(bundleVersion());
    expect(box.git(other, "config", "--get", "filter.cairn.clean").trim()).toBe(`node "${homeMain()}" clean %f`);
  });

  it("init rewrites a repository that records a path elsewhere, its agent hooks included", () => {
    const gone = 'node "/gone/cairn/main.js"';
    box.cli(repo, "init", "--command", gone, "--hooks", "claude-code");
    const dryRun = box.cli(repo, "init", "--dry-run");
    expect(dryRun).toContain(`git config: set filter.cairn.clean = node "${homeMain()}" clean %f`);
    expect(dryRun).toContain(".claude/settings.local.json: set the claude-code hook");
    box.cli(repo, "init");
    const settings = readFileSync(path.join(repo, ".claude", "settings.local.json"), "utf8");
    expect(settings).not.toContain("/gone/");
    expect(settings).toContain(`${homeMain()}\\" hook claude-code`);
  });
});
