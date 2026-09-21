import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BRAND } from "@tildenote/core";

// package.json cannot import the constant, so a rename has to touch it by hand; fail loudly if it was missed.
it("the CLI binary is named after the brand constant", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin: Record<string, string> };
  expect(Object.keys(manifest.bin)).toEqual([BRAND]);
});
