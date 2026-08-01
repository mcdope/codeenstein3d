// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { loadDemoCampaignTree } from "../../fs/demoCampaign";
import { readFileText } from "../../fs/workspace";
import { extensionOf, parseFile } from "../../parser/registry";
import type { CodeEntity, ParsedFile } from "../../parser/types";
import { STYLE_SET_IDS } from "../types";
import { BONUS_STYLE_SET, NORMAL_STYLE_SETS, styleSetFor } from "./styleSet";

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    language: "javascript",
    linesOfCode: 20,
    entities: [],
    gotos: [],
    comments: [],
    secretTriggers: [],
    exceptionZones: [],
    importCount: 0,
    ...overrides,
  };
}

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

describe("styleSetFor", () => {
  it("is deterministic: the same parsed file always yields the same styleset", () => {
    const parsed = parsedFile({ entities: [entity({ name: "alpha" }), entity({ name: "beta" })] });
    const first = styleSetFor(parsed, false);
    for (let i = 0; i < 20; i++) expect(styleSetFor(parsed, false)).toBe(first);
  });

  it("always returns a known styleset id", () => {
    for (let i = 0; i < 50; i++) {
      const parsed = parsedFile({ linesOfCode: i, entities: [entity({ name: `f${i}` })] });
      expect(STYLE_SET_IDS).toContain(styleSetFor(parsed, false));
    }
  });

  it("forces the bonus styleset for a bonus level, whatever the file", () => {
    for (let i = 0; i < 20; i++) {
      const parsed = parsedFile({ linesOfCode: i, entities: [entity({ name: `f${i}` })] });
      expect(styleSetFor(parsed, true)).toBe(BONUS_STYLE_SET);
    }
  });

  it("never hands the bonus styleset to a normal level", () => {
    // Seeing `techCool` has to *mean* "restock arena" — if a normal level
    // could draw it, that signal is gone.
    expect(NORMAL_STYLE_SETS).not.toContain(BONUS_STYLE_SET);
    for (let i = 0; i < 200; i++) {
      const parsed = parsedFile({ linesOfCode: i, entities: [entity({ name: `f${i}` })] });
      expect(styleSetFor(parsed, false)).not.toBe(BONUS_STYLE_SET);
    }
  });

  it("reaches every normal styleset across a spread of files", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(styleSetFor(parsedFile({ linesOfCode: i, entities: [entity({ name: `f${i}` })] }), false));
    }
    expect(seen.size).toBe(NORMAL_STYLE_SETS.length);
  });

  it("responds to file content, not just line count", () => {
    // Two files of identical size but different entities must be able to
    // differ — otherwise a campaign of similarly-sized files would be
    // uniformly one styleset.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      seen.add(styleSetFor(parsedFile({ linesOfCode: 20, entities: [entity({ name: `name${i}` })] }), false));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("spreads the bundled demo campaign across at least three stylesets", async () => {
    // The real distribution check: a hash that clusters would leave a whole
    // playthrough looking like one level repeated, which is exactly what this
    // feature exists to fix. Uses the shipped campaign, not synthetic input —
    // its files share a language and a naming scheme, which is precisely the
    // correlated input a weaker seed-to-index mapping would collapse on.
    const tree = loadDemoCampaignTree();
    const seen = new Set<string>();
    let counted = 0;
    for (const child of tree.children ?? []) {
      if (child.kind !== "file") continue;
      const text = await readFileText(child.handle as FileSystemFileHandle);
      const parsed = await parseFile(child.name, text);
      if (!parsed) continue;
      const bonusLevel = extensionOf(child.name) === "h";
      counted++;
      seen.add(styleSetFor(parsed, bonusLevel));
    }
    expect(counted).toBeGreaterThan(5);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});
