import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_HOME_ENV, cliHome, homeCommand, installCli, pendingInstall } from "../src/home.js";

describe("cliHome", () => {
  it("honors the override on every platform", () => {
    expect(cliHome({ [CLI_HOME_ENV]: "/tmp/x" }, "win32", "C:\\Users\\u")).toBe("/tmp/x");
    expect(cliHome({ [CLI_HOME_ENV]: "/tmp/x" }, "linux", "/home/u")).toBe("/tmp/x");
  });

  it("is under LOCALAPPDATA on Windows", () => {
    expect(cliHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Users\\u\\AppData\\Local", "cairn", "cli"));
    expect(cliHome({}, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Users\\u", "AppData", "Local", "cairn", "cli"));
  });

  it("is under XDG_DATA_HOME elsewhere, defaulting to ~/.local/share", () => {
    expect(cliHome({ XDG_DATA_HOME: "/data" }, "linux", "/home/u")).toBe(path.join("/data", "cairn", "cli"));
    expect(cliHome({}, "darwin", "/Users/u")).toBe(path.join("/Users/u", ".local", "share", "cairn", "cli"));
  });
});

describe("installCli", () => {
  let dir: string;
  let home: string;

  /** A stand-in bundle whose main.js prints its version and proves it can read its grammar. */
  function bundle(name: string, version: string, build: number): string {
    const source = path.join(dir, name);
    mkdirSync(path.join(source, "grammars"), { recursive: true });
    writeFileSync(
      path.join(source, "main.js"),
      [
        'import { readFileSync } from "node:fs";',
        `readFileSync(new URL("grammars/g.wasm", import.meta.url));`,
        `console.log(${JSON.stringify(`${version}+${build}`)});`,
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(source, "web-tree-sitter.wasm"), "wasm");
    writeFileSync(path.join(source, "grammars", "g.wasm"), "grammar");
    writeFileSync(path.join(source, "version.json"), JSON.stringify({ version, build }));
    return source;
  }

  const runHome = () => execFileSync(process.execPath, [path.join(home, "main.js")], { encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cairn-home-"));
    home = path.join(dir, "home");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs into an empty home, and the home's main.js runs the copy", () => {
    const result = installCli(bundle("a", "0.1.0", 1), home);
    expect(result.installed).toBe(true);
    expect(runHome()).toBe("0.1.0+1");
    expect(JSON.parse(readFileSync(path.join(home, "version.json"), "utf8"))).toEqual({ version: "0.1.0", build: 1 });
  });

  it("replaces an older copy with a newer version or a later build of the same version", () => {
    installCli(bundle("a", "0.1.0", 1), home);
    expect(installCli(bundle("b", "0.1.0", 2), home).installed).toBe(true);
    expect(runHome()).toBe("0.1.0+2");
    expect(installCli(bundle("c", "0.2.0", 0), home).installed).toBe(true);
    expect(runHome()).toBe("0.2.0+0");
  });

  it("keeps the installed copy when the incoming one is older or the same", () => {
    installCli(bundle("a", "0.2.0", 5), home);
    expect(pendingInstall(bundle("b", "0.1.9", 9), home)).toBeUndefined();
    expect(installCli(bundle("b", "0.1.9", 9), home).installed).toBe(false);
    expect(installCli(bundle("c", "0.2.0", 5), home).installed).toBe(false);
    expect(installCli(bundle("d", "0.2.0", 4), home).installed).toBe(false);
    expect(runHome()).toBe("0.2.0+5");
  });

  it("compares version parts as numbers", () => {
    installCli(bundle("a", "0.9.0", 1), home);
    expect(pendingInstall(bundle("b", "0.10.0", 0), home)).toEqual({ version: "0.10.0", build: 0 });
  });

  it("leaves the old copy runnable when a copy is interrupted", () => {
    installCli(bundle("a", "0.1.0", 1), home);
    const broken = bundle("b", "0.2.0", 1);
    rmSync(path.join(broken, "grammars"), { recursive: true });
    expect(() => installCli(broken, home)).toThrow();
    expect(runHome()).toBe("0.1.0+1");
    expect(readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("is a no-op when run from the installed copy itself", () => {
    installCli(bundle("a", "0.1.0", 1), home);
    const installed = readdirSync(home).find((f) => f.startsWith("0.1.0-"))!;
    expect(installCli(path.join(home, installed), home).installed).toBe(false);
    expect(runHome()).toBe("0.1.0+1");
  });

  it("keeps the copy it replaced, for a filter that already read the old main.js, and drops older ones", () => {
    installCli(bundle("a", "0.1.0", 1), home);
    installCli(bundle("b", "0.1.0", 2), home);
    installCli(bundle("c", "0.1.0", 3), home);
    expect(readdirSync(home).filter((f) => f.startsWith("0.1.0-")).sort()).toEqual(["0.1.0-2", "0.1.0-3"]);
  });

  it("reports the installed version when the incoming one is not newer", () => {
    installCli(bundle("a", "0.2.0", 5), home);
    expect(installCli(bundle("b", "0.1.0", 1), home)).toEqual({ installed: false, version: { version: "0.2.0", build: 5 } });
  });

  it("drops only older version copies, not other folders or an installer's copy in progress", () => {
    installCli(bundle("a", "0.1.0", 1), home);
    mkdirSync(path.join(home, "notes"));
    const inProgress = path.join(home, "0.0.1-1.tmp-99999");
    mkdirSync(inProgress);
    writeFileSync(path.join(inProgress, "version.json"), JSON.stringify({ version: "0.0.1", build: 1 }));
    installCli(bundle("b", "0.1.0", 2), home);
    installCli(bundle("c", "0.1.0", 3), home);
    expect(readdirSync(home).sort()).toEqual(["0.0.1-1.tmp-99999", "0.1.0-2", "0.1.0-3", "main.js", "notes", "version.json"]);
  });

  it("refuses a source without a version file", () => {
    const source = bundle("a", "0.1.0", 1);
    rmSync(path.join(source, "version.json"));
    expect(() => installCli(source, home)).toThrow(/version\.json/);
  });

  it("names the home's main.js in the recorded command, with forward slashes", () => {
    expect(homeCommand(path.join("C:", "x", "cli"))).toBe(`node "${["C:", "x", "cli", "main.js"].join("/")}"`);
  });
});
