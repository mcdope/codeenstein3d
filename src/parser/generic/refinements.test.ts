// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * refinements.ts only imports the tree-sitter `Node` TYPE (erased at compile
 * time) — these tests parse real tiny snippets with each language's actual
 * bundled grammar (already proven working under Vitest via the Phase 0
 * `?url`-as-path plugin) to get genuine node ancestry/structure, then supply
 * a synthetic stub `CodeEntity` as the second `refine()` argument (its
 * fields are simple test inputs, not something worth re-deriving from a real
 * parse). A couple of branches (cpp's `!list`, ruby's `!body`) are only
 * reachable if a refine hook is called with a parentless node, which never
 * happens via the real `refine: (node, entity) => …` call sites in
 * genericParser.ts — those two use a minimal synthetic node instead.
 */
import { Language, Parser, type Node } from "web-tree-sitter";
import jsWasmUrl from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import pyWasmUrl from "tree-sitter-python/tree-sitter-python.wasm?url";
import javaWasmUrl from "tree-sitter-java/tree-sitter-java.wasm?url";
import cppWasmUrl from "tree-sitter-cpp/tree-sitter-cpp.wasm?url";
import goWasmUrl from "tree-sitter-go/tree-sitter-go.wasm?url";
import rustWasmUrl from "tree-sitter-rust/tree-sitter-rust.wasm?url";
import rubyWasmUrl from "tree-sitter-ruby/tree-sitter-ruby.wasm?url";
import csharpWasmUrl from "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm?url";
import scalaWasmUrl from "tree-sitter-scala/tree-sitter-scala.wasm?url";
import objcWasmUrl from "tree-sitter-objc/tree-sitter-objc.wasm?url";
import { beforeAll, describe, expect, it } from "vitest";
import type { CodeEntity } from "../types";
import { initTreeSitter } from "../runtime";
import { cpp, csharp, go, java, javascriptLike, objc, python, ruby, rust, scala } from "./refinements";

const languages = new Map<string, Language>();

async function loadLang(id: string, wasmUrl: string): Promise<Language> {
  const cached = languages.get(id);
  if (cached) return cached;
  const lang = await Language.load(wasmUrl);
  languages.set(id, lang);
  return lang;
}

beforeAll(async () => {
  await initTreeSitter();
});

function parse(lang: Language, source: string): Node {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error("parse failed");
  return tree.rootNode;
}

function find(root: Node, type: string, matchIndex = 0): Node {
  const matches = root.descendantsOfType(type);
  const node = matches[matchIndex];
  if (!node) throw new Error(`no "${type}" node found (index ${matchIndex})`);
  return node;
}

function stubEntity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "x", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0, ...overrides };
}

describe("javascriptLike", () => {
  let js: Language;
  beforeAll(async () => {
    js = await loadLang("js", jsWasmUrl);
  });

  it("filter: true for a function-valued variable_declarator", () => {
    const root = parse(js, "const foo = () => {};");
    expect(javascriptLike.filter!(find(root, "variable_declarator"))).toBe(true);
  });

  it("filter: false for a non-function-valued variable_declarator", () => {
    const root = parse(js, "const foo = 5;");
    expect(javascriptLike.filter!(find(root, "variable_declarator"))).toBe(false);
  });

  it("filter: true for a function-valued class field_definition", () => {
    const root = parse(js, "class C { foo = () => {} }");
    expect(javascriptLike.filter!(find(root, "field_definition"))).toBe(true);
  });

  it("filter: recognizes function_expression values too", () => {
    const root = parse(js, "const foo = function() {};");
    expect(javascriptLike.filter!(find(root, "variable_declarator"))).toBe(true);
  });

  it("filter: true (default) for a node type outside the special three", () => {
    const root = parse(js, "function bar() {}");
    expect(javascriptLike.filter!(find(root, "function_declaration"))).toBe(true);
  });

  it("refine: renames a variable_declarator entity to its declared name", () => {
    const root = parse(js, "const foo = () => {};");
    const entity = javascriptLike.refine!(find(root, "variable_declarator"), stubEntity({ name: "placeholder" }));
    expect(entity.name).toBe("foo");
  });

  it("refine: falls back to the entity's existing name when the name field is missing", () => {
    const fakeNode = { type: "variable_declarator", childForFieldName: () => null } as unknown as Node;
    const entity = javascriptLike.refine!(fakeNode, stubEntity({ name: "kept" }));
    expect(entity.name).toBe("kept");
  });

  it("refine: leaves an unrelated node type's entity unchanged", () => {
    const root = parse(js, "function bar() {}");
    const original = stubEntity({ name: "bar" });
    expect(javascriptLike.refine!(find(root, "function_declaration"), original)).toEqual(original);
  });
});

