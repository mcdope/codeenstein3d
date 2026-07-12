// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { Parser } from "web-tree-sitter";
import jsWasmUrl from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import cppWasmUrl from "tree-sitter-cpp/tree-sitter-cpp.wasm?url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as refine from "./refinements";
import { GenericParserAdapter } from "./genericParser";

describe("GenericParserAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures a filter-accepted entity (javascriptLike's function_declaration default-true path)", async () => {
    const adapter = new GenericParserAdapter({
      id: "javascript",
      extensions: ["js"],
      wasmUrl: jsWasmUrl,
      ...refine.javascriptLike,
    });
    const result = await adapter.parse("function bar() {}\n");
    expect(result.entities.some((e) => e.name === "bar" && e.kind === "function")).toBe(true);
  });

  it("drops a filter-rejected node (javascriptLike's non-function-valued variable_declarator)", async () => {
    const adapter = new GenericParserAdapter({
      id: "javascript",
      extensions: ["js"],
      wasmUrl: jsWasmUrl,
      ...refine.javascriptLike,
    });
    const result = await adapter.parse("const foo = 5;\n");
    // The variable_declarator itself is filtered out of the entity loop —
    // it may still surface separately as a heuristic "global" (a different
    // code path, genericGlobals), so assert on kind, not mere absence.
    expect(result.entities.some((e) => e.name === "foo" && e.kind === "function")).toBe(false);
  });

  it("still captures entities when the language config defines no filter hook at all", async () => {
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const result = await adapter.parse("int foo() { return 1; }\n");
    expect(result.entities.some((e) => e.name === "foo")).toBe(true);
  });

  it("applies the code-smell bonus path for a method-kind entity too", async () => {
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const result = await adapter.parse("class C { int m(int a, int b, int c, int d, int e, int f) { return 1; } };\n");
    const method = result.entities.find((e) => e.name === "m");
    expect(method?.kind).toBe("method");
    // 1 base + a param-count smell bonus for 6 params (> 5 threshold).
    expect(method?.complexityScore).toBe(1 + (6 - 5) * 2);
  });

  it("skips the code-smell bonus path entirely for a non-callable (class) entity", async () => {
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const result = await adapter.parse("class C {};\n");
    const cls = result.entities.find((e) => e.name === "C");
    expect(cls?.kind).toBe("class");
    expect(cls?.complexityScore).toBe(1);
  });

  it("does not double-count an entity as both itself and a top-level global", async () => {
    const adapter = new GenericParserAdapter({
      id: "javascript",
      extensions: ["js"],
      wasmUrl: jsWasmUrl,
      ...refine.javascriptLike,
    });
    const result = await adapter.parse("const foo = () => {};\n");
    expect(result.entities.filter((e) => e.name === "foo")).toHaveLength(1);
    expect(result.entities[0].kind).toBe("function");
  });

  it("reuses the same parser instance across repeated parse() calls", async () => {
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const setLangSpy = vi.spyOn(Parser.prototype, "setLanguage");
    await adapter.parse("int a() { return 0; }\n");
    await adapter.parse("int b() { return 0; }\n");
    expect(setLangSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the underlying parser returns no syntax tree at all", async () => {
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(null);
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    await expect(adapter.parse("int a();")).rejects.toThrow("cpp parser returned no syntax tree");
  });

  it("skips an anonymous node matching an entity type by coincidence", async () => {
    const fakeAnonymousMatch = {
      isNamed: false,
      type: "class",
      childForFieldName: () => null,
      namedChildren: [],
      descendantsOfType: () => [],
    };
    const fakeTree = {
      rootNode: {
        // Only the entity-type lookup (an array including "class") should
        // surface the coincidental match — goto/label/comment lookups must
        // not, so extractGotos'/comment-scanning's own descendantsOfType
        // calls stay unaffected.
        descendantsOfType: (types: unknown) =>
          Array.isArray(types) && types.includes("class") ? [fakeAnonymousMatch] : [],
        namedChildren: [],
      },
      delete: () => {},
    };
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(fakeTree as unknown as ReturnType<Parser["parse"]>);
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const result = await adapter.parse("irrelevant");
    expect(result.entities).toEqual([]);
  });

  it("skips the tree's own root node even if its type coincidentally matches an entity type", async () => {
    const fakeRoot: {
      isNamed: boolean;
      type: string;
      descendantsOfType: (types: unknown) => unknown[];
      namedChildren: unknown[];
      childForFieldName: () => null;
    } = {
      isNamed: true,
      type: "class_declaration",
      descendantsOfType: () => [],
      namedChildren: [],
      childForFieldName: () => null,
    };
    fakeRoot.descendantsOfType = (types: unknown) =>
      Array.isArray(types) && types.includes("class_declaration") ? [fakeRoot] : [];
    const fakeTree = { rootNode: fakeRoot, delete: () => {} };
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(fakeTree as unknown as ReturnType<Parser["parse"]>);
    const adapter = new GenericParserAdapter({ id: "cpp", extensions: ["cpp"], wasmUrl: cppWasmUrl, ...refine.cpp });
    const result = await adapter.parse("irrelevant");
    expect(result.entities).toEqual([]);
  });
});
