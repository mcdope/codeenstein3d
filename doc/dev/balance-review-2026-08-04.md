# Balance review — 2026-08-04

First review produced with the offline solver and the event log
(`doc/dev/balancing-telemetry.md`, "The balance model"). Every number here is
reproducible from a clean checkout:

```sh
npm run balancing:budget -- --all-difficulties --json demo-all.json
npm run balancing:corpus && npm run balancing:budget -- --dir balancing_corpus/<id>
CODEENSTEIN_TELEMETRY_EVENT_LOG=ev npm run balancing:telemetry   # scoped, see §7
npm run balancing:events -- ev/
```

**Scope.** The analytic half covers the 17-level `demo-campaign/` at all three
difficulties plus 8 real repositories (6,700 generated enemies in total). The
empirical half is a scoped bot capture, sample sizes stated in §7. Read §8 before
acting on anything: the solver is deliberately optimistic in one direction and
that shapes what its numbers mean.

---

## 1. The five findings, ranked

| # | Finding | Evidence | Where it lives |
|---|---|---|---|
| 1 | **Hard collapses in the back half of the campaign.** Not "harder" — a cliff. | Carried ammo peaks at level 9 and hits **zero by level 14**; levels 15 and 17 are unclearable *counting every drop* (0.30 and 0.92) | `difficulty.ts` |
| 2 | **Killing things pays for itself, so ammo has no floor.** | Edge Cases return **8.5–13.5×** the damage they cost, across every repo tested; regular enemies exceed 1.0 on 5 of 8 | `loot.ts`, `enemies.ts` |
| 3 | **A repo is mostly trivial functions, and the generator prices them as full enemies.** | **81.5%** of enemies come from complexity-1 entities; **65%** of the roster is Edge Cases; 47% of regular enemies sit at the 25 HP floor | `enemies.ts` |
| 4 | **The Elite threshold is a cliff, and past it HP is unbounded.** | c=39 → 244 HP, c=40 → **2000 HP**. On Hard, demo level 15 has two Elites that individually exceed all obtainable damage | `enemies.ts:89-101` |
| 5 | **Two weapons are dead content for the bot.** | ghidra: **0 shots in 5,897**, owned on 71 level-visits. Friday Hotfix: **25 pulls** and 1.4% of kills across 1,049 kills | `weapons.ts`, `combatPolicy.mjs` |

---

## 2. What a repository actually becomes

Across the corpus plus the demo campaign — 6,700 enemies generated from real
source:

| Complexity of the source entity | Enemies produced | Share |
|---|---:|---:|
| 1 | 5,461 | **81.5%** |
| 2–4 | 702 | 10.5% |
| 5–9 | 246 | 3.7% |
| 10–19 | 192 | 2.9% |
| 20–39 | 90 | 1.3% |
| **40+ (Elite)** | **9** | **0.13%** |

| Archetype | Count | Share |
|---|---:|---:|
| Edge Case | 4,370 | **65.2%** |
| Regular | 2,321 | 34.6% |
| Elite | 9 | 0.13% |

Two things follow, and they drive most of §3.

**The design's central mapping barely varies in practice.** "HP scales with
cyclomatic complexity" is the game's core idea, but four fifths of real functions
have complexity 1, so four fifths of enemies land on `Math.max(HP_PER_COMPLEXITY,
…)` — the *floor*, not the curve. 47% of regular enemies are exactly 25 HP. The
complexity mapping is expressive across the 18.5% tail and flat everywhere else.

**Two thirds of the roster isn't from the source at all.** Edge Cases come from
corridor dressing (`enemies.ts:176-215`), 1–3 per breakup room, and they outnumber
source-derived enemies 2:1. That is a pacing decision doing most of the work of
populating a level, which is fine — but every economy number in §3 is dominated by
them, and that is probably not intended.

### The Elite cliff, measured

