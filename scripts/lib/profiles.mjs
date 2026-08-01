// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The playtest bot's skill profiles, and the radii they share.
 *
 * Extracted from `run-balancing-telemetry.mjs` (which re-exports everything
 * here, so no caller changed) for two reasons:
 *
 * 1. **Tests can import the real profiles.** This module pulls in only
 *    `combatPolicy.mjs`'s pure weapon-index constants — no Playwright, no
 *    browser, no telemetry harness — so a unit test can assert against the
 *    values that actually ship. `combatPolicy.test.mjs` previously hand-copied
 *    Gamer's numbers into a local fixture, which no test could detect drifting.
 * 2. **The ladder is a thing that can be checked.** `profiles.test.mjs` asserts
 *    key order and per-knob monotonicity; several consumers depend on both and
 *    nothing enforced either. `curateMixedProfiles`
 *    (`run-balancing-telemetry-multiplayer.mjs`) reads `tierNames[0]` as the
 *    weakest tier and treats adjacent keys as one tier apart, and
 *    `QUALIFY_LEVEL_INDEX_BY_PROFILE` (`generate-default-highscore.mjs`) is
 *    keyed by profile *name*, failing silently if one is renamed.
 *
 * A profile may carry a `tuning` object. It is deep-merged over
 * `DEFAULT_TUNING` in the `Bot` constructor and under any explicit
 * `opts.tuning`, so a profile can own what would otherwise be a global
 * constant — which is how a tier expresses *competence* (how well it avoids
 * damage) rather than only *pace* (how fast it moves and shoots). See
 * `scripts/lib/bot.mjs`'s constructor.
 */
import {
  PISTOL_WEAPON_INDEX,
  SHOTGUN_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  FRIDAY_HOTFIX_WEAPON_INDEX,
} from "./combatPolicy.mjs";

// Mirrors src/engine/enemyAi.ts — plain literal rather than importing that TS
// module (this is a plain Node script, not bundled like the map/parser layer
// in loadEngineModules.mjs). Only referenced here (via `ENGAGE_RADIUS`) for
// `PROFILES.*.engageRadius` — every other movement/combat tuning constant
// lives in `scripts/lib/bot.mjs`'s `DEFAULT_TUNING`.
export const AGGRO_RADIUS = 7.5;
export const ENGAGE_RADIUS = AGGRO_RADIUS + 2; // combat always preempts navigation within this — same for every profile, non-negotiable, see PROFILES's doc comment

/**
 * Bot behavior profiles. `engageRadius` is deliberately identical across all
 * three (see `ENGAGE_RADIUS`) — "low aggression" (Casual) never means
 * skipping a fight, only a looser `fireAngleEps` (worse aim) and a lower
 * `healthDetourThreshold` urgency inversion (higher = detours for health
 * sooner). `weaponPriority` lists ranged `WEAPONS` indices in preference
 * order (melee indices are excluded — melee-in-range is handled separately,
 * universally, for every profile: see the `MELEE_RANGE` check in
 * `Bot#tick`). Every profile's list ends in a complete fallback chain
 * (pistol, shotgun, Friday Hotfix) so a profile never ends up with *no*
 * valid ranged option just because its preferred unlockable weapon isn't
 * owned yet or is out of ammo — Pro's list originally omitted the
 * shotgun/Friday Hotfix entirely, meaning it had nothing to fall back on
 * beyond the bare pistol whenever ghidra/gdb weren't available, found while
 * investigating why Pro/normal was taking dramatically longer to qualify
 * than the "less skilled" Casual and Gamer profiles despite Pro's much
 * tighter aim.
 *
 * `proactiveMineDisarm` is `true` for every profile — mines were the #1
 * killer in early testing even for profiles that didn't proactively shoot
 * them, kept as a per-profile field only so it still shows up explicitly in
 * the output's `meta.profiles` dump.
 *
 * `coverageMode` is `false` for every profile — navigation is always
 * shortest-route-to-exit (`planRoute`, not `planCoverageRoute`), regardless
 * of skill level. This was originally Casual-only "maximize map coverage"
 * (visit every room), which turned out to be the single biggest driver of
 * Casual's implausibly low survival rate — see the git history for the full
 * rationale. Skill differences now come entirely from combat/aim/tactics,
 * not from how much of the map gets walked.
 *
 * `fireAngleEps` calibration note: earlier values (Casual 0.17-0.22, Gamer
 * 0.15, Pro 0.08) were all *far* too loose — see git history for the
 * controlled-experiment writeup. Retuned to a much tighter ladder that still
 * preserves real skill differentiation (Pro tightest, Casual loosest)
 * without any tier being catastrophically bad.
 *
 * `fireCooldownMs`: the minimum simulated time (`Bot#simTimeMs`, see
 * `bot.mjs`) between two dispatched shots of a *semi-auto* ranged weapon
 * (pistol/shotgun/ghidra) — those have no engine-side fire-rate cap (see
 * `updateFiring`'s doc comment in `engine.ts`) and fire exactly once per
 * `Backquote` keydown, so a bot re-dispatching that key every single
 * decision tick fired far faster than any human trigger-pull (~20/sec at
 * the headless 50ms tick rate — "the pistol becomes an smg"). Auto weapons
 * (gdb/Friday Hotfix) are unaffected by this field, since their own
 * `fireIntervalSec` cooldown already caps them realistically while held.
 * Values are plausible real semi-auto trigger-pull rates, tightest→loosest
 * matching the `fireAngleEps`/`rotSpeedMultiplier` skill ladder: Pro 120ms
 * (~8.3/sec, a fast competitive rate), Gamer 160ms (~6.25/sec), Casual
 * 220ms (~4.5/sec, an unhurried rate).
 */
