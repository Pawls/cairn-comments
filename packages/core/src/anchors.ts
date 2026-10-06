import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { LanguageSpec } from "./languages.js";

// Hashes of the code a comment describes, blind to what formatters change (design.md
// § Staleness, "Normalization").

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Hash of a node's normalized tokens: a declaration contributes its signature only, unless `withBodies`. */
export function nodeHash(spec: LanguageSpec, node: Node, withBodies = false): string {
  const skipped = withBodies ? new Set<number>() : declarationBodies(node);
  return digest(serialize({ spec, range: { start: node.startIndex, end: node.endIndex }, skipped }, node));
}

/**
 * Hash of a declaration with its bodies but without its name, so a renamed function keeps
 * it (design.md § Anchoring, "Renames").
 */
export function bodyHash(spec: LanguageSpec, declaration: Node): string {
  const name = declaration.childForFieldName("name");
  const range = { start: declaration.startIndex, end: declaration.endIndex };
  return digest(serialize({ spec, range, skipped: new Set(name ? [name.id] : []) }, declaration));
}

const DECLARATION = /function|method|class|interface|struct|enum|namespace|internal_module|constructor|record|property|object_declaration|companion_object/;
/** Statements that wrap one declaration: `namespace N {}` in TypeScript, `const f = () => {}`. */
const WRAPPER = /^(?:expression_statement|lexical_declaration|variable_declaration)$/;
/** Kotlin's grammar gives bodies no field: `class_body`, `function_body`, a constructor's `block`. */
const UNFIELDED_BODY = /(?:^|_)body$|^block$/;

/** A declaration's body: its `body` field, else a child typed as a body. */
export function bodyOf(declaration: Node): Node | null {
  return declaration.childForFieldName("body") ?? declaration.namedChildren.find((c): c is Node => !!c && UNFIELDED_BODY.test(c.type)) ?? null;
}

/**
 * A comment above a declaration describes its signature, so the body is left out: an edit
 * deep inside a class would otherwise flag every comment above it. Only the anchor's own
 * spine counts (through `export`, decorators, and a name bound to a function), so a
 * callback's body still does.
 */
function declarationBodies(anchor: Node): Set<number> {
  const skipped = new Set<number>();
  for (let node: Node | null = anchor; node; node = spineChild(node)) {
    if (!DECLARATION.test(node.type)) continue;
    // A C# property keeps its block bodies in `accessors`. An expression body is all a
    // function says (`() => a()`, Kotlin's `fun f() = a()`), so only a block body is left out.
    const body = node.type.includes("property") ? node.childForFieldName("accessors") : bodyOf(node);
    if (body && !isExpressionBody(node, body)) skipped.add(body.id);
  }
  return skipped;
}

/** An arrow function whose body is not a block, or a Kotlin function whose body starts with something other than a block. */
function isExpressionBody(declaration: Node, body: Node): boolean {
  if (declaration.type === "arrow_function") return body.type !== "statement_block";
  return body.type === "function_body" && body.namedChild(0)?.type !== "block";
}

function spineChild(node: Node): Node | null {
  const next = node.childForFieldName("definition") ?? node.childForFieldName("declaration");
  if (next) return next;
  if (WRAPPER.test(node.type) && node.namedChildCount === 1) return node.namedChild(0);
  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  const bound = node.type === "variable_declarator" || node.type === "assignment_expression" || node.type.endsWith("field_definition");
  return bound && value && /function|class/.test(value.type) ? value : null;
}

const QUOTE = /^[A-Za-z]*(?:'''|"""|'|")$/;
const NUMBER_TYPE = /integer|float|number|decimal|hex|octal|binary|real_literal/;
const PLAIN_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** One token as a formatter could not have changed it: quote style, string prefix case, number spelling. */
function normalizeLeaf(node: Node): string {
  const text = node.text;
  if (QUOTE.test(text)) return text.toLowerCase().replaceAll("u", "").replaceAll("'", '"');
  if (NUMBER_TYPE.test(node.type)) {
    const lower = text.toLowerCase();
    return PLAIN_DECIMAL.test(lower) ? String(Number(lower)) : lower;
  }
  return node.isNamed ? `${node.type}:${text}` : text;
}

function isCloser(node: Node | null): boolean {
  return !!node && !node.isNamed && (node.type === ")" || node.type === "]" || node.type === "}");
}

/** A lone identifier parameter of an arrow function, serialized without its parentheses so `(x) => …` and `x => …` match. */
function loneArrowParameter(node: Node, children: Node[]): string | undefined {
  if (node.type !== "formal_parameters" || node.parent?.type !== "arrow_function") return undefined;
  const named = children.filter((c) => c.isNamed);
  if (named.length !== 1 || !IDENTIFIER.test(named[0]!.text)) return undefined;
  return `identifier:${named[0]!.text}`;
}

/** A token formatters add or drop: a parenthesized expression's parentheses, or a trailing comma before a closer. */
function isFormatterToken(node: Node, children: Node[], i: number): boolean {
  const child = children[i]!;
  if (child.isNamed) return false;
  if (node.type === "parenthesized_expression" && (child.type === "(" || child.type === ")")) return true;
  return child.type === "," && isCloser(children[i + 1] ?? null);
}

/** What one serialization walk shares: the grammar, the offsets it covers, and the nodes left out. */
interface Walk {
  spec: LanguageSpec;
  range: { start: number; end: number };
  skipped: ReadonlySet<number>;
}

/** The children of `node` that are not comments. */
function codeChildren(spec: LanguageSpec, node: Node): Node[] {
  const children: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (!spec.commentTypes.includes(child.type)) children.push(child);
  }
  return children;
}

/** Each child's serialization, leaving out formatter tokens and children that contribute nothing. */
function serializeChildren(walk: Walk, node: Node, children: Node[]): string[] {
  const parts: string[] = [];
  for (const [i, child] of children.entries()) {
    if (isFormatterToken(node, children, i)) continue;
    const part = serialize(walk, child);
    if (part) parts.push(part);
  }
  return parts;
}

/**
 * Tokens and structure of the nodes overlapping the walk's range, blind to whatever a
 * formatter changes: whitespace, comments, semicolons, trailing commas, redundant
 * parentheses, and the parentheses around a lone arrow-function parameter. A named node
 * wholly inside the range contributes its type, so `(a + b) * c` and `a + b * c` still differ.
 */
function serialize(walk: Walk, node: Node): string {
  const { spec, range } = walk;
  if (node.endIndex <= range.start || node.startIndex >= range.end) return "";
  if (walk.skipped.has(node.id) || spec.commentTypes.includes(node.type)) return "";
  if (node.childCount === 0) {
    if (!node.text || node.type === ";") return "";
    return normalizeLeaf(node);
  }
  const children = codeChildren(spec, node);
  const parameter = loneArrowParameter(node, children);
  if (parameter) return parameter;
  const text = serializeChildren(walk, node, children).join(" ");
  const inside = node.startIndex >= range.start && node.endIndex <= range.end;
  if (node.isNamed && inside && node.type !== "parenthesized_expression") return `(${node.type} ${text})`;
  return text;
}
