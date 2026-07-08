// src/engine/loot.test.ts
import { describe, it, expect } from "vitest";
import { rollLoot } from "./loot";

describe("rollLoot", () => {
  it("uses BONUS_LOOT_WEIGHTS when bonusLevel is true", () => {
    // bonus level weights:
    // bullets: 30, rockets: 25, health: 25, swap: 20
    // Total: 100
    expect(rollLoot(true, "normal", () => 0.1)).toBe("bullets"); // 10 < 30
    expect(rollLoot(true, "normal", () => 0.4)).toBe("rockets"); // 40 -> 40-30=10 < 25
    expect(rollLoot(true, "normal", () => 0.7)).toBe("health"); // 70 -> 70-55=15 < 25
    expect(rollLoot(true, "normal", () => 0.9)).toBe("swap"); // 90 -> 90-80=10 < 20
  });

  it("uses NORMAL_LOOT_WEIGHTS when difficulty is normal", () => {
    // normal weights:
    // bullets: 58, rockets: 12, health: 15, swap: 15
    // Total: 100
    expect(rollLoot(false, "normal", () => 0.1)).toBe("bullets"); // 10 < 58
    expect(rollLoot(false, "normal", () => 0.65)).toBe("rockets"); // 65 -> 65-58=7 < 12
    expect(rollLoot(false, "normal", () => 0.8)).toBe("health"); // 80 -> 80-70=10 < 15
    expect(rollLoot(false, "normal", () => 0.95)).toBe("swap"); // 95 -> 95-85=10 < 15
  });

  it("uses LOOT_WEIGHTS when difficulty is easy or hard", () => {
    // easy/hard weights:
    // bullets: 50, rockets: 10, health: 20, swap: 20
    // Total: 100
    expect(rollLoot(false, "easy", () => 0.1)).toBe("bullets"); // 10 < 50
    expect(rollLoot(false, "easy", () => 0.55)).toBe("rockets"); // 55 -> 55-50=5 < 10
    expect(rollLoot(false, "easy", () => 0.7)).toBe("health"); // 70 -> 70-60=10 < 20
    expect(rollLoot(false, "easy", () => 0.9)).toBe("swap"); // 90 -> 90-80=10 < 20

    expect(rollLoot(false, "hard", () => 0.1)).toBe("bullets");
    expect(rollLoot(false, "hard", () => 0.55)).toBe("rockets");
    expect(rollLoot(false, "hard", () => 0.7)).toBe("health");
    expect(rollLoot(false, "hard", () => 0.9)).toBe("swap");
  });

  it("filters out rockets when hasRocketLauncher is false", () => {
    // normal without rockets:
    // bullets: 58, health: 15, swap: 15
    // Total: 88
    expect(rollLoot(false, "normal", () => 0.65, false)).toBe("bullets"); // 0.65 * 88 = 57.2 < 58
    expect(rollLoot(false, "normal", () => 0.75, false)).toBe("health"); // 0.75 * 88 = 66 -> 66-58=8 < 15
    expect(rollLoot(false, "normal", () => 0.95, false)).toBe("swap"); // 0.95 * 88 = 83.6 -> 83.6-73=10.6 < 15
  });

  it("filters out health when playerAtFullHealth is true", () => {
    // normal without health:
    // bullets: 58, rockets: 12, swap: 15
    // Total: 85
    expect(rollLoot(false, "normal", () => 0.8, true, true)).toBe("rockets"); // 0.8 * 85 = 68 -> 68-58=10 < 12
    expect(rollLoot(false, "normal", () => 0.95, true, true)).toBe("swap"); // 0.95 * 85 = 80.75 -> 80.75-70=10.75 < 15
  });

  it("filters out both rockets and health", () => {
    // normal without rockets or health:
    // bullets: 58, swap: 15
    // Total: 73
    expect(rollLoot(false, "normal", () => 0.9, false, true)).toBe("swap"); // 0.9 * 73 = 65.7 -> 65.7-58=7.7 < 15
  });

  it("returns the first item when rng is 1 to cover loop-completion edge case", () => {
    // If rng() returns 1 (which it shouldn't normally, but theoretically could),
    // the variable `r` = `total`, and it bypasses `< w.weight` in the loop, falling through to `usable[0].kind`.
    expect(rollLoot(false, "normal", () => 1)).toBe("bullets");
  });

  it("works with default parameters", () => {
    const result = rollLoot();
    expect(["bullets", "rockets", "health", "swap"]).toContain(result);
  });

  it("works with default rng when other defaults are used", () => {
    const result = rollLoot(true);
    expect(["bullets", "rockets", "health", "swap"]).toContain(result);
  });
});
