// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * astUtils.ts only imports the tree-sitter `Node` TYPE (erased at compile
 * time), but its functions operate on real `Node`-shaped trees — rather than
 * hand-build a mock node graph (easy to get subtly wrong), these tests parse
 * real tiny C/JS snippets with the actual grammars (already proven working
 * under Vitest via the Phase 0 `?url`-as-path plugin) and exercise astUtils
 * against genuine syntax trees. C covers most decision-point/nesting/param
 * cases; JS covers `try`/`catch` (C has no exceptions at all).
 */
import { Language, Parser, type Node } from "web-tree-sitter";
import cWasmUrl from "tree-sitter-c/tree-sitter-c.wasm?url";
import jsWasmUrl from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  codeSmellBonus,
  countAllocations,
  countDecisionPoints,
  countLines,
  countParameters,
  countTopLevelImports,
  findExceptionZones,
  summarizeSwitchBranches,
  extractLargeComments,
  extractLargeCommentsFromNodes,
  findCommentedOutCodeBlocks,
  findCommentedOutCodeBlocksFromNodes,
  findDeadCodeAfterReturn,
  findDeprecationMarkers,
  findEmptyCatchBlocks,
  findMagicNumberBlobs,
  isDeprecationFlagged,
  isLicenseHeader,
  isTodoFlagged,
  maxNestingDepth,
  resolveGotos,
  type RawGotoRef,
} from "./astUtils";
import { initTreeSitter } from "./runtime";

let cLanguage: Language;
let jsLanguage: Language;

beforeAll(async () => {
  await initTreeSitter();
  cLanguage = await Language.load(cWasmUrl);
  jsLanguage = await Language.load(jsWasmUrl);
});

function parseC(source: string): Node {
  const parser = new Parser();
  parser.setLanguage(cLanguage);
  const tree = parser.parse(source);
  if (!tree) throw new Error("C parse failed");
  return tree.rootNode;
}

function parseJs(source: string): Node {
  const parser = new Parser();
  parser.setLanguage(jsLanguage);
  const tree = parser.parse(source);
  if (!tree) throw new Error("JS parse failed");
  return tree.rootNode;
}

const C_DECISION_NODE_TYPES = [
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "case_statement",
  "conditional_expression",
];
const C_LOGICAL_OPERATORS = new Set(["&&", "||"]);
const C_NESTING_NODE_TYPES = new Set(["if_statement", "for_statement", "while_statement", "do_statement", "switch_statement"]);
const C_PARAM_LIST_NODE_TYPES = ["parameter_list"];
const C_COMMENT_NODE_TYPES = ["comment"];
const C_BLOCK_NODE_TYPES = new Set(["compound_statement"]);
const C_RETURN_NODE_TYPES = new Set(["return_statement"]);
const C_STRING_NODE_TYPES = ["string_literal"];
const C_NUMBER_NODE_TYPES = ["number_literal"];

const JS_CATCH_NODE_TYPES = ["catch_clause"];
const JS_BLOCK_NODE_TYPES = new Set(["statement_block"]);
const JS_COMMENT_NODE_TYPES = new Set(["comment"]);

// C spells `default:` as another `case_statement`, so it exercises the
// leading-keyword rule; JS gives the catch-all its own `switch_default` node
// type, so it exercises the by-node-type rule. The `_`/`*` wildcard rule and
// Ruby's sibling-`else` rule need grammars that aren't loaded here — those are
// covered per-language in `generic/languages.test.ts`.
const C_CASE_BRANCH_NODE_TYPES = ["case_statement"];
const C_DEFAULT_BRANCH_NODE_TYPES = new Set<string>();
const JS_CASE_BRANCH_NODE_TYPES = ["switch_case", "switch_default"];
const JS_DEFAULT_BRANCH_NODE_TYPES = new Set(["switch_default"]);
const NO_EXCLUDED_ANCESTORS = new Set<string>();

const JS_TRY_NODE_TYPES = ["try_statement"];
const JS_CATCH_NODE_TYPE_SET = new Set(["catch_clause"]);
const JS_FINALLY_NODE_TYPES = new Set(["finally_clause"]);

const C_IMPORT_NODE_TYPES = ["preproc_include"];
const JS_IMPORT_NODE_TYPES = ["import_statement"];
const NO_CALL_SHAPED_IMPORTS: string[] = [];
const NEVER_MATCHES = /^$/;
const JS_BLOCK_NODE_TYPE_SET = new Set(["statement_block"]);

const C_ALLOCATION_NODE_TYPES: string[] = [];
const C_CALL_NODE_TYPES = ["call_expression"];
const C_ALLOCATOR_NAME_PATTERN = /^((m|c|re)?alloc)$/;
const C_ARRAY_DECLARATOR_NODE_TYPES = ["array_declarator"];
const JS_ALLOCATION_NODE_TYPES = ["new_expression"];

