// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { createResumablePrng, mulberry32, randomSeed } from "./prng";

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

describe("createResumablePrng", () => {
  it("next() produces the exact same sequence as mulberry32() for the same seed", () => {
    const resumable = createResumablePrng(12345);
    const plain = mulberry32(12345);
    const seqA = [resumable.next(), resumable.next(), resumable.next(), resumable.next()];
    const seqB = [plain(), plain(), plain(), plain()];
    expect(seqA).toEqual(seqB);
  });

  it("getState() immediately after construction reflects the seed, normalized to uint32", () => {
    expect(createResumablePrng(-1).getState()).toBe(0xffffffff);
    expect(createResumablePrng(42).getState()).toBe(42);
  });

  it("setState() resumes the sequence exactly where the captured state left off, not from a fresh seed", () => {
    const source = createResumablePrng(999);
    source.next();
    source.next();
    const capturedState = source.getState();
    const expectedNext = [source.next(), source.next(), source.next()];

    const resumed = createResumablePrng(1); // different seed entirely
    resumed.setState(capturedState);
    const actualNext = [resumed.next(), resumed.next(), resumed.next()];

    expect(actualNext).toEqual(expectedNext);
  });

  it("setState() normalizes its argument with >>> 0, same as construction", () => {
    const a = createResumablePrng(0);
    a.setState(-1);
    const b = createResumablePrng(0xffffffff);
    expect(a.next()).toBe(b.next());
  });

  it("getState() after some draws differs from the original seed", () => {
    const rng = createResumablePrng(7);
    rng.next();
    rng.next();
    expect(rng.getState()).not.toBe(7);
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

describe("pinnedSeed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** `randomSeed` memoises its pinned stream for the lifetime of the module,
   * which is the right behaviour for a page load and the wrong one for a test
   * file — so each case imports a fresh copy. */
  async function freshPrng(search: string | null) {
    if (search !== null) vi.stubGlobal("window", { location: { search } });
    vi.resetModules();
    return await import("./prng");
  }

  it("returns null with no window at all, so Node-side importers are unaffected", async () => {
    const { pinnedSeed } = await freshPrng(null);
    expect(pinnedSeed()).toBeNull();
  });

  it("reads a decimal seed", async () => {
    const { pinnedSeed } = await freshPrng("?seed=12345");
    expect(pinnedSeed()).toBe(12345);
  });

  it("reads a hex seed", async () => {
    const { pinnedSeed } = await freshPrng("?seed=0xc0ffee");
    expect(pinnedSeed()).toBe(0xc0ffee);
  });

  it("ignores an absent or empty parameter", async () => {
    expect((await freshPrng("?testHooks=1")).pinnedSeed()).toBeNull();
    expect((await freshPrng("?seed=")).pinnedSeed()).toBeNull();
    expect((await freshPrng("?seed=%20%20")).pinnedSeed()).toBeNull();
  });

  it("ignores a typo rather than silently pinning every run to seed 0", async () => {
    expect((await freshPrng("?seed=banana")).pinnedSeed()).toBeNull();
    expect((await freshPrng("?seed=1.5")).pinnedSeed()).toBeNull();
    expect((await freshPrng("?seed=-1")).pinnedSeed()).toBeNull();
    expect((await freshPrng("?seed=4294967296")).pinnedSeed()).toBeNull();
  });

  it("accepts both ends of the uint32 range", async () => {
    expect((await freshPrng("?seed=0")).pinnedSeed()).toBe(0);
    expect((await freshPrng("?seed=4294967295")).pinnedSeed()).toBe(0xffffffff);
  });
});

describe("randomSeed with a pinned seed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function freshPrng(search: string) {
    vi.stubGlobal("window", { location: { search } });
    vi.resetModules();
    return await import("./prng");
  }

  it("reproduces the whole sequence across two page loads with the same pin", async () => {
    const first = await freshPrng("?seed=777");
    const a = [first.randomSeed(), first.randomSeed(), first.randomSeed()];
    const second = await freshPrng("?seed=777");
    const b = [second.randomSeed(), second.randomSeed(), second.randomSeed()];
    expect(a).toEqual(b);
  });

  it("hands each level a different seed, so the first loot roll is not identical every level", async () => {
    const { randomSeed: seed } = await freshPrng("?seed=777");
    const seeds = [seed(), seed(), seed(), seed()];
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("gives different pins genuinely different sequences", async () => {
    const a = (await freshPrng("?seed=1")).randomSeed();
    const b = (await freshPrng("?seed=2")).randomSeed();
    expect(a).not.toBe(b);
  });

  it("never consults Math.random once pinned", async () => {
    const spy = vi.spyOn(Math, "random");
    const { randomSeed: seed } = await freshPrng("?seed=99");
    seed();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("still yields uint32 values", async () => {
    const { randomSeed: seed } = await freshPrng("?seed=5");
    for (let i = 0; i < 200; i++) {
      const value = seed();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
