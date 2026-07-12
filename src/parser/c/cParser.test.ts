// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { Parser } from "web-tree-sitter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CParserAdapter } from "./cParser";

describe("CParserAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures a function_definition as a function entity", async () => {
    const result = await new CParserAdapter().parse("int add(int a, int b) {\n  return a + b;\n}\n");
    expect(result.language).toBe("c");
    const fn = result.entities.find((e) => e.name === "add");
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe("function");
    expect(fn?.startLine).toBe(1);
    expect(fn?.endLine).toBe(3);
  });

  it("resolves a pointer-returning function's name through the nested declarator", async () => {
    const result = await new CParserAdapter().parse("int *foo(int x) {\n  return &x;\n}\n");
    expect(result.entities.find((e) => e.name === "foo")?.kind).toBe("function");
  });

  it("captures a struct with a body as a class entity", async () => {
    const result = await new CParserAdapter().parse("struct Point { int x; int y; };\n");
    const entity = result.entities.find((e) => e.name === "Point");
    expect(entity?.kind).toBe("class");
  });

  it("captures a union and an enum with a body as class entities too", async () => {
    const result = await new CParserAdapter().parse("union U { int i; float f; };\nenum Color { RED, GREEN };\n");
    expect(result.entities.some((e) => e.name === "U" && e.kind === "class")).toBe(true);
    expect(result.entities.some((e) => e.name === "Color" && e.kind === "class")).toBe(true);
  });

  it("skips a forward-declared struct with no body", async () => {
    const result = await new CParserAdapter().parse("struct Point;\nint f() { return 0; }\n");
    expect(result.entities.some((e) => e.name === "Point")).toBe(false);
  });

  it("skips an anonymous struct (no name)", async () => {
    const result = await new CParserAdapter().parse("typedef struct { int x; } Anon;\n");
    expect(result.entities.some((e) => e.kind === "class")).toBe(false);
  });

  it("captures a top-level declaration as a global", async () => {
    const result = await new CParserAdapter().parse("int counter;\n");
    const entity = result.entities.find((e) => e.name === "counter");
    expect(entity?.kind).toBe("global");
  });

  it("does not treat a function prototype declaration as a global", async () => {
    const result = await new CParserAdapter().parse("int add(int a, int b);\n");
    expect(result.entities.some((e) => e.kind === "global")).toBe(false);
  });

  it("skips a declaration with no identifiable name", async () => {
    const result = await new CParserAdapter().parse("int (*fp)(void);\nint dummy;\n");
    // Regardless of how the function-pointer declarator resolves, this must
    // not throw, and the plain `int dummy;` global must still be captured.
    expect(result.entities.some((e) => e.name === "dummy" && e.kind === "global")).toBe(true);
  });

  it("sorts entities starting on the same line by ascending endLine", async () => {
    const result = await new CParserAdapter().parse("int a() { return 0; } int b() {\n  return 1;\n}\n");
    const names = result.entities.filter((e) => e.kind === "function").map((e) => e.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("skips a top-level declaration with no identifiable name", async () => {
    // A synthetic tree — every real top-level C `declaration` that isn't a
    // function prototype has an identifiable name in valid syntax.
    const fakeDecl = {
      type: "declaration",
      parent: { type: "translation_unit" },
      descendantsOfType: () => [],
      namedChildren: [],
    };
    const fakeTree = {
      rootNode: {
        descendantsOfType: (types: string[] | string) =>
          types === "declaration" ? [fakeDecl] : Array.isArray(types) && types.includes("function_definition") ? [] : [],
      },
      delete: () => {},
    };
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(fakeTree as unknown as ReturnType<Parser["parse"]>);

    const result = await new CParserAdapter().parse("irrelevant");
    expect(result.entities).toEqual([]);
  });

  it("scores complexity via decision points and adds a code-smell bonus", async () => {
    const result = await new CParserAdapter().parse(`
      int f(int a, int b, int c, int d, int e, int g) {
        if (a) {}
        for (;;) {}
        return a && b || c;
      }
    `);
    const fn = result.entities.find((e) => e.name === "f");
    // 1 base + if(1) + for(1) + &&(1) + ||(1) = 5, plus a param-count smell
    // bonus for 6 params (> 5 threshold): (6-5)*2 = 2 -> 7 total.
    expect(fn?.complexityScore).toBe(7);
  });

  it("computes nesting depth, flattening an else-if ladder", async () => {
    const result = await new CParserAdapter().parse(`
      int f(int x) {
        if (x == 1) {}
        else if (x == 2) { for (;;) {} }
      }
    `);
    const fn = result.entities.find((e) => e.name === "f");
    expect(fn?.nestingDepth).toBe(2);
  });

  it("resolves goto/label pairs", async () => {
    const result = await new CParserAdapter().parse(`
      int f(int x) {
        if (x) goto done;
        done:
        return 0;
      }
    `);
    expect(result.gotos).toEqual([{ label: "done", gotoLine: 3, labelLine: 4 }]);
  });

  it("extracts a large comment", async () => {
    const long = "x".repeat(70);
    const result = await new CParserAdapter().parse(`// ${long}\nint f() { return 0; }\n`);
    expect(result.comments).toHaveLength(1);
  });

  it("finds dead code after an unconditional return", async () => {
    const result = await new CParserAdapter().parse("int f() { return 1; int x = 2; }\n");
    expect(result.secretTriggers.some((t) => t.kind === "deadCode")).toBe(true);
  });

  it("finds a deprecation marker in a comment (C has no annotation/decorator syntax)", async () => {
    const result = await new CParserAdapter().parse("// @deprecated\nint f() { return 0; }\n");
    expect(result.secretTriggers.some((t) => t.kind === "deprecated")).toBe(true);
  });

  it("finds commented-out code and a magic hex number", async () => {
    const result = await new CParserAdapter().parse("// int x = 1;\nint y = 0xDEADBEEF;\n");
    expect(result.secretTriggers.some((t) => t.kind === "commentedCode")).toBe(true);
    expect(result.secretTriggers.some((t) => t.kind === "magicBlob")).toBe(true);
  });

  it("counts lines via countLines", async () => {
    const result = await new CParserAdapter().parse("int f() {\n  return 0;\n}\n");
    expect(result.linesOfCode).toBe(3);
  });

  it("reuses the same parser instance across repeated parse() calls", async () => {
    const adapter = new CParserAdapter();
    const parseSpy = vi.spyOn(Parser.prototype, "setLanguage");
    await adapter.parse("int a;\n");
    await adapter.parse("int b;\n");
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to <anonymous> when a function_definition's name truly can't be resolved", async () => {
    // A real valid C function_definition always resolves a name through
    // either the direct-function_declarator or nested-declarator path — this
    // exercises functionName()'s full fallback chain (no function_declarator
    // found at all -> no name declarator -> firstIdentifier(null)) via a
    // synthetic tree, since valid C syntax can't naturally produce this.
    const fakeDeclarator = { type: "other_declarator", descendantsOfType: () => [] };
    const fakeFnDef = {
      type: "function_definition",
      childForFieldName: (f: string) => (f === "declarator" ? fakeDeclarator : null),
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      namedChildren: [],
      descendantsOfType: () => [],
    };
    const fakeTree = {
      rootNode: {
        descendantsOfType: (types: string[]) => (types.includes("function_definition") ? [fakeFnDef] : []),
      },
      delete: () => {},
    };
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(fakeTree as unknown as ReturnType<Parser["parse"]>);

    const result = await new CParserAdapter().parse("irrelevant");
    expect(result.entities[0].name).toBe("<anonymous>");
  });

  it("throws when the underlying parser returns no syntax tree at all", async () => {
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(null);
    await expect(new CParserAdapter().parse("int a;")).rejects.toThrow("C parser returned no syntax tree");
  });
});
