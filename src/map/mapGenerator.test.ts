import { describe, it, expect } from "vitest";
import { MapGenerator } from "./mapGenerator";
import type { ParsedFile, CodeEntity, CodeComment, DeadCodeRegion, GotoLink } from "../parser/types";

function createParsedFile(
  entities: Partial<CodeEntity>[] = [],
  comments: Partial<CodeComment>[] = [],
  deadCodeRegions: Partial<DeadCodeRegion>[] = [],
  gotos: Partial<GotoLink>[] = [],
  linesOfCode: number = 100
): ParsedFile {
  return {
    path: "test.ts",
    language: "typescript",
    linesOfCode,
    entities: entities.map((e, i) => ({
      name: `Entity${i}`,
      kind: "function",
      startLine: 1,
      endLine: 10,
      complexityScore: 1,
      nestingDepth: 0,
      visibility: "public",
      ...e
    })) as CodeEntity[],
    comments: comments.map(c => ({
      text: "A comment",
      startLine: 1,
      endLine: 1,
      ...c
    })) as CodeComment[],
    deadCodeRegions: deadCodeRegions.map(d => ({
      startLine: 1,
      endLine: 5,
      ...d
    })) as DeadCodeRegion[],
    gotos: gotos.map(g => ({
      gotoLine: 1,
      labelLine: 5,
      label: "lbl",
      ...g
    })) as GotoLink[]
  };
}

describe("MapGenerator", () => {
  it("generates fallback map when no entities provided", () => {
    const generator = new MapGenerator({ minSize: 20 });
    const map = generator.generate(createParsedFile([], [], [], [], 10));
    expect(map.rooms.length).toBe(1);
    expect(map.spawn).toBeDefined();
  });

  it("handles various code entity features", () => {
    const generator = new MapGenerator({ minSize: 80, maxSize: 100 });
    const parsed = createParsedFile([
      { kind: "class", complexityScore: 1 },
      { kind: "function", complexityScore: 10, nestingDepth: 3 },
      { kind: "function", complexityScore: 45 },
      { kind: "method", complexityScore: 5, visibility: "private" },
      { kind: "method", complexityScore: 5, visibility: "protected" },
      { kind: "global", complexityScore: 1 },
      { kind: "function", complexityScore: 1, startLine: 50, endLine: 60 }
    ],
    [
      { text: "TODO: fix this bug", startLine: 55 },
      { text: "FIXME: memory leak", startLine: 55 },
      { text: "TODO: something else", startLine: 55 },
      { text: "Normal comment", startLine: 1 }
    ],
    [
      { startLine: 55, endLine: 58 }
    ],
    [
      { gotoLine: 1, labelLine: 55, label: "skip" }
    ],
    1000);

    const map = generator.generate(parsed, true, false);
    expect(map.rooms.length).toBeGreaterThan(0);
  });

  it("covers more PRNG paths with different content signatures", () => {
    const generator = new MapGenerator({ placementAttempts: 10 });
    for (let i = 0; i < 50; i++) {
        const parsed = createParsedFile(
            [
                { name: `F${i}`, kind: i % 2 ? "function" : "global", complexityScore: i % 10 + 1, startLine: i, endLine: i + 5 },
                { name: `M${i}`, kind: "method", visibility: "private", complexityScore: 5 }
            ],
            [
                { text: `TODO ${i}`, startLine: i }
            ],
            [
                { startLine: i, endLine: i + 2 }
            ],
            [
                { gotoLine: i, labelLine: i + 1, label: "lbl" }
            ],
            500 + i * 10
        );
        generator.generate(parsed, i % 2 === 0, i % 3 === 0);
    }
  });

  it("fails to place rooms when maxSize is too small and entities are too large", () => {
    const generator = new MapGenerator({ minSize: 10, maxSize: 10, placementAttempts: 1 });
    const parsed = createParsedFile([
        { kind: "function", complexityScore: 100 }
    ]);
    const map = generator.generate(parsed);
    expect(map.rooms.length).toBe(1);
  });

  it("exhausts placement attempts for normal sized rooms in a small map", () => {
    const generator = new MapGenerator({ minSize: 10, maxSize: 10, roomMargin: 2, placementAttempts: 10 });
    const parsed = createParsedFile([
        { kind: "function", complexityScore: 1 },
        { kind: "function", complexityScore: 1 },
        { kind: "function", complexityScore: 1 }
    ]);
    const map = generator.generate(parsed);
    expect(map.rooms.length).toBeLessThan(3);
  });

  it("hits edge cases for returning null in findWallPerimeterSpot and trySecretRoomOffAnchor", () => {
    const generator = new MapGenerator({ minSize: 10, maxSize: 10, roomMargin: -10, placementAttempts: 50 });
    const entities: Partial<CodeEntity>[] = [];
    for(let i=0; i<30; i++) {
      entities.push({ kind: "function", complexityScore: 1 });
    }
    const parsed = createParsedFile(
      entities,
    [
        { text: "A", startLine: 1 },
        { text: "B", startLine: 1 },
        { text: "C", startLine: 1 },
        { text: "D", startLine: 1 },
        { text: "E", startLine: 1 },
        { text: "F", startLine: 1 },
        { text: "G", startLine: 1 }
    ],
    [
        { startLine: 1, endLine: 5 }
    ]);
    const map = generator.generate(parsed);
    expect(map).toBeDefined();
  });
});
