// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * vocabulary.ts's functions are fully grammar-agnostic (parameterized purely
 * by node-type-name tables), unlike astUtils.ts/refinements.ts's ancestry-
 * shaped logic — so synthetic `Node`-shaped fixtures give precise, reliable
 * control over branches (BFS depth, unwrap paths) that would be fragile to
 * hit via any one specific real grammar's exact AST shape. Real end-to-end
 * exercising of this module through an actual grammar happens in Phase 4's
 * genericParser.ts/languages.ts tests.
 */
import { describe, expect, it } from "vitest";
import type { Node } from "web-tree-sitter";
import {
  ANNOTATION_NODE_TYPES,
  BLOCK_NODE_TYPES,
  CATCH_NODE_TYPES,
  COMMENT_NODE_TYPES,
  DECISION_NODE_TYPES,
  ENTITY_NODE_TYPES,
  GOTO_NODE_TYPE,
  LABEL_NODE_TYPE,
  LOGICAL_OPERATORS,
  NESTING_NODE_TYPES,
  NUMBER_LITERAL_NODE_TYPES,
  PARAMETER_LIST_NODE_TYPES,
  RETURN_NODE_TYPES,
  STRING_LITERAL_NODE_TYPES,
  entityName,
  extractGotos,
  genericGlobals,
  positionKey,
} from "./vocabulary";

describe("shared vocabulary tables", () => {
  it("ENTITY_NODE_TYPES is a nonempty map of node type -> EntityKind", () => {
    expect(Object.keys(ENTITY_NODE_TYPES).length).toBeGreaterThan(0);
  });

  it.each([
    ["DECISION_NODE_TYPES", DECISION_NODE_TYPES],
    ["NESTING_NODE_TYPES", [...NESTING_NODE_TYPES]],
    ["COMMENT_NODE_TYPES", COMMENT_NODE_TYPES],
    ["BLOCK_NODE_TYPES", [...BLOCK_NODE_TYPES]],
    ["RETURN_NODE_TYPES", [...RETURN_NODE_TYPES]],
    ["CATCH_NODE_TYPES", CATCH_NODE_TYPES],
    ["ANNOTATION_NODE_TYPES", ANNOTATION_NODE_TYPES],
    ["STRING_LITERAL_NODE_TYPES", STRING_LITERAL_NODE_TYPES],
    ["NUMBER_LITERAL_NODE_TYPES", NUMBER_LITERAL_NODE_TYPES],
    ["PARAMETER_LIST_NODE_TYPES", PARAMETER_LIST_NODE_TYPES],
  ])("%s is a nonempty list with no duplicate entries", (_label, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
  });

  it("LOGICAL_OPERATORS is a nonempty set of operator tokens", () => {
    expect(LOGICAL_OPERATORS.size).toBeGreaterThan(0);
    expect(LOGICAL_OPERATORS.has("&&")).toBe(true);
  });

  it("GOTO_NODE_TYPE/LABEL_NODE_TYPE are distinct non-empty strings", () => {
    expect(GOTO_NODE_TYPE).not.toBe("");
    expect(LABEL_NODE_TYPE).not.toBe("");
    expect(GOTO_NODE_TYPE).not.toBe(LABEL_NODE_TYPE);
  });
});

function fakeNode(overrides: Record<string, unknown>): Node {
  return {
    childForFieldName: () => null,
    namedChildren: [],
    ...overrides,
  } as unknown as Node;
}

describe("entityName", () => {
  it("prefers the grammar's own name field", () => {
    const node = fakeNode({ childForFieldName: (f: string) => (f === "name" ? { text: "foo" } : null) });
    expect(entityName(node)).toBe("foo");
  });

  it("falls back to an identifier-like child at depth 1", () => {
    const node = fakeNode({ namedChildren: [fakeNode({ type: "identifier", text: "bar" })] });
    expect(entityName(node)).toBe("bar");
  });

  it("falls back to an identifier-like grandchild at depth 2", () => {
    const grandchild = fakeNode({ type: "type_identifier", text: "baz" });
    const child = fakeNode({ type: "declarator", namedChildren: [grandchild] });
    const node = fakeNode({ namedChildren: [child] });
    expect(entityName(node)).toBe("baz");
  });

  it("returns <anonymous> once the identifier is beyond maxDepth", () => {
    const level3 = fakeNode({ type: "identifier", text: "toodeep" });
    const level2 = fakeNode({ type: "wrapper", namedChildren: [level3] });
    const level1 = fakeNode({ type: "wrapper", namedChildren: [level2] });
    const node = fakeNode({ namedChildren: [level1] });
    expect(entityName(node, 2)).toBe("<anonymous>");
  });

  it("returns <anonymous> when there's no identifier-like descendant at all", () => {
    const node = fakeNode({ namedChildren: [fakeNode({ type: "punctuation", text: "{" })] });
    expect(entityName(node)).toBe("<anonymous>");
  });

  it("matches a 'name'-suffixed type as identifier-like (e.g. label_name)", () => {
    const node = fakeNode({ namedChildren: [fakeNode({ type: "label_name", text: "L1" })] });
    expect(entityName(node)).toBe("L1");
  });
});

describe("positionKey", () => {
  it("formats startIndex:endIndex", () => {
    expect(positionKey(fakeNode({ startIndex: 5, endIndex: 10 }))).toBe("5:10");
  });
});

