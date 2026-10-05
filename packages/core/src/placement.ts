import type { Node } from "web-tree-sitter";
import { bodyHash, bodyOf, nodeHash } from "./anchors.js";
import { resolveIds } from "./ids.js";
import { languageForPath, type LanguageSpec } from "./languages.js";
import { applySplices, dominantEol, lineIndexAt, splitLines, trailingRunStart, type Line, type Splice } from "./lines.js";
import { STALE_TAG, markersFrom, type Marker } from "./markers.js";
import { commentsIn, parseWith } from "./parser.js";
import { normalizeBody, type Sidecar, type SidecarEntry } from "./sidecar.js";

/**
 * Anchoring (design.md § Anchoring): committed code holds no trace of AI comments.
 * `stripComments` is the clean filter, `placeComments` the smudge, and `recordComments`
 * writes each comment's position into its sidecar entry as these metadata keys.
 */
export const PLACEMENT_KEYS = ["pos", "scope", "body", "stmts", "in", "node", "nth", "decl", "skip", "seq", "indent", "gap", "eof"] as const;

type Pos = "before" | "after" | "trail" | "row";

/**
 * Where a comment goes, relative to code that survives `stripComments`:
 * - `before`: above the code node `node`, `skip` kept lines higher (blank lines, human comments);
 * - `after`: below the last code line of `node`, `skip` kept lines lower (the last comment of a block);
 * - `trail`: at the end of the line where `node` starts;
 * - `row`: at line `skip` of the stripped file, when no code node anchors the comment.
 * `node` is the `nth` node with that hash among the line-starting nodes of `scope`.
 */
interface Placement {
  pos: Pos;
  /** Path of the enclosing function or class (`Ledger.settle`, `@n` for the nth duplicate); absent at module level. */
  scope?: string;
  /** Hash of the enclosing function, name left out (`bodyHash`): while it matches, placement is exact. */
  body?: string;
  /** Short hashes of the function's top-level statements, diffed to place its comments once it changes. */
  stmts?: string[];
  /** The top-level statement holding `node` (`k`), and which of its nodes with that hash it is (`m`). */
  in?: { k: number; m: number };
  /** Path of the declaration `node` is (a comment above a function): found by name once its signature changes. */
  decl?: string;
  node?: string;
  nth: number;
  skip: number;
  /** Order among own-line comments that land on the same line. */
  seq: number;
  /** Leading whitespace, when it differs from the line the comment is placed against. */
  indent?: string;
  /** Whitespace between the code and a trailing comment. */
  gap?: string;
  /**
   * The terminator `stripComments` took from the line before a comment on an unterminated
   * last line; nothing left in the stripped file says which one it was.
   */
  eof?: string;
}

/** Whitespace as runs, so the metadata line stays readable: four spaces are `4s`, a tab `1t`. */
function encodeWhitespace(ws: string): string {
  if (!ws) return "0";
  return [...ws.matchAll(/ +|\t+/g)].map((run) => `${run[0].length}${run[0].startsWith(" ") ? "s" : "t"}`).join("");
}

function decodeWhitespace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "0") return "";
  // Sticky: each run starts where the last one ended, so the runs cover `value` only when it is nothing but runs.
  const runs = [...value.matchAll(/(\d+)([st])/gy)];
  const covered = runs.reduce((length, run) => length + run[0].length, 0);
  if (!runs.length || covered !== value.length) return undefined;
  return runs.map((run) => (run[2] === "s" ? " " : "\t").repeat(Number(run[1]))).join("");
}

const EOF_BY_NAME = new Map([
  ["crlf", "\r\n"],
  ["lf", "\n"],
]);

/** A count's metadata value; a zero count is left out. */
const countMeta = (n: number | undefined) => (n ? String(n) : undefined);

function placementMeta(p: Placement): Map<string, string> {
  const fields: [string, string | undefined][] = [
    ["pos", p.pos],
    ["scope", p.scope],
    ["body", p.body],
    ["stmts", p.stmts && (p.stmts.join(".") || "-")],
    ["in", p.in && (p.in.m ? `${p.in.k}.${p.in.m}` : String(p.in.k))],
    ["decl", p.decl],
    ["node", p.node],
    ["nth", countMeta(p.nth)],
    ["skip", countMeta(p.skip)],
    ["seq", countMeta(p.seq)],
    ["indent", p.indent === undefined ? undefined : encodeWhitespace(p.indent)],
    ["gap", p.gap === undefined ? undefined : encodeWhitespace(p.gap)],
    ["eof", p.eof && (p.eof === "\r\n" ? "crlf" : "lf")],
  ];
  return new Map(fields.filter((field): field is [string, string] => field[1] !== undefined));
}

