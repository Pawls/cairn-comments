import { createRequire } from "node:module";

export interface LanguageSpec {
  id: string;
  /** Human-readable name; TSX shares TypeScript's. */
  name: string;
  extensions: readonly string[];
  /** Line-comment sigil, e.g. `#~`. */
  lineSigil: string;
  /** Tree-sitter node types that are comments in this grammar. */
  commentTypes: readonly string[];
  /** Module specifier of the grammar's prebuilt WASM. */
  wasm: string;
}

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: "python",
    name: "Python",
    extensions: [".py", ".pyi"],
    lineSigil: "#~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
  },
  {
    id: "typescript",
    name: "TypeScript",
    extensions: [".ts", ".mts", ".cts"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  },
  {
    id: "tsx",
    name: "TypeScript",
    extensions: [".tsx"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  },
  {
    id: "javascript",
    name: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  },
  {
    id: "csharp",
    name: "C#",
    extensions: [".cs"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  },
  {
    id: "java",
    name: "Java",
    extensions: [".java"],
    lineSigil: "//~",
    commentTypes: ["line_comment", "block_comment"],
    wasm: "tree-sitter-java/tree-sitter-java.wasm",
  },
];

export function languageForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase();
  return LANGUAGES.find((l) => l.extensions.some((ext) => lower.endsWith(ext)));
}

export function resolveWasm(spec: LanguageSpec): string {
  return createRequire(import.meta.url).resolve(spec.wasm);
}
