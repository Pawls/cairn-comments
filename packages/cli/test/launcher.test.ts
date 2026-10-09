import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LAUNCHER, RUNTIME_FILE } from "@cairn-comments/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const NODE_FILE = process.platform === "win32" ? "node.exe" : "node";
/** The search path with every folder that holds a `node` left out, as on a machine without Node. */
const PATH_WITHOUT_NODE = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => dir && !existsSync(path.join(dir, NODE_FILE)))
  .join(path.delimiter);
const REAL_NODE = process.execPath.split(path.sep).join("/");

/** Writes an executable sh script; the launcher and git's sh run it on every platform. */
function writeScript(file: string, lines: string[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
}

describe("the launcher git runs", () => {
  let box: Sandbox;
  let repo: string;
  let runtimeLog: string;

  /**
   * A stand-in for an editor's runtime at `file`: it logs the variables the launcher must
   * set and clear, then runs the script on this test's Node.
   */
  function fakeRuntime(file: string): string {
    writeScript(file, [
      `echo "ELECTRON_RUN_AS_NODE=$ELECTRON_RUN_AS_NODE crashpad=\${CHROME_CRASHPAD_PIPE_NAME-unset}" >> "${runtimeLog}"`,
      `exec "${REAL_NODE}" "$@"`,
    ]);
    return file.split(path.sep).join("/");
  }

  const recordRuntimePath = (runtime: string) => writeFileSync(path.join(box.home, RUNTIME_FILE), runtime + "\n");
  const runtimeRuns = () => (existsSync(runtimeLog) ? readFileSync(runtimeLog, "utf8").trim().split("\n") : []);

  /** Stages a.py through the filter and reports whether the comment stayed out of the index. */
  function stageWith(env: NodeJS.ProcessEnv): { stripped: boolean; stderr: string } {
    box.write(path.join(repo, "a.py"), "def f():\n    #~ explains f\n    return 1\n");
    const add = box.gitWithEnv(env, repo, "add", "a.py");
    expect(add.status, add.stderr).toBe(0);
    return { stripped: !box.git(repo, "show", ":a.py").includes("explains f"), stderr: add.stderr };
  }

  beforeEach(() => {
    box = new Sandbox({ autocrlf: false });
    repo = box.path("repo");
    runtimeLog = box.path("runtime.log");
    box.git(box.dir, "init", "-q", "repo");
    box.cli(repo, "init");
  });
  afterEach(() => box.dispose());

  it("init records the launcher in the home", () => {
    const launcher = path.join(box.home, LAUNCHER).split(path.sep).join("/");
    expect(box.git(repo, "config", "--get", "filter.cairn.clean").trim()).toBe(`"${launcher}" clean %f`);
    expect(box.git(repo, "config", "--get", "filter.cairn.process").trim()).toBe(`"${launcher}" filter-process`);
  });

  it("init again puts back a launcher that went missing while the installed copy stayed current", () => {
    rmSync(path.join(box.home, LAUNCHER));
    expect(box.cli(repo, "init")).toContain(box.home);
    expect(stageWith({})).toEqual({ stripped: true, stderr: "" });
  });

  it("uses node from PATH when there is one, and leaves the recorded runtime alone", () => {
    recordRuntimePath(fakeRuntime(box.path("editor", "code")));
    expect(stageWith({})).toEqual({ stripped: true, stderr: "" });
    expect(runtimeRuns()).toEqual([]);
  });

  it("without node on PATH, runs the recorded runtime as Node, with the inherited crashpad pipe cleared", () => {
    recordRuntimePath(fakeRuntime(box.path("editor", "code")));
    const staged = stageWith({ PATH: PATH_WITHOUT_NODE, CHROME_CRASHPAD_PIPE_NAME: String.raw`\\.\pipe\crashpad_1_STALE` });
    expect(staged).toEqual({ stripped: true, stderr: "" });
    expect(runtimeRuns()).toEqual(["ELECTRON_RUN_AS_NODE=1 crashpad=unset"]);
  });

  it("falls back to the recorded runtime when the node on PATH is older than 22", () => {
    recordRuntimePath(fakeRuntime(box.path("editor", "code")));
    const preload = box.path("old-node.mjs");
    writeFileSync(preload, 'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.11.1" } });\n');
    const oldNode = box.path("old-node-bin");
    writeScript(path.join(oldNode, "node"), [`exec "${REAL_NODE}" --import "${pathToFileURL(preload).href}" "$@"`]);
    expect(stageWith({ PATH: oldNode + path.delimiter + PATH_WITHOUT_NODE })).toEqual({ stripped: true, stderr: "" });
    expect(runtimeRuns()).toHaveLength(1);
  });

  it("finds a VS Code Server's runtime in the commit folder that replaced the recorded one", () => {
    const server = box.path(".vscode-server", "bin");
    fakeRuntime(path.join(server, "newcommit", "node"));
    recordRuntimePath(path.join(server, "oldcommit", "node").split(path.sep).join("/"));
    expect(stageWith({ PATH: PATH_WITHOUT_NODE })).toEqual({ stripped: true, stderr: "" });
    expect(runtimeRuns()).toHaveLength(1);
  });

  it("with neither node nor a runtime, the commit fails and says what is missing", () => {
    box.write(path.join(repo, "a.py"), "def f():\n    #~ explains f\n    return 1\n");
    box.git(repo, "add", "a.py");
    const commit = box.gitWithEnv({ PATH: PATH_WITHOUT_NODE }, repo, "commit", "-qm", "one");
    expect(commit.status).not.toBe(0);
    expect(commit.stderr).toMatch(/needs Node\.js 22 or later on PATH/);
  });
});