function placementOf(entry: SidecarEntry): Placement | undefined {
  const pos = entry.meta.get("pos");
  if (pos !== "before" && pos !== "after" && pos !== "trail" && pos !== "row") return undefined;
  const count = (key: string) => Number(entry.meta.get(key) ?? 0) || 0;
  const stmts = entry.meta.get("stmts");
  const within = /^(\d+)(?:\.(\d+))?$/.exec(entry.meta.get("in") ?? "");
  return {
    pos,
    scope: entry.meta.get("scope"),
    body: entry.meta.get("body"),
    stmts: stmts === undefined ? undefined : stmts.split(".").filter((h) => h !== "-"),
    in: within ? { k: Number(within[1]), m: Number(within[2] ?? 0) } : undefined,
    decl: entry.meta.get("decl"),
    node: entry.meta.get("node"),
    nth: count("nth"),
    skip: count("skip"),
    seq: count("seq"),
    indent: decodeWhitespace(entry.meta.get("indent")),
    gap: decodeWhitespace(entry.meta.get("gap")),
    eof: EOF_BY_NAME.get(entry.meta.get("eof") ?? ""),
  };
}

/** Whether `stripComments` and `placeComments` manage this entry. */
function isPlaced(entry: SidecarEntry): boolean {
  return placementOf(entry) !== undefined;
}

/**
 * A scope's name in its path. A function or class expression takes the name it is bound to
 * (`const f = () => {}`, a class field, `exports.run = function () {}`); one with no such
 * name is a callback, and its comments belong to the scope around it.
 */
function scopeName(node: Node): string | undefined {
  const own = node.childForFieldName("name");
  if (own) return own.text;
  const parent = node.parent;
  if (!parent) return undefined;
  if (parent.childForFieldName("value")?.id === node.id) return (parent.childForFieldName("name") ?? parent.childForFieldName("property"))?.text;
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) return parent.childForFieldName("left")?.text;
  return undefined;
}

type RowKind = "blank" | "comment" | "code" | "continuation";

interface Row {
  kind: RowKind;
  indent: string;
  /** The largest node starting at the line's first character, on a code line. */
  node?: Node;
}

/**
 * One parse, with everything placement needs to ask of it. The same questions asked of a
 * file with its AI comments and of the stripped file get the same answers, because
 * comments are extras in every grammar: they add rows but never change nodes or hashes.
 */
class Layout {
  readonly lines: Line[];
  readonly rows: Row[];
  private readonly hashes = new Map<number, string>();
  private readonly bodies = new Map<number, string>();
  private readonly candidates = new Map<number, Node[]>();
  private readonly keys = new Map<number, string>();
  private readonly byKey = new Map<string, Node>();

  constructor(
    readonly spec: LanguageSpec,
    readonly root: Node,
    readonly source: string,
  ) {
    this.lines = splitLines(source);
    this.rows = this.lines.map((line) => this.classify(line));
    const scopeTypes = [...spec.functionTypes, ...spec.namespaceTypes];
    const seen = new Map<string, number>();
    for (const node of scopeTypes.length ? root.descendantsOfType(scopeTypes) : []) {
      if (!node || scopeName(node) === undefined) continue;
      const path = this.pathOf(node);
      const n = seen.get(path) ?? 0;
      seen.set(path, n + 1);
      const key = n ? `${path}@${n}` : path;
      this.keys.set(node.id, key);
      this.byKey.set(key, node);
    }
  }

  private classify(line: Line): Row {
    const content = this.source.slice(line.start, line.contentEnd);
    const indent = /^[ \t]*/.exec(content)![0];
    if (indent.length === content.length) return { kind: "blank", indent };
    const at = line.start + indent.length;
    const leaf = this.root.descendantForIndex(at, at);
    // A line inside a multi-line string or template starts in the middle of a token.
    if (leaf?.startIndex !== at) return { kind: "continuation", indent };
    if (this.spec.commentTypes.includes(leaf.type)) return { kind: "comment", indent };
    let node = leaf;
    // Python's `block` starts at its first statement; climbing into it would take the whole body.
    while (node.parent?.parent && node.parent.startIndex === node.startIndex && node.parent.type !== "block") node = node.parent;
    return { kind: "code", indent, node };
  }

  private pathOf(scope: Node): string {
    const names: string[] = [];
    const types = new Set([...this.spec.functionTypes, ...this.spec.namespaceTypes]);
    for (let n: Node | null = scope; n; n = n.parent) {
      if (!types.has(n.type)) continue;
      const name = scopeName(n);
      if (name !== undefined) names.unshift(name);
    }
    return names.join(".");
  }

  private isScope(node: Node, types: readonly string[]): boolean {
    return types.includes(node.type) && scopeName(node) !== undefined;
  }

  /** The innermost named function around `node`, else its innermost class; null at module level. */
  scopeOf(node: Node): Node | null {
    for (let p = node.parent; p; p = p.parent) if (this.isScope(p, this.spec.functionTypes)) return p;
    for (let p = node.parent; p; p = p.parent) if (this.isScope(p, this.spec.namespaceTypes)) return p;
    return null;
  }

  keyOf(scope: Node | null): string | undefined {
    return scope ? this.keys.get(scope.id) : undefined;
  }

  scopeFor(key: string | undefined): Node | null | undefined {
    return key === undefined ? null : this.byKey.get(key);
  }

  isFunction(scope: Node | null): scope is Node {
    return !!scope && this.spec.functionTypes.includes(scope.type);
  }