| Complexity | Enemies spawned | HP each | Total |
|---:|---:|---:|---:|
| 37 | 4 | 231 | 924 |
| 39 | 4 | 244 | 976 |
| **40** | **1** | **2000** | **2000** |
| 41 | 1 | 2050 | 2050 |
| 47 | 1 | 2350 | 2350 |

One point of complexity multiplies single-enemy HP by **8.2×** and doubles the
room's total. Past the threshold `hp = complexity × 25 × 2` is linear and
**unbounded** — there is no clamp, cap or normalisation anywhere in the generator.

It is rare (0.13% of enemies) but not hypothetical: it already caused one live
incident (`enemies.ts:22-37`, a complexity-44 function killing the bot 12/12 runs),
and on Hard it makes demo level 15 unwinnable outright.

---

## 3. The loot economy has no floor

**Self-sustain** is the damage-worth of what an enemy drops, over the damage it
costs to kill. Above 1.0, fighting is net-positive ammo.

| Repo | regular | Edge Case |
|---|---:|---:|
| axios | 2.07 | 13.0 |
| chi | 2.70 | 13.0 |
| click | 2.75 | 13.5 |
| flask | 2.86 | 13.4 |
| ripgrep | 2.43 | 13.3 |
| cJSON | 0.96 | 10.4 |
| kilo | 0.77 | 9.1 |
| ms | 0.66 | 8.5 |
| *demo campaign, **measured*** | ***0.95–0.98*** | ***10.6–11.1*** |

**Edge Cases are an ammo printer.** They take the regular drop path with no
special-casing, so a 12 HP nuisance is valued identically to a 250 HP enemy —
and they are 65% of the roster. At 8.5–13.5× return they invalidate any scarcity
the rest of the design is aiming for.

**Regular enemies are net-positive too** on the five larger repos, for the same
reason one layer down: 47% of them are 25 HP floor enemies paying a full-sized
drop.

The analytic prediction (from the drop tables) and the empirical measurement (from
observed rolls) agree closely, and the measurement is stable across profiles —
Casual and Gamer land at 0.98/0.95 for regulars and 10.64/11.05 for Edge Cases over
1,049 kills, against predictions of 0.76–2.33 and 8.1–13.8. Two models built from
opposite directions landing together is what makes this a finding rather than an
artifact of either.

### Where the loot actually comes from

Measured, demo campaign: **83.9–84.2%** of everything collected came from drops
rather than from the floor. Pre-placed placement is ~16% of the economy, so tuning
it moves almost nothing — which matches the earlier campaign finding of 93–100%
and is why the drop amounts were cut ~30%.

**Also measured: 101 of 288 health pickups granted nothing at all** (31% and 39%
across the two profiles), collected at full stability — over a third of health
placement doing no work.

---

## 4. Difficulty is a cliff, not a slope

Combined clear ratio (drops included), demo campaign:

| Level | easy | normal | hard |
|---:|---:|---:|---:|
| 1 | 20.3 | 13.6 | 8.8 |
| 5 | 34.2 | 19.4 | 9.3 |
| 9 | 46.9 | 24.1 | 9.4 |
| 11 | 22.6 | 11.2 | 3.7 |
| 12 | 12.6 | 6.2 | 2.0 |
| 13 | 13.4 | 6.2 | 1.5 |
| **15** | 7.3 | 3.0 | **0.30** |
| 16 (bonus) | 142.3 | 47.9 | 6.8 |
| **17** | 6.5 | 2.9 | **0.92** |

Easy→hard is 2.3× at level 1 and **24× at level 15**. The two multipliers compound
through carryover rather than applying per level: enemies get 1.5× HP *and* pickups
give 0.7×, so the deficit accumulates.

Carried ammo, in damage, without farming:

- **normal**: 3,894 → plateaus around 11,000. Never runs out.
- **hard**: 4,769 → peaks 6,414 at level 9 → **1,930 → 0 → 116 → 0** at levels 13–16.

Hard's back half is played on drops alone. The solver's `combined` column still
counts those drops, and levels 15 and 17 fail anyway.

