// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the trace-scanning anomaly detectors in `bot.mjs`.
 *
 * These exist because the detectors are the only automated check on bot
 * *behaviour* — `balancing:scan` is built on them — and until now nothing
 * verified that they fire when they should, or stay quiet when they shouldn't.
 * A detector that silently stops firing is worse than no detector, because the
 * scan keeps reporting clean.
 *
 * `detectOscillation` in particular was written against a real, reproducible
 * failure the other two miss entirely: a demo-campaign level that wedges most
 * full-campaign attempts while producing zero findings, because the bot paces
 * instead of freezing.
 */
import { describe, expect, it } from "vitest";
import { detectAnomalies, detectHeldKeyNoMovement, detectOscillation } from "./bot.mjs";

/** One trace record, with the fields the detectors actually read. */
function rec(over = {}) {
  return {
    branch: "main",
    x: 0,
    y: 0,
    hpFrac: 1,
    threatDist: null,
    mineDist: null,
    waitingOnSpike: false,
    moveKeys: [],
    turnBurst: 50,
    fire: false,
    fireOnCooldown: false,
    ...over,
  };
}

/** `n` records ping-ponging along x between `a` and `b`. */
function pingPong(n, a = 10, b = 11, over = {}) {
  return Array.from({ length: n }, (_, i) => rec({ x: i % 2 === 0 ? a : b, y: 10, moveKeys: ["KeyW"], ...over }));
}

/** `n` records walking steadily in +x. */
function traverse(n, step = 0.3) {
  return Array.from({ length: n }, (_, i) => rec({ x: 10 + i * step, y: 10, moveKeys: ["KeyW"] }));
}

describe("detectOscillation", () => {
  it("flags a bot ping-ponging between two waypoints", () => {
    // The real failure shape: real ground covered, no net progress, sustained.
    const found = detectOscillation(pingPong(60));
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("oscillation");
    expect(found[0].ticks).toBeGreaterThanOrEqual(30);
  });

  it("stays quiet on a bot actually going somewhere", () => {
    expect(detectOscillation(traverse(200))).toEqual([]);
  });

  it("stays quiet on a bot standing still", () => {
    // That is `stall`'s job — reporting it here too would just double the noise
    // on every finding.
    expect(detectOscillation(Array.from({ length: 60 }, () => rec({ x: 10, y: 10 })))).toEqual([]);
  });

  it("does not flag circling while engaged with a threat", () => {
    // Sidestepping and dodging in a firefight is deliberate behaviour, not a
    // wedge — counting it would bury the real findings.
    expect(detectOscillation(pingPong(60, 10, 11, { threatDist: 4 }))).toEqual([]);
  });

  it("does flag pacing that is only briefly in combat", () => {
    const trace = pingPong(60);
    for (let i = 0; i < 10; i++) trace[i].threatDist = 4; // a minority
    expect(detectOscillation(trace)).toHaveLength(1);
  });

  it("does not flag waiting out a spike trap", () => {
    expect(detectOscillation(pingPong(60, 10, 11, { waitingOnSpike: true }))).toEqual([]);
  });

  it("needs a sustained run, not a brief wobble", () => {
    expect(detectOscillation(pingPong(20))).toEqual([]);
  });

  it("reports travelled distance, net displacement and their ratio", () => {
    const [f] = detectOscillation(pingPong(60));
    expect(f.detail).toMatch(/travelled=[\d.]+t/);
    expect(f.detail).toMatch(/net=[\d.]+t/);
    expect(f.detail).toMatch(/ratio=/);
  });

  it("treats zero net displacement as maximally oscillatory rather than dividing by zero", () => {
    const [f] = detectOscillation(pingPong(61)); // odd count ends where it began
    expect(f.detail).toContain("ratio=inf");
  });

  it("closes the run once the bot genuinely leaves the area", () => {
    // Pace, then walk away: the pacing is still reported, and the departure is
    // what ends it rather than being folded into one giant finding.
    const found = detectOscillation([...pingPong(40), ...traverse(60)]);
    expect(found).toHaveLength(1);
    expect(found[0].endTick).toBeLessThan(60);
  });

  it("tolerates an absent or too-short trace", () => {
    expect(detectOscillation(undefined)).toEqual([]);
    expect(detectOscillation([])).toEqual([]);
    expect(detectOscillation(pingPong(5))).toEqual([]);
  });
});

describe("the three detectors cover distinct failures", () => {
  const paced = pingPong(60);
  const frozen = Array.from({ length: 60 }, () => rec({ x: 10, y: 10, moveKeys: ["KeyW"] }));

  it("a paced wedge is caught only by detectOscillation", () => {
    // This is exactly why it was written: the existing passes report nothing.
    expect(detectOscillation(paced).length).toBeGreaterThan(0);
    expect(detectAnomalies(paced).filter((f) => f.type === "stall")).toEqual([]);
    expect(detectHeldKeyNoMovement(paced)).toEqual([]);
  });

  it("a frozen wedge is caught by the older passes, not by oscillation", () => {
    expect(detectAnomalies(frozen).some((f) => f.type === "stall")).toBe(true);
    expect(detectHeldKeyNoMovement(frozen).length).toBeGreaterThan(0);
    expect(detectOscillation(frozen)).toEqual([]);
  });
});

describe("detectAnomalies", () => {
  it("flags a frozen position as a stall", () => {
    const found = detectAnomalies(Array.from({ length: 40 }, () => rec({ x: 5, y: 5 })));
    expect(found.some((f) => f.type === "stall")).toBe(true);
  });

  it("does not call a firefight a stall", () => {
    const trace = Array.from({ length: 40 }, () => rec({ x: 5, y: 5, fire: true, threatDist: 3 }));
    expect(detectAnomalies(trace).some((f) => f.type === "stall")).toBe(false);
  });

  it("flags health draining while frozen, even briefly", () => {
    const trace = [rec({ x: 5, y: 5, hpFrac: 1 }), rec({ x: 5, y: 5, hpFrac: 0.9 }), rec({ x: 5, y: 5, hpFrac: 0.8 })];
    expect(detectAnomalies(trace).some((f) => f.type === "healthDrainFrozen")).toBe(true);
  });

  it("does not call waiting out a spike a stall", () => {
    const trace = Array.from({ length: 40 }, () => rec({ x: 5, y: 5, waitingOnSpike: true }));
    expect(detectAnomalies(trace).some((f) => f.type === "stall")).toBe(false);
  });
});

describe("detectHeldKeyNoMovement", () => {
  it("flags a translating key held with no displacement", () => {
    const trace = Array.from({ length: 20 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW"] }));
    expect(detectHeldKeyNoMovement(trace).length).toBeGreaterThan(0);
  });

  it("ignores a turn key, which is not supposed to translate", () => {
    const trace = Array.from({ length: 20 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyE"] }));
    expect(detectHeldKeyNoMovement(trace)).toEqual([]);
  });

  it("reports the union of keys held across the run, not one tick's", () => {
    // Worth pinning: this reads as "these keys were held simultaneously" and is
    // not — it misled a reading of a real trace once.
    const trace = [
      ...Array.from({ length: 8 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW", "KeyE"] })),
      ...Array.from({ length: 8 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW", "KeyQ"] })),
    ];
    const [f] = detectHeldKeyNoMovement(trace);
    expect(f.detail).toContain("keysDuringRun=");
    expect(f.detail).toContain("KeyE");
    expect(f.detail).toContain("KeyQ");
  });
});
