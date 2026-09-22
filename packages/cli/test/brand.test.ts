import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BRAND, BRAND_TITLE } from "@slopstash/core";

const manifest = (url: URL) => JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;

// package.json cannot import the constant, so a rename has to touch it by hand; fail loudly if it was missed.
it("the CLI binary is named after the brand constant", () => {
  const { bin } = manifest(new URL("../package.json", import.meta.url)) as { bin: Record<string, string> };
  expect(Object.keys(bin)).toEqual([BRAND]);
});

it("the extension manifest carries the brand in its name, display name, command ids, and settings", () => {
  const ext = manifest(new URL("../../vscode/package.json", import.meta.url)) as {
    name: string;
    displayName: string;
    contributes: {
      commands: { command: string; category: string }[];
      configuration: { title: string; properties: Record<string, unknown> };
    };
  };
  expect(ext.name).toBe(`${BRAND}-vscode`);
  // design.md § Naming: the display name must carry the literal search phrase.
  expect(ext.displayName).toBe(`${BRAND_TITLE}: Hide AI Comments`);
  expect(ext.contributes.configuration.title).toBe(BRAND_TITLE);
  for (const { command, category } of ext.contributes.commands) {
    expect(command).toMatch(new RegExp(`^${BRAND}\\.`));
    expect(category).toBe(BRAND_TITLE);
  }
  for (const key of Object.keys(ext.contributes.configuration.properties)) expect(key).toMatch(new RegExp(`^${BRAND}\\.`));
});
