// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the replay balance fingerprint.
 *
 * The bug this guards against was live and silent: halving
 * `ELITE_HP_MULTIPLIER` changed generated enemy HP without touching any
 * demo-campaign source, so every segment's `astHash` still matched and the
 * shipped replays would have played the recorded inputs against a differently
 * balanced world. The two properties worth pinning are therefore "an HP change
 * moves the hash" and "an option that only reshuffles pickups does not".
 */
import { describe, expect, it } from "vitest";
import { balanceHashMatches, computeBalanceHash, sha256Hex, stableStringify, type BalanceRelevantEnemy } from "./balanceHash";

const enemy = (over: Partial<BalanceRelevantEnemy> = {}): BalanceRelevantEnemy => ({ x: 3, y: 4, maxHp: 100, elite: false, ...over });
const SIM = { MOVE_SPEED: 3.2, MAX_HEALTH: 100 } as const;

describe("stableStringify", () => {
  it("is insensitive to key order, so a cosmetic reorder doesn't invalidate replays", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("is still sensitive to values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("sorts nested keys too", () => {
    expect(stableStringify({ o: { a: 1, b: 2 } })).toBe(stableStringify({ o: { b: 2, a: 1 } }));
  });

  it("handles primitives, null and undefined members", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(5)).toBe("5");
    expect(stableStringify("s")).toBe('"s"');
    expect(stableStringify(true)).toBe("true");
    // An undefined property is dropped rather than serialized, so adding an
    // explicitly-undefined field doesn't move the fingerprint.
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("serializes a bare undefined as null rather than undefined", () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string — without the
    // fallback this would splice a literal `undefined` into the digest input.
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify([undefined])).toBe("[null]");
  });
});

describe("sha256Hex", () => {
  it("returns 64 lowercase hex characters", async () => {
    const hex = await sha256Hex("abc");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("computeBalanceHash", () => {
  it("changes when an enemy's max HP changes — the Elite-nerf case", async () => {
    const before = await computeBalanceHash({ enemies: [enemy({ maxHp: 4400, elite: true })] }, SIM);
    const after = await computeBalanceHash({ enemies: [enemy({ maxHp: 2200, elite: true })] }, SIM);
    expect(after).not.toBe(before);
  });

  it("changes when an enemy becomes an Elite", async () => {
    const a = await computeBalanceHash({ enemies: [enemy({ elite: false })] }, SIM);
    const b = await computeBalanceHash({ enemies: [enemy({ elite: true })] }, SIM);
    expect(a).not.toBe(b);
  });

  it("changes when enemies are added, removed or moved", async () => {
    const base = await computeBalanceHash({ enemies: [enemy()] }, SIM);
    expect(await computeBalanceHash({ enemies: [enemy(), enemy({ x: 9 })] }, SIM)).not.toBe(base);
    expect(await computeBalanceHash({ enemies: [] }, SIM)).not.toBe(base);
    expect(await computeBalanceHash({ enemies: [enemy({ x: 7 })] }, SIM)).not.toBe(base);
  });

  it("changes when a simulation constant changes", async () => {
    const a = await computeBalanceHash({ enemies: [enemy()] }, { ...SIM, MOVE_SPEED: 3.2 });
    const b = await computeBalanceHash({ enemies: [enemy()] }, { ...SIM, MOVE_SPEED: 4.0 });
    expect(a).not.toBe(b);
  });

  it("ignores fields that mutate during play", async () => {
    // Only the static roster fields are read. Were `hp`/`alive`/`aggroed`
    // folded in, the fingerprint would depend on *when* it was taken and a
    // mid-run hash could never match a fresh one.
    const fresh = await computeBalanceHash({ enemies: [enemy()] }, SIM);
    const midRun = await computeBalanceHash(
      { enemies: [{ ...enemy(), hp: 3, alive: false, aggroed: true } as BalanceRelevantEnemy] },
      SIM,
    );
    expect(midRun).toBe(fresh);
  });

  it("is stable across calls, so recording and playback agree", async () => {
    const a = await computeBalanceHash({ enemies: [enemy(), enemy({ x: 1, elite: true })] }, SIM);
    const b = await computeBalanceHash({ enemies: [enemy(), enemy({ x: 1, elite: true })] }, SIM);
    expect(a).toBe(b);
  });
});

describe("balanceHashMatches", () => {
  it("accepts a run recorded before the guard existed", () => {
    // Deliberate: the shipped defaultHighscore.ts has no hashes yet, and
    // refusing them would break "Watch Replay" for every first-time visitor.
    expect(balanceHashMatches(undefined, "anything")).toBe(true);
  });

  it("accepts a matching hash and refuses a stale one", () => {
    expect(balanceHashMatches("abc", "abc")).toBe(true);
    expect(balanceHashMatches("abc", "def")).toBe(false);
  });
});
