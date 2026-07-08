// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { mulberry32, randomSeed } from './prng';

describe('PRNG', () => {
  it('should generate deterministic numbers based on seed', () => {
    const prng1 = mulberry32(12345);
    const seq1 = [prng1(), prng1(), prng1()];

    const prng2 = mulberry32(12345);
    const seq2 = [prng2(), prng2(), prng2()];

    expect(seq1).toEqual(seq2);
  });

  it('should generate different numbers for different seeds', () => {
    const prng1 = mulberry32(123);
    const prng2 = mulberry32(456);
    
    expect(prng1()).not.toBe(prng2());
  });

  it('randomSeed should return a 32 bit unsigned integer', () => {
    for (let i = 0; i < 100; i++) {
      const seed = randomSeed();
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(seed)).toBe(true);
    }
  });

  it('randomSeed should generate different seeds', () => {
    const seed1 = randomSeed();
    const seed2 = randomSeed();
    expect(seed1).not.toBe(seed2);
  });
});
