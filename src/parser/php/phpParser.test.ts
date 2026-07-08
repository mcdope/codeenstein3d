import { describe, it, expect, vi, beforeEach } from "vitest";
import { PhpParserAdapter } from "./phpParser";
import { Parser, Language } from "web-tree-sitter";

vi.mock("../runtime", () => ({
  initTreeSitter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("tree-sitter-php/tree-sitter-php.wasm?url", () => ({
  default: "mock-php-wasm-url",
}));

vi.mock("web-tree-sitter", () => {
  return {
    Parser: vi.fn().mockImplementation(() => ({
      setLanguage: vi.fn(),
      parse: vi.fn(),
    })),
    Language: {
      load: vi.fn().mockResolvedValue({}),
    },
  };
});

class MockNode {
  type: string;
  isNamed: boolean = true;
  text: string;
  parent: MockNode | null = null;
  namedChildren: MockNode[] = [];
  startPosition = { row: 0, column: 0 };
  endPosition = { row: 0, column: 0 };
  fields: Record<string, MockNode> = {};

  constructor(options: Partial<MockNode>) {
    this.type = options.type || "unknown";
    this.text = options.text || "";
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
      for (const child of Object.values(node.fields)) {
        if (child && !node.namedChildren.includes(child)) traverse(child);
      }
    };
    traverse(this);
    const idx = results.indexOf(this);
    if (idx !== -1) results.splice(idx, 1);
    return results;
  }

  childForFieldName(name: string): MockNode | null {
    return this.fields[name] || null;
  }
}

describe("PhpParserAdapter", () => {
  let adapter: PhpParserAdapter;
  let mockParserInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new PhpParserAdapter();
    mockParserInstance = {
      setLanguage: vi.fn(),
      parse: vi.fn(),
    };
    vi.mocked(Parser).mockImplementation(() => mockParserInstance);
  });

  it("should have correct properties", () => {
    expect(adapter.language).toBe("php");
    expect(adapter.extensions).toEqual(["php", "php3", "php4", "php5", "phtml"]);
  });

  it("should initialize parser and parse source", async () => {
    const rootNode = new MockNode({ type: "program" });
    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("<?php echo 1;");
    
    expect(Language.load).toHaveBeenCalledWith("mock-php-wasm-url");
    expect(mockParserInstance.setLanguage).toHaveBeenCalled();
    expect(mockParserInstance.parse).toHaveBeenCalledWith("<?php echo 1;");
    expect(mockTree.delete).toHaveBeenCalled();
  });

  it("should throw if parsing fails", async () => {
    mockParserInstance.parse.mockReturnValue(null);
    await expect(adapter.parse("<?php")).rejects.toThrow("PHP parser returned no syntax tree");
  });

  it("should extract entities (function, class, method, etc)", async () => {
    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({
          type: "function_definition",
          startPosition: { row: 5, column: 0 },
          endPosition: { row: 10, column: 0 },
          fields: { name: new MockNode({ type: "name", text: "myFunc" }) }
        }),
        new MockNode({
          type: "class_declaration",
          fields: { name: new MockNode({ type: "name", text: "MyClass" }) }
        }),
        new MockNode({
          type: "method_declaration",
          namedChildren: [
            new MockNode({ type: "visibility_modifier", text: "private" })
          ],
          fields: { name: new MockNode({ type: "name", text: "myMethod" }) }
        }),
        new MockNode({
          type: "method_declaration",
          fields: { name: new MockNode({ type: "name", text: "pubMethod" }) } // public by default
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(4);
    
    const func = result.entities.find(e => e.name === "myFunc");
    expect(func).toMatchObject({ kind: "function", startLine: 6, endLine: 11 });

    const cls = result.entities.find(e => e.name === "MyClass");
    expect(cls).toMatchObject({ kind: "class" });

    const privMethod = result.entities.find(e => e.name === "myMethod");
    expect(privMethod).toMatchObject({ kind: "method", visibility: "private" });

    const pubMethod = result.entities.find(e => e.name === "pubMethod");
    expect(pubMethod).toMatchObject({ kind: "method", visibility: "public" });
  });

  it("should handle public method visibility explicitly", async () => {
    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({
          type: "method_declaration",
          namedChildren: [
            new MockNode({ type: "visibility_modifier", text: "public" })
          ],
          fields: { name: new MockNode({ type: "name", text: "explPubMethod" }) }
        }),
        new MockNode({
          type: "method_declaration",
          namedChildren: [
            new MockNode({ type: "visibility_modifier", text: "static" })
          ],
          fields: { name: new MockNode({ type: "name", text: "otherModifier" }) }
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].visibility).toBe("public");
    expect(result.entities[1].visibility).toBe("public");
  });

  it("should handle anonymous entities", async () => {
    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({ type: "function_definition" })
      ]
    });
    mockParserInstance.parse.mockReturnValue({ rootNode, delete: vi.fn() });

    const result = await adapter.parse("test");
    expect(result.entities[0].name).toBe("<anonymous>");
  });

  it("should extract globals", async () => {
    const rootNode = new MockNode({ type: "program" });
    const exprStmt = new MockNode({ type: "expression_statement", parent: rootNode });
    const assign = new MockNode({
      type: "assignment_expression",
      parent: exprStmt,
      fields: {
        left: new MockNode({ type: "variable_name", text: "$config" })
      }
    });
    exprStmt.namedChildren.push(assign);
    rootNode.namedChildren.push(exprStmt);

    mockParserInstance.parse.mockReturnValue({ rootNode, delete: vi.fn() });

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ name: "$config", kind: "global" });
  });

  it("should resolve gotos", async () => {
    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({
          type: "goto_statement",
          startPosition: { row: 5, column: 0 },
          namedChildren: [new MockNode({ type: "name", text: "end" })]
        }),
        new MockNode({
          type: "named_label_statement",
          startPosition: { row: 10, column: 0 },
          namedChildren: [new MockNode({ type: "name", text: "end" })]
        })
      ]
    });

    mockParserInstance.parse.mockReturnValue({ rootNode, delete: vi.fn() });

    const result = await adapter.parse("test");
    expect(result.gotos).toEqual([
      { label: "end", gotoLine: 6, labelLine: 11 }
    ]);
  });
});
