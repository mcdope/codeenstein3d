// @ts-nocheck
import { describe, it, expect } from "vitest";
import { entityName, extractGotos, genericGlobals, positionKey, ENTITY_NODE_TYPES } from "./vocabulary";
import type { Node, Point } from "web-tree-sitter";

class MockNode {
  type: string;
  isNamed: boolean = true;
  text: string;
  parent: MockNode | null = null;
  namedChildren: MockNode[] = [];
  startIndex: number = 0;
  endIndex: number = 0;
  startPosition: Point = { row: 0, column: 0 };
  endPosition: Point = { row: 0, column: 0 };
  fields: Record<string, MockNode> = {};

  constructor(options: Partial<MockNode>) {
    this.type = options.type || "unknown";
    this.text = options.text || "";
    if (options.startIndex) this.startIndex = options.startIndex;
    if (options.endIndex) this.endIndex = options.endIndex;
    if (options.startPosition) this.startPosition = options.startPosition;
    if (options.endPosition) this.endPosition = options.endPosition;
    if (options.fields) {
      this.fields = options.fields as Record<string, MockNode>;
      for (const child of Object.values(this.fields)) {
        if (child) child.parent = this;
      }
    }
    if (options.namedChildren) {
      this.namedChildren = options.namedChildren as MockNode[];
      for (const child of this.namedChildren) {
        child.parent = this;
      }
    }
    if (options.parent) {
      this.parent = options.parent as MockNode;
    }
  }

  get namedChildCount() {
    return this.namedChildren.length;
  }
  namedChild(index: number) {
    return this.namedChildren[index] || null;
  }

  descendantsOfType(types: string | readonly string[]): MockNode[] {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const results: MockNode[] = [];
    const traverse = (node: MockNode) => {
      if (typeSet.has(node.type)) {
        results.push(node);
      }
      for (const child of node.namedChildren) traverse(child);
      for (const child of Object.values(node.fields)) {
        if (child && !node.namedChildren.includes(child)) traverse(child);
      }
    };
    for (const child of this.namedChildren) traverse(child);
    return results;
  }

  childForFieldName(name: string): MockNode | null {
    return this.fields[name] || null;
  }
}

describe("vocabulary", () => {
  describe("entityName", () => {
    it("should use 'name' field if present", () => {
      const node = new MockNode({
        type: "function_definition",
        fields: { name: new MockNode({ type: "identifier", text: "myFunc" }) }
      });
      expect(entityName(node as any)).toBe("myFunc");
    });

    it("should fallback to first identifier-like child", () => {
      const node = new MockNode({
        type: "function_definition",
        namedChildren: [
          new MockNode({ type: "some_wrapper", namedChildren: [
            new MockNode({ type: "identifier", text: "buriedFunc" })
          ]})
        ]
      });
      expect(entityName(node as any)).toBe("buriedFunc");
    });

    it("should return <anonymous> if no name found within depth limit", () => {
      const node = new MockNode({
        type: "function_definition",
        namedChildren: [
          new MockNode({ type: "level1", namedChildren: [
            new MockNode({ type: "level2", namedChildren: [
              new MockNode({ type: "level3", namedChildren: [
                new MockNode({ type: "level4", namedChildren: [
                  new MockNode({ type: "identifier", text: "tooDeep" })
                ]})
              ]})
            ]})
          ]})
        ]
      });
      expect(entityName(node as any)).toBe("<anonymous>");
    });
  });

  describe("extractGotos", () => {
    it("should extract gotos and labels and resolve them", () => {
      const root = new MockNode({
        type: "program",
        namedChildren: [
          new MockNode({
            type: "goto_statement",
            startPosition: { row: 1, column: 0 },
            namedChildren: [new MockNode({ type: "identifier", text: "skip" })]
          }),
          new MockNode({
            type: "labeled_statement",
            startPosition: { row: 5, column: 0 },
            fields: { label: new MockNode({ type: "identifier", text: "skip" }) }
          })
        ]
      });
      const gotos = extractGotos(root as any);
      expect(gotos).toEqual([{ label: "skip", gotoLine: 2, labelLine: 6 }]);
    });
  });

  describe("positionKey", () => {
    it("should format start and end index", () => {
      const node = new MockNode({ startIndex: 10, endIndex: 20 });
      expect(positionKey(node as any)).toBe("10:20");
    });
  });

  describe("genericGlobals", () => {
    it("should extract global variable from root", () => {
      const root = new MockNode({ type: "program" });
      const decl = new MockNode({
        type: "variable_declaration",
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 2, column: 0 },
        namedChildren: [new MockNode({ type: "identifier", text: "myGlobal" })]
      });
      root.namedChildren.push(decl);
      root.namedChildren.push(root); // simulate self reference to hit line 328 `if (child === root) continue;`
      decl.parent = root;

      const globals = genericGlobals(root as any, new Set(), Object.keys(ENTITY_NODE_TYPES));
      expect(globals).toHaveLength(1);
    });

    it("should unwrap expression_statement to find global", () => {
      const root = new MockNode({ type: "program" });
      const exprStmt = new MockNode({
        type: "expression_statement",
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 2, column: 0 }
      });
      const assign = new MockNode({
        type: "assignment",
        namedChildren: [new MockNode({ type: "identifier", text: "unwrappedGlobal" })]
      });
      exprStmt.namedChildren.push(assign);
      assign.parent = exprStmt;
      root.namedChildren.push(exprStmt);
      exprStmt.parent = root;

      const globals = genericGlobals(root as any, new Set(), Object.keys(ENTITY_NODE_TYPES));
      expect(globals).toHaveLength(1);
      expect(globals[0].name).toBe("unwrappedGlobal");
    });

    it("should exclude consumed entities", () => {
      const root = new MockNode({ type: "program" });
      const decl = new MockNode({
        type: "variable_declaration",
        startIndex: 10,
        endIndex: 20,
        namedChildren: [
          new MockNode({
            type: "function_declaration",
            startIndex: 15,
            endIndex: 18,
            namedChildren: [new MockNode({ type: "identifier", text: "innerFunc" })]
          })
        ]
      });
      root.namedChildren.push(decl);
      decl.parent = root;

      const consumed = new Set(["15:18"]);
      const globals = genericGlobals(root as any, consumed, ["function_declaration"]);
      expect(globals).toHaveLength(0); // skipped because it contains consumed entity
    });

    it("should skip anonymous globals", () => {
      const root = new MockNode({ type: "program" });
      const decl = new MockNode({
        type: "variable_declaration",
        namedChildren: [new MockNode({ type: "unknown", text: "val" })] // no identifier
      });
      root.namedChildren.push(decl);
      decl.parent = root;

      const globals = genericGlobals(root as any, new Set(), Object.keys(ENTITY_NODE_TYPES));
      expect(globals).toHaveLength(0);
    });

    it("should exclude import/export types", () => {
      const root = new MockNode({ type: "program" });
      const decl = new MockNode({
        type: "import_declaration",
        namedChildren: [new MockNode({ type: "identifier", text: "mod" })]
      });
      root.namedChildren.push(decl);
      decl.parent = root;

      const globals = genericGlobals(root as any, new Set(), Object.keys(ENTITY_NODE_TYPES));
      expect(globals).toHaveLength(0);
    });
  });
});
