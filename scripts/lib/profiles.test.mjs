// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Static guards on the skill ladder — no browser, no bot time.
 *
 * Two consumers depend on properties of `PROFILES` that nothing enforced:
 * `curateMixedProfiles` (`run-balancing-telemetry-multiplayer.mjs`) reads
 * `tierNames[0]` as the weakest tier and treats adjacent keys as one tier
 * apart, and `QUALIFY_LEVEL_INDEX_BY_PROFILE`
 * (`generate-default-highscore.mjs`) is keyed by profile *name* and silently
 * makes every attempt non-qualifying if one is renamed.
 *
 * The monotonicity assertions matter because the whole point of a skill ladder
 * is that it is ordered. A knob that stops being monotone is a tier that stops
 * meaning anything, and it is otherwise only discoverable by spending ~40
 * minutes of bot time.
 */
import { describe, expect, it } from "vitest";
import { AGGRO_RADIUS, ENGAGE_RADIUS, NAVIGATION_PROFILE, PROFILES } from "./profiles.mjs";

/** Weakest → strongest. Several consumers depend on exactly this. */
const LADDER = ["Casual", "Gamer", "Pro"];

describe("PROFILES ladder", () => {
  it("has exactly the three expected tiers, weakest first", () => {
    expect(Object.keys(PROFILES)).toEqual(LADDER);
  });

  // Each entry: knob, and the direction it must move from Casual to Pro.
  // "down" = a more skilled tier has a smaller number.
  it.each([
    ["fireAngleEps", "down"],
    ["fireCooldownMs", "down"],
    ["rotSpeedMultiplier", "up"],
    ["healthDetourThreshold", "down"],
  ])("is monotonic on %s (%s the ladder)", (knob, direction) => {
    const values = LADDER.map((name) => PROFILES[name][knob]);
    const ordered = direction === "down" ? [...values].sort((a, b) => b - a) : [...values].sort((a, b) => a - b);
    expect(values).toEqual(ordered);
    // Strictly monotone: two tiers sharing a value is a tier that isn't one.
    expect(new Set(values).size).toBe(values.length);
  });

  it("leaves every tier a complete ranged fallback chain", () => {
    // The historical Pro bug: its list omitted the shotgun and Friday Hotfix,
    // so whenever its unlockables were dry it had nothing but the bare pistol
    // — which read as "Pro is worse than Casual" in the telemetry.
    for (const name of LADDER) {
      expect(PROFILES[name].weaponPriority).toContain(0); // pistol, always owned
      expect(PROFILES[name].weaponPriority.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps engageRadius identical across tiers", () => {
    // Deliberate: "low aggression" must never mean skipping a fight, or the
    // tiers stop differing in competence and start differing in how much of
    // the world they engage with at all.
    for (const name of LADDER) expect(PROFILES[name].engageRadius).toBe(ENGAGE_RADIUS);
    expect(ENGAGE_RADIUS).toBe(AGGRO_RADIUS + 2);
  });
});

describe("NAVIGATION_PROFILE", () => {
  it("is not a member of the ladder", () => {
    // It exists so the two multiplayer CI verifiers stop pinning a skill tier.
    // If it ever became a `PROFILES` key it would change the mixed-skill
    // matrix and the highscore generator's per-profile qualify bar.
    expect(Object.values(PROFILES)).not.toContain(NAVIGATION_PROFILE);
    expect(Object.keys(PROFILES)).toHaveLength(3);
  });

  it("carries everything a Bot needs to navigate", () => {
    for (const key of ["engageRadius", "weaponPriority", "rotSpeedMultiplier", "fireCooldownMs", "healthDetourThreshold"]) {
      expect(NAVIGATION_PROFILE[key]).toBeDefined();
    }
  });
});
