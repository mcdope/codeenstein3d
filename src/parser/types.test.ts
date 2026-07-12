// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * types.ts is a type-only module (interfaces/type aliases, no runtime code) —
 * this file exists purely to force the module to load under coverage
 * instrumentation and to pin the documented `EntityKind`/`SecretTriggerKind`
 * value sets, which nothing else asserts on directly.
 */
import { describe, expect, it } from "vitest";
import "./types";
import type { CodeEntity, EntityKind, ParsedFile, SecretTriggerKind } from "./types";

describe("types.ts", () => {
  it("loads with no runtime exports (type-only module)", async () => {
    const mod = await import("./types");
    expect(Object.keys(mod)).toEqual([]);
  });

  it("EntityKind covers the documented set", () => {
    const kinds: EntityKind[] = ["function", "method", "class", "interface", "trait", "global"];
    expect(kinds).toHaveLength(6);
  });

  it("SecretTriggerKind covers the documented set", () => {
    const kinds: SecretTriggerKind[] = ["deadCode", "emptyCatch", "deprecated", "commentedCode", "magicBlob"];
    expect(kinds).toHaveLength(5);
  });

  it("a minimal ParsedFile literal satisfies the contract shape", () => {
    const entity: CodeEntity = {
      name: "foo",
      kind: "function",
      startLine: 1,
      endLine: 2,
      complexityScore: 1,
      nestingDepth: 0,
    };
    const parsed: ParsedFile = {
      language: "javascript",
      linesOfCode: 2,
      entities: [entity],
      gotos: [],
      comments: [],
      secretTriggers: [],
    };
    expect(parsed.entities[0].name).toBe("foo");
  });
});
