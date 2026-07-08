// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GenericParserAdapter } from "./genericParser";
import { Parser, Language } from "web-tree-sitter";

vi.mock("../runtime", () => ({
  initTreeSitter: vi.fn().mockResolvedValue(undefined),
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
  startIndex: number = 0;
  endIndex: number = 0;
  startPosition = { row: 0, column: 0 };
  endPosition = { row: 0, column: 0 };
  fields: Record<string, MockNode> = {};

  constructor(options: Partial<MockNode>) {
    this.type = options.type || "unknown";
    this.text = options.text || "";
    if (options.isNamed !== undefined) this.isNamed = options.isNamed;
    if (options.startIndex !== undefined) this.startIndex = options.startIndex;
    if (options.endIndex !== undefined) this.endIndex = options.endIndex;
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

describe("GenericParserAdapter", () => {
  let mockParserInstance: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockParserInstance = {
      setLanguage: vi.fn(),
      parse: vi.fn(),
    };
    vi.mocked(Parser).mockImplementation(() => mockParserInstance);
  });

  it("should have correct properties", () => {
    const adapter = new GenericParserAdapter({
      id: "testlang",
      extensions: ["test"],
      wasmUrl: "mock-url"
    });
    expect(adapter.language).toBe("testlang");
    expect(adapter.extensions).toEqual(["test"]);
  });

  it("should parse using the tree-sitter parser and cache it", async () => {
    const adapter = new GenericParserAdapter({ id: "testlang", extensions: ["test"], wasmUrl: "mock-url" });
    const rootNode = new MockNode({ type: "program" });
    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    await adapter.parse("code");
    await adapter.parse("code2"); // Should reuse cached parser
    
    expect(Language.load).toHaveBeenCalledTimes(1); // called once
    expect(mockParserInstance.parse).toHaveBeenCalledTimes(2);
  });

  it("should throw if no tree is returned", async () => {
    const adapter = new GenericParserAdapter({ id: "testlang", extensions: ["test"], wasmUrl: "mock-url" });
    mockParserInstance.parse.mockReturnValue(null);

    await expect(adapter.parse("code")).rejects.toThrow("testlang parser returned no syntax tree");
  });

  it("should extract entities via vocabulary", async () => {
    const adapter = new GenericParserAdapter({ id: "testlang", extensions: ["test"], wasmUrl: "mock-url" });
    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({
          type: "function_definition",
          startPosition: { row: 10, column: 0 },
          endPosition: { row: 15, column: 0 },
          fields: { name: new MockNode({ type: "identifier", text: "secondFunc" }) }
        }),
        new MockNode({
          type: "function_definition",
          startPosition: { row: 5, column: 0 },
          endPosition: { row: 8, column: 0 },
          fields: { name: new MockNode({ type: "identifier", text: "firstFunc" }) }
        }),
        new MockNode({
          type: "function_definition",
          startPosition: { row: 5, column: 0 },
          endPosition: { row: 6, column: 0 },
          fields: { name: new MockNode({ type: "identifier", text: "firstFuncShorter" }) }
        })
      ]
    });
    const mockTree = { rootNode, delete: vi.fn() };
    mockParserInstance.parse.mockReturnValue(mockTree);

    const result = await adapter.parse("code");
    expect(result.entities).toHaveLength(3);
    // ordered by startLine then endLine
    expect(result.entities[0].name).toBe("firstFuncShorter");
    expect(result.entities[1].name).toBe("firstFunc");
    expect(result.entities[2].name).toBe("secondFunc");
  });

  it("should apply config refine and filter", async () => {
    const adapter = new GenericParserAdapter({
      id: "testlang",
      extensions: ["test"],
      wasmUrl: "mock-url",
      extraEntityTypes: { custom_node: "function" },
      filter: (n) => n.text !== "skipme",
      refine: (n, e) => ({ ...e, name: e.name + "Refined" })
    });

    const rootNode = new MockNode({
      type: "program",
      namedChildren: [
        new MockNode({
          type: "custom_node",
          text: "keepme",
          fields: { name: new MockNode({ type: "identifier", text: "keep" }) }
        }),
        new MockNode({
          type: "custom_node",
          text: "skipme",
          fields: { name: new MockNode({ type: "identifier", text: "skip" }) }
        })
      ]
    });
    mockParserInstance.parse.mockReturnValue({ rootNode, delete: vi.fn() });

    const result = await adapter.parse("code");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe("keepRefined");
    expect(result.entities[0].kind).toBe("function");
  });

  it("should extract globals", async () => {
    const adapter = new GenericParserAdapter({ id: "testlang", extensions: ["test"], wasmUrl: "mock-url" });
    const rootNode = new MockNode({ type: "program" });
    const decl = new MockNode({
      type: "variable_declaration",
      parent: rootNode,
      namedChildren: [new MockNode({ type: "identifier", text: "myGlobal" })]
    });
    rootNode.namedChildren.push(decl);

    mockParserInstance.parse.mockReturnValue({ rootNode, delete: vi.fn() });

    const result = await adapter.parse("code");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].kind).toBe("global");
    expect(result.entities[0].name).toBe("myGlobal");
  });
});
