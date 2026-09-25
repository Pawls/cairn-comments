import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  /**
   * Node types that scope markerless anchors (placement.ts): a comment inside a function is
   * placed only while that function is unchanged; classes only name the path. Empty means
   * every comment anchors at module level.
   */
  functionTypes: readonly string[];
  namespaceTypes: readonly string[];
}

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    id: "python",
    name: "Python",
    extensions: [".py", ".pyi"],
    lineSigil: "#~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    functionTypes: ["function_definition"],
    namespaceTypes: ["class_definition"],
  },
  {
    id: "typescript",
    name: "TypeScript",
    extensions: [".ts", ".mts", ".cts"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    functionTypes: [],
    namespaceTypes: [],
  },
  {
    id: "tsx",
    name: "TypeScript",
    extensions: [".tsx"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
    functionTypes: [],
    namespaceTypes: [],
  },
  {
    id: "javascript",
    name: "JavaScript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm",
    functionTypes: [],
    namespaceTypes: [],
  },
  {
    id: "csharp",
    name: "C#",
    extensions: [".cs"],
    lineSigil: "//~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
    functionTypes: [],
    namespaceTypes: [],
  },
  {
    id: "java",
    name: "Java",
    extensions: [".java"],
    lineSigil: "//~",
    commentTypes: ["line_comment", "block_comment"],
    wasm: "tree-sitter-java/tree-sitter-java.wasm",
    functionTypes: [],
    namespaceTypes: [],
  },
];

export function languageForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase();
  return LANGUAGES.find((l) => l.extensions.some((ext) => lower.endsWith(ext)));
}

/**
 * A published bundle carries the grammars in `grammars/` beside it, so it needs none of the
 * grammar packages (whose install scripts build native bindings nothing here uses). From
 * source, the packages resolve through `node_modules`.
 */
export function resolveWasm(spec: LanguageSpec): string {
  const bundled = fileURLToPath(new URL(`grammars/${path.posix.basename(spec.wasm)}`, import.meta.url));
  return existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve(spec.wasm);
}
