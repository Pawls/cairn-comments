import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = (cwd: string, ...args: string[]) =>
  // npm is a .cmd on Windows, which only a shell can start.
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });

/** Install the packed tarball into an empty project and run the quickstart. */
describe("the published CLI package", () => {
  let scratch: Sandbox;
  let box: Sandbox;
  let installed: string;
  let files: string[];

  beforeAll(() => {
    scratch = new Sandbox({ autocrlf: false });
    const packed = JSON.parse(npm(packageDir, "pack", "--json", "--pack-destination", scratch.dir)) as { filename: string; files: { path: string }[] }[];
    files = packed[0]!.files.map((f) => f.path).sort();
    const project = scratch.path("project");
    mkdirSync(project);
    writeFileSync(path.join(project, "package.json"), '{ "name": "consumer", "private": true }\n');
    npm(project, "install", "--offline", "--no-audit", "--no-fund", path.join(scratch.dir, packed[0]!.filename));
    installed = path.join(project, "node_modules", "slopstash");
    box = new Sandbox({ autocrlf: false, cli: path.join(installed, "bundle", "main.js") });
  }, 180_000);
  afterAll(() => {
    box?.dispose();
    scratch?.dispose();
  });

  it("ships the bundle, its WASM, the README, and the license, and nothing to install", () => {
    expect(files).toEqual([
      "LICENSE",
      "README.md",
      "bundle/grammars/tree-sitter-c_sharp.wasm",
      "bundle/grammars/tree-sitter-java.wasm",
      "bundle/grammars/tree-sitter-javascript.wasm",
      "bundle/grammars/tree-sitter-python.wasm",
      "bundle/grammars/tree-sitter-tsx.wasm",
      "bundle/grammars/tree-sitter-typescript.wasm",
      "bundle/main.js",
      "bundle/web-tree-sitter.wasm",
      "package.json",
    ]);
    const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
    expect(manifest.dependencies).toBeUndefined();
    expect(readdirSync(path.join(installed, "..")).filter((d) => !d.startsWith("."))).toEqual(["slopstash"]);
  });

  it("runs the quickstart: init, an agent worktree, a commit, and check", () => {
    const main = box.path("main");
    box.write(box.path("main", "app.ts"), "export const port = 8080;\n");
    box.git(box.dir, "init", "-q", "main");
    expect(box.cli(main, "init")).toContain(`${installed.split(path.sep).join("/")}/bundle/main.js`);
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    box.cli(main, "worktree", "add", box.path("agent"), "-b", "agent");
    box.write(box.path("agent", "app.ts"), "//~ the proxy in front expects this port\nexport const port = 8080;\n");
    box.git(box.path("agent"), "commit", "-qam", "explain the port");
    expect(box.git(main, "show", "agent:app.ts")).toMatch(/^\/\/~[0-9a-z]{4}\nexport const port = 8080;\n$/);
    expect(box.git(main, "show", "agent:.agents/comments/app.ts.md")).toContain("the proxy in front expects this port");
    expect(box.status(box.path("agent"))).toBe("");
    expect(box.cliResult(box.path("agent"), "check")).toMatchObject({ status: 0, stdout: "" });
    expect(existsSync(path.join(installed, "node_modules"))).toBe(false);
  });
});