export const PROFILES = {
  Casual: {
    fireAngleEps: 0.08,
    fireCooldownMs: 220,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Simple/reliable weapons first; ghidra last (a "casual" player is more
    // hesitant with a self-splash-capable rocket launcher) — but still in
    // the list, since every profile should be able to use whatever it has.
    weaponPriority: [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, GDB_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.75,
    proactiveMineDisarm: true,
    // Same "more hesitant with a self-splash launcher" reasoning as the
    // weaponPriority ordering above, applied to situational cluster-
    // targeting too (see `pickRangedWeapon` in bot.mjs) — sticks to the
    // shotgun for a distant cluster instead of reaching for rockets.
    rocketForDistantClusters: false,
    // Exchange rate between "kill it faster" and "still have ammo later", used
    // by `scoreRangedWeapon`. Casual is thrifty: it accepts a slower kill
    // rather than burn down a scarce reserve, matching the same conservative
    // streak as its 0.75 healthDetourThreshold.
    ammoThrift: 1.6,
    // Restores the hesitancy the old ghidra-last `weaponPriority` used to
    // encode: a casual player is wary of a self-splash-capable launcher.
    selfHarmAversion: 2.2,
    // See `botRotSpeedMul`'s doc comment (engine.ts's `rotSpeedMultiplier`)
    // — approximates a realistic *mouse* turn speed for this skill tier
    // rather than the real Q/E keyboard rate, since mouse-look itself isn't
    // available to a Playwright-automated browser. ~2x keyboard (~5.2
    // rad/sec, ~300°/sec) — an unhurried, average mouse sensitivity.
    rotSpeedMultiplier: 2,
  },
  Gamer: {
    fireAngleEps: 0.05,
    fireCooldownMs: 160,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Ammo-efficient auto weapon first, heavy hitter last, everything else
    // in between.
    weaponPriority: [GDB_WEAPON_INDEX, PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.5,
    proactiveMineDisarm: true,
    rocketForDistantClusters: true,
    // Aggressive: spends the reserve to end fights sooner — the same streak
    // as its 160ms trigger and 0.5 healthDetourThreshold.
    ammoThrift: 0.4,
    selfHarmAversion: 0.9,
    // ~3.5x keyboard (~9.1 rad/sec, ~520°/sec) — a comfortable, practiced
    // enthusiast's mouse turn speed.
    rotSpeedMultiplier: 3.5,
  },
  Pro: {
    fireAngleEps: 0.03,
    fireCooldownMs: 120,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Heavy hitters first, complete fallback chain through everything else —
    // was missing 1/FRIDAY_HOTFIX_WEAPON_INDEX entirely before, the direct
    // cause of Pro/normal needing far more attempts to qualify than the
    // "less skilled" profiles.
    weaponPriority: [GHIDRA_WEAPON_INDEX, GDB_WEAPON_INDEX, PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX],
    healthDetourThreshold: 0.25,
    proactiveMineDisarm: true,
    rocketForDistantClusters: true,
    // Exchange rate between "kill it faster" and "still have ammo later", used
    // by `scoreRangedWeapon`. Pro sits between the other two: it optimises the
    // trade rather than favouring either side of it.
    ammoThrift: 0.9,
    selfHarmAversion: 1.3,
    // ~5x keyboard (~13 rad/sec, ~745°/sec) — a fast, high-sensitivity
    // competitive flick-turn, still within real human mouse-aim territory.
    rotSpeedMultiplier: 5,
  },
};

/**
 * Not a skill tier — a bot that navigates predictably.
 *
 * Deliberately **not** a member of `PROFILES`: `Object.keys(PROFILES)` is
 * load-bearing for the mixed-skill multiplayer matrix and for the highscore
 * generator's per-profile qualify bar, so adding a fourth key there would
 * change both.
 *
 * `verify-multiplayer-transition.mjs` and `verify-multiplayer-campaign.mjs`
 * used to pin `PROFILES.Casual`, described in their own comments as "already
 * proven safe for the navigation-only decisions". But the transition script
 * god-modes its host and passes `ignoreThreats: true`, so it never exercises a
 * combat knob at all — it wants a bot that reliably walks to an exit, not a
 * skill tier. Pinning a tier meant that retuning Casual could slow or flake an
 * ~18-minute CI job that has nothing to do with skill. This decouples them.
 */
export const NAVIGATION_PROFILE = {
  ...PROFILES.Gamer,
  tuning: { ...(PROFILES.Gamer.tuning ?? {}) },
};
