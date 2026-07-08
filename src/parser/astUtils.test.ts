import { describe, it, expect } from "vitest";
import type { Node, Point } from "web-tree-sitter";
import {
  countLines,
  countDecisionPoints,
  maxNestingDepth,
  countParameters,
  codeSmellBonus,
  resolveGotos,
  isTodoFlagged,
  isLicenseHeader,
  extractLargeComments,
  findDeadCodeAfterReturn
} from "./astUtils";

class MockNode {
  type: string;
  isNamed: boolean;
  text: string;
  parent: MockNode | null = null;
  namedChildren: MockNode[] = [];
  startPosition: Point = { row: 0, column: 0 };
  endPosition: Point = { row: 0, column: 0 };
  fields: Record<string, MockNode> = {};

  constructor(options: Partial<MockNode> & { type: string }) {
    this.type = options.type;
    this.isNamed = options.isNamed !== undefined ? options.isNamed : true;
    this.text = options.text || "";
    if (options.startPosition) this.startPosition = options.startPosition;
    if (options.endPosition) this.endPosition = options.endPosition;
    if (options.fields) {
      this.fields = options.fields as Record<string, MockNode>;
      for (const child of Object.values(this.fields)) {
        child.parent = this;
      }
    }
    
    if (options.namedChildren) {
      this.namedChildren = options.namedChildren as MockNode[];
      for (const child of this.namedChildren) {
        child.parent = this;
      }
    }
  }

  descendantsOfType(types: string | readonly string[]): MockNode[] {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const results: MockNode[] = [];
    const traverse = (node: MockNode) => {
      if (typeSet.has(node.type)) {
        results.push(node);
      }
      for (const child of node.namedChildren) {
        traverse(child);
      }
    };
    for (const child of this.namedChildren) {
      traverse(child);
    }
    return results;
  }

  childForFieldName(name: string): MockNode | null {
    return this.fields[name] || null;
  }
}