describe("python", () => {
  let py: Language;
  beforeAll(async () => {
    py = await loadLang("py", pyWasmUrl);
  });

  it("leaves a non-function_definition node's entity unchanged", () => {
    const root = parse(py, "class C:\n    pass\n");
    const original = stubEntity();
    expect(python.refine!(find(root, "class_definition"), original)).toEqual(original);
  });

  it("leaves a top-level function's entity unchanged (not a method)", () => {
    const root = parse(py, "def top_level():\n    pass\n");
    const original = stubEntity({ kind: "function" });
    expect(python.refine!(find(root, "function_definition"), original)).toEqual(original);
  });

  it("reclassifies a class method as 'method', dunder stays public", () => {
    const root = parse(py, "class C:\n    def __init__(self):\n        pass\n");
    const entity = python.refine!(find(root, "function_definition"), stubEntity({ name: "__init__" }));
    expect(entity.kind).toBe("method");
    expect(entity.visibility).toBe("public");
  });

  it("a name-mangled double-underscore method (not dunder) is private", () => {
    const root = parse(py, "class C:\n    def m(self):\n        pass\n");
    const entity = python.refine!(find(root, "function_definition"), stubEntity({ name: "__secret" }));
    expect(entity.visibility).toBe("private");
  });

  it("a single-underscore method is protected", () => {
    const root = parse(py, "class C:\n    def m(self):\n        pass\n");
    const entity = python.refine!(find(root, "function_definition"), stubEntity({ name: "_helper" }));
    expect(entity.visibility).toBe("protected");
  });

  it("a plain-named method is public", () => {
    const root = parse(py, "class C:\n    def m(self):\n        pass\n");
    const entity = python.refine!(find(root, "function_definition"), stubEntity({ name: "normal" }));
    expect(entity.visibility).toBe("public");
  });
});

describe("java", () => {
  let javaLang: Language;
  beforeAll(async () => {
    javaLang = await loadLang("java", javaWasmUrl);
  });

  it("leaves a non-method entity unchanged", () => {
    const root = parse(javaLang, "class C { private void a() {} }");
    const original = stubEntity({ kind: "function" });
    expect(java.refine!(find(root, "method_declaration"), original)).toEqual(original);
  });

  it("private modifier -> private visibility", () => {
    const root = parse(javaLang, "class C { private void a() {} }");
    const entity = java.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" }));
    expect(entity.visibility).toBe("private");
  });

  it("protected modifier -> protected visibility", () => {
    const root = parse(javaLang, "class C { protected void b() {} }");
    const entity = java.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" }));
    expect(entity.visibility).toBe("protected");
  });

  it("public modifier -> public visibility", () => {
    const root = parse(javaLang, "class C { public void c() {} }");
    const entity = java.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" }));
    expect(entity.visibility).toBe("public");
  });

  it("no modifiers at all -> defaults to public (package-private)", () => {
    const root = parse(javaLang, "class C { void d() {} }");
    const entity = java.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" }));
    expect(entity.visibility).toBe("public");
  });
});

