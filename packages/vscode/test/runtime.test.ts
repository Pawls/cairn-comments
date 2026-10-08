import { readFileSync } from "node:fs";
import { MIN_NODE_MAJOR } from "@cairn-comments/core";
import { describe, expect, it } from "vitest";
import { cliEnv, runtimeMajor } from "../src/runtime.js";

describe("runtimeMajor", () => {
  it("reads the major from what a runtime run as Node prints for --version", () => {
    expect(runtimeMajor("v24.21.0\n")).toBe(24);
    expect(runtimeMajor("v22.0.0")).toBe(22);
  });

  it("rejects the editor's own version, which its binary prints when it will not run as Node", () => {
    expect(runtimeMajor("1.140.0\n2a59476c9b\nx64\n")).toBeUndefined();
    expect(runtimeMajor("")).toBeUndefined();
  });
});

describe("cliEnv", () => {
  it("runs the editor's binary as Node and drops an inherited crashpad pipe, leaving the caller's environment alone", () => {
    const inherited = { PATH: "/bin", CHROME_CRASHPAD_PIPE_NAME: String.raw`\.\pipe\crashpad_1_STALE` };
    expect(cliEnv(inherited)).toEqual({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
    expect(inherited.CHROME_CRASHPAD_PIPE_NAME).toBeDefined();
  });
});

describe("MIN_NODE_MAJOR", () => {
  it("matches the CLI package's engines field", () => {
    const cli = JSON.parse(readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    expect(cli.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});