  hashOf(node: Node): string {
    let hash = this.hashes.get(node.id);
    if (hash === undefined) {
      hash = nodeHash(this.spec, node);
      this.hashes.set(node.id, hash);
    }
    return hash;
  }

  bodyHashOf(scope: Node): string {
    let hash = this.bodies.get(scope.id);
    if (hash === undefined) {
      hash = bodyHash(this.spec, scope);
      this.bodies.set(scope.id, hash);
    }
    return hash;
  }

  /**
   * A function's top-level statements: the children of its block, a property's accessors,
   * or an expression body as one statement.
   */
  statements(scope: Node): Node[] {
    let body = bodyOf(scope) ?? scope.childForFieldName("accessors") ?? scope.childForFieldName("value");
    if (!body) return [];
    // Kotlin wraps a function's block, or its `= expression`, in `function_body`.
    if (body.type === "function_body") body = body.namedChildren.find((c): c is Node => !!c && !this.spec.commentTypes.includes(c.type)) ?? null;
    if (!body) return [];
    if (!/block|body|accessor_list/.test(body.type)) return [body];
    return body.namedChildren.filter((c): c is Node => !!c && !this.spec.commentTypes.includes(c.type));
  }

  statementHash(statement: Node): string {
    return nodeHash(this.spec, statement, true).slice(0, 4);
  }

  /** Candidates of `scope` inside `statement`. */
  candidatesWithin(scope: Node, statement: Node): Node[] {
    return this.candidatesIn(scope).filter((c) => c.startIndex >= statement.startIndex && c.startIndex < statement.endIndex);
  }

  /**
   * The path of the declaration `node` is, through `export`, decorators, and a name bound
   * to a function (`const f = () => {}`); undefined for any other statement.
   */
  declarationAt(node: Node): string | undefined {
    for (let n: Node | null = node; n; ) {
      const key = this.keys.get(n.id);
      if (key !== undefined) return key;
      const named: Node[] = n.namedChildren.filter((c): c is Node => !!c && !this.spec.commentTypes.includes(c.type));
      n = n.childForFieldName("definition") ?? n.childForFieldName("declaration") ?? (named.length === 1 ? named[0]! : n.childForFieldName("value"));
    }
    return undefined;
  }

  /** Every named scope, in document order. */
  scopes(): Node[] {
    return [...this.byKey.values()];
  }

  /** Nodes that start a code line and belong to `scope` itself, not to a function inside it. */
  candidatesIn(scope: Node | null): Node[] {
    const id = scope?.id ?? -1;
    let found = this.candidates.get(id);
    if (!found) {
      found = [];
      const first = scope?.startPosition.row ?? 0;
      const last = scope?.endPosition.row ?? this.rows.length - 1;
      for (let r = first; r <= last && r < this.rows.length; r++) {
        const node = this.rows[r]!.node;
        if (node && (this.scopeOf(node)?.id ?? -1) === id) found.push(node);
      }
      this.candidates.set(id, found);
    }
    return found;
  }

  /** The row of the last code token in `node`, skipping comments the grammar folded into it. */
  lastCodeRow(node: Node): number {
    let last: Node = node;
    for (;;) {
      let child: Node | null = null;
      for (let i = last.childCount - 1; i >= 0; i--) {
        const c = last.child(i)!;
        if (!this.spec.commentTypes.includes(c.type)) {
          child = c;
          break;
        }
      }
      if (!child) return last.endPosition.row;
      last = child;
    }
  }

  /** Whether a line ends with a comment, which a trailing comment cannot follow. */
  endsWithComment(row: number): boolean {
    const line = this.lines[row]!;
    const content = this.source.slice(line.start, line.contentEnd).trimEnd();
    if (!content) return false;
    const at = line.start + content.length - 1;
    const leaf = this.root.descendantForIndex(at, at);
    return !!leaf && this.spec.commentTypes.includes(leaf.type);
  }

  isContent(row: number): boolean {
    const kind = this.rows[row]?.kind;
    return kind === "code" || kind === "continuation";
  }
}

async function withLayout<T>(spec: LanguageSpec, source: string, read: (layout: Layout) => T): Promise<T> {
  return parseWith(spec, source, (root) => read(new Layout(spec, root, source)));
}

/** Rows each own-line marker covers, and the half-open offset range a trailing marker takes. */
function removals(layout: Layout, markers: readonly Marker[]): { rows: Set<number>; trailing: Splice[] } {
  const rows = new Set<number>();
  const trailing: Splice[] = [];
  for (const m of markers) {
    if (m.placement === "own-line") {
      const first = lineIndexAt(layout.lines, m.start);
      const last = lineIndexAt(layout.lines, m.end);
      for (let r = first; r <= last; r++) rows.add(r);
    } else {
      const line = layout.lines[lineIndexAt(layout.lines, m.start)]!;
      const before = layout.source.slice(line.start, m.start);
      const gap = before.slice(trailingRunStart(before, " \t"));
      trailing.push({ start: m.start - gap.length, end: m.end, text: "" });
    }
  }
  return { rows, trailing };
}

