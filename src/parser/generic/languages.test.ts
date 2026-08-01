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

/**
 * The shared switch/try/import/allocation vocabulary tables (`vocabulary.ts`)
 * are only as good as the node-type names in them, and every grammar spells
 * these differently — a wrong name silently produces nothing rather than
 * failing, so each language needs a real end-to-end assertion. This is also the
 * only place the `_`/`*` wildcard and Ruby sibling-`else` catch-all rules get
 * exercised, since those grammars aren't loaded in `astUtils.test.ts`.
 *
 * Each snippet has 2 real cases plus a catch-all, one try/catch/finally where
 * the language has one, 2 top-level imports, and at least 1 allocation.
 */
const FEATURE_SOURCE: Record<string, string> = {
  javascript: `import a from "a";
import b from "b";
function f(v) {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}
function g() {
  try { h(); } catch (e) { k(e); } finally { m(); }
  return new Foo();
}
`,
  typescript: `import a from "a";
import b from "b";
function f(v: number): number {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}
function g(): Foo {
  try { h(); } catch (e) { k(e); } finally { m(); }
  return new Foo();
}
`,
  tsx: `import a from "a";
import b from "b";
function f(v: number): number {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}
function g(): Foo {
  try { h(); } catch (e) { k(e); } finally { m(); }
  return new Foo();
}
`,
  python: `import os
import sys

def f(v):
    match v:
        case 1:
            return 1
        case 2:
            return 2
        case _:
            return 0

def g():
    try:
        h()
    except ValueError:
        k()
    finally:
        m()
`,
  java: `import java.util.List;
import java.util.Map;
class C {
  int f(int v) {
    switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
  }
  void g() {
    try { h(); } catch (Exception e) { k(); } finally { m(); }
    Object o = new Object();
  }
}
`,
  cpp: `#include <vector>
#include "local.h"
int f(int v) {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}
void g() {
  try { h(); } catch (const std::exception& e) { k(); }
  int* p = new int[8];
}
`,
  go: `package main

import (
  "os"
  "io"
)

func f(v int) int {
  switch v {
  case 1:
    return 1
  case 2:
    return 2
  default:
    return 0
  }
}

func g() []byte {
  return make([]byte, 16)
}
`,
  rust: `use std::fs;
use std::io::Read;
fn f(v: i32) -> i32 {
  match v { 1 => 1, 2 => 2, _ => 0 }
}
fn g() -> Box<i32> {
  Box::new(1)
}
`,
  ruby: `require "json"
require "set"
def f(v)
  case v
  when 1 then 1
  when 2 then 2
  else 0
  end
end
def g
  begin
    h
  rescue StandardError => e
    k
  ensure
    m
  end
  Array.new(4)
end
`,
  csharp: `using System;
using System.Text;
class C {
  int F(int v) {
    switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
  }
  void G() {
    try { H(); } catch (Exception e) { K(); } finally { M(); }
    var o = new object();
  }
}
`,
  bash: `source ./lib.sh
. ./other.sh
f() {
  case "$1" in
    a) echo 1 ;;
    b) echo 2 ;;
    *) echo 0 ;;
  esac
}
`,
  scala: `import scala.collection.mutable
import java.io.File
object O {
  def f(v: Int): Int = v match {
    case 1 => 1
    case 2 => 2
    case _ => 0
  }
  def g(): Unit = {
    try { h() } catch { case e: Exception => k() } finally { m() }
    val a = new Array[Int](4)
  }
}
`,
  objc: `#import <Foundation/Foundation.h>
#include "local.h"
@implementation Foo
- (int)f:(int)v {
  switch (v) { case 1: return 1; case 2: return 2; default: return 0; }
}
- (void)g {
  @try { [self h]; } @catch (NSException *e) { } @finally { }
  id o = [[NSObject alloc] init];
}
@end
`,
};

/** Languages whose grammar genuinely has no exception construct — they must
 * report zero zones, and that's correct rather than a missing table entry. */
const NO_EXCEPTION_CONSTRUCT = new Set(["go", "rust", "bash"]);

/** Languages with no *explicit* allocation construct at all. Python allocates
 * implicitly (no `new`, no `malloc`, no fixed-size arrays) and Bash has no
 * concept of it, so neither ever produces an Acid Overflow room — the same
 * shape as `goto`/teleporters only existing in C/C++/PHP/Go. */
const NO_ALLOCATION_CONSTRUCT = new Set(["python", "bash"]);

describe("GENERIC_ADAPTERS — shared switch/try/import/allocation vocabulary", () => {
  it.each(EXPECTED.map((e) => e.id))("%s: finds 2 cases plus a catch-all", async (id) => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === id)!;
    const result = await adapter.parse(FEATURE_SOURCE[id]);
    const withSwitch = result.entities.filter((e) => e.switchBranches);
    expect(withSwitch.length).toBeGreaterThan(0);
    // A `class`/`object` entity aggregates its methods' switches, so assert on
    // the innermost (smallest-span) one — the entity a Switchboard hub is
    // actually built from.
    const innermost = withSwitch.reduce((a, b) => (b.endLine - b.startLine < a.endLine - a.startLine ? b : a));
    expect(innermost.switchBranches).toEqual({ caseCount: 2, hasDefault: true });
  });

  it.each(EXPECTED.map((e) => e.id))("%s: counts 2 top-level imports", async (id) => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === id)!;
    const result = await adapter.parse(FEATURE_SOURCE[id]);
    expect(result.importCount).toBe(2);
  });

  it.each(EXPECTED.map((e) => e.id))("%s: finds a try/catch/finally where the language has one", async (id) => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === id)!;
    const result = await adapter.parse(FEATURE_SOURCE[id]);
    if (NO_EXCEPTION_CONSTRUCT.has(id)) {
      expect(result.exceptionZones).toEqual([]);
      return;
    }
    expect(result.exceptionZones).toHaveLength(1);
    expect(result.exceptionZones[0].catchCount).toBe(1);
    // C++ is the one sample without a `finally` — the language has no such
    // clause at all (RAII is the idiom instead).
    expect(result.exceptionZones[0].hasFinally).toBe(id !== "cpp");
  });

  it.each(EXPECTED.map((e) => e.id))("%s: counts at least one allocation", async (id) => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === id)!;
    const result = await adapter.parse(FEATURE_SOURCE[id]);
    const total = result.entities.reduce((sum, e) => sum + (e.allocations ?? 0), 0);
    if (NO_ALLOCATION_CONSTRUCT.has(id)) expect(total).toBe(0);
    else expect(total).toBeGreaterThan(0);
  });

  it("doesn't mistake Scala's `catch { case … }` for a switch", async () => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === "scala")!;
    const result = await adapter.parse(`object O {
  def g(): Unit = {
    try { h() } catch { case e: Exception => k() } finally { m() }
  }
}
`);
    expect(result.entities.every((e) => e.switchBranches === undefined)).toBe(true);
  });

  it("leaves switchBranches/allocations absent when there's nothing to report", async () => {
    const adapter = GENERIC_ADAPTERS.find((a) => a.language === "javascript")!;
    const result = await adapter.parse("function foo() { return 1; }\n");
    const fn = result.entities.find((e) => e.name === "foo")!;
    expect(fn.switchBranches).toBeUndefined();
    expect(fn.allocations).toBeUndefined();
    expect(result.exceptionZones).toEqual([]);
    expect(result.importCount).toBe(0);
  });
});
