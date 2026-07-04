// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tree-sitter helpers shared by the language adapters. Kept generic so each
 * adapter only has to declare its own node-type vocabulary.
 */
import type { Node } from "web-tree-sitter";

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