/**
 * Removes every sigil comment whole: own-line comments with their lines and terminators,
 * trailing ones with the whitespace before them. Pure in (path, source), like `clean`.
 * A comment on an unterminated last line takes the terminator before it instead, so the
 * stripped file keeps the original's missing final newline.
 */
export async function stripComments(path: string, source: string): Promise<string> {
  const spec = languageForPath(path);
  if (!spec || !source.includes(spec.lineSigil)) return source;
  return withLayout(spec, source, (layout) => {
    const markers = markersFrom(spec, source, layout.lines, commentsIn(spec, layout.root));
    if (!markers.length) return source;
    const { rows, trailing } = removals(layout, markers);
    const splices: Splice[] = [...trailing];
    for (const [first, lastRow] of runsOf(rows)) {
      const last = layout.lines[lastRow]!;
      const unterminated = last.end === last.contentEnd && first > 0;
      splices.push({ start: unterminated ? layout.lines[first - 1]!.contentEnd : layout.lines[first]!.start, end: last.end, text: "" });
    }
    return applySplices(source, splices);
  });
}

/** Consecutive rows as [first, last] pairs, in order. */
function runsOf(rows: ReadonlySet<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const row of [...rows].sort((a, b) => a - b)) {
    const current = runs.at(-1);
    if (current?.[1] === row - 1) current[1] = row;
    else runs.push([row, row]);
  }
  return runs;
}

/** The code line an own-line comment block sits against, found the same way in both parses. */
function placementFor(layout: Layout, m: Marker, aiRows: Set<number>, cleanRow: (row: number) => number): Placement {
  const { lines, rows } = layout;
  const first = lineIndexAt(lines, m.start);
  const last = lineIndexAt(lines, m.end);
  const kept = (from: number, to: number) => {
    let n = 0;
    for (let r = from; r < to; r++) if (!aiRows.has(r)) n++;
    return n;
  };
  const anchored = (pos: Pos, node: Node, skip: number, defaultIndent: string, gap?: string): Placement => {
    const scope = layout.scopeOf(node);
    const hash = layout.hashOf(node);
    const nth = layout.candidatesIn(scope).filter((c) => layout.hashOf(c) === hash).findIndex((c) => c.id === node.id);
    let stmts: string[] | undefined;
    let within: Placement["in"];
    if (layout.isFunction(scope)) {
      const statements = layout.statements(scope);
      stmts = statements.map((s) => layout.statementHash(s));
      const k = statements.findIndex((s) => node.startIndex >= s.startIndex && node.startIndex < s.endIndex);
      const m = k < 0 ? -1 : layout.candidatesWithin(scope, statements[k]!).filter((c) => layout.hashOf(c) === hash).findIndex((c) => c.id === node.id);
      if (m >= 0) within = { k, m };
    }
    return {
      pos,
      scope: layout.keyOf(scope),
      body: layout.isFunction(scope) ? layout.bodyHashOf(scope) : undefined,
      stmts,
      in: within,
      decl: layout.declarationAt(node),
      node: hash,
      nth: Math.max(nth, 0),
      skip,
      seq: 0,
      indent: m.placement === "own-line" && m.indent !== defaultIndent ? m.indent : undefined,
      gap,
    };
  };

  if (m.placement === "trailing") {
    const line = lines[first]!;
    const before = layout.source.slice(line.start, m.start);
    const gap = before.slice(trailingRunStart(before, " \t"));
    const node = rows[first]!.node;
    if (node?.startPosition.row === first) return anchored("trail", node, 0, "", gap);
    return { pos: "row", nth: 0, skip: cleanRow(first), seq: 0, gap };
  }

  let next = last + 1;
  while (next < rows.length && rows[next]!.kind !== "code") next++;
  const nextRow = rows[next];
  if (nextRow && nextRow.indent.length >= m.indent.length) return anchored("before", nextRow.node!, kept(last + 1, next), nextRow.indent);

  // The last comment of a block: below the statement it follows at its own indent.
  for (let prev = first - 1; prev >= 0; prev--) {
    const row = rows[prev]!;
    if (row.kind !== "code" || row.indent.length > m.indent.length) continue;
    if (row.indent.length < m.indent.length) break;
    return anchored("after", row.node!, kept(layout.lastCodeRow(row.node!) + 1, first), row.indent);
  }
  if (nextRow) return anchored("before", nextRow.node!, kept(last + 1, next), nextRow.indent);
  return { pos: "row", nth: 0, skip: cleanRow(first), seq: 0, indent: m.indent || undefined };
}

/** A stale comment, and the row of the stripped file it was placed against. */
export interface StalePlacement {
  id: string;
  row: number;
}

interface Located {
  node: Node;
  /** Whether the comment was placed after its declaration changed. */
  stale: boolean;
  /** Whether the recorded scope no longer resolved and was found as a rename. */
  renamed: boolean;
}

/**
 * Statement-set overlap (Jaccard) a function needs to count as the renamed one when its
 * body changed too. The measured history never exercised it (design.md § Anchoring, "Measured").
 */
const RENAME_OVERLAP = 0.5;

/**
 * The code node an entry goes against. While its function is unchanged, that is the
 * recorded node; once it changed, the same node if its statement is in an unchanged run.
 * A comment above a declaration whose signature changed follows the declaration by name.
 * A scope that no longer resolves is looked up as a rename first. Anything else is an
 * orphan, kept in the sidecar.
 */
