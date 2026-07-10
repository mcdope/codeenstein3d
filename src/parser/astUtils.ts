// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tree-sitter helpers shared by the language adapters. Kept generic so each
 * adapter only has to declare its own node-type vocabulary.
 */
import type { Node } from "web-tree-sitter";
import type { CodeComment, GotoLink, SecretTrigger } from "./types";

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