describe("astUtils", () => {
  describe("countLines", () => {
    it("should return 0 for empty text", () => {
      expect(countLines("")).toBe(0);
    });
    it("should count lines without trailing newline", () => {
      expect(countLines("line1\nline2\nline3")).toBe(3);
    });
    it("should not count a single trailing newline as an extra line", () => {
      expect(countLines("line1\nline2\n")).toBe(2);
    });
  });

  describe("countDecisionPoints", () => {
    it("should count named decision nodes and logical operators", () => {
      const root = new MockNode({
        type: "function",
        namedChildren: [
          new MockNode({ type: "if_statement", isNamed: true }),
          new MockNode({ type: "if_statement", isNamed: false }), // Should be ignored
          new MockNode({
            type: "binary_expression",
            fields: { operator: new MockNode({ type: "operator", text: "&&" }) }
          }),
          new MockNode({
            type: "binary_expression",
            fields: { operator: new MockNode({ type: "operator", text: "+" }) }
          })
        ]
      });

      const decisionTypes = ["if_statement"];
      const logicalOps = new Set(["&&", "||"]);

      const count = countDecisionPoints(root as unknown as Node, decisionTypes, logicalOps);
      expect(count).toBe(2); // one named if_statement, one && operator
    });
  });

  describe("maxNestingDepth", () => {
    it("should calculate max depth correctly", () => {
      const root = new MockNode({
        type: "function",
        namedChildren: [
          new MockNode({
            type: "if_statement",
            namedChildren: [
              new MockNode({
                type: "while_statement",
                namedChildren: []
              })
            ]
          }),
          new MockNode({
            type: "for_statement",
            namedChildren: []
          })
        ]
      });

      const nestingTypes = new Set(["if_statement", "while_statement", "for_statement"]);
      expect(maxNestingDepth(root as unknown as Node, nestingTypes)).toBe(2);
    });

    it("should treat else if as same depth", () => {
      const elseClause = new MockNode({
        type: "else_clause",
        namedChildren: []
      });
      const ifStatement = new MockNode({
        type: "if_statement",
        namedChildren: []
      });
      ifStatement.parent = elseClause; // Simulate else if

      const root = new MockNode({
        type: "function",
        namedChildren: [elseClause]
      });
      elseClause.namedChildren.push(ifStatement);

      const nestingTypes = new Set(["if_statement", "else_clause"]);
      expect(maxNestingDepth(root as unknown as Node, nestingTypes)).toBe(1); // else_clause is 1, if_statement inside is 0 inc
    });
  });

  describe("countParameters", () => {
    it("should return parameter count from first param list", () => {
      const root = new MockNode({
        type: "function",
        namedChildren: [
          new MockNode({
            type: "parameter_list",
            namedChildren: [
              new MockNode({ type: "param" }),
              new MockNode({ type: "param" })
            ]
          }),
          new MockNode({
            type: "parameter_list",
            namedChildren: [new MockNode({ type: "param" })]
          })
        ]
      });

      expect(countParameters(root as unknown as Node, ["parameter_list"])).toBe(2);
    });

    it("should return 0 if no parameter list", () => {
      const root = new MockNode({ type: "function", namedChildren: [] });
      expect(countParameters(root as unknown as Node, ["parameter_list"])).toBe(0);
    });
  });

  describe("codeSmellBonus", () => {
    it("should return 0 if under limits", () => {
      expect(codeSmellBonus(5, 3)).toBe(0);
    });
    it("should calculate bonus for excess params", () => {
      expect(codeSmellBonus(7, 3)).toBe(4); // (7 - 5) * 2
    });
    it("should calculate bonus for excess nesting", () => {
      expect(codeSmellBonus(5, 5)).toBe(6); // (5 - 3) * 3
    });
    it("should accumulate bonuses", () => {
      expect(codeSmellBonus(6, 4)).toBe(5); // 2 + 3
    });
  });

  describe("resolveGotos", () => {
    it("should match gotos with labels", () => {
      const gotos = [{ label: "start", line: 10 }];
      const labels = [{ label: "start", line: 20 }, { label: "end", line: 30 }];
      const resolved = resolveGotos(gotos, labels);
      expect(resolved).toEqual([{ label: "start", gotoLine: 10, labelLine: 20 }]);
    });
    it("should drop unresolvable gotos", () => {
      const gotos = [{ label: "start", line: 10 }];
      const labels = [{ label: "end", line: 20 }];
      expect(resolveGotos(gotos, labels)).toEqual([]);
    });
    it("should use first label occurrence", () => {
      const gotos = [{ label: "start", line: 10 }];
      const labels = [{ label: "start", line: 20 }, { label: "start", line: 30 }];
      expect(resolveGotos(gotos, labels)).toEqual([{ label: "start", gotoLine: 10, labelLine: 20 }]);
    });
  });

  describe("isTodoFlagged", () => {
    it("should detect TODO or FIXME", () => {
      expect(isTodoFlagged("Here is a TODO item")).toBe(true);
      expect(isTodoFlagged("FIXME: broken")).toBe(true);
      expect(isTodoFlagged("clean code")).toBe(false);
    });
  });

  describe("isLicenseHeader", () => {
    it("should detect common licenses in top 10 lines", () => {
      expect(isLicenseHeader("Copyright (c) 2026", 5)).toBe(true);
      expect(isLicenseHeader("MIT License", 5)).toBe(false); // No explicit MIT check without 'licensed under the' or similar, wait, my check in code is different.
      expect(isLicenseHeader("SPDX-License-Identifier", 1)).toBe(true);
    });
    it("should ignore licenses past line 10", () => {
      expect(isLicenseHeader("Copyright (c) 2026", 11)).toBe(false);
    });
  });

  describe("extractLargeComments", () => {
    it("should extract long comments", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "comment",
            text: "a".repeat(60),
            startPosition: { row: 15, column: 0 },
            endPosition: { row: 15, column: 0 }
          })
        ]
      });
      const comments = extractLargeComments(root as unknown as Node, ["comment"]);
      expect(comments.length).toBe(1);
      expect(comments[0].text).toBe("a".repeat(60));
    });

    it("should extract multi-line comments", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "comment",
            text: "short",
            startPosition: { row: 15, column: 0 },
            endPosition: { row: 16, column: 0 }
          })
        ]
      });
      const comments = extractLargeComments(root as unknown as Node, ["comment"]);
      expect(comments.length).toBe(1);
    });

    it("should ignore short single-line comments without TODO", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "comment",
            text: "short",
            startPosition: { row: 15, column: 0 },
            endPosition: { row: 15, column: 0 }
          }),
          new MockNode({
            type: "comment",
            text: "unnamed",
            isNamed: false,
            startPosition: { row: 16, column: 0 },
            endPosition: { row: 16, column: 0 }
          })
        ]
      });
      expect(extractLargeComments(root as unknown as Node, ["comment"])).toEqual([]);
    });

    it("should include short TODO flagged comments", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "comment",
            text: "TODO: fix",
            startPosition: { row: 15, column: 0 },
            endPosition: { row: 15, column: 0 }
          })
        ]
      });
      expect(extractLargeComments(root as unknown as Node, ["comment"]).length).toBe(1);
    });

    it("should exclude license headers", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "comment",
            text: "Copyright (c) 2026",
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 0, column: 0 }
          })
        ]
      });
      expect(extractLargeComments(root as unknown as Node, ["comment"])).toEqual([]);
    });
  });

  describe("findDeadCodeAfterReturn", () => {
    it("should find dead code after return", () => {
      const block = new MockNode({
        type: "block",
        namedChildren: [
          new MockNode({ type: "expr1", endPosition: { row: 10, column: 0 } }),
          new MockNode({ type: "return_statement" }),
          new MockNode({ type: "dead_expr", startPosition: { row: 12, column: 0 }, endPosition: { row: 12, column: 0 } }),
          new MockNode({ type: "dead_expr2", startPosition: { row: 13, column: 0 }, endPosition: { row: 14, column: 0 } })
        ]
      });
      const root = new MockNode({ type: "program", namedChildren: [block] });

      const regions = findDeadCodeAfterReturn(
        root as unknown as Node,
        new Set(["block"]),
        new Set(["return_statement"])
      );

      expect(regions).toEqual([{ startLine: 13, endLine: 15 }]);
    });

    it("should return empty if return is the last statement", () => {
      const block = new MockNode({
        type: "block",
        namedChildren: [
          new MockNode({ type: "expr1" }),
          new MockNode({ type: "return_statement" })
        ]
      });
      const root = new MockNode({ type: "program", namedChildren: [block] });

      const regions = findDeadCodeAfterReturn(
        root as unknown as Node,
        new Set(["block"]),
        new Set(["return_statement"])
      );

      expect(regions).toEqual([]);
    });
  });
});
