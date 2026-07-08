import { describe, it, expect, vi, beforeEach } from "vitest";
import { CParserAdapter } from "./cParser";
import { Parser, Language } from "web-tree-sitter";

vi.mock("../runtime", () => ({
  initTreeSitter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("tree-sitter-c/tree-sitter-c.wasm?url", () => ({
  default: "mock-c-wasm-url",
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
    // Tree-sitter's descendantsOfType doesn't return the root node it's called on if it matches, unless it's a child.
    // We adjust by removing 'this' if it's in the results
    const idx = results.indexOf(this);
    if (idx !== -1) results.splice(idx, 1);
    return results;
  }

  childForFieldName(name: string): MockNode | null {
    return this.fields[name] || null;
  }
}

describe("CParserAdapter", () => {
  let adapter: CParserAdapter;
  let mockParserInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CParserAdapter();
    mockParserInstance = {
      setLanguage: vi.fn(),
      parse: vi.fn(),
    };
    vi.mocked(Parser).mockImplementation(() => mockParserInstance);
  });

  it("should have correct properties", () => {
    expect(adapter.language).toBe("c");
    expect(adapter.extensions).toEqual(["c", "h"]);
  });

  it("should initialize parser and parse source", async () => {
    const rootNode = new MockNode({ type: "translation_unit" });
    const mockTree = {
      rootNode,
      delete: vi.fn(),
    };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("int x = 1;");
    
    expect(Language.load).toHaveBeenCalledWith("mock-c-wasm-url");
    expect(mockParserInstance.setLanguage).toHaveBeenCalled();
    expect(mockParserInstance.parse).toHaveBeenCalledWith("int x = 1;");
    expect(mockTree.delete).toHaveBeenCalled();
    expect(result.linesOfCode).toBe(1);
  });

  it("should throw if parsing fails", async () => {
    mockParserInstance.parse.mockReturnValue(null);
    await expect(adapter.parse("int x")).rejects.toThrow("C parser returned no syntax tree");
  });

  it("should extract functions", async () => {
    const funcDecl = new MockNode({
      type: "function_declarator",
      fields: {
        declarator: new MockNode({ type: "identifier", text: "myFunc" })
      }
    });

    const rootNode = new MockNode({
      type: "translation_unit",
      namedChildren: [
        new MockNode({
          type: "function_definition",
          startPosition: { row: 10, column: 0 },
          endPosition: { row: 20, column: 0 },
          fields: {
            declarator: funcDecl
          }
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      name: "myFunc",
      kind: "function",
      startLine: 11,
      endLine: 21
    });
  });

  it("should extract functions with nested declarators but no identifier", async () => {
    const funcDecl = new MockNode({
      type: "function_declarator",
      fields: {
        declarator: new MockNode({ type: "pointer_declarator", namedChildren: [] })
      }
    });

    const rootNode = new MockNode({
      type: "translation_unit",
      namedChildren: [
        new MockNode({
          type: "function_definition",
          startPosition: { row: 10, column: 0 },
          endPosition: { row: 20, column: 0 },
          fields: {
            declarator: funcDecl
          }
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("<anonymous>");
  });

  it("should extract structs/classes with body", async () => {
    const rootNode = new MockNode({
      type: "translation_unit",
      namedChildren: [
        new MockNode({
          type: "struct_specifier",
          fields: {
            name: new MockNode({ type: "type_identifier", text: "MyStruct" }),
            body: new MockNode({ type: "field_declaration_list" })
          }
        }),
        // Should skip struct without body
        new MockNode({
          type: "struct_specifier",
          fields: {
            name: new MockNode({ type: "type_identifier", text: "OpaqueStruct" })
          }
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("MyStruct");
  });

  it("should extract globals", async () => {
    const rootNode = new MockNode({ type: "translation_unit" });
    const decl = new MockNode({
      type: "declaration",
      parent: rootNode,
      namedChildren: [
        new MockNode({ type: "identifier", text: "myGlobal" })
      ]
    });
    rootNode.namedChildren.push(decl);

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      name: "myGlobal",
      kind: "global"
    });
  });

  it("should ignore declarations inside functions", async () => {
    const rootNode = new MockNode({ type: "translation_unit" });
    const funcDef = new MockNode({ type: "function_definition", parent: rootNode });
    const decl = new MockNode({
      type: "declaration",
      parent: funcDef,
      namedChildren: [
        new MockNode({ type: "identifier", text: "local" })
      ]
    });
    funcDef.namedChildren.push(decl);
    rootNode.namedChildren.push(funcDef);

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    // Should extract function (anonymous), but not the local declaration
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].kind).toBe("function");
    expect(result.entities[0].name).toBe("<anonymous>");
  });

  it("should resolve gotos", async () => {
    const rootNode = new MockNode({
      type: "translation_unit",
      namedChildren: [
        new MockNode({
          type: "goto_statement",
          startPosition: { row: 5, column: 0 },
          fields: { label: new MockNode({ type: "identifier", text: "end" }) }
        }),
        new MockNode({
          type: "labeled_statement",
          startPosition: { row: 10, column: 0 },
          fields: { label: new MockNode({ type: "identifier", text: "end" }) }
        })
      ]
    });

    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("test");
    expect(result.gotos).toEqual([
      { label: "end", gotoLine: 6, labelLine: 11 }
    ]);
  });
});
