// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tree-sitter helpers shared by the language adapters. Kept generic so each
 * adapter only has to declare its own node-type vocabulary.
 */
import type { Node } from "web-tree-sitter";
import type {
  CodeComment,
  ExceptionZoneTrigger,
  GotoLink,
  SecretTrigger,
  SwitchBranchSummary,
} from "./types";

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

/** A comment past this line (1-based) is no longer considered part of the
 * file's "header" — license-y phrasing found further down is assumed to be
 * incidental prose, not an actual header, so it isn't suppressed. */
const LICENSE_HEADER_MAX_LINE = 10;

/** Phrases that mark a comment as license/copyright boilerplate rather than
 * genuine lore — covers this project's own SPDX+Copyright convention plus
 * the common full-paragraph headers (MIT, BSD, GPL family, Apache) found
 * across real-world repos a player might load. */
const LICENSE_MARKERS: RegExp[] = [
  /SPDX-License-Identifier/i,
  /copyright\s*(\(c\)|©|\d{4})/i,
  /all rights reserved/i,
  /permission is hereby granted/i,
  /redistribution and use in source and binary forms/i,
  /gnu (general|lesser|affero) public license/i,
  /this program is free software/i,
  /licensed under the/i,
  /apache license/i,
];

/**
 * True if a comment near the top of the file (within `LICENSE_HEADER_MAX_LINE`)
 * reads as license/copyright boilerplate. Checked ahead of the TODO bypass in
 * `extractLargeComments` so a license header can never become a lore
 * terminal, even if it happens to also contain "TODO" somewhere in its text.
 */
export function isLicenseHeader(text: string, startLine: number): boolean {
  if (startLine > LICENSE_HEADER_MAX_LINE) return false;
  return LICENSE_MARKERS.some((marker) => marker.test(text));
}

/**
 * Comments substantial enough to surface as in-game "lore terminals": either
 * long, or already a multi-line block, so a one-line `// eslint-disable` noise
 * comment doesn't qualify just for having a few extra characters — unless
 * it's TODO/FIXME-flagged, which bypasses this gate entirely. A top-of-file
 * license/copyright header is excluded outright, overriding even the TODO
 * bypass — see `isLicenseHeader`.
 */
export function extractLargeComments(
  root: Node,
  commentNodeTypes: readonly string[],
): CodeComment[] {
  return extractLargeCommentsFromNodes(root.descendantsOfType([...commentNodeTypes]));
}

/**
 * Same as `extractLargeComments`, but against an already-collected list of
 * comment nodes — lets a caller that also needs `findCommentedOutCodeBlocks`
 * share one `descendantsOfType` walk instead of each function repeating it.
 */
