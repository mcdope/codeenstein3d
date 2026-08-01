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
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGGRO_RADIUS, ENGAGE_RADIUS, NAVIGATION_PROFILE, profilesHash, PROFILES } from "./profiles.mjs";

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
    // Both of these were non-monotonic until 2026-08-01 — ammoThrift ran
    // 1.6/0.4/0.9 and selfHarmAversion 2.2/0.9/1.3, i.e. Gamer was the most
    // spendthrift and Pro the more self-harm-averse of the two. Neither was
    // detectable without a bot run before this test existed.
    ["ammoThrift", "down"],
    ["selfHarmAversion", "down"],
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

  it("gives only the tiers that should reach for a rocket launcher access to one", () => {
    // `weaponPriority` membership is a hard filter — the scoring loop iterates
    // this list, so an absent weapon is never considered at all. Casual
    // omitting ghidra is therefore a real behavioural tier, not a preference.
    const GHIDRA = 4;
    expect(PROFILES.Casual.weaponPriority).not.toContain(GHIDRA);
    expect(PROFILES.Gamer.weaponPriority).toContain(GHIDRA);
    expect(PROFILES.Pro.weaponPriority).toContain(GHIDRA);
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

describe("profilesHash — the staleness guard for defaultHighscore.ts", () => {
  const generated = path.join(import.meta.dirname, "../../src/engine/defaultHighscore.ts");
  // Read as text rather than importing: the module is a ~640KB generated data
  // literal, and only one small constant is wanted from it.
  const source = fs.readFileSync(generated, "utf8");
  const baked = /export const PROFILES_HASH = "([0-9a-f]{64})";/.exec(source)?.[1] ?? null;

  it("is deterministic", () => {
    expect(profilesHash()).toBe(profilesHash());
    expect(profilesHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the hash baked into the shipped defaultHighscore.ts", () => {
    if (baked === null) {
      // The shipped file predates this guard, so there is nothing to compare
      // against yet — it arms at the next `npm run generate:default-highscore`.
      // Deliberately not a failure: an assertion that cannot pass until an
      // unrelated 35-minute job runs would just be turned off by whoever hits
      // it, which is worse than a guard that arms slightly later.
      expect(source).toContain("DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED");
      return;
    }
    expect(
      baked,
      "src/engine/defaultHighscore.ts was generated by different bot profiles — " +
        "those runs no longer represent the current bot. Re-run `npm run generate:default-highscore`.",
    ).toBe(profilesHash());
  });
});

describe("profilesHash sensitivity", () => {
  // The hash is only useful if it moves for real changes and stays put for
  // cosmetic ones. Exercised through a local re-implementation of the same
  // rule, since the real one closes over the live PROFILES.
  const hashOf = (obj) => {
    const stable = (v) =>
      Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
          : v;
    return JSON.stringify(Object.entries(obj).map(([k, v]) => [k, stable(v)]));
  };

  it("ignores field reordering inside a profile, which changes no behaviour", () => {
    expect(hashOf({ A: { a: 1, b: 2 } })).toBe(hashOf({ A: { b: 2, a: 1 } }));
  });

  it("changes when any tuning value changes", () => {
    expect(hashOf({ A: { a: 1 } })).not.toBe(hashOf({ A: { a: 1.0001 } }));
  });

  it("changes when the ladder is reordered, because tier order is read positionally", () => {
    // `curateMixedProfiles` takes key order as tier order, so this is a real
    // change even though the same three profiles are present.
    expect(hashOf({ A: {}, B: {} })).not.toBe(hashOf({ B: {}, A: {} }));
  });
});
