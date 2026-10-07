import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeProblem } from "../src/node.js";

describe("nodeProblem", () => {
  it("says Node is missing when `node --version` could not run", () => {
    expect(nodeProblem(undefined)).toMatch(/needs Node\.js 22 or later on PATH, and none was found/);
  });

  it("names the old version when Node is older than the CLI supports", () => {
    expect(nodeProblem("v20.11.1\n")).toMatch(/needs Node\.js 22 or later on PATH; found v20\.11\.1/);
  });

  it("accepts the minimum major and anything newer", () => {
    expect(nodeProblem("v22.0.0\n")).toBeUndefined();
    expect(nodeProblem("v26.1.0")).toBeUndefined();
  });

  it("treats output it cannot parse as missing rather than guessing a version", () => {
    expect(nodeProblem("node: command not found")).toMatch(/none was found/);
  });

  it("links to nodejs.org and says VS Code must restart to see a new PATH", () => {
    expect(nodeProblem(undefined)).toMatch(/\[nodejs\.org\]\(https:\/\/nodejs\.org\)/);
    expect(nodeProblem(undefined)).toMatch(/restart VS Code/);
  });
});

describe("MIN_NODE_MAJOR", () => {
  it("matches the CLI package's engines field, which the recorded git filter runs under", () => {
    const cli = JSON.parse(readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    expect(cli.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});
