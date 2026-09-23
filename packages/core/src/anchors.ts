import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { LanguageSpec } from "./languages.js";
import type { Line } from "./lines.js";

/**
 * The code a marker describes, as a hash of its normalized tokens (design.md § Staleness).
 * An own-line marker anchors to the node that starts the next code line at the marker's
 * indent; a trailing marker anchors to the code before it on its own line. Undefined
 * when there is no such code (the last comment of a block, the end of the file).
 */
export function anchorHash(
  spec: LanguageSpec,
  root: Node,
  source: string,
  lines: readonly Line[],
  marker: { placement: "own-line" | "trailing"; start: number; end: number; indent: string },
  row: { first: number; last: number },
): string | undefined {
  const text =
    marker.placement === "trailing"
      ? serialize(spec, root, { start: lines[row.first]!.start, end: marker.start }, new Set())
      : ownLineAnchor(spec, root, source, lines, marker.indent, row.last);
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 8) : undefined;
}

function ownLineAnchor(spec: LanguageSpec, root: Node, source: string, lines: readonly Line[], indent: string, lastRow: number): string | undefined {
  for (let r = lastRow + 1; r < lines.length; r++) {
    const line = lines[r]!;
    const content = source.slice(line.start, line.contentEnd);
    const lead = /^[ \t]*/.exec(content)![0];
    if (lead.length === content.length) continue;
    const at = line.start + lead.length;
    const leaf = root.descendantForIndex(at, at);
    if (!leaf || spec.commentTypes.includes(leaf.type)) continue;
    // Code at another indent belongs to an enclosing or nested construct, not to this comment.
    if (lead !== indent) return undefined;
    let node = leaf;
    // Python's `block` starts at its first statement; climbing into it would take the whole body.
    while (node.parent?.parent && node.parent.startIndex === node.startIndex && node.parent.type !== "block") node = node.parent;
    return serialize(spec, node, { start: node.startIndex, end: node.endIndex }, declarationBodies(node));
  }
  return undefined;
}

const DECLARATION = /function|method|class|interface|struct|enum|namespace|constructor|record/;

/**
 * A comment above a declaration describes its signature, so the body is left out: an edit
 * deep inside a class would otherwise flag every comment above it. Only the anchor's own
 * spine counts (through `export` and decorators), so a callback's body still does.
 */
function declarationBodies(anchor: Node): Set<number> {
  const skipped = new Set<number>();
  for (let node: Node | null = anchor; node; ) {
    const body = node.childForFieldName("body");
    if (body && DECLARATION.test(node.type)) skipped.add(body.id);
    node = node.childForFieldName("definition") ?? node.childForFieldName("declaration");
  }
  return skipped;
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