function locate(layout: Layout, p: Placement): Located | undefined {
  // `null` is module level; `undefined` is a scope path that no longer resolves.
  const resolved = layout.scopeFor(p.scope);
  const scope = resolved === undefined ? renamedScope(layout, p) : resolved;
  if (scope === undefined) return undefined;
  const renamed = resolved === undefined;
  const exact = p.body === undefined || (layout.isFunction(scope) && layout.bodyHashOf(scope) === p.body);
  const node = exact ? layout.candidatesIn(scope).filter((c) => layout.hashOf(c) === p.node)[p.nth] : inUnchangedRun(layout, scope, p);
  if (node) return { node, stale: !exact, renamed };
  // A declaration whose signature changed: the comment above it follows it by name, to the
  // line that starts it (decorators, `export`), never an `if` block around it.
  if (p.decl === undefined) return undefined;
  const wrapper = layout.candidatesIn(scope).find((c) => layout.declarationAt(c) === p.decl);
  return wrapper && { node: wrapper, stale: true, renamed };
}

/**
 * The recorded node, found through a diff of the function's statement hashes: only while
 * the statement holding it is in an unchanged run, or was moved whole within the function.
 * A comment on a replaced statement is not moved onto its replacement; the measurement
 * found such moves wrong a third of the time (design.md § Anchoring, "Measured").
 */
function inUnchangedRun(layout: Layout, scope: Node | null, p: Placement): Node | undefined {
  if (!layout.isFunction(scope) || !p.stmts || !p.in) return undefined;
  const statements = layout.statements(scope);
  const hashes = statements.map((s) => layout.statementHash(s));
  const matched = matchRuns(p.stmts, hashes);
  const now = matched.get(p.in.k) ?? movedStatement(p.stmts, hashes, matched, p.in.k);
  if (now === undefined) return undefined;
  return layout.candidatesWithin(scope, statements[now]!).filter((c) => layout.hashOf(c) === p.node)[p.in.m];
}

/**
 * Where old statement `k` went when it was moved rather than changed (a line moved with
 * Alt+Up or Alt+Down): its hash occurs once in the function before and once after, and
 * the diff matched neither occurrence, so no other statement can be it.
 */
function movedStatement(old: readonly string[], now: readonly string[], matched: ReadonlyMap<number, number>, k: number): number | undefined {
  const hash = old[k]!;
  const j = now.indexOf(hash);
  if (old.indexOf(hash) !== old.lastIndexOf(hash) || j === -1 || j !== now.lastIndexOf(hash)) return undefined;
  return [...matched.values()].includes(j) ? undefined : j;
}

