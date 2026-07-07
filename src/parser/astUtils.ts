// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tree-sitter helpers shared by the language adapters. Kept generic so each
 * adapter only has to declare its own node-type vocabulary.
 */
import type { Node } from "web-tree-sitter";
import type { CodeComment, DeadCodeRegion, GotoLink } from "./types";

/** Total line count; a single trailing newline is not counted as a new line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Number of decision points within `root`'s subtree: one for each occurrence of
 * the given control-flow node types, plus one for each short-circuiting logical
 * operator (&&, ||, …) in a binary expression. A cyclomatic complexity score is
 * `1 + countDecisionPoints(...)`.
 *
 * Only *named* matches count — `descendantsOfType` also matches anonymous
 * keyword tokens (e.g. the literal `if` keyword node inside an `if_statement`
 * is itself typed `"if"`), which would otherwise silently double-count in any
 * grammar whose keyword token happens to share a name with a real named node
 * type from a different grammar in a shared, cross-language type list (see
 * [[codeenstein-project]]'s generic parser).
 */
export function countDecisionPoints(
  root: Node,
  decisionNodeTypes: readonly string[],
  logicalOperators: ReadonlySet<string>,
): number {
  let count = root.descendantsOfType([...decisionNodeTypes]).filter((n) => n.isNamed).length;
  for (const binary of root.descendantsOfType("binary_expression")) {
    const operator = binary.childForFieldName("operator")?.text;
    if (operator && logicalOperators.has(operator)) count += 1;
  }
  return count;
}

/**
 * Deepest chain of nested control-flow blocks under `root` — the longest
 * root-to-leaf path counting only `nestingNodeTypes`. A flat body returns 0;
 * `for { if { while {} } }` returns 3.
 *
 * `else if` (an `if_statement` sitting directly inside an `else_clause`, as C
 * nests it) is treated as the same level, so a flat else-if ladder doesn't
 * inflate the depth.
 */
export function maxNestingDepth(
  root: Node,
  nestingNodeTypes: ReadonlySet<string>,
): number {
  let inc = nestingNodeTypes.has(root.type) ? 1 : 0;
  if (inc && root.type === "if_statement" && root.parent?.type === "else_clause") {
    inc = 0;
  }
  let childMax = 0;
  for (const child of root.namedChildren) {
    const d = maxNestingDepth(child, nestingNodeTypes);
    if (d > childMax) childMax = d;
  }
  return inc + childMax;
}

/**
 * Number of parameters in `entityNode`'s own parameter list — a heuristic,
 * not a precise count: it takes the *first* descendant matching
 * `paramListNodeTypes` (parameter lists always appear before a function's
 * body in every grammar's node order, so this reliably finds the entity's
 * own list rather than a nested closure's), then counts its named children.
 * Returns 0 if no parameter list is found at all (e.g. entity kinds that
 * don't have one, or a grammar quirk).
 */
export function countParameters(entityNode: Node, paramListNodeTypes: readonly string[]): number {
  const list = entityNode.descendantsOfType([...paramListNodeTypes])[0];
  return list ? list.namedChildren.length : 0;
}

/** A function/method needs more than this many parameters, or more than this
 * much nesting depth, to count as a "code smell" (see `codeSmellBonus`). */
const MAX_PARAMS_BEFORE_SMELL = 5;
const MAX_NESTING_BEFORE_SMELL = 3;
/** Bonus complexity points added per parameter/nesting-level *over* the
 * threshold above — scales with how bad the smell is, rather than a flat
 * penalty for barely crossing the line. */
const PARAM_SMELL_BONUS_PER_EXCESS = 2;
const NESTING_SMELL_BONUS_PER_EXCESS = 3;

/**
 * Extra complexity points for two heuristic "code smells": too many
 * parameters (>5) and too much nesting (>3, reusing the same `nestingDepth`
 * already computed by `maxNestingDepth`). Added on top of the normal
 * decision-point complexity score — a smelly function ends up with more HP
 * (or an outright Elite spawn at extreme complexity), same as genuinely
 * complex control flow does. Returns 0 for a function with neither smell.
 */
