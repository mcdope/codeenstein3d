import { describe, it, expect } from 'vitest';
import { DIFFICULTY_MULTIPLIERS, DEFAULT_DIFFICULTY } from './difficulty';

describe('Difficulty Configuration', () => {
  it('should have normal as default difficulty', () => {
    expect(DEFAULT_DIFFICULTY).toBe('normal');
  });

  it('should define multipliers for all difficulty levels', () => {
    expect(DIFFICULTY_MULTIPLIERS).toHaveProperty('easy');
    expect(DIFFICULTY_MULTIPLIERS).toHaveProperty('normal');
    expect(DIFFICULTY_MULTIPLIERS).toHaveProperty('hard');
  });

  it('easy difficulty should scale correctly', () => {
    const easy = DIFFICULTY_MULTIPLIERS.easy;
    expect(easy.hp).toBe(0.7);
    expect(easy.damage).toBe(0.7);
    expect(easy.ammoDropRate).toBe(1.3);
  });

  it('normal difficulty should scale correctly', () => {
    const normal = DIFFICULTY_MULTIPLIERS.normal;
    expect(normal.hp).toBe(1);
    expect(normal.damage).toBe(1);
    expect(normal.ammoDropRate).toBe(1);
  });

  it('hard difficulty should scale correctly', () => {
    const hard = DIFFICULTY_MULTIPLIERS.hard;
    expect(hard.hp).toBe(1.5);
    expect(hard.damage).toBe(1.5);
    expect(hard.ammoDropRate).toBe(0.7);
  });
});