describe("csharp", () => {
  let cs: Language;
  beforeAll(async () => {
    cs = await loadLang("csharp", csharpWasmUrl);
  });

  it("leaves a non-method entity unchanged", () => {
    const root = parse(cs, "class C { public void A() {} }");
    const original = stubEntity({ kind: "function" });
    expect(csharp.refine!(find(root, "method_declaration"), original)).toEqual(original);
  });

  it("public modifier -> public visibility", () => {
    const root = parse(cs, "class C { public void A() {} }");
    expect(csharp.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" })).visibility).toBe("public");
  });

  it("protected modifier -> protected visibility", () => {
    const root = parse(cs, "class C { protected void B() {} }");
    expect(csharp.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" })).visibility).toBe(
      "protected",
    );
  });

  it("private modifier -> private visibility", () => {
    const root = parse(cs, "class C { private void C() {} }");
    expect(csharp.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" })).visibility).toBe(
      "private",
    );
  });

  it("no modifiers at all -> defaults to private", () => {
    const root = parse(cs, "class C { void D() {} }");
    expect(csharp.refine!(find(root, "method_declaration"), stubEntity({ kind: "method" })).visibility).toBe(
      "private",
    );
  });
});

describe("scala", () => {
  let scalaLang: Language;
  beforeAll(async () => {
    scalaLang = await loadLang("scala", scalaWasmUrl);
  });

  it("leaves an unrelated node type's entity unchanged", () => {
    const root = parse(scalaLang, "class C {}");
    const original = stubEntity();
    expect(scala.refine!(find(root, "class_definition"), original)).toEqual(original);
  });

  it("leaves a top-level def's entity unchanged (not inside a template_body)", () => {
    const root = parse(scalaLang, "def topLevel() = {}");
    const original = stubEntity({ kind: "function" });
    expect(scala.refine!(find(root, "function_definition"), original)).toEqual(original);
  });

  it("a private class member becomes a private method", () => {
    const root = parse(scalaLang, "class C { private def a() = {} }");
    const entity = scala.refine!(find(root, "function_definition"), stubEntity());
    expect(entity.kind).toBe("method");
    expect(entity.visibility).toBe("private");
  });

  it("a protected class member becomes a protected method", () => {
    const root = parse(scalaLang, "class C { protected def b() = {} }");
    expect(scala.refine!(find(root, "function_definition"), stubEntity()).visibility).toBe("protected");
  });

  it("a class member with no access modifier defaults to public", () => {
    const root = parse(scalaLang, "class C { def c() = {} }");
    expect(scala.refine!(find(root, "function_definition"), stubEntity()).visibility).toBe("public");
  });
});

describe("rust", () => {
  let rustLang: Language;
  beforeAll(async () => {
    rustLang = await loadLang("rust", rustWasmUrl);
  });

  it("leaves a non-function-item entity unchanged", () => {
    const root = parse(rustLang, "struct S;");
    const original = stubEntity();
    expect(rust.refine!(find(root, "struct_item"), original)).toEqual(original);
  });

  it("leaves a top-level fn's entity unchanged (not a member)", () => {
    const root = parse(rustLang, "fn top() {}");
    const original = stubEntity({ kind: "function" });
    expect(rust.refine!(find(root, "function_item"), original)).toEqual(original);
  });

  it("a pub fn inside an impl block becomes a public method", () => {
    const root = parse(rustLang, "impl Foo { pub fn a() {} }");
    const entity = rust.refine!(find(root, "function_item"), stubEntity());
    expect(entity.kind).toBe("method");
    expect(entity.visibility).toBe("public");
  });

  it("a non-pub fn inside an impl block becomes a private method", () => {
    const root = parse(rustLang, "impl Foo { fn b() {} }");
    expect(rust.refine!(find(root, "function_item"), stubEntity()).visibility).toBe("private");
  });

  it("a fn signature inside a trait block is also a member", () => {
    const root = parse(rustLang, "trait T { fn c(); }");
    const entity = rust.refine!(find(root, "function_signature_item"), stubEntity());
    expect(entity.kind).toBe("method");
  });
});

describe("go", () => {
  let goLang: Language;
  beforeAll(async () => {
    goLang = await loadLang("go", goWasmUrl);
  });

  it("filter: true (default) for a node type outside type_spec", () => {
    const root = parse(goLang, "func Foo() {}");
    expect(go.filter!(find(root, "function_declaration"))).toBe(true);
  });

  it("filter: true for a struct type_spec", () => {
    const root = parse(goLang, "type Foo struct{}");
    expect(go.filter!(find(root, "type_spec"))).toBe(true);
  });

  it("filter: true for an interface type_spec", () => {
    const root = parse(goLang, "type Bar interface{}");
    expect(go.filter!(find(root, "type_spec"))).toBe(true);
  });

  it("filter: false for a plain type alias", () => {
    const root = parse(goLang, "type Baz int");
    expect(go.filter!(find(root, "type_spec"))).toBe(false);
  });

  it("refine: a struct type_spec becomes kind 'class'", () => {
    const root = parse(goLang, "type Foo struct{}");
    expect(go.refine!(find(root, "type_spec"), stubEntity()).kind).toBe("class");
  });

  it("refine: an interface type_spec becomes kind 'interface'", () => {
    const root = parse(goLang, "type Bar interface{}");
    expect(go.refine!(find(root, "type_spec"), stubEntity()).kind).toBe("interface");
  });

  it("refine: an exported (capitalized) function is public", () => {
    const root = parse(goLang, "func Exported() {}");
    const entity = go.refine!(find(root, "function_declaration"), stubEntity({ name: "Exported" }));
    expect(entity.visibility).toBe("public");
  });

  it("refine: an unexported (lowercase) function is private", () => {
    const root = parse(goLang, "func unexported() {}");
    const entity = go.refine!(find(root, "function_declaration"), stubEntity({ name: "unexported" }));
    expect(entity.visibility).toBe("private");
  });

  it("refine: a method_declaration is also visibility-tagged", () => {
    const root = parse(goLang, "func (r *R) Method() {}");
    const entity = go.refine!(find(root, "method_declaration"), stubEntity({ name: "Method" }));
    expect(entity.visibility).toBe("public");
  });

  it("refine: leaves an unrelated node type's entity unchanged", () => {
    const root = parse(goLang, "package main\ntype Baz int");
    const original = stubEntity();
    expect(go.refine!(find(root, "package_clause"), original)).toEqual(original);
  });

  it("filter: falls back to namedChildren[1] when there's no 'type' field", () => {
    // Real tree-sitter-go type_spec nodes always expose a "type" field (all
    // prior tests hit it) — this fallback only exists for grammar-quirk
    // defensiveness, exercised here with a synthetic node.
    const fakeStruct = { type: "struct_type" };
    const fakeNode = {
      type: "type_spec",
      childForFieldName: () => null,
      namedChildren: [{ type: "type_identifier" }, fakeStruct],
    } as unknown as Node;
    expect(go.filter!(fakeNode)).toBe(true);
  });

  it("refine: falls back to namedChildren[1] when there's no 'type' field", () => {
    const fakeNode = {
      type: "type_spec",
      childForFieldName: () => null,
      namedChildren: [{ type: "type_identifier" }, { type: "interface_type" }],
    } as unknown as Node;
    expect(go.refine!(fakeNode, stubEntity()).kind).toBe("interface");
  });
});

describe("cpp", () => {
  let cppLang: Language;
  beforeAll(async () => {
    cppLang = await loadLang("cpp", cppWasmUrl);
  });

  it("leaves a non-function_definition entity unchanged", () => {
    const root = parse(cppLang, "class C {};");
    const original = stubEntity();
    expect(cpp.refine!(find(root, "class_specifier"), original)).toEqual(original);
  });

  it("leaves a top-level function's entity unchanged (not a class member)", () => {
    const root = parse(cppLang, "void top() {}");
    const original = stubEntity({ kind: "function" });
    expect(cpp.refine!(find(root, "function_definition"), original)).toEqual(original);
  });

  it("a struct member defaults to public before any access_specifier", () => {
    const root = parse(cppLang, "struct S { void d() {} };");
    const entity = cpp.refine!(find(root, "function_definition"), stubEntity());
    expect(entity.kind).toBe("method");
    expect(entity.visibility).toBe("public");
  });

  it("a class member defaults to private before any access_specifier", () => {
    const root = parse(cppLang, "class C { void a() {} };");
    expect(cpp.refine!(find(root, "function_definition"), stubEntity()).visibility).toBe("private");
  });

  it("visibility follows the nearest preceding access_specifier", () => {
    const root = parse(cppLang, "class C { public: void a() {} private: void b() {} protected: void c() {} };");
    const methods = root.descendantsOfType("function_definition");
    expect(cpp.refine!(methods[0], stubEntity()).visibility).toBe("public");
    expect(cpp.refine!(methods[1], stubEntity()).visibility).toBe("private");
    expect(cpp.refine!(methods[2], stubEntity()).visibility).toBe("protected");
  });

});

describe("objc", () => {
  let objcLang: Language;
  beforeAll(async () => {
    objcLang = await loadLang("objc", objcWasmUrl);
  });

  it("filter: false for a method_declaration (interface prototype)", () => {
    const root = parse(objcLang, "@interface Foo\n- (void)proto;\n@end\n");
    expect(objc.filter!(find(root, "method_declaration"))).toBe(false);
  });

  it("filter: true (default) for anything else", () => {
    const root = parse(objcLang, "@implementation Foo\n- (void)simple {}\n@end\n");
    expect(objc.filter!(find(root, "method_definition"))).toBe(true);
  });

  it("leaves a non-method_definition entity unchanged", () => {
    const root = parse(objcLang, "@interface Foo\n@end\n");
    const original = stubEntity();
    expect(objc.refine!(find(root, "identifier"), original)).toEqual(original);
  });

  it("assembles a multi-part colon-joined selector for a method with params", () => {
    const root = parse(objcLang, "@implementation Foo\n- (void)add:(int)x with:(int)y {}\n@end\n");
    const entity = objc.refine!(find(root, "method_definition"), stubEntity());
    expect(entity.name).toBe("add:with:");
  });

  it("uses the bare identifier for a parameterless method", () => {
    const root = parse(objcLang, "@implementation Foo\n- (void)simple {}\n@end\n");
    const entity = objc.refine!(find(root, "method_definition"), stubEntity());
    expect(entity.name).toBe("simple");
  });

  it("falls back to <anonymous> when no identifier children exist at all", () => {
    const fakeNode = { type: "method_definition", namedChildren: [] } as unknown as Node;
    expect(objc.refine!(fakeNode, stubEntity()).name).toBe("<anonymous>");
  });
});

describe("ruby", () => {
  let rubyLang: Language;
  beforeAll(async () => {
    rubyLang = await loadLang("ruby", rubyWasmUrl);
  });

  it("leaves a non-method/singleton_method entity unchanged", () => {
    const root = parse(rubyLang, "class C\nend\n");
    const original = stubEntity();
    expect(ruby.refine!(find(root, "class"), original)).toEqual(original);
  });

  it("a method before any visibility toggle is public", () => {
    const root = parse(rubyLang, "class C\n  def a\n  end\nend\n");
    expect(ruby.refine!(find(root, "method"), stubEntity()).visibility).toBe("public");
  });

  it("a method after a private toggle is private", () => {
    const root = parse(rubyLang, "class C\n  private\n  def b\n  end\nend\n");
    expect(ruby.refine!(find(root, "method"), stubEntity()).visibility).toBe("private");
  });

  it("a method after a protected toggle is protected", () => {
    const root = parse(rubyLang, "class C\n  protected\n  def c\n  end\nend\n");
    expect(ruby.refine!(find(root, "method"), stubEntity()).visibility).toBe("protected");
  });

  it("a method after an explicit public toggle (following a private one) is public again", () => {
    const root = parse(rubyLang, "class C\n  private\n  public\n  def d\n  end\nend\n");
    expect(ruby.refine!(find(root, "method"), stubEntity()).visibility).toBe("public");
  });

  it("a singleton_method is also visibility-tagged", () => {
    const root = parse(rubyLang, "class C\n  def self.e\n  end\nend\n");
    const entity = ruby.refine!(find(root, "singleton_method"), stubEntity());
    expect(entity.visibility).toBe("public");
  });

  it("rubyVisibility's defensive !body branch is unreachable via refine's own call sites, covered synthetically", () => {
    // A real parsed "method"/"singleton_method" node always has a non-null
    // parent (every node but the tree's own root does) — `!body` can only
    // fire for a parentless node, which refine's real call sites never pass.
    const fakeNode = { type: "method", parent: null } as unknown as Node;
    expect(ruby.refine!(fakeNode, stubEntity())).toEqual({ ...stubEntity(), visibility: "public" });
  });
});