/** Old index to new index for every statement in the longest common subsequence of the two. */
function matchRuns(old: readonly string[], now: readonly string[]): Map<number, number> {
  const lengths = Array.from({ length: old.length + 1 }, () => new Array<number>(now.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = now.length - 1; j >= 0; j--) {
      lengths[i]![j] = old[i] === now[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const matched = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < old.length && j < now.length) {
    if (old[i] === now[j]) matched.set(i++, j++);
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return matched;
}

/**
 * The declaration a scope that no longer resolves was renamed to: the one function whose
 * body hash is unchanged, else the function whose statements overlap most (at least
 * `RENAME_OVERLAP`); for a class, the one class holding the anchor node.
 */
function renamedScope(layout: Layout, p: Placement): Node | undefined {
  if (p.scope === undefined) return undefined;
  const scopes = layout.scopes();
  if (p.body === undefined) {
    const holders = scopes.filter((s) => !layout.isFunction(s) && layout.candidatesIn(s).filter((c) => layout.hashOf(c) === p.node).length > p.nth);
    return holders.length === 1 ? holders[0] : undefined;
  }
  const functions = scopes.filter((s) => layout.isFunction(s));
  const same = functions.filter((f) => layout.bodyHashOf(f) === p.body);
  if (same.length === 1) return same[0];
  if (same.length > 1 || !p.stmts?.length) return undefined;
  const old = new Set(p.stmts);
  let best: Node | undefined;
  let bestScore = 0;
  let tied = false;
  for (const f of functions) {
    const now = new Set(layout.statements(f).map((s) => layout.statementHash(s)));
    const shared = [...now].filter((h) => old.has(h)).length;
    // One shared statement (a lone `pass` or `return`) says nothing about identity.
    const score = shared < 2 ? 0 : shared / (old.size + now.size - shared);
    if (score > bestScore) [best, bestScore, tied] = [f, score, false];
    else if (score === bestScore) tied = true;
  }
  return best && !tied && bestScore >= RENAME_OVERLAP ? best : undefined;
}

interface Insertion {
  id: string;
  row: number;
  seq: number;
  order: number;
  lines: string[];
  eof?: string;
}

/** Where each placeable entry goes in a stripped file; ids absent from the result could not be placed. */
interface Resolved {
  own: Insertion[];
  trailing: Map<number, { id: string; text: string }[]>;
  placed: string[];
  stale: StalePlacement[];
  renamed: string[];
}

function resolve(layout: Layout, entries: readonly SidecarEntry[]): Resolved {
  const own: Insertion[] = [];
  const trailing = new Map<number, { id: string; text: string }[]>();
  const placed: string[] = [];
  const staleRows: StalePlacement[] = [];
  const renamed: string[] = [];
  const { rows, spec } = layout;

  entries.forEach((entry, order) => {
    const p = placementOf(entry);
    const body = normalizeBody(entry.body);
    if (!p || !body) return;

    let row: number;
    let defaultIndent = "";
    let stale = false;
    if (p.pos === "row") {
      row = clamp(p.skip, 0, rows.length);
    } else {
      const found = locate(layout, p);
      if (!found) return;
      stale = found.stale;
      if (found.renamed) renamed.push(entry.id);
      ({ row, defaultIndent } = targetRow(layout, p, found.node));
    }

    placed.push(entry.id);
    if (stale) staleRows.push({ id: entry.id, row });
    const tag = stale ? STALE_TAG + " " : "";
    if (p.pos === "trail" || (p.pos === "row" && p.gap !== undefined)) {
      const onRow = trailing.get(row) ?? [];
      onRow.push({ id: entry.id, text: `${p.gap ?? "  "}${spec.lineSigil}${entry.id} ${tag}${body.replaceAll("\n", " ")}` });
      trailing.set(row, onRow);
      return;
    }
    const indent = p.indent ?? defaultIndent;
    const [head, ...rest] = body.split("\n");
    own.push({
      id: entry.id,
      row,
      seq: p.seq,
      order,
      lines: [`${indent}${spec.lineSigil}${entry.id} ${tag}${head!}`, ...rest.map((l) => indent + spec.lineSigil + (l ? " " + l : ""))],
      eof: p.eof,
    });
  });

  oneTrailingPerLine(layout, trailing, own);
  return { own, trailing, placed, stale: staleRows, renamed };
}

const clamp = (row: number, low: number, high: number) => Math.min(Math.max(row, low), high);

/** The row a located entry goes on, and the indent its comment takes unless it recorded its own. */
function targetRow(layout: Layout, p: Placement, node: Node): { row: number; defaultIndent: string } {
  const start = node.startPosition.row;
  if (p.pos === "trail") return { row: start, defaultIndent: "" };
  const defaultIndent = layout.rows[start]!.indent;
  if (p.pos === "before") {
    let low = start - 1;
    while (low >= 0 && !layout.isContent(low)) low--;
    return { row: clamp(start - p.skip, low + 1, start), defaultIndent };
  }
  const end = layout.lastCodeRow(node);
  let high = end + 1;
  while (high < layout.rows.length && !layout.isContent(high)) high++;
  return { row: clamp(end + 1 + p.skip, end + 1, high), defaultIndent };
}

/** A line holds one trailing comment: any other, or one after a comment already there, moves to `own` above it. */
function oneTrailingPerLine(layout: Layout, trailing: Map<number, { id: string; text: string }[]>, own: Insertion[]): void {
  for (const [row, items] of trailing) {
    const pastEnd = row >= layout.lines.length;
    const keep = pastEnd || layout.endsWithComment(row) ? [] : items.slice(0, 1);
    for (const extra of items.slice(keep.length)) {
      const indent = layout.rows[row]?.indent ?? "";
      const text = extra.text.trimStart();
      own.push({ id: extra.id, row, seq: Number.MAX_SAFE_INTEGER, order: own.length, lines: [indent + text] });
    }
    trailing.set(row, keep);
  }
}

/** The terminator of `row`, else the one before it, else the file's usual one. */
function eolFor(layout: Layout, row: number): string {
  for (const r of [row, row - 1]) {
    const line = layout.lines[r];
    if (line && line.end > line.contentEnd) return layout.source.slice(line.contentEnd, line.end);
  }
  return dominantEol(layout.source);
}

export interface PlaceResult {
  source: string;
  /** Ids placed, in sidecar order. */
  placed: string[];
  /** Ids of placement entries that could not be placed: orphans (`check --orphans`). */
  unplaced: string[];
  /** Comments placed after their function changed, shown behind `STALE_TAG` (design.md § Anchoring). */
  stale: StalePlacement[];
  /** Ids placed in a declaration found as a rename of the recorded one. */
  renamed: string[];
  /** Where each placed comment sits in the stripped file, in display order. */
  sites: CommentSite[];
}

/**
 * A placed comment against the stripped file: `own` comments go above `row` (which may
 * equal the row count, past the last line), `trail` ones at the end of `row`.
 */
export interface CommentSite {
  id: string;
  row: number;
  kind: "own" | "trail";
}

function placeIn(layout: Layout, sidecar: Sidecar): PlaceResult {
  const managed = sidecar.entries.filter(isPlaced);
  const { own, trailing, placed, stale, renamed } = resolve(layout, managed);
  const { lines, source } = layout;
  const splices: Splice[] = [];
  const sites: CommentSite[] = [];
  for (const [row, items] of trailing) {
    if (!items.length || row >= lines.length) continue;
    splices.push({ start: lines[row]!.contentEnd, end: lines[row]!.contentEnd, text: items[0]!.text });
    sites.push({ id: items[0]!.id, row, kind: "trail" });
  }
  const byRow = new Map<number, Insertion[]>();
  for (const ins of own) byRow.set(ins.row, [...(byRow.get(ins.row) ?? []), ins]);
  for (const [row, group] of byRow) {
    group.sort((a, b) => a.seq - b.seq || a.order - b.order);
    for (const ins of group) sites.push({ id: ins.id, row, kind: "own" });
    splices.push(ownLinesSplice(layout, row, group));
  }
  const placedSet = new Set(placed);
  sites.sort((a, b) => a.row - b.row || kindOrder(a) - kindOrder(b));
  return {
    source: applySplices(source, splices),
    placed,
    unplaced: managed.filter((e) => e.body && !placedSet.has(e.id)).map((e) => e.id),
    stale,
    renamed,
    sites,
  };
}

/** On one row, own-line comments come before the trailing one. */
const kindOrder = (site: CommentSite) => (site.kind === "own" ? 0 : 1);

/** Inserts the own-line comments of `group` above `row`, or appends them when `row` is past the last line. */
function ownLinesSplice(layout: Layout, row: number, group: Insertion[]): Splice {
  const { lines, source } = layout;
  const text = group.flatMap((g) => g.lines);
  if (row < lines.length) {
    const eol = eolFor(layout, row);
    return { start: lines[row]!.start, end: lines[row]!.start, text: text.map((l) => l + eol).join("") };
  }
  const terminated = !source || source.endsWith("\n");
  const eol = (!terminated && group.find((g) => g.eof)?.eof) || eolFor(layout, lines.length - 1);
  return { start: source.length, end: source.length, text: terminated ? text.map((l) => l + eol).join("") : eol + text.join(eol) };
}

/** Inserts each placement entry's comment into a stripped file; entries that no longer match stay out. */
export async function placeComments(path: string, source: string, sidecar: Sidecar): Promise<PlaceResult> {
  const spec = languageForPath(path);
  if (!spec || !sidecar.entries.some(isPlaced)) return { source, placed: [], unplaced: [], stale: [], renamed: [], sites: [] };
  return withLayout(spec, source, (layout) => placeIn(layout, sidecar));
}

export interface RecordOptions {
  /** Provenance merged into the metadata of every entry whose body this run writes. */
  meta?: ReadonlyMap<string, string>;
  /**
   * Ids that were in the file when the tool last wrote it (placed or recorded). One of
   * them missing now was deleted by whoever edited the file, and its entry goes. Absence
   * alone proves nothing: a sidecar can gain entries (a cherry-pick) without the file
   * being placed again.
   */
  seen?: ReadonlySet<string>;
  /**
   * Ignore a comment whose id the sidecar does not hold: after a checkout it belongs to
   * another commit's sidecar and must not be written back into this one.
   */
  knownOnly?: boolean;
  /**
   * The file as committed (HEAD). A comment whose function changed since its placement was
   * recorded keeps that placement, and so stays stale, while the function matches the
   * baseline: the change was not made here, by an agent with the comment in view
   * (design.md § Anchoring, "Who saw it"). Without a baseline every comment is re-recorded.
   */
  baseline?: string;
  /** Ids re-recorded whatever the baseline says: `confirm`. */
  confirm?: ReadonlySet<string>;
}

/** Whether `now`'s function changed since `entry` was placed, somewhere other than this working file. */
function unseenChange(entry: SidecarEntry, now: Placement, baselineBodies: ReadonlyMap<string, string> | undefined): boolean {
  const before = placementOf(entry);
  if (!baselineBodies || before?.body === undefined || now.scope === undefined || before.scope !== now.scope) return false;
  return before.body !== now.body && baselineBodies.get(now.scope) === now.body;
}

export interface RecordResult {
  source: string;
  sidecar: Sidecar;
  sourceChanged: boolean;
  sidecarChanged: boolean;
  /** Ids of the comments in `source`. */
  ids: string[];
  /** Ids removed because their comment was deleted from the file. */
  deleted: string[];
}

function sameMeta(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Replaces an entry's placement keys, keeping the order of its other metadata; false when unchanged. */
function setPlacement(entry: SidecarEntry, placement: Placement): boolean {
  const wanted = placementMeta(placement);
  const current = new Map([...entry.meta].filter(([k]) => (PLACEMENT_KEYS as readonly string[]).includes(k)));
  if (sameMeta(current, wanted)) return false;
  for (const k of PLACEMENT_KEYS) entry.meta.delete(k);
  for (const [k, v] of wanted) entry.meta.set(k, v);
  return true;
}

/**
 * Moves a comment's text into its entry, creating the entry for a new comment. `written`
 * when the body changed; a trailing comment's text matches a multi-line body joined with spaces.
 */
function recordBody(entries: SidecarEntry[], id: string, m: Marker, meta: ReadonlyMap<string, string> | undefined): { entry: SidecarEntry | undefined; written: boolean } {
  const entry = entries.find((e) => e.id === id);
  const text = m.text === undefined ? undefined : normalizeBody(m.text);
  const flat = (body: string) => (m.placement === "trailing" ? body.replaceAll("\n", " ") : body);
  if (text === undefined || (entry && flat(entry.body) === text)) return { entry, written: false };
  const target = entry ?? { id, meta: new Map(), body: text };
  if (!entry) entries.push(target);
  target.body = text;
  for (const [k, v] of meta ?? []) target.meta.set(k, v);
  return { entry: target, written: true };
}

/** Removes `STALE_TAG`, which starts at `tagStart`, and one space beside it. */
function staleTagRemoval(source: string, tagStart: number): Splice {
  const tagEnd = tagStart + STALE_TAG.length;
  if (source[tagEnd] === " ") return { start: tagStart, end: tagEnd + 1, text: "" };
  return { start: tagStart - 1, end: tagEnd, text: "" };
}

/**
 * What `sync` does to one file: stamps ids onto new comments, moves bodies into the sidecar, and
 * records where every comment in the file sits. A comment on disk has been seen by whoever
 * edited the file, so its placement is always re-recorded. Entries not on disk are kept,
 * except deletions (see `RecordOptions`).
 */
export async function recordComments(path: string, source: string, sidecar: Sidecar, options: RecordOptions = {}): Promise<RecordResult> {
  const unchanged: RecordResult = { source, sidecar, sourceChanged: false, sidecarChanged: false, ids: [], deleted: [] };
  const spec = languageForPath(path);
  if (!spec) return unchanged;
  if (!source.includes(spec.lineSigil) && !options.seen?.size) return unchanged;

  const recorded = await withLayout(spec, source, (layout) => {
    const markers = markersFrom(spec, source, layout.lines, commentsIn(spec, layout.root));
    const ids = resolveIds(path, markers);
    const { rows: aiRows } = removals(layout, markers);
    const removedBefore: number[] = [];
    let removed = 0;
    for (let r = 0; r < layout.lines.length; r++) {
      removedBefore.push(removed);
      if (aiRows.has(r)) removed++;
    }
    const cleanRow = (row: number) => row - removedBefore[row]!;
    const placements = markers.map((m) => placementFor(layout, m, aiRows, cleanRow));
    // Blocks in the run of comment lines that ends the file, when its last line is
    // unterminated: `stripComments` took the terminator before the run.
    const lastRow = layout.lines.length - 1;
    const lastLine = layout.lines[lastRow];
    if (lastLine && lastLine.end === lastLine.contentEnd && aiRows.has(lastRow)) {
      let runStart = lastRow;
      while (aiRows.has(runStart - 1)) runStart--;
      const before = layout.lines[runStart - 1];
      markers.forEach((m, i) => {
        if (before && m.placement === "own-line" && lineIndexAt(layout.lines, m.start) >= runStart) {
          placements[i]!.eof = layout.source.slice(before.contentEnd, before.end);
        }
      });
    }
    // Own-line blocks that land on one line of the stripped file keep their order.
    const onRow = new Map<number, number>();
    markers.forEach((m, i) => {
      if (m.placement !== "own-line") return;
      const row = cleanRow(lineIndexAt(layout.lines, m.start));
      const n = onRow.get(row) ?? 0;
      placements[i]!.seq = n;
      onRow.set(row, n + 1);
    });
    return { markers, ids, placements };
  });
  const baselineBodies =
    options.baseline === undefined
      ? undefined
      : await withLayout(spec, options.baseline, (layout) => new Map(layout.scopes().filter((s) => layout.isFunction(s)).map((s) => [layout.keyOf(s)!, layout.bodyHashOf(s)])));

  const entries = sidecar.entries.map((e) => ({ ...e, meta: new Map(e.meta) }));
  let sidecarChanged = false;
  const splices: Splice[] = [];
  const present = new Set<string>();
  recorded.markers.forEach((m, i) => {
    const id = recorded.ids[i]!;
    if (options.knownOnly && m.id !== undefined && !entries.some((e) => e.id === m.id)) return;
    present.add(id);
    if (m.id !== id) {
      const idStart = m.start + spec.lineSigil.length;
      splices.push({ start: idStart, end: idStart + (m.id?.length ?? 0), text: id });
    }
    const { entry, written } = recordBody(entries, id, m, options.meta);
    if (written) sidecarChanged = true;
    if (!entry) return;
    const placement = recorded.placements[i]!;
    if (!written && !options.confirm?.has(id) && unseenChange(entry, placement, baselineBodies)) return;
    if (setPlacement(entry, placement)) sidecarChanged = true;
    if (m.staleTag) splices.push(staleTagRemoval(source, m.start + spec.lineSigil.length + id.length + 1));
  });

  const deleted = entries.filter((e) => options.seen?.has(e.id) && !present.has(e.id)).map((e) => e.id);
  return {
    source: applySplices(source, splices),
    sidecar: { preamble: sidecar.preamble, entries: entries.filter((e) => !deleted.includes(e.id)) },
    sourceChanged: splices.length > 0,
    sidecarChanged: sidecarChanged || deleted.length > 0,
    ids: [...present],
    deleted,
  };
}
