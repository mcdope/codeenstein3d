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
empirical half is four 12-level bot captures — Casual/Gamer/Pro on normal and
Gamer on hard, 5 attempts each: **2,162 kills, 8,718 trigger-pulls**. Read §8 before
acting on anything: the solver is deliberately optimistic in one direction and
that shapes what its numbers mean.

---

## 1. The five findings, ranked

| # | Finding | Evidence | Where it lives |
|---|---|---|---|
| 1 | **Hard is unfinishable, and it fails at two specific levels — but not through ammo.** | 0 of 16 runs completed; death rate 64% on level 15 and 100% on level 17, against 0–6% on levels 10–14. Ammo never runs short (see §4) | `enemies.ts`, `difficulty.ts` |
| 2 | **Killing pays for itself on easy and normal; only Hard has a floor.** | Edge Cases return **8.5–13.5×** the damage they cost across every repo; on Hard that halves to 4.7× — still net-positive | `loot.ts`, `enemies.ts` |
| 3 | **A repo is mostly trivial functions, and the generator prices them as full enemies.** | **81.5%** of enemies come from complexity-1 entities; **65%** of the roster is Edge Cases; 47% of regular enemies sit at the 25 HP floor | `enemies.ts` |
| 4 | **The Elite threshold is a cliff, and past it HP is unbounded.** | c=39 → 244 HP, c=40 → **2000 HP**. On Hard, demo level 15 has two Elites that individually exceed all obtainable damage | `enemies.ts:89-101` |
| 5 | **ghidra is never used, and melee wastes most of its damage.** | ghidra: **2 pulls in 8,718, zero kills**, owned on 122 level-visits. Toolchain wastes **60 of its 80** damage per kill | `weapons.ts`, `combatPolicy.mjs` |

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
observed rolls) agree, and the measurement barely moves across skill tiers:

| Capture (12 levels, 5 attempts) | kills | regular | Edge Case | reliance on drops |
|---|---:|---:|---:|---:|
| Casual, normal | 495 | 0.98 | 10.64 | 83.9% |
| Gamer, normal | 554 | 0.95 | 11.05 | 84.2% |
| Pro, normal | 555 | 1.12 | 12.13 | 84.1% |
| **Gamer, hard** | 558 | **0.45** | **4.73** | 84.6% |

2,162 kills across four captures, against predictions of 0.76–2.33 and 8.1–13.8.
Two models built from opposite directions landing together — and a result this
insensitive to who is playing — makes this a property of the drop tables rather
than an artifact of either model or of one bot's habits.

**Hard is the one setting that has an economy at all, and the mechanism is exact.**
Self-sustain halves — 0.95 → 0.45 for regulars, 11.05 → 4.73 for Edge Cases —
because enemies carry 1.5× HP while pickups give 0.7×. `0.7 / 1.5 = 0.467`, and
`0.95 × 0.467 = 0.44` against the 0.45 measured. That compounding is the same
mechanism that empties the reserve in §4; it is doing exactly what it was designed
to, and only Hard gets it.

Note reliance on drops is **~84% on all four**, unchanged by difficulty: Hard makes
each drop smaller, not rarer, so the pre-placed share stays a fifth of the economy
regardless.

### Where the loot actually comes from

Measured, demo campaign: **83.9–84.2%** of everything collected came from drops (see
the table above)
rather than from the floor. Pre-placed placement is ~16% of the economy, so tuning
it moves almost nothing — which matches the earlier campaign finding of 93–100%
and is why the drop amounts were cut ~30%.

**Also measured: 195 of 579 health pickups granted nothing at all** — 27–40%
across the four captures — collected at full stability. A third of health placement
does no work, on every difficulty.

---

## 4. Hard fails at two levels, and not for the reason I first reported