**Survival windows** (full health, no armour): 1 regular enemy 7.0/6.0/4.0s, three
at once 2.3/2.0/1.3s, one Elite 3.5/3.0/2.0s. Level 17 alone fields **846 enemy
DPS**.

---

## 5. Weapons

Perfect-accuracy efficiency, from the real table:

| Weapon | dmg/trigger | ammo | **dmg per ammo** | dps | pool |
|---|---:|---:|---:|---:|---|
| echo pistol | 22 | 1 | 22.0 | 147 | bullets |
| Regex Shotgun | 175 | 4 | **43.8** | 206 | bullets |
| gdb | 12 | 1 | 12.0 | 133 | smg |
| ghidra | 150 | 1 | 150.0 | 136 | rockets |
| Friday Hotfix | 48 | 2.5 | 19.2 | 480 | gas |
| SIGKILL Knife | 40 | — | ∞ | 267 | — |
| Toolchain | 80 | — | ∞ | 229 | — |

The shotgun is **2× the pistol per round out of the same pool** — so a
bullets-starved level should always be shot-gunned, and `startingBullets` (which
prices the reserve at pistol efficiency) is roughly twice as generous as it reads.

### Observed

Aggregated over two 12-level captures (Casual and Gamer, normal, 5 attempts each):
**1,049 kills, 3,936 trigger-pulls**. The two profiles have different aim
tolerances (`fireAngleEps` 0.08 vs 0.05), so the hit rates are a blend.

| Weapon | pulls | pellet hit rate | 0–2 | 2–4 | 4–7 | kill share | overkill/kill |
|---|---:|---:|---:|---:|---:|---:|---:|
| echo pistol | 1,225 | 61.0% | 78.8% | 75.2% | 70.3% | 19.5% | 9.7 |
| Regex Shotgun | 321 | 40.1% | 57.5% | 48.9% | **35.0%** | 17.9% | 13.1 |
| gdb | 1,851 | 53.4% | 78.4% | 72.0% | 67.7% | 25.1% | 5.3 |
| SIGKILL Knife | 274 | 100% | 100% | — | — | 16.9% | **24.9** |
| Toolchain | 240 | 100% | 100% | — | — | 19.2% | **60.4** |
| **Friday Hotfix** | **25** | 54.0% | 77.8% | 52.0% | — | **1.4%** | 2.5 |
| **ghidra** | **0** | — | — | — | — | **0%** | — |

- **ghidra is never fired.** **Zero shots in 5,897**, across **71 level-visits
  where it was owned** and every profile including the one whose weapon priority
  *leads* with it. Something in `scoreRangedWeapon` rejects it against a 4-rocket
  reserve.
- **Friday Hotfix is dead content**: **25 trigger-pulls in the whole capture** and
  1.4% of kills. Its accuracy is fine at the range it is used (77.8% inside 2
  tiles); the problem is that it is almost never chosen. *An earlier, much smaller
  capture showed 0% beyond 2 tiles — that was 0/24 pellets and did not survive a
  4× larger sample, which now reads 52%. The dead-content finding stands; the
  range-cliff one does not.*
- **Melee wastes most of its damage.** Toolchain averages 60.2 wasted of an
  80-damage swing; the knife 24.8 of 40. Against a roster that is 65% 10–15 HP
  Edge Cases, doubling the knife's damage bought almost nothing.
- **The cone is visible in the gradient.** The shotgun degrades 57.5% → 48.9% →
  35.0% across the three near buckets while the pistol holds 78.8% → 75.2% →
  70.3%. Both fall with range, as the cubic deviation predicts; the shotgun falls
  roughly three times faster, which is the spread doing its job.

---

## 6. What unseen repositories produce

Median combined clear ratio, per repo, normal:

