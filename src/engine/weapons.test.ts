// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  WEAPONS,
  STARTING_WEAPONS,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  MELEE_WEAPON,
  pelletOffsets,
  Weapon
} from './weapons';

describe('weapons', () => {
  it('should export WEAPONS with exactly 5 weapons', () => {
    expect(WEAPONS.length).toBe(5);
  });

  it('should export starting weapons', () => {
    expect(STARTING_WEAPONS).toEqual([0, 1, 2]);
  });

  it('should have correct indices for gdb and ghidra', () => {
    expect(GDB_WEAPON_INDEX).toBe(3);
    expect(GHIDRA_WEAPON_INDEX).toBe(4);
  });

  it('should identify the MELEE_WEAPON correctly', () => {
    expect(MELEE_WEAPON.name).toBe('SIGKILL Knife');
    expect(MELEE_WEAPON.meleeRange).toBe(1.5);
  });

  describe('pelletOffsets', () => {
    it('returns [0] if weapon has 1 pellet', () => {
      const weapon = {
        name: 'test',
        pellets: 1,
        spreadPx: 10,
        damagePerPellet: 1,
        ammoPerShot: 1,
        tracerColor: '#fff',
        viewKind: 'pistol'
      };
      expect(pelletOffsets(weapon)).toEqual([0]);
    });

    it('returns [0] if weapon has 0 pellets', () => {
      const weapon = {
        name: 'test',
        pellets: 0,
        spreadPx: 10,
        damagePerPellet: 1,
        ammoPerShot: 1,
        tracerColor: '#fff',
        viewKind: 'pistol'
      };
      expect(pelletOffsets(weapon)).toEqual([0]);
    });

    it('returns evenly spaced offsets if weapon has >1 pellets', () => {
      const weapon = {
        name: 'test',
        pellets: 3,
        spreadPx: 10,
        damagePerPellet: 1,
        ammoPerShot: 1,
        tracerColor: '#fff',
        viewKind: 'pistol'
      };
      expect(pelletOffsets(weapon)).toEqual([-10, 0, 10]);
    });
  });
});
