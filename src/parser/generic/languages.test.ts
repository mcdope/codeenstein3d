// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * GENERIC_ADAPTERS wiring: every bundled language's LanguageConfig resolves
 * a real grammar wasm and produces a working end-to-end parse. This is the
 * one place all 13 non-bespoke bundled languages get exercised together
 * through the real GenericParserAdapter pipeline (individual refine/filter
 * hook logic is already unit-tested in refinements.test.ts).
 */
import { describe, expect, it } from "vitest";
import { GENERIC_ADAPTERS } from "./languages";

const EXPECTED = [
  { id: "javascript", extensions: ["js", "mjs", "cjs", "jsx"] },
  { id: "typescript", extensions: ["ts", "mts", "cts"] },
  { id: "tsx", extensions: ["tsx"] },
  { id: "python", extensions: ["py", "pyw"] },
  { id: "java", extensions: ["java"] },
  { id: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"] },
  { id: "go", extensions: ["go"] },
  { id: "rust", extensions: ["rs"] },
  { id: "ruby", extensions: ["rb"] },
  { id: "csharp", extensions: ["cs"] },
  { id: "bash", extensions: ["sh", "bash"] },
  { id: "scala", extensions: ["scala", "sc"] },
  { id: "objc", extensions: ["m", "mm"] },
];

const SAMPLE_SOURCE: Record<string, string> = {
  javascript: "function foo() { return 1; }\n",
  typescript: "function foo(): number { return 1; }\n",
  tsx: "function Foo() { return <div />; }\n",
  python: "def foo():\n    return 1\n",
  java: "class C { void foo() {} }\n",
  cpp: "int foo() { return 1; }\n",
  go: "package main\nfunc foo() {}\n",
  rust: "fn foo() {}\n",
  ruby: "def foo\nend\n",
  csharp: "class C { void Foo() {} }\n",
  bash: "foo() {\n  echo hi\n}\n",
  scala: "def foo() = {}\n",
  objc: "@implementation Foo\n- (void)bar {}\n@end\n",
};

describe("GENERIC_ADAPTERS", () => {
  it("wires exactly the 13 expected languages with their extensions", () => {
    expect(GENERIC_ADAPTERS).toHaveLength(EXPECTED.length);
    const actual = GENERIC_ADAPTERS.map((a) => ({ id: a.language, extensions: [...a.extensions] }));
    expect(actual).toEqual(EXPECTED);
  });

  it.each(EXPECTED.map((e) => e.id))("%s: real grammar wasm loads and produces a ParsedFile", async (id) => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === id)!;
    const source = SAMPLE_SOURCE[id];
    const result = await adapter.parse(source);
    expect(result.language).toBe(id);
    expect(result.linesOfCode).toBeGreaterThan(0);
  });
});
