// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { Parser } from "web-tree-sitter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhpParserAdapter } from "./phpParser";

const PHP_OPEN = "<?php\n";

describe("PhpParserAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures function/method/class/interface/trait entities", async () => {
    const result = await new PhpParserAdapter().parse(
      `${PHP_OPEN}function f() {}\ninterface I {}\ntrait T {}\nclass C implements I {\n  public function m() {}\n}\n`,
    );
    expect(result.language).toBe("php");
    expect(result.entities.find((e) => e.name === "f")?.kind).toBe("function");
    expect(result.entities.find((e) => e.name === "I")?.kind).toBe("interface");
    expect(result.entities.find((e) => e.name === "T")?.kind).toBe("trait");
    expect(result.entities.find((e) => e.name === "C")?.kind).toBe("class");
    expect(result.entities.find((e) => e.name === "m")?.kind).toBe("method");
  });

  it("resolves method visibility: private/protected/explicit public/default public", async () => {
    const result = await new PhpParserAdapter().parse(
      `${PHP_OPEN}class C {\n  private function a() {}\n  protected function b() {}\n  public function c() {}\n  function d() {}\n}\n`,
    );
    expect(result.entities.find((e) => e.name === "a")?.visibility).toBe("private");
    expect(result.entities.find((e) => e.name === "b")?.visibility).toBe("protected");
    expect(result.entities.find((e) => e.name === "c")?.visibility).toBe("public");
    expect(result.entities.find((e) => e.name === "d")?.visibility).toBe("public");
  });

  it("classes/interfaces/traits get no visibility field at all", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}class C {}\n`);
    expect(result.entities.find((e) => e.name === "C")?.visibility).toBeUndefined();
  });

  it("captures a program-scope variable assignment as a global", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}$config = [1, 2, 3];\n`);
    const entity = result.entities.find((e) => e.name === "$config");
    expect(entity?.kind).toBe("global");
  });

  it("does not treat a function-local assignment as a global", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}function f() {\n  $local = 1;\n}\n`);
    expect(result.entities.some((e) => e.kind === "global")).toBe(false);
  });

  it("does not treat a non-variable-target assignment at program scope as a global", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}$arr = [];\n$arr[0] = 1;\n`);
    // $arr[0] = 1 assigns to a subscript_expression, not a bare variable_name.
    expect(result.entities.filter((e) => e.kind === "global")).toHaveLength(1);
  });

  it("does not treat an assignment used as a sub-expression (not its own statement) as a global", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}if ($a = 1) {\n}\n`);
    // The assignment's parent here is the if-condition's parenthesized
    // expression, not expression_statement.
    expect(result.entities.some((e) => e.kind === "global")).toBe(false);
  });

  it("sorts entities starting on the same line by ascending endLine", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}function a() {} function b() {\n  return 1;\n}\n`);
    const names = result.entities.filter((e) => e.kind === "function").map((e) => e.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("falls back to <anonymous> when an entity's name field truly can't be resolved", async () => {
    // Every real PHP function_definition/method_declaration/class_declaration/
    // interface_declaration/trait_declaration always has a "name" field in
    // valid syntax — this exercises the fallback via a synthetic tree.
    const fakeEntityNode = {
      type: "function_definition",
      childForFieldName: () => null,
      startPosition: { row: 0 },
      endPosition: { row: 0 },
      namedChildren: [],
      descendantsOfType: () => [],
    };
    const fakeTree = {
      rootNode: {
        descendantsOfType: (types: string[] | string) =>
          Array.isArray(types) && types.includes("function_definition") ? [fakeEntityNode] : [],
      },
      delete: () => {},
    };
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(fakeTree as unknown as ReturnType<Parser["parse"]>);

    const result = await new PhpParserAdapter().parse("irrelevant");
    expect(result.entities[0].name).toBe("<anonymous>");
  });

  it("scores complexity via decision points including PHP-specific elseif/foreach", async () => {
    const result = await new PhpParserAdapter().parse(
      `${PHP_OPEN}function f($a) {\n  if ($a) {}\n  elseif ($a) {}\n  foreach ($a as $x) {}\n  return $a && $a;\n}\n`,
    );
    const fn = result.entities.find((e) => e.name === "f");
    // 1 base + if + elseif + foreach + && = 5
    expect(fn?.complexityScore).toBe(5);
  });

  it("resolves goto/label pairs via unnamed name children", async () => {
    const result = await new PhpParserAdapter().parse(
      `${PHP_OPEN}function f($x) {\n  if ($x) goto done;\n  done:\n  return 0;\n}\n`,
    );
    expect(result.gotos).toEqual([{ label: "done", gotoLine: 3, labelLine: 4 }]);
  });

  it("finds an empty catch block", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}try {\n  f();\n} catch (Exception $e) {\n}\n`);
    expect(result.secretTriggers.some((t) => t.kind === "emptyCatch")).toBe(true);
  });

  it("does not flag a catch block that handles the exception", async () => {
    const result = await new PhpParserAdapter().parse(
      `${PHP_OPEN}try {\n  f();\n} catch (Exception $e) {\n  log($e);\n}\n`,
    );
    expect(result.secretTriggers.some((t) => t.kind === "emptyCatch")).toBe(false);
  });

  it("finds a deprecation marker in a comment", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}// @deprecated\nfunction f() {}\n`);
    expect(result.secretTriggers.some((t) => t.kind === "deprecated")).toBe(true);
  });

  it("finds commented-out code and a magic hex number", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}// $x = 1;\n$y = 0xDEADBEEF;\n`);
    expect(result.secretTriggers.some((t) => t.kind === "commentedCode")).toBe(true);
    expect(result.secretTriggers.some((t) => t.kind === "magicBlob")).toBe(true);
  });

  it("extracts a large comment", async () => {
    const long = "x".repeat(70);
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}// ${long}\nfunction f() {}\n`);
    expect(result.comments).toHaveLength(1);
  });

  it("counts lines via countLines", async () => {
    const result = await new PhpParserAdapter().parse(`${PHP_OPEN}function f() {\n  return 1;\n}\n`);
    expect(result.linesOfCode).toBe(4);
  });

  it("reuses the same parser instance across repeated parse() calls", async () => {
    const adapter = new PhpParserAdapter();
    const setLangSpy = vi.spyOn(Parser.prototype, "setLanguage");
    await adapter.parse(`${PHP_OPEN}$a = 1;\n`);
    await adapter.parse(`${PHP_OPEN}$b = 2;\n`);
    expect(setLangSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the underlying parser returns no syntax tree at all", async () => {
    vi.spyOn(Parser.prototype, "parse").mockReturnValue(null);
    await expect(new PhpParserAdapter().parse(`${PHP_OPEN}$a = 1;`)).rejects.toThrow("PHP parser returned no syntax tree");
  });
});
