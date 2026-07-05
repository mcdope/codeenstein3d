// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tree-sitter helpers shared by the language adapters. Kept generic so each
 * adapter only has to declare its own node-type vocabulary.
 */
import type { Node } from "web-tree-sitter";
import type { GotoLink } from "./types";

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
 */
export function countDecisionPoints(
  root: Node,
  decisionNodeTypes: readonly string[],
  logicalOperators: ReadonlySet<string>,
): number {
  let count = root.descendantsOfType([...decisionNodeTypes]).length;
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
