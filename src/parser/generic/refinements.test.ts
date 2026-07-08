import { describe, it, expect } from "vitest";
import * as ref from "./refinements";
import type { CodeEntity } from "../types";

class MockNode {
  type: string;
  isNamed: boolean = true;
  text: string;
  parent: MockNode | null = null;
  namedChildren: MockNode[] = [];
  startIndex: number = 0;
  endIndex: number = 0;
  fields: Record<string, MockNode> = {};

  constructor(options: Partial<MockNode>) {
    this.type = options.type || "unknown";
    this.text = options.text || "";
    if (options.startIndex !== undefined) this.startIndex = options.startIndex;
    if (options.endIndex !== undefined) this.endIndex = options.endIndex;
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

  childForFieldName(name: string): MockNode | null {
    return this.fields[name] || null;
  }
}

const baseEntity: CodeEntity = {
  name: "test",
  kind: "function",
  startLine: 1,
  endLine: 2,
  complexityScore: 1,
  nestingDepth: 0,
};

describe("refinements", () => {
  describe("javascriptLike", () => {
    it("filters only function-valued declarators/fields", () => {
      const nodeFunc = new MockNode({
        type: "variable_declarator",
        fields: { value: new MockNode({ type: "arrow_function" }) }
      });
      const nodeObj = new MockNode({
        type: "variable_declarator",
        fields: { value: new MockNode({ type: "object" }) }
      });
      const nodeOther = new MockNode({ type: "if_statement" });

      expect(ref.javascriptLike.filter!(nodeFunc as any)).toBe(true);
      expect(ref.javascriptLike.filter!(nodeObj as any)).toBe(false);
      expect(ref.javascriptLike.filter!(nodeOther as any)).toBe(true);
    });

    it("refines name for variable_declarator", () => {
      const node = new MockNode({
        type: "variable_declarator",
        fields: { name: new MockNode({ type: "identifier", text: "myArrowFunc" }) }
      });
      const refined = ref.javascriptLike.refine!(node as any, baseEntity);
      const nodeOther = new MockNode({ type: "other_node" });
      const refinedOther = ref.javascriptLike.refine!(nodeOther as any, baseEntity);
      expect(refinedOther).toBe(baseEntity);
    });
  });

  describe("python", () => {
    it("identifies methods and visibility", () => {
      const block = new MockNode({ type: "block" });
      const cls = new MockNode({ type: "class_definition", namedChildren: [block] });
      block.parent = cls;

      const nodePublic = new MockNode({ type: "function_definition", parent: block });
      const refinedPublic = ref.python.refine!(nodePublic as any, { ...baseEntity, name: "pub" });
      expect(refinedPublic).toMatchObject({ kind: "method", visibility: "public" });

      const nodePrivate = new MockNode({ type: "function_definition", parent: block });
      const refinedPrivate = ref.python.refine!(nodePrivate as any, { ...baseEntity, name: "__priv" });
      expect(refinedPrivate).toMatchObject({ kind: "method", visibility: "private" });

      const nodeProtected = new MockNode({ type: "function_definition", parent: block });
      const refinedProtected = ref.python.refine!(nodeProtected as any, { ...baseEntity, name: "_prot" });
      expect(refinedProtected).toMatchObject({ kind: "method", visibility: "protected" });

      const nodeDunder = new MockNode({ type: "function_definition", parent: block });
      const refinedDunder = ref.python.refine!(nodeDunder as any, { ...baseEntity, name: "__init__" });
      expect(refinedDunder).toMatchObject({ kind: "method", visibility: "public" });

      const notFunc = new MockNode({ type: "other" });
      expect(ref.python.refine!(notFunc as any, baseEntity)).toBe(baseEntity);

      const notMethod = new MockNode({ type: "function_definition" });
      expect(ref.python.refine!(notMethod as any, baseEntity)).toBe(baseEntity);
    });
  });

  describe("java", () => {
    it("extracts visibility from modifiers", () => {
      const method = { ...baseEntity, kind: "method" as const };
      const nodePriv = new MockNode({ type: "method_declaration", namedChildren: [new MockNode({ type: "modifiers", text: "private static" })]});
      expect(ref.java.refine!(nodePriv as any, method).visibility).toBe("private");

      const nodeProt = new MockNode({ type: "method_declaration", namedChildren: [new MockNode({ type: "modifiers", text: "protected" })]});
      expect(ref.java.refine!(nodeProt as any, method).visibility).toBe("protected");

      const nodePub = new MockNode({ type: "method_declaration", namedChildren: [new MockNode({ type: "modifiers", text: "public" })]});
      expect(ref.java.refine!(nodePub as any, method).visibility).toBe("public");

      const nodeNone = new MockNode({ type: "method_declaration" });
      expect(ref.java.refine!(nodeNone as any, method).visibility).toBe("public");

      const notMethod = { ...baseEntity, kind: "class" as const };
      expect(ref.java.refine!(nodePub as any, notMethod)).toBe(notMethod);
    });
  });

  describe("csharp", () => {
    it("extracts visibility from separate modifier children", () => {
      const method = { ...baseEntity, kind: "method" as const };
      const nodePub = new MockNode({ type: "method_declaration", namedChildren: [new MockNode({ type: "modifier", text: "public" })]});
      expect(ref.csharp.refine!(nodePub as any, method).visibility).toBe("public");

      const nodeProt = new MockNode({ type: "method_declaration", namedChildren: [new MockNode({ type: "modifier", text: "protected" })]});
      expect(ref.csharp.refine!(nodeProt as any, method).visibility).toBe("protected");

      const nodeNone = new MockNode({ type: "method_declaration", namedChildren: [] });
      expect(ref.csharp.refine!(nodeNone as any, method).visibility).toBe("private");

      const notMethod = { ...baseEntity, kind: "class" as const };
      expect(ref.csharp.refine!(nodePub as any, notMethod)).toBe(notMethod);
    });
  });

  describe("scala", () => {
    it("identifies methods and extracts access_modifier", () => {
      const parent = new MockNode({ type: "template_body" });
      const nodePriv = new MockNode({
        type: "function_definition",
        parent,
        namedChildren: [
          new MockNode({ type: "modifiers", namedChildren: [new MockNode({ type: "access_modifier", text: "private[this]" })]})
        ]
      });
      const refined = ref.scala.refine!(nodePriv as any, baseEntity);
      expect(refined).toMatchObject({ kind: "method", visibility: "private" });

      const nodeProt = new MockNode({
        type: "function_definition",
        parent,
        namedChildren: [
          new MockNode({ type: "modifiers", namedChildren: [new MockNode({ type: "access_modifier", text: "protected" })]})
        ]
      });
      const refinedProt = ref.scala.refine!(nodeProt as any, baseEntity);
      expect(refinedProt).toMatchObject({ kind: "method", visibility: "protected" });

      const nodePub = new MockNode({
        type: "function_definition",
        parent,
      });
      const refinedPub = ref.scala.refine!(nodePub as any, baseEntity);
      expect(refinedPub).toMatchObject({ kind: "method", visibility: "public" });

      const notMethod = new MockNode({ type: "function_definition" });
      expect(ref.scala.refine!(notMethod as any, baseEntity)).toBe(baseEntity);

      const notFunc = new MockNode({ type: "other" });
      expect(ref.scala.refine!(notFunc as any, baseEntity)).toBe(baseEntity);
    });
  });

  describe("rust", () => {
    it("identifies methods inside impl/trait and visibility", () => {
      const implItem = new MockNode({ type: "impl_item" });
      const declList = new MockNode({ type: "declaration_list", parent: implItem });
      const nodePub = new MockNode({
        type: "function_item",
        parent: declList,
        namedChildren: [new MockNode({ type: "visibility_modifier", text: "pub" })]
      });
      const refined = ref.rust.refine!(nodePub as any, baseEntity);
      expect(refined).toMatchObject({ kind: "method", visibility: "public" });

      const nodePriv = new MockNode({
        type: "function_item",
        parent: declList,
        namedChildren: []
      });
      const refinedPriv = ref.rust.refine!(nodePriv as any, baseEntity);
      expect(refinedPriv).toMatchObject({ kind: "method", visibility: "private" });
    });
  });

  describe("go", () => {
    it("filters type_spec correctly", () => {
      const nodeStruct = new MockNode({ type: "type_spec", fields: { type: new MockNode({ type: "struct_type" }) }});
      const nodeAlias = new MockNode({ type: "type_spec", fields: { type: new MockNode({ type: "type_identifier" }) }});
      expect(ref.go.filter!(nodeStruct as any)).toBe(true);
      expect(ref.go.filter!(nodeAlias as any)).toBe(false);
    });

    it("refines type_spec kind and function visibility", () => {
      const nodeStruct = new MockNode({ type: "type_spec", fields: { type: new MockNode({ type: "struct_type" }) }});
      expect(ref.go.refine!(nodeStruct as any, baseEntity).kind).toBe("class");

      const nodeInterface = new MockNode({ type: "type_spec", fields: { type: new MockNode({ type: "interface_type" }) }});
      expect(ref.go.refine!(nodeInterface as any, baseEntity).kind).toBe("interface");

      const nodeFuncPub = new MockNode({ type: "function_declaration" });
      expect(ref.go.refine!(nodeFuncPub as any, { ...baseEntity, name: "Exported" }).visibility).toBe("public");

      const nodeFuncPriv = new MockNode({ type: "function_declaration" });
      expect(ref.go.refine!(nodeFuncPriv as any, { ...baseEntity, name: "unexported" }).visibility).toBe("private");

      const notFunc = new MockNode({ type: "other" });
      expect(ref.go.refine!(notFunc as any, baseEntity)).toBe(baseEntity);
    });
  });

  describe("cpp", () => {
    it("identifies methods and calculates visibility from preceding access_specifier", () => {
      const struct = new MockNode({ type: "struct_specifier" });
      const list = new MockNode({ type: "field_declaration_list", parent: struct });
      const access = new MockNode({ type: "access_specifier", text: "private:", startIndex: 5, endIndex: 10, parent: list });
      const func = new MockNode({ type: "function_definition", startIndex: 15, endIndex: 20, parent: list });
      list.namedChildren = [access, func];

      const refined = ref.cpp.refine!(func as any, baseEntity);
      expect(refined).toMatchObject({ kind: "method", visibility: "private" });

      const notMethod = new MockNode({ type: "function_definition" });
      expect(ref.cpp.refine!(notMethod as any, baseEntity)).toBe(baseEntity);

      const notFunc = new MockNode({ type: "other" });
      expect(ref.cpp.refine!(notFunc as any, baseEntity)).toBe(baseEntity);
    });
  });

  describe("objc", () => {
    it("filters out method_declaration", () => {
      expect(ref.objc.filter!(new MockNode({ type: "method_declaration" }) as any)).toBe(false);
      expect(ref.objc.filter!(new MockNode({ type: "method_definition" }) as any)).toBe(true);
    });

    it("builds selector name from identifiers", () => {
      const node = new MockNode({
        type: "method_definition",
        namedChildren: [
          new MockNode({ type: "identifier", text: "initWithValue" }),
          new MockNode({ type: "method_parameter" }),
          new MockNode({ type: "identifier", text: "andError" }),
          new MockNode({ type: "method_parameter" })
        ]
      });
      const refined = ref.objc.refine!(node as any, baseEntity);
      expect(refined.name).toBe("initWithValue:andError:");
    });
  });

  describe("ruby", () => {
    it("calculates visibility from preceding siblings", () => {
      const cls = new MockNode({ type: "class" });
      const priv = new MockNode({ type: "identifier", text: "private", startIndex: 5, endIndex: 10, parent: cls });
      const method = new MockNode({ type: "method", startIndex: 15, endIndex: 20, parent: cls });
      cls.namedChildren = [priv, method];

      const refined = ref.ruby.refine!(method as any, baseEntity);
      expect(refined.visibility).toBe("private");
    });
  });
});