export function extractLargeCommentsFromNodes(nodes: readonly Node[]): CodeComment[] {
  const comments: CodeComment[] = [];
  for (const node of nodes) {
    if (!node.isNamed) continue;
    const text = node.text.trim();
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    if (isLicenseHeader(text, startLine)) continue;
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
): SecretTrigger[] {
  const regions: SecretTrigger[] = [];
  for (const block of root.descendantsOfType([...blockNodeTypes])) {
    const stmts = block.namedChildren;
    const returnIndex = stmts.findIndex((s) => returnNodeTypes.has(s.type));
    if (returnIndex === -1 || returnIndex >= stmts.length - 1) continue;
    const first = stmts[returnIndex + 1];
    const last = stmts[stmts.length - 1];
    regions.push({ kind: "deadCode", startLine: first.startPosition.row + 1, endLine: last.endPosition.row + 1 });
  }
  return regions;
}

/**
 * Catch/except/rescue clauses whose body is empty or contains only
 * comments — a swallowed-exception code smell, source for secret rooms. The
 * body is resolved via the grammar's own `body` field where one exists
 * (PHP/JS/TS/Java/C#/C++); Python's `except_clause` has no such field, so
 * this falls back to the first direct child matching `blockNodeTypes`.
 */
export function findEmptyCatchBlocks(
  root: Node,
  catchNodeTypes: readonly string[],
  blockNodeTypes: ReadonlySet<string>,
  commentNodeTypes: ReadonlySet<string>,
): SecretTrigger[] {
  if (catchNodeTypes.length === 0) return [];
  const regions: SecretTrigger[] = [];
  for (const node of root.descendantsOfType([...catchNodeTypes])) {
    if (!node.isNamed) continue;
    const body = node.childForFieldName("body") ?? node.namedChildren.find((c) => blockNodeTypes.has(c.type));
    if (!body) continue;
    const isEmpty = body.namedChildren.every((c) => commentNodeTypes.has(c.type));
    if (!isEmpty) continue;
    regions.push({ kind: "emptyCatch", startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  return regions;
}

/** Markers (checked case-insensitively) that flag an annotation/decorator,
 * comment, or string literal as a deprecation notice — see
 * `findDeprecationMarkers`. */
const DEPRECATION_MARKERS: RegExp[] = [/@deprecated\b/i, /\[obsolete\b/i, /\bdeprecated\b/i];

/** True if `text` reads as a deprecation notice — see `DEPRECATION_MARKERS`. */
export function isDeprecationFlagged(text: string): boolean {
  return DEPRECATION_MARKERS.some((marker) => marker.test(text));
}

/**
 * Deprecation markers found in annotation/decorator/attribute nodes,
 * comments, or string literals (covers JSDoc/PHPDoc `@deprecated`, Java
 * `@Deprecated`, Python decorators and docstrings, C# `[Obsolete]`, and plain
 * `// DEPRECATED:` comments alike) — source for secret rooms.
 */
export function findDeprecationMarkers(root: Node, markerNodeTypes: readonly string[]): SecretTrigger[] {
  if (markerNodeTypes.length === 0) return [];
  const regions: SecretTrigger[] = [];
  for (const node of root.descendantsOfType([...markerNodeTypes])) {
    if (!node.isNamed) continue;
    if (!isDeprecationFlagged(node.text)) continue;
    regions.push({ kind: "deprecated", startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  return regions;
}

/** A merged run of directly-adjacent comment lines spanning more lines than
 * this is treated as "commented-out code" worth a secret room, regardless of
 * content — see `findCommentedOutCodeBlocks`. */
const COMMENTED_CODE_MIN_LINES = 6;

/** Characters that read as actual code syntax rather than prose, inside a
 * comment — see `findCommentedOutCodeBlocks`. */
const CODE_SYNTAX_CHARS = /[{};]/;

/**
 * Commented-out code / oversized comment blocks: contiguous runs of comment
 * nodes (merged when one starts on the very next line after the previous one
 * ends — stacked `//` lines are separate sibling nodes, not one node) that
 * either span more than `COMMENTED_CODE_MIN_LINES` lines, or contain a
 * typical code-syntax character (`{`, `}`, `;`) anywhere in the run's
 * combined text. Source for secret rooms.
 */
export function findCommentedOutCodeBlocks(root: Node, commentNodeTypes: readonly string[]): SecretTrigger[] {
  return findCommentedOutCodeBlocksFromNodes(root.descendantsOfType([...commentNodeTypes]));
}

/**
 * Same as `findCommentedOutCodeBlocks`, but against an already-collected list
 * of comment nodes — lets a caller that also needs `extractLargeComments`
 * share one `descendantsOfType` walk instead of each function repeating it.
 */
export function findCommentedOutCodeBlocksFromNodes(nodes: readonly Node[]): SecretTrigger[] {
  const sorted = nodes
    .filter((n) => n.isNamed)
    .sort((a, b) => a.startPosition.row - b.startPosition.row);

  const regions: SecretTrigger[] = [];
  let runStart = -1;
  let runEnd = -1;
  let runText = "";

  const flushRun = (): void => {
    if (runStart === -1) return;
    const lineSpan = runEnd - runStart + 1;
    if (lineSpan > COMMENTED_CODE_MIN_LINES || CODE_SYNTAX_CHARS.test(runText)) {
      regions.push({ kind: "commentedCode", startLine: runStart, endLine: runEnd });
    }
  };

  for (const node of sorted) {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    if (runStart !== -1 && startLine === runEnd + 1) {
      runEnd = endLine;
      runText += "\n" + node.text;
    } else {
      flushRun();
      runStart = startLine;
      runEnd = endLine;
      runText = node.text;
    }
  }
  flushRun();
  return regions;
}

/** A string literal longer than this many characters, with no whitespace at
 * all, reads as an encoded blob (Base64, a hash, ...) rather than prose —
 * see `findMagicNumberBlobs`. */
const MAGIC_BLOB_MIN_LENGTH = 100;

/** Well-known "magic" hex constants (checked case-insensitively, substring
 * match so e.g. a `0xDEADBEEFu` suffix still matches) — see
 * `findMagicNumberBlobs`. */
const HEX_MAGIC_PATTERNS: RegExp[] = [
  /0x1337/i,
  /0xdeadbeef/i,
  /0xcafebabe/i,
  /0xc0ffee/i,
  /0xbaadf00d/i,
  /0xdeadc0de/i,
  /0x8badf00d/i,
  /0xfeedface/i,
];

function isMagicBlobString(text: string): boolean {
  return text.length > MAGIC_BLOB_MIN_LENGTH && !/\s/.test(text);
}

function isHexMagicNumber(text: string): boolean {
  return HEX_MAGIC_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Magic numbers and blobs: very long, space-free string literals (indicating
 * Base64/hashes/similar encoded data) and well-known hex magic-number
 * literals (`0xDEADBEEF`, `0xCAFEBABE`, `0x1337`, and a handful of other
 * famous ones). Source for secret rooms.
 */
export function findMagicNumberBlobs(
  root: Node,
  stringNodeTypes: readonly string[],
  numberNodeTypes: readonly string[],
): SecretTrigger[] {
  const stringTypes = new Set(stringNodeTypes);
  const regions: SecretTrigger[] = [];
  for (const node of root.descendantsOfType([...stringNodeTypes, ...numberNodeTypes])) {
    if (!node.isNamed) continue;
    const isBlob = stringTypes.has(node.type) ? isMagicBlobString(node.text) : isHexMagicNumber(node.text);
    if (!isBlob) continue;
    regions.push({ kind: "magicBlob", startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
  }
  return regions;
}

/** How a catch-all branch is spelled when it isn't its own node type: a leading
 * `default` keyword (C/C++/ObjC/Java/C#), a `_` wildcard pattern (Rust, Scala,
 * Python, C#'s `discard`), or Bash's `*)` glob. Checked against the branch's own
 * text, trimmed — see `summarizeSwitchBranches`. */
const DEFAULT_BRANCH_TEXT = /^default\b/;
const WILDCARD_PATTERN_TEXT = /^[_*]$/;
/** Node types whose presence as a *sibling* of the case branches marks the
 * catch-all: Ruby writes `case … when … else … end`, putting the fallback in an
 * `else` node hanging off the `case` container rather than in a branch of its
 * own. */
const ELSE_BRANCH_NODE_TYPES = new Set(["else", "else_clause"]);

/**
 * Aggregate every `switch`/`match`/`case` branch under `root` into one summary,
 * or `undefined` when there are none.
 *
 * Deliberately counts *branches only* and never scans for switch containers.
 * That's not a shortcut — it's what makes one shared, cross-language node-type
 * table possible at all: Bash's `case_statement` is the switch *container*,
 * while C/C++/ObjC/PHP's `case_statement` is a single *branch*, so a table
 * listing containers would double-count in one grammar or miss the other. A
 * switch with no branches at all (`switch (x) {}`) correctly yields `undefined`
 * — there'd be nothing for `placeSwitchboards` to build spokes from anyway.
 *
 * `excludeAncestorNodeTypes` drops branches nested inside an unrelated
 * construct that happens to reuse the same branch node type — Scala spells
 * `catch { case e: Exception => … }` with real `case_clause` nodes, which would
 * otherwise turn every Scala try/catch into a Switchboard.
 */
export function summarizeSwitchBranches(
  root: Node,
  caseBranchNodeTypes: readonly string[],
  defaultBranchNodeTypes: ReadonlySet<string>,
  excludeAncestorNodeTypes: ReadonlySet<string>,
): SwitchBranchSummary | undefined {
  let caseCount = 0;
  let hasDefault = false;
  let sawBranch = false;

  const branchTypes = new Set(caseBranchNodeTypes);
  for (const branch of root.descendantsOfType([...caseBranchNodeTypes])) {
    if (!branch.isNamed) continue;
    if (hasAncestorOfType(branch, root, excludeAncestorNodeTypes)) continue;
    // Bash's `case_statement` is the switch *container* whose direct children
    // are the `case_item` branches, while C++/ObjC's `case_statement` is a
    // branch — one shared table has to carry both, so a match holding another
    // matched branch as a direct child is the container and is skipped. Only
    // *direct* children count: a whole switch nested inside a branch body sits
    // further down (under the inner switch's own body node) and must not
    // disqualify the branch containing it.
    if (branch.namedChildren.some((child) => child !== null && branchTypes.has(child.type))) continue;
    sawBranch = true;
    if (isDefaultBranch(branch, defaultBranchNodeTypes)) hasDefault = true;
    else caseCount += 1;
  }

  if (!sawBranch) return undefined;
  // Ruby's `else` fallback isn't a branch node, so it can't be found by the
  // walk above — look for it as a sibling only once we know a switch exists.
  if (!hasDefault) {
    hasDefault = root
      .descendantsOfType([...ELSE_BRANCH_NODE_TYPES])
      .some((node) => node.isNamed && !isIfElse(node));
  }
  return { caseCount, hasDefault };
}

/** True if `node` is the `else` of an `if`, not of a `case`/`switch` — the same
 * node type serves both in several grammars. */
function isIfElse(node: Node): boolean {
  const parentType = node.parent?.type ?? "";
  return parentType.includes("if") || parentType.includes("conditional");
}

/** True if any ancestor strictly between `node` and `stopAt` (exclusive on both
 * ends) has one of `types`. */
function hasAncestorOfType(node: Node, stopAt: Node, types: ReadonlySet<string>): boolean {
  if (types.size === 0) return false;
  for (let cur = node.parent; cur !== null && cur.id !== stopAt.id; cur = cur.parent) {
    if (types.has(cur.type)) return true;
  }
  return false;
}

/** Whether one case branch is the catch-all: by node type (JS `switch_default`,
 * Go `default_case`, PHP `default_statement`), by a leading `default` keyword,
 * or by a bare `_`/`*` wildcard pattern. */
function isDefaultBranch(branch: Node, defaultBranchNodeTypes: ReadonlySet<string>): boolean {
  if (defaultBranchNodeTypes.has(branch.type)) return true;
  if (DEFAULT_BRANCH_TEXT.test(branch.text.trimStart())) return true;
  // `pattern` before `value`: Rust's `match_arm` uses `value` for the arm's
  // *body*, so checking `value` first would test `0` in `_ => 0` instead of the
  // `_` that actually makes it the catch-all. `value` still comes ahead of the
  // positional fallback for the grammars (C, PHP) that label the matched
  // constant that way.
  const pattern = branch.childForFieldName("pattern") ?? branch.childForFieldName("value") ?? branch.namedChildren[0];
  return pattern !== null && pattern !== undefined && WILDCARD_PATTERN_TEXT.test(pattern.text.trim());
}

/**
 * Every `try`/`catch`/`finally` construct under `root` (also `begin`/`rescue`/
 * `ensure` and `try`/`except`/`finally`), source for Exception Handling Zones.
 *
 * A construct with neither a catch nor a finally clause is skipped: a bare
 * `try` block is grammatically impossible in most languages, and the 3-part
 * zone it would map to has no second or third part to build.
 */
export function findExceptionZones(
  root: Node,
  tryNodeTypes: readonly string[],
  catchNodeTypes: ReadonlySet<string>,
  finallyNodeTypes: ReadonlySet<string>,
): ExceptionZoneTrigger[] {
  const zones: ExceptionZoneTrigger[] = [];
  for (const node of root.descendantsOfType([...tryNodeTypes])) {
    if (!node.isNamed) continue;
    let catchCount = 0;
    let hasFinally = false;
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (catchNodeTypes.has(child.type)) catchCount += 1;
      else if (finallyNodeTypes.has(child.type)) hasFinally = true;
    }
    if (catchCount === 0 && !hasFinally) continue;
    zones.push({
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      catchCount,
      hasFinally,
    });
  }
  return zones;
}

/**
 * Number of top-level `import`/`#include`/`require`/`use` declarations under
 * `root`. Source for the "Vendor Depot" supply alcoves.
 *
 * "Top-level" is defined as *not inside any function/class body block* rather
 * than by nesting depth: a lazily-`require`d module inside a function isn't a
 * file-level dependency, while Go nests a grouped `import ( … )` three levels
 * down (`import_declaration > import_spec_list > import_spec`) and PHP wraps
 * `require` in an `expression_statement`, so any depth cap loose enough for
 * those would also let a C `#include` inside a function body through.
 * `bodyNodeTypes` is the same flat-statement-list set `findDeadCodeAfterReturn`
 * already takes.
 *
 * Only *leaf-most* matches count — a matched node containing another matched
 * node is skipped. That's what makes Go's two import spellings agree: a single
 * `import "fmt"` nests one `import_spec` inside its `import_declaration` and
 * counts once, while a grouped `import ( "os" \n "io" )` counts each spec, so
 * ten grouped imports read as ten rather than as one.
 *
 * `callShapedImportNodeTypes` + `callImportPattern` cover the grammars with no
 * import node at all: Ruby's `require`/`require_relative` and Bash's
 * `source`/`.` are ordinary calls/commands, matched on their text instead.
 */
export function countTopLevelImports(
  root: Node,
  importNodeTypes: readonly string[],
  callShapedImportNodeTypes: readonly string[],
  callImportPattern: RegExp,
  bodyNodeTypes: ReadonlySet<string>,
): number {
  const matchedTypes = new Set(importNodeTypes);
  let count = 0;
  for (const node of root.descendantsOfType([...importNodeTypes])) {
    if (!node.isNamed || hasAncestorOfType(node, root, bodyNodeTypes)) continue;
    const nested = node
      .descendantsOfType([...importNodeTypes])
      .some((inner) => inner.isNamed && inner.id !== node.id && matchedTypes.has(inner.type));
    if (!nested) count += 1;
  }

  for (const node of root.descendantsOfType([...callShapedImportNodeTypes])) {
    if (!node.isNamed || hasAncestorOfType(node, root, bodyNodeTypes)) continue;
    if (callImportPattern.test(node.text.trimStart())) count += 1;
  }
  return count;
}

/**
 * Number of explicit allocation expressions under `root` — source for the
 * "Acid Overflow" room event. Three shapes are counted, all as +1 each:
 *
 * - an allocation *node type* (`new_expression`, `object_creation_expression`,
 *   `stackalloc_expression`, …);
 * - a call whose *callee name* matches `allocatorNamePattern` — this is what
 *   reaches C's `malloc(64)`, Go's `make(...)`/`new(...)`, Rust's `Box::new`,
 *   Ruby's `Array.new`, and ObjC's `[[NSObject alloc] init]`;
 * - a fixed-size array declarator whose literal size reaches
 *   `largeArrayMinSize` — the "large static arrays" half. A small `char[8]` is
 *   deliberately not an allocation.
 *
 * Returns a raw count. The density threshold that turns a function into an
 * acid room lives in the map layer — see `CodeEntity.allocations`.
 */
export function countAllocations(
  root: Node,
  allocationNodeTypes: readonly string[],
  callNodeTypes: readonly string[],
  allocatorNamePattern: RegExp,
  arrayDeclaratorNodeTypes: readonly string[],
  largeArrayMinSize: number,
): number {
  let count = root.descendantsOfType([...allocationNodeTypes]).filter((n) => n.isNamed).length;

  for (const call of root.descendantsOfType([...callNodeTypes])) {
    if (!call.isNamed) continue;
    const callee = calleeName(call);
    if (callee !== null && allocatorNamePattern.test(callee)) count += 1;
  }

  for (const declarator of root.descendantsOfType([...arrayDeclaratorNodeTypes])) {
    if (!declarator.isNamed) continue;
    const size = declarator.childForFieldName("size") ?? declarator.namedChildren.find((c) => c?.type.endsWith("number_literal"));
    const parsed = size ? Number.parseInt(size.text, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= largeArrayMinSize) count += 1;
  }

  return count;
}

/** The name of whatever a call-shaped node is calling: the `function`/`name`
 * field where the grammar has one, else the last identifier-ish direct child —
 * which is exactly the selector of an ObjC `message_expression` (`[obj alloc]`)
 * and the macro name of a Rust `macro_invocation` (`vec![…]`). */
function calleeName(call: Node): string | null {
  const viaField = call.childForFieldName("function") ?? call.childForFieldName("name") ?? call.childForFieldName("macro");
  if (viaField) return viaField.text;
  let last: string | null = null;
  for (const child of call.namedChildren) {
    if (child && /(^|_)(identifier|name)$/.test(child.type)) last = child.text;
  }
  return last;
}