export function codeSmellBonus(paramCount: number, nestingDepth: number): number {
  let bonus = 0;
  if (paramCount > MAX_PARAMS_BEFORE_SMELL) {
    bonus += (paramCount - MAX_PARAMS_BEFORE_SMELL) * PARAM_SMELL_BONUS_PER_EXCESS;
  }
  if (nestingDepth > MAX_NESTING_BEFORE_SMELL) {
    bonus += (nestingDepth - MAX_NESTING_BEFORE_SMELL) * NESTING_SMELL_BONUS_PER_EXCESS;
  }
  return bonus;
}

/** A raw `goto` statement or label found while walking a syntax tree, before
 * the two are paired up by name. */
export interface RawGotoRef {
  label: string;
  line: number;
}

/**
 * Pair `goto` statements with the label they jump to, by name. A `goto` whose
 * label isn't found anywhere in the file is silently dropped rather than
 * guessed at. When several labels share a name (illegal, but parsers are
 * forgiving of malformed input), the first occurrence wins.
 */
export function resolveGotos(gotos: RawGotoRef[], labels: RawGotoRef[]): GotoLink[] {
  const labelLines = new Map<string, number>();
  for (const l of labels) {
    if (!labelLines.has(l.label)) labelLines.set(l.label, l.line);
  }
  const links: GotoLink[] = [];
  for (const g of gotos) {
    const labelLine = labelLines.get(g.label);
    if (labelLine === undefined) continue;
    links.push({ label: g.label, gotoLine: g.line, labelLine });
  }
  return links;
}

/** A comment counts as "large" — worth a lore terminal — once its raw text
 * reaches this length, or it already spans more than one source line. */
const LORE_COMMENT_MIN_LENGTH = 60;

/** Substrings (checked verbatim/case-sensitive, matching how developers
 * actually write them) that flag a comment as unresolved technical debt —
 * see `isTodoFlagged`. */
const TODO_MARKERS = ["TODO", "FIXME"];

/**
 * True if a comment's raw text contains a TODO/FIXME marker. Shared by
 * `extractLargeComments` (bypasses the length gate below, since even the
 * shortest one-line `// TODO: fix this` is exactly the kind of technical debt
 * this feature wants to surface) and `MapGenerator`'s TODO/FIXME encounter
 * mechanic (spawns a trap or a weak enemy next to the resulting terminal),
 * so both definitions of "flagged" stay in lockstep off one source.
 */
export function isTodoFlagged(text: string): boolean {
  return TODO_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Comments substantial enough to surface as in-game "lore terminals": either
 * long, or already a multi-line block, so a one-line `// eslint-disable` noise
 * comment doesn't qualify just for having a few extra characters — unless
 * it's TODO/FIXME-flagged, which bypasses this gate entirely.
 */
export function extractLargeComments(
  root: Node,
  commentNodeTypes: readonly string[],
): CodeComment[] {
  const comments: CodeComment[] = [];
  for (const node of root.descendantsOfType([...commentNodeTypes])) {
    if (!node.isNamed) continue;
    const text = node.text.trim();
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    if (!isTodoFlagged(text) && text.length < LORE_COMMENT_MIN_LENGTH && endLine === startLine) continue;
    comments.push({ text, startLine, endLine });
  }
  return comments;
}

/**
 * Unreachable-code spans: statements found after an unconditional `return` in
 * the same block. Only the block's own direct statement list is checked (a
 * `return` buried inside a nested `if` doesn't make the rest of the *outer*
 * block dead — only code following it at the very same nesting level is
 * genuinely unreachable). A block ending with its `return` (the normal case)
 * yields nothing.
 */
export function findDeadCodeAfterReturn(
  root: Node,
  blockNodeTypes: ReadonlySet<string>,
  returnNodeTypes: ReadonlySet<string>,
): DeadCodeRegion[] {
  const regions: DeadCodeRegion[] = [];
  for (const block of root.descendantsOfType([...blockNodeTypes])) {
    const stmts = block.namedChildren;
    const returnIndex = stmts.findIndex((s) => returnNodeTypes.has(s.type));
    if (returnIndex === -1 || returnIndex >= stmts.length - 1) continue;
    const first = stmts[returnIndex + 1];
    const last = stmts[stmts.length - 1];
    regions.push({ startLine: first.startPosition.row + 1, endLine: last.endPosition.row + 1 });
  }
  return regions;
}
