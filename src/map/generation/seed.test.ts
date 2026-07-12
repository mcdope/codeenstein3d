// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { ParsedFile } from "../../parser/types";
import { seedFrom } from "./seed";

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    language: "javascript",
    linesOfCode: 10,
    entities: [{ name: "foo", kind: "function", startLine: 1, endLine: 2, complexityScore: 1, nestingDepth: 0 }],
    gotos: [],
    comments: [],
    secretTriggers: [],
    ...overrides,
  };
}

describe("seedFrom", () => {
  it("is deterministic for identical input", () => {
    const parsed = parsedFile();
    expect(seedFrom(parsed)).toBe(seedFrom(parsedFile()));
  });

  it("returns a value in the uint32 range", () => {
    const seed = seedFrom(parsedFile());
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });

  it("changes when linesOfCode changes", () => {
    expect(seedFrom(parsedFile({ linesOfCode: 10 }))).not.toBe(seedFrom(parsedFile({ linesOfCode: 20 })));
  });

  it("changes when the language changes", () => {
    expect(seedFrom(parsedFile({ language: "python" }))).not.toBe(seedFrom(parsedFile({ language: "javascript" })));
  });

  it("changes when an entity's name/kind/complexity changes", () => {
    const base = parsedFile();
    const renamed = parsedFile({
      entities: [{ name: "bar", kind: "function", startLine: 1, endLine: 2, complexityScore: 1, nestingDepth: 0 }],
    });
    expect(seedFrom(base)).not.toBe(seedFrom(renamed));
  });

  it("handles a file with zero entities", () => {
    const seed = seedFrom(parsedFile({ entities: [] }));
    expect(Number.isInteger(seed)).toBe(true);
  });

  it("is order-sensitive to entity list order", () => {
    const a = parsedFile({
      entities: [
        { name: "a", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
        { name: "b", kind: "function", startLine: 2, endLine: 2, complexityScore: 1, nestingDepth: 0 },
      ],
    });
    const b = parsedFile({
      entities: [
        { name: "b", kind: "function", startLine: 2, endLine: 2, complexityScore: 1, nestingDepth: 0 },
        { name: "a", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
      ],
    });
    expect(seedFrom(a)).not.toBe(seedFrom(b));
  });
});