describe("extractGotos", () => {
  it("pairs a goto with its label found via the 'label' field", () => {
    const gotoNode = fakeNode({
      childForFieldName: (f: string) => (f === "label" ? { text: "done" } : null),
      startPosition: { row: 4 },
    });
    const labelNode = fakeNode({
      childForFieldName: (f: string) => (f === "label" ? { text: "done" } : null),
      startPosition: { row: 9 },
    });
    const root = fakeNode({
      descendantsOfType: (t: string) => (t === GOTO_NODE_TYPE ? [gotoNode] : t === LABEL_NODE_TYPE ? [labelNode] : []),
    });
    expect(extractGotos(root)).toEqual([{ label: "done", gotoLine: 5, labelLine: 10 }]);
  });

  it("falls back to scanning namedChildren for an identifier-like label when there's no 'label' field", () => {
    const gotoNode = fakeNode({
      namedChildren: [fakeNode({ type: "label_name", text: "L1" })],
      startPosition: { row: 0 },
    });
    const labelNode = fakeNode({
      namedChildren: [fakeNode({ type: "label_name", text: "L1" })],
      startPosition: { row: 2 },
    });
    const root = fakeNode({
      descendantsOfType: (t: string) => (t === GOTO_NODE_TYPE ? [gotoNode] : t === LABEL_NODE_TYPE ? [labelNode] : []),
    });
    expect(extractGotos(root)).toEqual([{ label: "L1", gotoLine: 1, labelLine: 3 }]);
  });

  it("drops a goto/label whose name can't be resolved at all", () => {
    const gotoNode = fakeNode({ startPosition: { row: 0 } });
    const root = fakeNode({
      descendantsOfType: (t: string) => (t === GOTO_NODE_TYPE ? [gotoNode] : []),
    });
    expect(extractGotos(root)).toEqual([]);
  });

  it("returns [] for a grammar with no goto/label nodes at all", () => {
    const root = fakeNode({ descendantsOfType: () => [] });
    expect(extractGotos(root)).toEqual([]);
  });
});

describe("genericGlobals", () => {
  it("captures a top-level assignment-shaped node as a global", () => {
    const child = fakeNode({
      type: "assignment",
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      childForFieldName: (f: string) => (f === "name" ? { text: "x" } : null),
      descendantsOfType: () => [],
    });
    const root = fakeNode({ namedChildren: [child] });
    const globals = genericGlobals(root, new Set(), []);
    expect(globals).toEqual([{ name: "x", kind: "global", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 }]);
  });

  it("skips a top-level node whose own type is already a registered entity", () => {
    const child = fakeNode({ type: "class_declaration", descendantsOfType: () => [] });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), [])).toEqual([]);
  });

  it("unwraps a single-child expression_statement before classifying", () => {
    const inner = fakeNode({
      type: "assignment",
      startPosition: { row: 1 },
      endPosition: { row: 1 },
      childForFieldName: (f: string) => (f === "name" ? { text: "y" } : null),
      descendantsOfType: () => [],
    });
    const child = fakeNode({
      type: "expression_statement",
      namedChildCount: 1,
      namedChild: () => inner,
      startPosition: { row: 1 },
      endPosition: { row: 1 },
    });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), [])).toEqual([
      { name: "y", kind: "global", startLine: 2, endLine: 2, complexityScore: 1, nestingDepth: 0 },
    ]);
  });

  it("skips a node whose type doesn't look like a declaration/assignment container", () => {
    const child = fakeNode({ type: "comment", descendantsOfType: () => [] });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), [])).toEqual([]);
  });

  it("skips an excluded container type even if it matches the declaration/assignment shape", () => {
    const child = fakeNode({ type: "import_declaration", descendantsOfType: () => [] });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), [])).toEqual([]);
  });

  it("skips a container that already contains a consumed entity", () => {
    const entityMatch = fakeNode({ type: "variable_declarator", isNamed: true, startIndex: 5, endIndex: 20 });
    const child = fakeNode({
      type: "lexical_declaration",
      descendantsOfType: () => [entityMatch],
    });
    const root = fakeNode({ namedChildren: [child] });
    const consumed = new Set([positionKey(entityMatch)]);
    expect(genericGlobals(root, consumed, ["variable_declarator"])).toEqual([]);
  });

  it("does not skip when a descendant matches the entity type but isn't in the consumed set", () => {
    const entityMatch = fakeNode({ type: "variable_declarator", isNamed: true, startIndex: 5, endIndex: 20 });
    const child = fakeNode({
      type: "lexical_declaration",
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      childForFieldName: (f: string) => (f === "name" ? { text: "z" } : null),
      descendantsOfType: () => [entityMatch],
    });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), ["variable_declarator"])).toHaveLength(1);
  });

  it("does not skip when the descendant match is anonymous, even if its position is in consumed", () => {
    const anonymousMatch = fakeNode({ type: "variable_declarator", isNamed: false, startIndex: 5, endIndex: 20 });
    const child = fakeNode({
      type: "lexical_declaration",
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      childForFieldName: (f: string) => (f === "name" ? { text: "z" } : null),
      descendantsOfType: () => [anonymousMatch],
    });
    const root = fakeNode({ namedChildren: [child] });
    const consumed = new Set([positionKey(anonymousMatch)]);
    expect(genericGlobals(root, consumed, ["variable_declarator"])).toHaveLength(1);
  });

  it("skips a node whose name can't be resolved at all (entityNameQuiet -> null)", () => {
    const child = fakeNode({
      type: "assignment",
      descendantsOfType: () => [],
      namedChildren: [],
    });
    const root = fakeNode({ namedChildren: [child] });
    expect(genericGlobals(root, new Set(), [])).toEqual([]);
  });

  it("skips the root node itself if it ever appears in its own namedChildren", () => {
    const root = fakeNode({});
    (root as unknown as { namedChildren: Node[] }).namedChildren = [root];
    expect(genericGlobals(root, new Set(), [])).toEqual([]);
  });
});
