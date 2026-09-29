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
  return digest(serialize(spec, node, { start: node.startIndex, end: node.endIndex }, skipped));
}

/**
 * Hash of a declaration with its bodies but without its name, so a renamed function keeps
 * it (design.md § Anchoring, "Renames").
 */
export function bodyHash(spec: LanguageSpec, declaration: Node): string {
  const name = declaration.childForFieldName("name");
  return digest(serialize(spec, declaration, { start: declaration.startIndex, end: declaration.endIndex }, new Set(name ? [name.id] : [])));
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
    if (!body) continue;
    const expression =
      (node.type === "arrow_function" && body.type !== "statement_block") || (body.type === "function_body" && body.namedChild(0)?.type !== "block");
    if (!expression) skipped.add(body.id);
  }
  return skipped;
}

function spineChild(node: Node): Node | null {
  const next = node.childForFieldName("definition") ?? node.childForFieldName("declaration");
  if (next) return next;
  if (WRAPPER.test(node.type) && node.namedChildCount === 1) return node.namedChild(0);
  const value = node.childForFieldName("value") ?? node.childForFieldName("right");
  const bound = node.type === "variable_declarator" || node.type === "assignment_expression" || /field_definition$/.test(node.type);
  return bound && value && /function|class/.test(value.type) ? value : null;
}

const QUOTE = /^[A-Za-z]*(?:'''|"""|'|")$/;
const NUMBER_TYPE = /integer|float|number|decimal|hex|octal|binary|real_literal/;
const PLAIN_DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
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

/**
 * Tokens and structure of the nodes overlapping `range`, blind to whatever a formatter
 * changes: whitespace, comments, semicolons, trailing commas, redundant parentheses, and
 * the parentheses around a lone arrow-function parameter. A named node wholly inside the
 * range contributes its type, so `(a + b) * c` and `a + b * c` still differ.
 */
function serialize(spec: LanguageSpec, node: Node, range: { start: number; end: number }, skipped: Set<number>): string {
  if (node.endIndex <= range.start || node.startIndex >= range.end) return "";
  if (skipped.has(node.id) || spec.commentTypes.includes(node.type)) return "";
  if (node.childCount === 0) {
    if (!node.text || node.type === ";") return "";
    return normalizeLeaf(node);
  }
  const children: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (!spec.commentTypes.includes(child.type)) children.push(child);
  }
  if (node.type === "formal_parameters" && node.parent?.type === "arrow_function") {
    const named = children.filter((c) => c.isNamed);
    if (named.length === 1 && IDENTIFIER.test(named[0]!.text)) return `identifier:${named[0]!.text}`;
  }
  const parts: string[] = [];
  children.forEach((child, i) => {
    if (node.type === "parenthesized_expression" && !child.isNamed && (child.type === "(" || child.type === ")")) return;
    if (child.type === "," && !child.isNamed && isCloser(children[i + 1] ?? null)) return;
    const part = serialize(spec, child, range, skipped);
    if (part) parts.push(part);
  });
  const inside = node.startIndex >= range.start && node.endIndex <= range.end;
  return node.isNamed && inside && node.type !== "parenthesized_expression" ? `(${node.type} ${parts.join(" ")})` : parts.join(" ");
}
