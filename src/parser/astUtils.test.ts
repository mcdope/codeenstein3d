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
  countDecisionPoints,
  countLines,
  countParameters,
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