describe("countLines", () => {
  it("returns 0 for an empty string", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts lines without a trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  it("doesn't count a single trailing newline as an extra line", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  it("counts a single line with no newline at all as 1", () => {
    expect(countLines("just one line")).toBe(1);
  });
});

describe("countDecisionPoints", () => {
  it("counts if/for/while/do/case/ternary once each", () => {
    const root = parseC(`
      int f(int x) {
        if (x) {}
        for (;;) {}
        while (x) {}
        do {} while (x);
        switch (x) { case 1: break; }
        int y = x ? 1 : 2;
        return 0;
      }
    `);
    expect(countDecisionPoints(root, C_DECISION_NODE_TYPES, C_LOGICAL_OPERATORS)).toBe(6);
  });

  it("adds one per short-circuiting logical operator", () => {
    const root = parseC(`int f(int a, int b, int c) { return a && b || c; }`);
    expect(countDecisionPoints(root, C_DECISION_NODE_TYPES, C_LOGICAL_OPERATORS)).toBe(2);
  });

  it("ignores a binary operator that isn't in the logical-operator set", () => {
    const root = parseC(`int f(int a, int b) { return a + b; }`);
    expect(countDecisionPoints(root, C_DECISION_NODE_TYPES, C_LOGICAL_OPERATORS)).toBe(0);
  });

  it("returns 0 for a flat function with no decision points", () => {
    const root = parseC(`int f() { return 1; }`);
    expect(countDecisionPoints(root, C_DECISION_NODE_TYPES, C_LOGICAL_OPERATORS)).toBe(0);
  });
});

describe("maxNestingDepth", () => {
  it("returns 0 for a flat body", () => {
    const root = parseC(`int f() { return 1; }`);
    expect(maxNestingDepth(root, C_NESTING_NODE_TYPES)).toBe(0);
  });

  it("counts the deepest nested chain", () => {
    const root = parseC(`int f(int x) { for (;;) { if (x) { while (x) {} } } }`);
    expect(maxNestingDepth(root, C_NESTING_NODE_TYPES)).toBe(3);
  });

  it("treats an else-if ladder as the same nesting level, not deeper", () => {
    const root = parseC(`
      int f(int x) {
        if (x == 1) {}
        else if (x == 2) {}
        else if (x == 3) {}
        else {}
      }
    `);
    expect(maxNestingDepth(root, C_NESTING_NODE_TYPES)).toBe(1);
  });

  it("takes the max across sibling branches, not the sum", () => {
    const root = parseC(`
      int f(int x) {
        if (x) { for (;;) {} }
        if (x) { while (x) { if (x) {} } }
      }
    `);
    expect(maxNestingDepth(root, C_NESTING_NODE_TYPES)).toBe(3);
  });
});

describe("countParameters", () => {
  it("counts a function's own parameters", () => {
    const root = parseC(`int f(int a, int b, int c) { return 0; }`);
    const fn = root.descendantsOfType("function_definition")[0];
    expect(countParameters(fn, C_PARAM_LIST_NODE_TYPES)).toBe(3);
  });

  it("returns 0 for a function with no parameters", () => {
    const root = parseC(`int f() { return 0; }`);
    const fn = root.descendantsOfType("function_definition")[0];
    expect(countParameters(fn, C_PARAM_LIST_NODE_TYPES)).toBe(0);
  });

  it("returns 0 when no parameter list is found at all", () => {
    const root = parseC(`int x;`);
    expect(countParameters(root, C_PARAM_LIST_NODE_TYPES)).toBe(0);
  });
});

describe("codeSmellBonus", () => {
  it("returns 0 when neither threshold is exceeded", () => {
    expect(codeSmellBonus(3, 2)).toBe(0);
  });

  it("adds a per-excess-parameter bonus", () => {
    expect(codeSmellBonus(7, 0)).toBe((7 - 5) * 2);
  });

  it("adds a per-excess-nesting bonus", () => {
    expect(codeSmellBonus(0, 5)).toBe((5 - 3) * 3);
  });

  it("adds both bonuses when both thresholds are exceeded", () => {
    expect(codeSmellBonus(7, 5)).toBe((7 - 5) * 2 + (5 - 3) * 3);
  });

  it("treats exactly-at-threshold as not smelly", () => {
    expect(codeSmellBonus(5, 3)).toBe(0);
  });
});

describe("resolveGotos", () => {
  it("pairs a goto with its matching label", () => {
    const gotos: RawGotoRef[] = [{ label: "done", line: 5 }];
    const labels: RawGotoRef[] = [{ label: "done", line: 10 }];
    expect(resolveGotos(gotos, labels)).toEqual([{ label: "done", gotoLine: 5, labelLine: 10 }]);
  });

  it("drops a goto with no matching label", () => {
    expect(resolveGotos([{ label: "missing", line: 1 }], [])).toEqual([]);
  });

  it("uses the first label when duplicate label names exist", () => {
    const labels: RawGotoRef[] = [
      { label: "dup", line: 5 },
      { label: "dup", line: 20 },
    ];
    expect(resolveGotos([{ label: "dup", line: 1 }], labels)).toEqual([{ label: "dup", gotoLine: 1, labelLine: 5 }]);
  });
});

describe("isTodoFlagged", () => {
  it("matches TODO and FIXME", () => {
    expect(isTodoFlagged("// TODO: fix this")).toBe(true);
    expect(isTodoFlagged("// FIXME later")).toBe(true);
  });

  it("returns false for ordinary prose", () => {
    expect(isTodoFlagged("// just a normal comment")).toBe(false);
  });
});

describe("isLicenseHeader", () => {
  it("matches an SPDX header near the top of the file", () => {
    expect(isLicenseHeader("SPDX-License-Identifier: AGPL-3.0-or-later", 1)).toBe(true);
  });

  it("matches a copyright notice", () => {
    expect(isLicenseHeader("Copyright (c) 2026 Someone", 2)).toBe(true);
  });

  it("returns false past the header line cutoff even for license-shaped text", () => {
    expect(isLicenseHeader("SPDX-License-Identifier: MIT", 50)).toBe(false);
  });

  it("returns false for ordinary prose near the top", () => {
    expect(isLicenseHeader("just a normal top-of-file comment", 1)).toBe(false);
  });
});

describe("isDeprecationFlagged", () => {
  it("matches @deprecated, [Obsolete], and the word deprecated", () => {
    expect(isDeprecationFlagged("@deprecated use newFn instead")).toBe(true);
    expect(isDeprecationFlagged("[Obsolete(\"use X\")]")).toBe(true);
    expect(isDeprecationFlagged("this is Deprecated")).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isDeprecationFlagged("perfectly normal comment")).toBe(false);
  });
});

describe("extractLargeComments / extractLargeCommentsFromNodes", () => {
  it("includes a comment at or over the length threshold", () => {
    const long = "x".repeat(70);
    const root = parseC(`// ${long}\nint f() { return 0; }`);
    const comments = extractLargeComments(root, C_COMMENT_NODE_TYPES);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain(long);
  });

  it("excludes a short single-line comment", () => {
    const root = parseC(`// short\nint f() { return 0; }`);
    expect(extractLargeComments(root, C_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("includes a short comment anyway when TODO-flagged", () => {
    const root = parseC(`// TODO: short\nint f() { return 0; }`);
    expect(extractLargeComments(root, C_COMMENT_NODE_TYPES)).toHaveLength(1);
  });

  it("includes a multi-line comment even if short", () => {
    const root = parseC(`/* a\nb */\nint f() { return 0; }`);
    expect(extractLargeComments(root, C_COMMENT_NODE_TYPES)).toHaveLength(1);
  });

  it("excludes a top-of-file license header even when TODO-flagged", () => {
    const root = parseC(`// SPDX-License-Identifier: AGPL-3.0-or-later TODO\nint f() { return 0; }`);
    expect(extractLargeComments(root, C_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("FromNodes variant matches the direct variant given the same nodes", () => {
    const root = parseC(`// TODO: short\nint f() { return 0; }`);
    const nodes = root.descendantsOfType(C_COMMENT_NODE_TYPES);
    expect(extractLargeCommentsFromNodes(nodes)).toEqual(extractLargeComments(root, C_COMMENT_NODE_TYPES));
  });

  it("skips an anonymous node matching a comment type by coincidence", () => {
    const fakeNode = { isNamed: false, type: "comment" } as unknown as Node;
    expect(extractLargeCommentsFromNodes([fakeNode])).toEqual([]);
  });
});

describe("findDeadCodeAfterReturn", () => {
  it("flags statements after an unconditional return in the same block", () => {
    const root = parseC(`int f() { return 1; int x = 2; int y = 3; }`);
    const regions = findDeadCodeAfterReturn(root, C_BLOCK_NODE_TYPES, C_RETURN_NODE_TYPES);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("deadCode");
  });

  it("returns nothing when the return is the block's last statement", () => {
    const root = parseC(`int f() { int x = 1; return x; }`);
    expect(findDeadCodeAfterReturn(root, C_BLOCK_NODE_TYPES, C_RETURN_NODE_TYPES)).toEqual([]);
  });

  it("returns nothing when there's no return at all", () => {
    const root = parseC(`void f() { int x = 1; }`);
    expect(findDeadCodeAfterReturn(root, C_BLOCK_NODE_TYPES, C_RETURN_NODE_TYPES)).toEqual([]);
  });

  it("doesn't flag code after a return nested inside an if (different nesting level)", () => {
    const root = parseC(`int f(int x) { if (x) { return 1; } int y = 2; return y; }`);
    expect(findDeadCodeAfterReturn(root, C_BLOCK_NODE_TYPES, C_RETURN_NODE_TYPES)).toEqual([]);
  });
});

describe("findEmptyCatchBlocks", () => {
  it("returns [] immediately when no catch node types are given", () => {
    const root = parseJs(`try {} catch (e) { console.log(e); }`);
    expect(findEmptyCatchBlocks(root, [], JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("flags a genuinely empty catch block", () => {
    const root = parseJs(`try { f(); } catch (e) {}`);
    const regions = findEmptyCatchBlocks(root, JS_CATCH_NODE_TYPES, JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("emptyCatch");
  });

  it("flags a catch block containing only comments", () => {
    const root = parseJs(`try { f(); } catch (e) { // swallowed\n }`);
    expect(findEmptyCatchBlocks(root, JS_CATCH_NODE_TYPES, JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES)).toHaveLength(1);
  });

  it("does not flag a catch block that actually handles the error", () => {
    const root = parseJs(`try { f(); } catch (e) { console.log(e); }`);
    expect(findEmptyCatchBlocks(root, JS_CATCH_NODE_TYPES, JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("skips an anonymous node matching the catch type by coincidence", () => {
    // descendantsOfType() matches by raw `.type` string regardless of
    // named/anonymous status (see countDecisionPoints's own doc comment) —
    // no bundled grammar's "catch_clause" is ever actually anonymous, but
    // the guard exists for it, so exercise it directly with a synthetic node.
    const fakeRoot = { descendantsOfType: () => [{ isNamed: false, type: "catch_clause" }] } as unknown as Node;
    expect(findEmptyCatchBlocks(fakeRoot, JS_CATCH_NODE_TYPES, JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("skips a catch node whose body can't be resolved by field or fallback child search", () => {
    const fakeCatchNode = { isNamed: true, type: "catch_clause", childForFieldName: () => null, namedChildren: [] };
    const fakeRoot = { descendantsOfType: () => [fakeCatchNode] } as unknown as Node;
    expect(findEmptyCatchBlocks(fakeRoot, JS_CATCH_NODE_TYPES, JS_BLOCK_NODE_TYPES, JS_COMMENT_NODE_TYPES)).toEqual([]);
  });
});

describe("findDeprecationMarkers", () => {
  it("returns [] immediately when no marker node types are given", () => {
    const root = parseC(`// @deprecated\nint f() { return 0; }`);
    expect(findDeprecationMarkers(root, [])).toEqual([]);
  });

  it("flags a deprecation-marked comment", () => {
    const root = parseC(`// @deprecated use g() instead\nint f() { return 0; }`);
    const regions = findDeprecationMarkers(root, C_COMMENT_NODE_TYPES);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("deprecated");
  });

  it("doesn't flag an ordinary comment", () => {
    const root = parseC(`// just a note\nint f() { return 0; }`);
    expect(findDeprecationMarkers(root, C_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("skips an anonymous node matching a marker type by coincidence", () => {
    const fakeRoot = {
      descendantsOfType: () => [{ isNamed: false, type: "comment", text: "@deprecated" }],
    } as unknown as Node;
    expect(findDeprecationMarkers(fakeRoot, C_COMMENT_NODE_TYPES)).toEqual([]);
  });
});

describe("findCommentedOutCodeBlocks / findCommentedOutCodeBlocksFromNodes", () => {
  it("flags a run of comment lines spanning more than the line-count threshold", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `// line ${i}`).join("\n");
    const root = parseC(`${lines}\nint f() { return 0; }`);
    const regions = findCommentedOutCodeBlocks(root, C_COMMENT_NODE_TYPES);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("commentedCode");
  });

  it("flags a short run that contains code-syntax characters", () => {
    const root = parseC(`// int x = 1;\nint f() { return 0; }`);
    expect(findCommentedOutCodeBlocks(root, C_COMMENT_NODE_TYPES)).toHaveLength(1);
  });

  it("doesn't flag a short run of plain prose comments", () => {
    const root = parseC(`// hello\n// world\nint f() { return 0; }`);
    expect(findCommentedOutCodeBlocks(root, C_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("treats non-adjacent comment lines as separate runs", () => {
    const root = parseC(`// note one\nint f() { return 0; }\n// note two\nint g() { return 1; }`);
    expect(findCommentedOutCodeBlocks(root, C_COMMENT_NODE_TYPES)).toEqual([]);
  });

  it("FromNodes variant matches the direct variant given the same nodes", () => {
    const root = parseC(`// int x = 1;\nint f() { return 0; }`);
    const nodes = root.descendantsOfType(C_COMMENT_NODE_TYPES);
    expect(findCommentedOutCodeBlocksFromNodes(nodes)).toEqual(findCommentedOutCodeBlocks(root, C_COMMENT_NODE_TYPES));
  });
});

describe("findMagicNumberBlobs", () => {
  it("flags a long, whitespace-free string literal as a blob", () => {
    const blob = "a".repeat(150);
    const root = parseC(`char *s = "${blob}";`);
    const regions = findMagicNumberBlobs(root, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("magicBlob");
  });

  it("doesn't flag a short string literal", () => {
    const root = parseC(`char *s = "short";`);
    expect(findMagicNumberBlobs(root, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES)).toEqual([]);
  });

  it("doesn't flag a long string literal that contains whitespace (prose, not a blob)", () => {
    const prose = Array.from({ length: 30 }, () => "word").join(" ");
    const root = parseC(`char *s = "${prose}";`);
    expect(findMagicNumberBlobs(root, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES)).toEqual([]);
  });

  it("flags a well-known hex magic number", () => {
    const root = parseC(`int x = 0xDEADBEEF;`);
    const regions = findMagicNumberBlobs(root, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES);
    expect(regions).toHaveLength(1);
  });

  it("doesn't flag an ordinary number literal", () => {
    const root = parseC(`int x = 42;`);
    expect(findMagicNumberBlobs(root, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES)).toEqual([]);
  });

  it("skips an anonymous node matching a string/number type by coincidence", () => {
    const fakeRoot = {
      descendantsOfType: () => [{ isNamed: false, type: "string_literal", text: "x".repeat(200) }],
    } as unknown as Node;
    expect(findMagicNumberBlobs(fakeRoot, C_STRING_NODE_TYPES, C_NUMBER_NODE_TYPES)).toEqual([]);
  });
});

describe("summarizeSwitchBranches", () => {
  it("counts C's case branches and spots `default:` by its leading keyword", () => {
    const root = parseC(`int f(int v) {
  switch (v) {
    case 1: return 1;
    case 2: return 2;
    default: return 0;
  }
}`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 2, hasDefault: true });
  });

  it("reports hasDefault false for a C switch with no default arm", () => {
    const root = parseC(`int f(int v) { switch (v) { case 1: return 1; } }`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 1, hasDefault: false });
  });

  it("doesn't mistake an if/else's `else_clause` for a switch catch-all", () => {
    // The Ruby-style sibling-`else` scan only runs when no default was found,
    // and C's if/else produces a real `else_clause` node — `isIfElse` is what
    // keeps this from reporting hasDefault true.
    const root = parseC(`int f(int v) {
  if (v > 0) { return 1; } else { return 2; }
  switch (v) { case 1: return 1; }
}`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 1, hasDefault: false });
  });

  it("spots JS's catch-all by node type rather than by text", () => {
    const root = parseJs(`function f(v) {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}`);
    expect(summarizeSwitchBranches(root, JS_CASE_BRANCH_NODE_TYPES, JS_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 2, hasDefault: true });
  });

  it("aggregates every switch in the subtree into one summary", () => {
    const root = parseC(`int f(int v) {
  switch (v) { case 1: return 1; }
  switch (v) { case 2: return 2; default: return 0; }
}`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 2, hasDefault: true });
  });

  it("returns undefined when there is no switch at all", () => {
    const root = parseC(`int f(int v) { return v; }`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toBeUndefined();
  });

  it("returns undefined for a switch with no branches at all", () => {
    const root = parseC(`int f(int v) { switch (v) { } return 0; }`);
    expect(summarizeSwitchBranches(root, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toBeUndefined();
  });

  it("drops branches nested inside an excluded ancestor", () => {
    // Stands in for Scala's `catch { case e: Exception => … }`, which reuses
    // the same branch node type for something that isn't a switch.
    const root = parseJs(`function f(v) {
  try { g(); } catch (e) { switch (v) { case 1: return 1; } }
  switch (v) { case 2: return 2; }
}`);
    expect(summarizeSwitchBranches(root, JS_CASE_BRANCH_NODE_TYPES, JS_DEFAULT_BRANCH_NODE_TYPES, new Set(["catch_clause"])))
      .toEqual({ caseCount: 1, hasDefault: false });
  });

  it("skips anonymous nodes that collide with a branch type name", () => {
    const fakeRoot = {
      id: 0,
      descendantsOfType: () => [{ isNamed: false, type: "case_statement", text: "case 1:" }],
    } as unknown as Node;
    expect(summarizeSwitchBranches(fakeRoot, C_CASE_BRANCH_NODE_TYPES, C_DEFAULT_BRANCH_NODE_TYPES, NO_EXCLUDED_ANCESTORS))
      .toBeUndefined();
  });
});

describe("findExceptionZones", () => {
  it("records a try/catch/finally with its clause counts and line span", () => {
    const root = parseJs(`function f() {
  try {
    g();
  } catch (e) {
    h(e);
  } finally {
    k();
  }
}`);
    expect(findExceptionZones(root, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES))
      .toEqual([{ startLine: 2, endLine: 8, catchCount: 1, hasFinally: true }]);
  });

  it("reports hasFinally false for a plain try/catch", () => {
    const root = parseJs(`function f() { try { g(); } catch (e) { h(e); } }`);
    const zones = findExceptionZones(root, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES);
    expect(zones).toHaveLength(1);
    expect(zones[0].catchCount).toBe(1);
    expect(zones[0].hasFinally).toBe(false);
  });

  it("reports catchCount 0 for a try/finally with no catch", () => {
    const root = parseJs(`function f() { try { g(); } finally { k(); } }`);
    const zones = findExceptionZones(root, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES);
    expect(zones).toHaveLength(1);
    expect(zones[0].catchCount).toBe(0);
    expect(zones[0].hasFinally).toBe(true);
  });

  it("finds every try in the file, including nested ones", () => {
    const root = parseJs(`function f() {
  try { try { g(); } catch (e) { h(); } } catch (e) { h(); }
}`);
    expect(findExceptionZones(root, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES)).toHaveLength(2);
  });

  it("returns nothing for a grammar with no exception construct", () => {
    const root = parseC(`int f(void) { return 0; }`);
    expect(findExceptionZones(root, ["seh_try_statement"], new Set(["seh_except_clause"]), new Set(["seh_finally_clause"])))
      .toEqual([]);
  });

  it("skips a try with neither a catch nor a finally clause", () => {
    const fakeRoot = {
      descendantsOfType: () => [
        { isNamed: true, type: "try_statement", namedChildren: [{ type: "statement_block" }, null], startPosition: { row: 0 }, endPosition: { row: 2 } },
      ],
    } as unknown as Node;
    expect(findExceptionZones(fakeRoot, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES)).toEqual([]);
  });

  it("skips anonymous nodes that collide with a try type name", () => {
    const fakeRoot = {
      descendantsOfType: () => [{ isNamed: false, type: "try_statement" }],
    } as unknown as Node;
    expect(findExceptionZones(fakeRoot, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES)).toEqual([]);
  });
});

describe("countTopLevelImports", () => {
  it("counts C's #include directives", () => {
    const root = parseC(`#include <stdio.h>
#include "local.h"
int f(void) { return 0; }`);
    expect(countTopLevelImports(root, C_IMPORT_NODE_TYPES, NO_CALL_SHAPED_IMPORTS, NEVER_MATCHES, C_BLOCK_NODE_TYPES)).toBe(2);
  });

  it("returns 0 for a file with no imports", () => {
    const root = parseC(`int f(void) { return 0; }`);
    expect(countTopLevelImports(root, C_IMPORT_NODE_TYPES, NO_CALL_SHAPED_IMPORTS, NEVER_MATCHES, C_BLOCK_NODE_TYPES)).toBe(0);
  });

  it("counts JS import statements", () => {
    const root = parseJs(`import a from "a";\nimport b from "b";\nimport c from "c";`);
    expect(countTopLevelImports(root, JS_IMPORT_NODE_TYPES, NO_CALL_SHAPED_IMPORTS, NEVER_MATCHES, JS_BLOCK_NODE_TYPE_SET)).toBe(3);
  });

  it("counts call-shaped imports by their text", () => {
    const root = parseJs(`const a = require("a");\nconst b = require("b");`);
    expect(countTopLevelImports(root, [], ["call_expression"], /^require\(/, JS_BLOCK_NODE_TYPE_SET)).toBe(2);
  });

  it("ignores a top-level call that is not an import, however call-shaped it is", () => {
    // The pair with "counts call-shaped imports by their text": the node type
    // alone is not enough, because in a grammar with no import statement every
    // call looks identical to `require(...)` until the pattern is applied. A
    // plain top-level call must not inflate the file's dependency count.
    const root = parseJs(`const a = require("a");\nconsole.log("hi");\nsetup();`);
    expect(countTopLevelImports(root, [], ["call_expression"], /^require\(/, JS_BLOCK_NODE_TYPE_SET)).toBe(1);
  });

  it("ignores a call-shaped import buried inside a function body", () => {
    // Depth 4+ (program > function > body > statement > call) is past the
    // top-level allowance — a lazily-required module isn't a file dependency.
    const root = parseJs(`function f() { const a = require("a"); }`);
    expect(countTopLevelImports(root, [], ["call_expression"], /^require\(/, JS_BLOCK_NODE_TYPE_SET)).toBe(0);
  });

  it("ignores an #include buried inside a function body", () => {
    const root = parseC(`int f(void) {\n#include "nested.h"\n  return 0;\n}`);
    expect(countTopLevelImports(root, C_IMPORT_NODE_TYPES, NO_CALL_SHAPED_IMPORTS, NEVER_MATCHES, C_BLOCK_NODE_TYPES)).toBe(0);
  });

  it("skips anonymous nodes that collide with an import type name", () => {
    const fakeRoot = {
      id: 0,
      descendantsOfType: () => [{ isNamed: false, type: "preproc_include" }],
    } as unknown as Node;
    expect(countTopLevelImports(fakeRoot, C_IMPORT_NODE_TYPES, NO_CALL_SHAPED_IMPORTS, NEVER_MATCHES, C_BLOCK_NODE_TYPES)).toBe(0);
  });

  it("skips an anonymous call-shaped node whose text would otherwise match", () => {
    const fakeRoot = {
      id: 0,
      descendantsOfType: (types: string[]) => (types.includes("call_expression") ? [{ isNamed: false, type: "call_expression", text: "require(\"a\")" }] : []),
    } as unknown as Node;
    expect(countTopLevelImports(fakeRoot, [], ["call_expression"], /^require\(/, C_BLOCK_NODE_TYPES)).toBe(0);
  });
});

describe("countAllocations", () => {
  it("counts C allocator calls by callee name", () => {
    const root = parseC(`int f(void) {
  char *a = malloc(64);
  char *b = calloc(2, 8);
  char *c = realloc(a, 128);
  return 0;
}`);
    expect(countAllocations(root, C_ALLOCATION_NODE_TYPES, C_CALL_NODE_TYPES, C_ALLOCATOR_NAME_PATTERN, C_ARRAY_DECLARATOR_NODE_TYPES, 1024)).toBe(3);
  });

  it("doesn't count an ordinary call", () => {
    const root = parseC(`int f(void) { printf("hi"); return 0; }`);
    expect(countAllocations(root, C_ALLOCATION_NODE_TYPES, C_CALL_NODE_TYPES, C_ALLOCATOR_NAME_PATTERN, C_ARRAY_DECLARATOR_NODE_TYPES, 1024)).toBe(0);
  });

  it("counts a large fixed-size array but not a small one", () => {
    const root = parseC(`int f(void) {
  char big[4096];
  char small[8];
  return 0;
}`);
    expect(countAllocations(root, C_ALLOCATION_NODE_TYPES, C_CALL_NODE_TYPES, C_ALLOCATOR_NAME_PATTERN, C_ARRAY_DECLARATOR_NODE_TYPES, 1024)).toBe(1);
  });

  it("ignores an array declarator with no literal size", () => {
    const root = parseC(`int f(int n) { char flexible[n]; return 0; }`);
    expect(countAllocations(root, C_ALLOCATION_NODE_TYPES, C_CALL_NODE_TYPES, C_ALLOCATOR_NAME_PATTERN, C_ARRAY_DECLARATOR_NODE_TYPES, 1024)).toBe(0);
  });

  it("counts JS `new` expressions by node type", () => {
    const root = parseJs(`function f() { const a = new Foo(); const b = new Bar(1); }`);
    expect(countAllocations(root, JS_ALLOCATION_NODE_TYPES, [], NEVER_MATCHES, [], 1024)).toBe(2);
  });

  it("falls back to the last identifier child when there is no callee field", () => {
    // Stands in for ObjC's `[[NSObject alloc] init]`, whose selector isn't
    // exposed as a `function`/`name`/`macro` field.
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("message_expression")
          ? [{
              isNamed: true,
              type: "message_expression",
              childForFieldName: () => null,
              namedChildren: [
                { type: "identifier", text: "NSObject" },
                { type: "identifier", text: "alloc" },
              ],
            }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["message_expression"], /^alloc$/, [], 1024)).toBe(1);
  });

  it("returns null callee (and counts nothing) for a call with no identifier child", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("call_expression")
          ? [{ isNamed: true, type: "call_expression", childForFieldName: () => null, namedChildren: [{ type: "parenthesized_expression", text: "(fp)" }] }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["call_expression"], /^alloc$/, [], 1024)).toBe(0);
  });

  it("skips anonymous nodes that collide with a call or declarator type name", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) => [
        { isNamed: false, type: types[0] ?? "call_expression" },
      ],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["call_expression"], /.*/, ["array_declarator"], 1024)).toBe(0);
  });
});

describe("astUtils — synthetic-tree edge cases", () => {
  // These branches guard against grammar shapes none of the 15 bundled
  // grammars actually produce, so they need hand-built nodes to reach at all
  // — same approach the adapter suites already use for their own unreachable
  // cases.

  it("treats a parentless `else` node as a switch catch-all, not an if/else", () => {
    const elseNode = { isNamed: true, type: "else", parent: null };
    const fakeRoot = {
      id: 0,
      descendantsOfType: (types: string[]) =>
        types.includes("when")
          ? [{ isNamed: true, type: "when", id: 1, parent: null, namedChildren: [], text: "when 1 then 1", childForFieldName: () => null }]
          : [elseNode],
    } as unknown as Node;
    expect(summarizeSwitchBranches(fakeRoot, ["when"], new Set<string>(), NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 1, hasDefault: true });
  });

  it("ignores a null direct child when testing whether a branch is a container", () => {
    const fakeRoot = {
      id: 0,
      descendantsOfType: (types: string[]) =>
        types.includes("case_item")
          ? [{ isNamed: true, type: "case_item", id: 1, parent: null, namedChildren: [null], text: "a) echo 1 ;;", childForFieldName: () => null }]
          : [],
    } as unknown as Node;
    expect(summarizeSwitchBranches(fakeRoot, ["case_item"], new Set<string>(), NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 1, hasDefault: false });
  });

  it("treats a branch with no pattern child at all as a non-default case", () => {
    const fakeRoot = {
      id: 0,
      descendantsOfType: (types: string[]) =>
        types.includes("case_item")
          ? [{ isNamed: true, type: "case_item", id: 1, parent: null, namedChildren: [], text: "opaque", childForFieldName: () => null }]
          : [],
    } as unknown as Node;
    expect(summarizeSwitchBranches(fakeRoot, ["case_item"], new Set<string>(), NO_EXCLUDED_ANCESTORS))
      .toEqual({ caseCount: 1, hasDefault: false });
  });

  it("ignores a null clause child when counting a try's catch/finally clauses", () => {
    const fakeRoot = {
      descendantsOfType: () => [
        {
          isNamed: true,
          type: "try_statement",
          namedChildren: [null, { type: "catch_clause" }],
          startPosition: { row: 0 },
          endPosition: { row: 3 },
        },
      ],
    } as unknown as Node;
    expect(findExceptionZones(fakeRoot, JS_TRY_NODE_TYPES, JS_CATCH_NODE_TYPE_SET, JS_FINALLY_NODE_TYPES))
      .toEqual([{ startLine: 1, endLine: 4, catchCount: 1, hasFinally: false }]);
  });

  it("reads a callee from a `name` field when there is no `function` field", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("method_invocation")
          ? [{
              isNamed: true,
              type: "method_invocation",
              childForFieldName: (field: string) => (field === "name" ? { text: "alloc" } : null),
              namedChildren: [],
            }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["method_invocation"], /^alloc$/, [], 1024)).toBe(1);
  });

  it("reads a callee from a `macro` field when there is no `function`/`name` field", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("macro_invocation")
          ? [{
              isNamed: true,
              type: "macro_invocation",
              childForFieldName: (field: string) => (field === "macro" ? { text: "vec" } : null),
              namedChildren: [],
            }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["macro_invocation"], /^vec$/, [], 1024)).toBe(1);
  });

  it("ignores a null child when scanning a call for its trailing identifier", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("message_expression")
          ? [{
              isNamed: true,
              type: "message_expression",
              childForFieldName: () => null,
              namedChildren: [null, { type: "identifier", text: "alloc" }],
            }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], ["message_expression"], /^alloc$/, [], 1024)).toBe(1);
  });

  it("ignores an array declarator with no size child at all", () => {
    const fakeRoot = {
      descendantsOfType: (types: string[]) =>
        types.includes("array_declarator")
          ? [{ isNamed: true, type: "array_declarator", childForFieldName: () => null, namedChildren: [null] }]
          : [],
    } as unknown as Node;
    expect(countAllocations(fakeRoot, [], [], NEVER_MATCHES, ["array_declarator"], 1024)).toBe(0);
  });
});