**This section replaces an earlier version that was wrong twice over, and the
correction is more useful than the original claim.** It reported that Hard's
carried ammo fell to zero by level 14 and that levels 15 and 17 were unclearable
at 0.30 and 0.92. Both numbers came from a bug in the solver's own campaign carry
model, which charged each level for its whole roster while banking none of its
drops — so every level was credited with its own drops and denied all previous
ones. Fixed (`levelSolver.mjs`'s `killRate`, default 0.71 measured from play), and
verified against a 17-level capture that flatly contradicts the original.

### What a full 17-level Hard capture shows

Pooled over **16 Gamer/hard runs**, all 17 levels, no level cap:

| level | reached | died | death rate | forced-melee shots |
|---:|---:|---:|---:|---:|
| 10 | 16 | 1 | 6% | 0.0% |
| 11–14 | 15 | 0 | **0%** | 0.0% |
| **15** | 14 | 9 | **64%** | 0.0% |
| 16 | 5 | 0 | 0% | 0.0% |
| **17** | 5 | 5 | **100%** | 1.2% |

**Zero of 16 runs finished the campaign.** So Hard *is* unfinishable for this bot,
and the failure is sharply localised — levels 1–14 are close to free, and then two
walls.

### Ammo is not the mechanism

Carried ammo, measured per level across the capture, stays **flat at 6,000–7,400
damage from level 1 to level 17**. It never trends down, and **forced-melee shots
are 0.0% on every level except 1.2% on 17** — the player is never dry. The
"attrition collapse" does not exist at any point.

What does happen is damage:

| level | enemies | damage taken/run | min HP | deaths |
|---:|---:|---:|---:|---:|
| 1–14 | 6–20 | 2–72 | 72–98 | ~0 |
| **15** | 13 | **92** | **33** | 9 |
| 16 | 11 | 22 | 82 | 0 |
| **17** | **77** | **166** | **0** | 5 |

Two different walls:

- **Level 15 is Elite-driven.** Only 13 enemies, but two Elites of 3,525 and 3,075
  HP on Hard, each dealing 2× damage. The survival window against one is 2.0s.
- **Level 17 is swarm-driven.** 77 enemies, and `enemyMelee` damage (291) exceeds
  `enemyRanged` (149) — you get surrounded.

### The analytic model localised this correctly

With the carry bug fixed, the solver ranks those two levels as the campaign's
tightest on Hard — **2.84 at level 15 and 2.12 at level 17**, against 5–50
elsewhere. Corrected for observed hit rates of 40–70%, a 2.12 lands near 1.2:
right at the edge. The original model's *magnitudes* were an artifact; its
*ranking* pointed at exactly the two levels that kill.

### Difficulty sweep

Combined clear ratio, corrected model:

| Level | easy | normal | hard |
|---:|---:|---:|---:|
| 1 | 20.3 | 13.6 | 8.8 |
| 9 | 78.6 | 44.5 | 20.1 |
| 12 | 21.3 | 11.9 | 5.1 |
| **15** | 14.4 | 7.7 | **2.8** |
| 16 (bonus) | 306.7 | 157.6 | 50.0 |
| **17** | 11.0 | 5.8 | **2.1** |

Nothing is unclearable on any difficulty. Hard is genuinely the tightest — its
back half runs 2.1–5.2 against 8–20 in the front half — and it is the only setting
with an economy at all (§3). But the cliff is in *incoming damage on two levels*,
not in the ammo budget.

### The confound

These death rates measure **this bot** as much as the levels. On level 15 it walks
in holding **8–17 unused rockets** and takes **72% of its kills with melee**,
closing to contact with the two things on the level that hit hardest. §5 and
`balancing-telemetry.md` §7.3 cover why it never fires the rocket launcher. Until
that is fixed, the 64% and 100% figures are an upper bound on the levels'
difficulty, not a measurement of it.

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

Aggregated over four 12-level captures (Casual/Gamer/Pro on normal, Gamer on hard;
5 attempts each): **2,162 kills, 8,718 trigger-pulls**. Hit rates blend skill tiers
with different aim tolerances (`fireAngleEps` 0.08 → 0.03).

| Weapon | pulls | pellet hit rate | 0–2 | 2–4 | 4–7 | kill share | overkill/kill |
|---|---:|---:|---:|---:|---:|---:|---:|
| gdb | 4,183 | 56.8% | 79.2% | 70.3% | 71.1% | **28.5%** | 5.3 |
| echo pistol | 2,521 | 66.0% | 84.2% | 79.1% | 74.0% | 14.6% | 9.8 |
| SIGKILL Knife | 780 | 100% | 100% | — | — | 21.1% | **24.5** |
| Regex Shotgun | 630 | 40.3% | 58.5% | 48.9% | **31.2%** | 18.4% | 11.1 |
| Toolchain | 377 | 100% | 100% | — | — | 14.1% | **60.0** |
| Friday Hotfix | 225 | 64.0% | 75.4% | 64.4% | — | 3.3% | 3.5 |
| **ghidra** | **2** | 0% | — | — | 0% | **0%** | — |

- **ghidra is effectively unfired.** **2 trigger-pulls in 8,718** (0.02%), **zero
  kills**, across **122 level-visits where it was owned** with rockets in the pool
  — including the profile whose weapon priority *leads* with it. Something in
  `scoreRangedWeapon` rejects it against a 4-rocket reserve. This is the one
  unambiguous dead-content result.
- **Melee does the heavy lifting, and wastes most of its damage.** Knife and
  Toolchain together take **35% of all kills**. Toolchain averages **60.0 wasted of
  an 80-damage swing** and the knife 24.5 of 40 — against a roster that is 65%
  10–15 HP Edge Cases, doubling the knife's damage bought almost nothing.
- **The cone is visible in the gradient.** The shotgun falls 58.5% → 48.9% →
  31.2% across the three near buckets while the pistol holds 84.2% → 79.1% →
  74.0%. Both decay with range as the cubic deviation predicts; the shotgun decays
  about three times faster, which is the spread doing its job.
- **Friday Hotfix is niche, not dead** — 3.3% of kills at a healthy 64% hit rate.
  Two earlier readings of this weapon did **not** survive larger samples and are
  retracted here rather than quietly dropped: a 24-pellet sample showed 0% beyond
  2 tiles (now 64.4%), and a 25-pull sample put it at 1.4% of kills (now 3.3%).
  Small per-weapon samples on a rarely-chosen weapon move a lot.

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
- **The empirical half stops at level 12** (`LEVEL_LIMIT=12`), so it does not reach
  the levels finding 1 is about. Every capture hit that cap rather than a death
  wall: across 234 level-plays, every profile cleared to 12 with **one death in
  total — including on hard**. That corroborates the analytic result for levels
  1–12, where §4 shows ratios never dropping below 1.5 even on hard. But **the Hard
  collapse at levels 13–17 is an analytic result only** and has not been observed.
- It also measures *this bot*, which is why §5's usage numbers are as much a
  statement about `combatPolicy.mjs` as about the weapons.
- **Damage is not attributed by attacking archetype** yet (open item in
  `balancing-telemetry.md`), so §4's survival windows are analytic only.
- **Multiplayer is out of scope.** Elite HP scales with player count while loot
  does not obviously scale to match; that asymmetry deserves its own pass.
