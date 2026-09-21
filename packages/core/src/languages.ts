import { createRequire } from "node:module";

export interface LanguageSpec {
  id: string;
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
    extensions: [".py", ".pyi"],
    lineSigil: "#~",
    commentTypes: ["comment"],
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
  },
];

export function languageForPath(path: string): LanguageSpec | undefined {
  const lower = path.toLowerCase();
  return LANGUAGES.find((l) => l.extensions.some((ext) => lower.endsWith(ext)));
}

export function resolveWasm(spec: LanguageSpec): string {
  return createRequire(import.meta.url).resolve(spec.wasm);
}
