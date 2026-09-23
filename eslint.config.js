import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/bundle/", "**/out/", "**/node_modules/", "**/.vscode-test/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
