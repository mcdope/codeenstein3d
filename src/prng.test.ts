// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { mulberry32, randomSeed } from "./prng";

describe("mulberry32", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("always returns values in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("normalizes the seed with >>> 0, so a negative seed still works", () => {
    const fromNegative = mulberry32(-1);
    const fromEquivalentUint32 = mulberry32(0xffffffff);
    expect(fromNegative()).toBe(fromEquivalentUint32());
  });

  it("handles a zero seed without throwing", () => {
    const rng = mulberry32(0);
    expect(() => rng()).not.toThrow();
  });
});

describe("randomSeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scales Math.random()'s [0,1) output into a uint32", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(randomSeed()).toBe((0.5 * 0xffffffff) >>> 0);
  });

  it("returns 0 when Math.random() returns 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(randomSeed()).toBe(0);
  });

  it("stays within the uint32 range across many real draws", () => {
    for (let i = 0; i < 1000; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
