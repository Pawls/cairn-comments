// Python string statements used as comments: an explicit demote moves one into the sidecar,
// and promote writes it back as the same string (design.md § Promote and demote).
import type { Node } from "web-tree-sitter";
import type { LanguageSpec } from "./languages.js";
import { lineIndexAt, splitLines, trailingRunStart, type Line } from "./lines.js";
import { parseWith } from "./parser.js";

/** Sidecar metadata key holding a demoted string's quotes and layout. */
export const LITERAL_KEY = "literal";

const QUOTES: Record<string, string> = { "triple-double": '"""', "triple-single": "'''", double: '"', single: "'" };

export interface StringStatement {
  /** Offsets of the string, from its prefix to just past its closing quote. */
  start: number;
  end: number;
  /** 0-based rows of its first and last line. */
  row: number;
  endRow: number;
  indent: string;
  /** Text between the quotes, one entry per line, without the statement's indentation. */
  lines: string[];
  /** The `literal` metadata value: quotes, prefix, and whether text shares the quote lines. */
  literal: string;
}

const FUNCTION_OR_CLASS = new Set(["function_definition", "class_definition"]);

function statementsOf(parent: Node): Node[] {
  return parent.namedChildren.filter((n): n is Node => !!n && n.type !== "comment");
}

function isAssignment(statement: Node | undefined): boolean {
  const expression = statement?.type === "expression_statement" ? statement.namedChild(0) : null;
  return expression?.type === "assignment" || expression?.type === "augmented_assignment";
}

/**
 * Whether `statement` is a docstring by PEP 257: the first statement of a module, class, or
 * function, or an attribute docstring, right after an assignment at module or class level
 * or in `__init__`. Documentation tools read both, so they stay in the code.
 */
function isDocstring(statement: Node, siblings: Node[]): boolean {
  const parent = statement.parent!;
  const owner = parent.type === "block" ? parent.parent : null;
  const documents = parent.type === "module" || (owner !== null && FUNCTION_OR_CLASS.has(owner.type));
  const index = siblings.findIndex((s) => s.id === statement.id);
  if (documents && index === 0) return true;
  const attributes =
    parent.type === "module" ||
    owner?.type === "class_definition" ||
    (owner?.type === "function_definition" && owner.childForFieldName("name")?.text === "__init__");
  return attributes && isAssignment(siblings[index - 1]);
}

/** A string's text lines and `literal` value, from its opening quote (with prefix) and what lies between the quotes. */
function readLiteral(opener: string, content: string, indent: string): { lines: string[]; literal: string } {
  const prefix = opener.slice(0, trailingRunStart(opener, `"'`));
  const quote = opener.slice(prefix.length);
  const quoteName = Object.keys(QUOTES).find((k) => QUOTES[k] === quote)!;
  const raw = content.split(/\r?\n/);
  const firstLine = raw.length === 1 || raw[0]!.trim() !== "";
  const lastLine = raw.length === 1 || raw.at(-1)!.trim() !== "";
  const dedent = (line: string) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
  const lines = [raw[0]!, ...raw.slice(1).map(dedent)];
  if (raw.length > 1) {
    if (!lastLine) lines.pop();
    if (!firstLine) lines.shift();
  }
  const parts = [quoteName, ...(prefix ? [`prefix-${prefix}`] : []), ...(firstLine ? ["first-line"] : []), ...(lastLine ? ["last-line"] : [])];
  return { lines: lines.map((l) => l.trimEnd()), literal: parts.join(",") };
}

/** The expression statement covering 0-based `row` that holds one string and nothing else. */
function bareStringAt(root: Node, row: number): { statement: Node; string: Node } | undefined {
  const statement = root
    .descendantsOfType("expression_statement")
    .find((n) => !!n && n.startPosition.row <= row && row <= n.endPosition.row && n.namedChildCount === 1);
  const string = statement?.namedChild(0);
  if (!statement || string?.type !== "string") return undefined;
  return { statement, string };
}

/** Why the bare string `statement` stays in the code for what it is or where it sits, if it does. */
function statementRefusal(statement: Node, string: Node): string | undefined {
  const siblings = statementsOf(statement.parent!);
  if (isDocstring(statement, siblings)) return "a docstring stays in the code";
  if (/f/i.test(string.child(0)!.text)) return "an f-string runs code, so it stays in the code";
  if (siblings.length === 1) return "the only statement in its block stays in the code";
  return undefined;
}

/** `string` as a `StringStatement`, or why its line or its empty text keeps it in the code. */
function readStatement(source: string, lines: Line[], string: Node): StringStatement | string {
  const opener = string.child(0)!;
  const closer = string.child(string.childCount - 1)!;
  const first = lines[lineIndexAt(lines, string.startIndex)]!;
  const last = lines[lineIndexAt(lines, string.endIndex)]!;
  const indent = source.slice(first.start, string.startIndex);
  if (!/^[ \t]*$/.test(indent) || source.slice(string.endIndex, last.contentEnd).trim()) {
    return "a string sharing its line with code or a comment stays in the code";
  }
  const { lines: text, literal } = readLiteral(opener.text, source.slice(opener.endIndex, closer.startIndex), indent);
  if (!text.some((l) => l.trim())) return "an empty string has nothing to demote";
  return {
    start: string.startIndex,
    end: string.endIndex,
    row: string.startPosition.row,
    endRow: string.endPosition.row,
    indent,
    lines: text,
    literal,
  };
}

/**
 * The bare string statement covering 0-based `row`, a reason it cannot be demoted, or
 * undefined when there is none (only Python has them).
 */
export async function stringStatementAt(spec: LanguageSpec, source: string, row: number): Promise<StringStatement | string | undefined> {
  if (spec.id !== "python") return undefined;
  const lines = splitLines(source);
  return parseWith(spec, source, (root) => {
    const found = bareStringAt(root, row);
    if (!found) return undefined;
    return statementRefusal(found.statement, found.string) ?? readStatement(source, lines, found.string);
  });
}

/**
 * `body` written back as the string `literal` describes, its continuation lines at
 * `indent`; undefined when the body no longer fits those quotes (it holds the closing
 * quote, a one-line string gained a line break, or its last character would escape or run
 * into the closing quote), so the caller writes comments instead.
 */
export function writeLiteral(literal: string, body: string, indent: string, eol: string): string | undefined {
  const [quoteName, ...flags] = literal.split(",");
  const quote = QUOTES[quoteName ?? ""];
  if (!quote) return undefined;
  const prefix = flags.find((f) => f.startsWith("prefix-"))?.slice("prefix-".length) ?? "";
  const firstLine = flags.includes("first-line");
  const lastLine = flags.includes("last-line");
  const lines = body.split("\n");
  // Escape pairs cannot close the string; what is left must not hold the closing quote.
  const unescaped = body.replace(/\\[\s\S]/g, "");
  const closes = quote.length === 3 ? unescaped.includes(quote) : unescaped.includes(quote) || lines.length > 1;
  if (closes || unescaped.endsWith("\\") || (lastLine && unescaped.endsWith(quote[0]!))) return undefined;

  const out = firstLine ? [prefix + quote + lines[0]!] : [prefix + quote];
  for (const line of firstLine ? lines.slice(1) : lines) out.push(line ? indent + line : "");
  if (lastLine) out[out.length - 1] += quote;
  else out.push(indent + quote);
  return out.join(eol);
}
