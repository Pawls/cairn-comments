import type { Node, Parser } from "web-tree-sitter";
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

/** Runs `read` over the parse tree of `source`; the tree is freed afterwards, so nodes must not escape. */
export async function parseWith<T>(spec: LanguageSpec, source: string, read: (root: Node) => T): Promise<T> {
  const parser = await parserFor(spec);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter returned no tree for a ${spec.id} source`);
  try {
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Comment nodes of `root` in document order, as string offsets. */
export function commentsIn(spec: LanguageSpec, root: Node): CommentNode[] {
  return root
    .descendantsOfType([...spec.commentTypes])
    .filter((n) => n !== null)
    .map((n) => ({ start: n.startIndex, end: n.endIndex, parentType: n.parent?.type }));
}

/** Comment tokens in document order, as string offsets into `source`. */
export function findComments(spec: LanguageSpec, source: string): Promise<CommentNode[]> {
  return parseWith(spec, source, (root) => commentsIn(spec, root));
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
