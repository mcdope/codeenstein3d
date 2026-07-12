// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import { clamp, dist, key, neighbors, shuffle } from "./util";

describe("clamp", () => {
  it("returns the value unchanged when already within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps below the minimum", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamps above the maximum", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("dist", () => {
  it("computes Euclidean distance", () => {
    expect(dist(0, 0, 3, 4)).toBe(5);
  });

  it("returns 0 for the same point", () => {
    expect(dist(2, 2, 2, 2)).toBe(0);
  });
});

describe("shuffle", () => {
  it("is a permutation of the original items", () => {
    const items = [1, 2, 3, 4, 5];
    const original = [...items];
    shuffle(items, mulberry32(1));
    expect([...items].sort()).toEqual(original.sort());
  });

  it("is deterministic for a given rng seed", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3, 4, 5];
    shuffle(a, mulberry32(42));
    shuffle(b, mulberry32(42));
    expect(a).toEqual(b);
  });

  it("handles an empty array without throwing", () => {
    const items: number[] = [];
    expect(() => shuffle(items, mulberry32(1))).not.toThrow();
  });

  it("handles a single-element array without throwing", () => {
    const items = [1];
    shuffle(items, mulberry32(1));
    expect(items).toEqual([1]);
  });

  it("produces a different order for a different seed (statistically, over many items)", () => {
    const a = Array.from({ length: 20 }, (_, i) => i);
    const b = Array.from({ length: 20 }, (_, i) => i);
    shuffle(a, mulberry32(1));
    shuffle(b, mulberry32(2));
    expect(a).not.toEqual(b);
  });
});

describe("key", () => {
  it("formats a point as x,y", () => {
    expect(key({ x: 3, y: 7 })).toBe("3,7");
  });

  it("distinguishes negative coordinates unambiguously", () => {
    expect(key({ x: -1, y: 2 })).toBe("-1,2");
  });
});

describe("neighbors", () => {
  it("returns the 4 orthogonal neighbors", () => {
    expect(neighbors({ x: 5, y: 5 })).toEqual([
      { x: 6, y: 5 },
      { x: 4, y: 5 },
      { x: 5, y: 6 },
      { x: 5, y: 4 },
    ]);
  });
});
