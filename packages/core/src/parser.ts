import type { Parser } from "web-tree-sitter";
import { resolveWasm, type LanguageSpec } from "./languages.js";

export interface CommentSpan {
  start: number;
  end: number;
}

let ready: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

function parserFor(spec: LanguageSpec): Promise<Parser> {
  let parser = parsers.get(spec.id);
  if (!parser) {
    parser = (async () => {
      // Loaded on demand: a one-shot filter run on a marker-free file never pays for it.
      const { Language, Parser } = await import("web-tree-sitter");
      await (ready ??= Parser.init());
      const p = new Parser();
      p.setLanguage(await Language.load(resolveWasm(spec)));
      return p;
    })();
    parsers.set(spec.id, parser);
  }
  return parser;
}

export interface CommentNode extends CommentSpan {
  /** Grammar type of the enclosing node, e.g. `jsx_expression` for a comment inside JSX. */
  parentType: string | undefined;
}

/** Comment tokens in document order, as string offsets into `source`. */
export async function findComments(spec: LanguageSpec, source: string): Promise<CommentNode[]> {
  const parser = await parserFor(spec);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter returned no tree for a ${spec.id} source`);
  try {
    return tree.rootNode
      .descendantsOfType([...spec.commentTypes])
      .filter((n) => n !== null)
      .map((n) => ({ start: n.startIndex, end: n.endIndex, parentType: n.parent?.type }));
  } finally {
    tree.delete();
  }
}

/** Whether `text` parses as this language with no error nodes: the commented-out-code test. */
export async function parsesCleanly(spec: LanguageSpec, text: string): Promise<boolean> {
  const tree = (await parserFor(spec)).parse(text);
  if (!tree) return false;
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}