| Repo | Levels | Enemies | Biggest level | Median ratio | Max ratio |
|---|---:|---:|---:|---:|---:|
| kilo | 1 | 140 | 140 | 8.2 | 8.2 |
| ms | 2 | 26 | 23 | 116.8 | 224.8 |
| cJSON | 11 | 392 | 246 | 8.8 | 63.5 |
| flask | 36 | 1,275 | 120 | 37.9 | 614.2 |
| click | 40* | 1,614 | 311 | 29.0 | 928.8 |
| chi | 40* | 388 | 85 | 126.9 | 1,044.4 |
| axios | 40* | 407 | 75 | 72.2 | **1,455.9** |
| ripgrep | 40* | 2,170 | **432** | 49.7 | 758.4 |

\* truncated by `--max-levels 40`; those four repos produce more levels than shown,
so their enemy totals are lower bounds.

**No unseen repo is ammo-starved — every one is drowning.** Median ratios run 8×
to 127×, against the demo campaign's ~15×. The generator's ammo budget is sized
for a curated campaign and is wildly loose on real code, because real code is
mostly trivial functions producing cheap, full-drop-paying enemies.

**Level sizes are unbounded too.** One source file becomes a 432-enemy level
(ripgrep's `flags/defs.rs`); `click` produces a 311-enemy level. Nothing caps
enemies per level any more than it caps HP per enemy.

---

## 7. What I would change

Ordered by effect per unit of risk. Each names the constant.

1. **Scale drops by what the enemy cost.** Multiply the drop roll's *amount* by
   something like `maxHp / 100`, or exclude Edge Cases from the ammo roll the way
   `health` already is (`healthHandledSeparately` in `loot.ts`). This is finding 2
   and most of finding 3; nothing else moves the economy as much. Edge Cases exist
   for pacing, not supply.
2. **Clamp Elite HP.** Either an absolute ceiling, or a fraction of the level's
   obtainable damage. Note the danger is specifically *not* level 1 —
   `startingAmmo` scales with the level's own enemy HP there, so an unbounded
   Elite funds its own counter-play. From level 2 on, carryover replaces that and
   nothing scales. Fixes finding 4, and Hard's level 15.
3. **Soften the c=40 cliff.** An 8.2× single-enemy jump for one point of
   complexity is a discontinuity in the game's central mapping. A ramp between
   ~30 and ~50 would keep the "boss tier" idea without the edge.
4. **Give Hard a floor.** `ammoDropRate: 0.7` compounding with `hp: 1.5` through
   carryover is what empties the reserve by level 14. Either stop compounding
   (scale drops but not carryover), or lift `ammoDropRate` and take the difficulty
   out of enemy damage instead.
5. **Decide what Friday Hotfix and ghidra are for.** Both are effectively unused.
   Friday Hotfix's `maxRange: 3.5` is tighter than the range fights actually happen
   at; ghidra is never selected at all. Neither is a balance tweak — both are "is
   this weapon reachable" questions.
6. **Trim health placement.** 38% of health pickups granted nothing. Either place
   fewer, or make the pickup conditional on the player being below full.

---

## 8. What this does not measure

- **The solver assumes perfect accuracy.** The Cone of Fire deviates with the cube
  of range against the z-buffer, which the solver deliberately does not model. So
  every ratio here is an **upper bound on how well-supplied you are**: "below 1.0"
  is a hard result, "above 1.0" proves nothing. Real hit rates are 40–70% (§5), so
  a ratio near 2 is genuinely tight.
- **The carry model excludes drops**, so the carry curve in §4 is the pessimistic
  end. The `combined` ratios do include drops.
- **The empirical half is a scoped capture on `normal`**, not a full campaign, and
  it measures *this bot* — which is why §5's usage numbers are as much a statement
  about `combatPolicy.mjs` as about the weapons.
- **Damage is not attributed by attacking archetype** yet (open item in
  `balancing-telemetry.md`), so §4's survival windows are analytic only.
- **Multiplayer is out of scope.** Elite HP scales with player count while loot
  does not obviously scale to match; that asymmetry deserves its own pass.
