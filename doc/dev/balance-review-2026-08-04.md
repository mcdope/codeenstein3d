# Balance review — 2026-08-04

Produced with the offline solver and the event log
(`doc/dev/balancing-telemetry.md`, "The balance model"). Every number here is
reproducible from a clean checkout:

```sh
npm run balancing:budget -- --all-difficulties --json demo-all.json
npm run balancing:corpus && npm run balancing:budget -- --dir balancing_corpus/<id>
CODEENSTEIN_TELEMETRY_EVENT_LOG=ev npm run balancing:telemetry
npm run balancing:events -- ev/
npm run verify:event-log -- ev/
```

**Scope.** The analytic half covers the 17-level `demo-campaign/` at all three
difficulties plus 8 real repositories (6,700 generated enemies). The empirical
half is a **360-run capture of the full 17-level campaign** — Casual/Gamer/Pro ×
{normal, hard}, 60 runs per cell, no level cap: **45,596 kills, 205,746
trigger-pulls, 820,785 events**. Easy was not captured and rests on analytic
numbers only.

**Every rate below carries its denominator and a 95% Wilson interval.** That is
not decoration. An earlier draft of this document reported a level-15 death rate
of 64% from n=14; the same quantity came in at 67% and 88% on two other small
captures, and now measures 46.2% [41–52] at n=318. Nothing at n<30 in this domain
means what it appears to mean.

Read §7 before acting on anything: the solver is deliberately optimistic in one
direction, and this capture found exactly where that matters.

**Data provenance.** Verified before use, in four steps: internal consistency
(`verify:event-log`, 820,785 events, 0 failures across 14 checks); an external
roster cross-check against an independently generated Node roster (5,507
level-visit rosters, all matching, and fault-proved by injecting a 1-HP error);
denominator sanity (60 distinct run ids in every cell); and an aggregate-counter
cross-check on one chunk. That last one found two discrepancies, both explained
and both in the event log's favour — it captures a stuck level-visit the
aggregate never snapshots, and splash weapons emit no `hit` event at all. The
event log is therefore the primary source throughout.

---

## 1. The five findings, ranked

| # | Finding | Evidence | Where it lives |
|---|---|---|---|
| 1 | **The campaign is effectively unfinishable, and neither difficulty nor skill fixes it.** | 3 completions in 360 runs (0.83% [0.3–2.4]) — all three from one cell. Level 17 kills **163 of 166** [95–99]; on hard, 70 of 70 | `enemies.ts`, `difficulty.ts` |
| 2 | **Two levels do all the killing, and they are the two with Elites.** | Levels 1–14 kill almost nobody; level 15 is 46.2% [41–52], level 17 is 98.2%. Levels 14 and 16 have no Elites and a 0% death rate | `enemies.ts:89-101` |
| 3 | **The rocket launcher cannot solve those levels even if perfectly used.** | Hard level 15: ~14 rockets carried in (2,130 damage) against **6,600 Elite HP**. Killing one Elite needs 24 rockets | `weapons.ts`, `enemies.ts` |
| 4 | **On hard, killing regular enemies costs more ammo than it returns.** | Self-sustain 0.48–0.50 on hard vs 1.04–1.06 on normal. Edge Cases still pay 5.3× (hard) and 11.8× (normal) | `loot.ts`, `enemies.ts` |
| 5 | **A repo is mostly trivial functions, and the generator prices them as full enemies.** | **81.5%** of enemies come from complexity-1 entities; **65%** of the roster is Edge Cases; 47% of regular enemies sit at the 25 HP floor | `enemies.ts` |

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

It is rare (0.13% of enemies) but not hypothetical. It already caused one live
incident (`enemies.ts:22-37`, a complexity-44 function killing the bot 12/12
runs), and §4 shows it is the single mechanism behind every death that matters in
this capture.

---

## 3. The loot economy

**Self-sustain** is the damage-worth of what an enemy drops over the damage it
costs to kill. Above 1.0, fighting is net-positive ammo. Measured over all 360
runs:

| difficulty | regular | Edge Case |
|---|---:|---:|
| normal | **1.04–1.06** | 11.4–11.8 |
| hard | **0.48–0.50** | 5.25–5.34 |

The profile axis is silent here — all three profiles agree to within 0.02 — so
this is a property of the difficulty settings, not of how well anyone plays.

**On hard, regular enemies are a net ammo loss** (0.5×), and on normal they are
break-even to the decimal (1.05×). Neither is obviously wrong on its own. What
makes the economy loose is that **Edge Cases pay 5–12× what they cost**, and Edge
Cases are 65% of the roster. The pacing filler is funding the campaign.

That shows up directly in where supplies come from: **85.6% of everything
collected is a drop**, not pre-placed loot. The level designer's placed ammo is a
rounding error against what the roster hands out.

And it never runs short. Across 205,746 trigger-pulls, **forced-melee shots
number exactly 0** — the state "wanted to shoot, had nothing to shoot with" did
not occur once in the entire capture, at either difficulty.

### Carry-in damage across the campaign

Mean damage-worth of ammunition carried into each level, pooled per difficulty:

| difficulty | L1 | L5 | L9 | L13 | L17 |
|---|---:|---:|---:|---:|---:|
| normal | 5,742 | 8,645 | 13,565 | 17,716 | **19,760** |
| hard | 6,617 | 6,218 | 7,376 | 7,739 | **8,409** |

On normal the reserve **triples** over the campaign. On hard it is flat, drifting
up by 27% from start to finish. Neither curve declines anywhere.

**This retires the "Hard collapses through attrition" claim for good.** An earlier
version of this document reported that hard's carried ammo fell to zero by level
14 and that levels 15 and 17 were unclearable at 0.30 and 0.92. Those numbers came
from a bug in the solver's campaign carry model, which charged each level for its
whole roster while banking none of its drops. Fixed (`levelSolver.mjs`'s
`killRate`, default 0.71 measured from play). The claim is now contradicted by
three independent measurements: the corrected model, a flat carry curve over 360
runs, and zero forced-melee shots.

**Health placement is wasteful.** 3,417 of 12,695 health pickups (**26.9%**) were
collected at full health and granted nothing.

---

## 4. Two walls, and neither knob moves them

This is the section the 360-run capture was built to settle, and it overturns the
previous draft's framing rather than refining it.

### Where runs die

Conditional death rate — deaths among runs that reached the level:

| level | Ca/n | Ga/n | Pr/n | Ca/h | Ga/h | Pr/h |
|---:|---:|---:|---:|---:|---:|---:|
| 1–9 | 0–3% | 0% | 0% | 0% | 0–2% | 0–2% |
| 10 | 21% | 0% | 0% | 17% | 7% | 0% |
| 11 | 2% | 0% | 0% | 10% | 2% | 3% |
| 12–14 | 0% | 0% | 0% | 0% | 0% | 0% |
| **15** | **41%** | **42%** | **34%** | **58%** | **57%** | **47%** |
| 16 | 0% | 0% | 0% | 0% | 0% | 0% |
| **17** | **100%** | **100%** | **92%** | **100%** | **100%** | **100%** |

Pooled, with intervals:

| level | normal | hard | all |
|---:|---|---|---|
| 15 | 38.9% [32–47] (63/162) | 53.8% [46–61] (84/156) | 46.2% [41–52] (147/318) |
| 17 | 96.9% [91–99] (93/96) | **100% [95–100] (70/70)** | 98.2% [95–99] (163/166) |

### Completion

| difficulty | completions | rate |
|---|---|---|
| normal | 3 / 180 | 1.67% [0.6–4.8] |
| hard | 0 / 180 | 0% [0.0–2.1] |
| **all** | **3 / 360** | **0.83% [0.3–2.4]** |

All three completions are Pro/normal. Every other cell is 0 for 60.

> **A correction worth keeping.** At 202 runs this capture had zero completions
> and level 17 stood at 90/90, and I wrote that the campaign "cannot be completed
> at normal or hard by any profile tested." The next 60 runs produced three. The
> zero-completion interval was [0.0–1.9] and the true rate of 0.83% sits inside
> it — the interval was right and the prose was wrong, because I read a point
> estimate of zero as "impossible" rather than "rarer than we can resolve." That
> is the exact error this document's interval discipline exists to prevent.

### Neither axis the player controls changes the outcome

The game exposes two knobs: difficulty, and (implicitly) skill. This capture
varies both.

- **Skill changes how far you get, not what happens when you arrive.** Runs
  reaching level 17 rise cleanly with profile — 30% → 38% → 48% on hard, 40% →
  57% → 63% on normal — while the conditional death rate at 15 and 17 barely
  responds. The profile axis is a live instrument (Casual dies at level 10 where
  Pro never does), which is what makes its silence at 15 and 17 a finding rather
  than an insensitive measurement.
- **Difficulty softens level 15 and does not touch level 17.** Level 15 falls from
  53.8% to 38.9% between hard and normal — a real effect, non-overlapping
  intervals. Level 17 goes from 100% to 96.9%, and the three survivors needed the
  strongest profile *and* the lower difficulty.

**So the previous framing — "Hard fails at two levels" — is wrong.** Hard is not
where this breaks; the back half of the campaign is unfinishable at normal too.
The accurate statement is that levels 15 and 17 are walls at every setting
measured, and difficulty and skill only buy the odds of reaching them.

### The mechanism is Elite HP

| difficulty | level | enemies | total HP | Elite HP | Elites | clear ratio | death rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| hard | 14 | 9 | 1,148 | 0 | 0 | 16.99 | 0% |
| hard | **15** | 13 | 7,207 | **6,600** | 2 | 2.84 | 53.8% |
| hard | 16 | 11 | 346 | 0 | 0 | 49.95 | 0% |
| hard | **17** | 77 | 13,343 | **9,675** | 3 | 2.12 | 100% |

Death rate tracks **Elite count**, not enemy count and not clear ratio. Level 16
has 11 enemies and kills nobody; level 15 has 13 and kills half. The two lethal
levels are exactly the two whose HP is 73–92% Elite.

The two levels fail differently, though:

- **Level 15 is a wall of HP.** 13 enemies, two of them Elites at 3,525 and 3,075
  HP on hard, each dealing 2× damage. Damage taken splits evenly — 5,643 melee
  against 5,532 ranged.
- **Level 17 is a wall of DPS.** 77 enemies totalling 1,268 incoming DPS on hard,
  with melee damage (6,345) exceeding ranged (4,682). You get surrounded. This is
  why it is the harder of the two despite a comparable clear ratio.

### Why the rocket launcher is not the answer

The previous draft ended §4 with a caveat: because the bot never fires ghidra, the
death rates were "an upper bound on the levels' difficulty, not a measurement of
it." **That caveat is now retired by measurement.**

| difficulty / level | rockets carried in | Elite HP present | rockets to kill one Elite |
|---|---:|---|---:|
| hard / 15 | 14.2 | 3,075 + 3,525 | **24** |
| hard / 17 | 16.2 | 3,000 + 3,300 + 3,375 | **22** |
| normal / 15 | 16.4 | 2,050 + 2,350 | 16 |
| normal / 17 | 18.5 | 2,000 + 2,200 + 2,250 | 15 |

On hard level 15 the player arrives with about 14 rockets — 2,130 damage — facing
6,600 Elite HP. Spending every rocket perfectly, on nothing but Elites, kills
**0.6 of one of the two**. The ammunition to solve these levels is not on them.
Fixing the bot's weapon selection would change the death rates somewhat; it cannot
change the outcome.

There is also a natural experiment in the profile table. **Casual cannot fire
ghidra at all** — it is absent from that profile's `weaponPriority` by design
(`profiles.mjs`) — while Pro fired 21 rockets on hard. Both die at level 17 100%
of the time.

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

### Observed, over 205,746 trigger-pulls

| Weapon | pulls | pellet hit rate | kill share | overkill/kill |
|---|---:|---:|---:|---:|
| gdb | 95,699 | 57.3% | **26.3%** | 5.4 |
| echo pistol | 50,135 | 65.3% | 13.9% | 8.7 |
| SIGKILL Knife | 24,042 | 100% | **24.5%** | **23.8** |
| Regex Shotgun | 14,204 | 41.6% | 16.5% | 9.6 |
| Friday Hotfix | 11,874 | 64.6% | 5.4% | 3.7 |
| Toolchain | 9,730 | 100% | 13.3% | **58.7** |
| **ghidra** | **62** | — (splash) | 0.05% | 44.2 |

Splash weapons show no hit rate rather than 0%: rockets never emit a `hit` event,
and an earlier draft published ghidra's "0% hit rate" as if it were a measurement.
It was an artifact of the instrument.

- **ghidra is 0.03% of all trigger-pulls, but it works when fired.** 62 pulls
  across **3,212 level-visits where it was owned** — yet those 62 pulls produced
  **25 kills**, 0.40 kills per pull, the best of any weapon. The problem is not
  that the rocket is weak or mis-scored; it is that the bot almost never reaches a
  situation it judges suitable. See the engagement ranges below.
- **Melee does a third of the killing and wastes most of its damage.** Knife and
  Toolchain together take **37.8%** of all kills. Toolchain averages **58.7 wasted
  of an 80-damage swing** (73%) and the knife 23.8 of 40 (60%) — against a roster
  that is 65% 10–15 HP Edge Cases. Doubling the knife's damage would buy almost
  nothing.
- **Friday Hotfix is niche, not dead** — 5.4% of kills at 64.6%. Two earlier
  readings of this weapon did not survive larger samples and stay retracted: a
  24-pellet sample showed 0% beyond 2 tiles, and a 25-pull sample put it at 1.4%
  of kills. Both were small-sample noise.

### The Cone of Fire is visible

Pellet hit rate by engagement range, charged to the shot that fired it:

| weapon | 0–2 t | 2–4 t | 4–6 t | 6–9 t |
|---|---:|---:|---:|---:|
| Regex Shotgun | 62% | 48% | **33%** | **24%** |
| echo pistol | 81% | 77% | 73% | 66% |
| gdb | 71% | 71% | 74% | 69% |
| Friday Hotfix | 76% | 66% | 33%¹ | — |

¹ n=30; the Hotfix's `maxRange: 3.5` means it barely reaches this bucket.

The shotgun loses **38 points** across four buckets while the pistol loses 15 and
gdb is flat. That is the cubic deviation doing exactly what it should, and it is
the clearest empirical confirmation that the spread model works.

Between 8% and 23% of each weapon's pellets are fired with no crosshair target and
have no range to bucket by; those are excluded from both numerator and
denominator here rather than silently dropped from one.

### Where fights actually happen

| target | shots | median range | inside 2 t | beyond 6 t |
|---|---:|---:|---:|---:|
| Elite | 8,842 | **0.5 t** | **83%** | 2% |
| Edge Case | 47,855 | 2.7 t | 37% | 16% |
| regular | 118,689 | 4.6 t | 19% | 26% |

**83% of Elite engagements happen inside two tiles**, at a median of half a tile.
The bot closes to knife range on precisely the targets a rocket is for. This is
the root cause of ghidra's non-use, and it now holds across all three profiles
rather than the single one it was first observed on.

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

Read against §4, this is the more worrying half of the review. The demo campaign
is *authored*, and its back half is still unfinishable. An arbitrary repo is
ordered by accident of filename, so a 432-enemy level or a complexity-60 Elite can
land anywhere, including level 1.

---

## 7. What this does not measure

- **The solver assumes perfect accuracy**, and the Cone of Fire deviates with the
  cube of range against the z-buffer. Every ratio here is an **upper bound on how
  well-supplied you are**: "below 1.0" is a hard result, "above 1.0" proves
  nothing. Measured hit rates are 24–81% (§5), so a ratio near 2 is genuinely
  tight.
- **The solver models ammunition, never survival — and this capture found the gap
  empirically.** It passes hard level 17 as clearable at ratio 2.12, meaning every
  enemy can be killed with the damage obtainable there. The bot then died on that
  level 70 times out of 70. Both are correct: you have enough bullets and you
  still die, because nothing in the offline model represents 1,268 incoming DPS.
  **Clearability is not survivability**, and for a game whose premise is confidence
  about repos nobody can playtest, that is the most important limitation on this
  page.
- **It measures *this bot*.** §5's usage numbers are as much a statement about
  `combatPolicy.mjs` as about the weapons — though §4 now shows the walls survive
  the bot's biggest known weakness.
- **Easy was not captured.** Everything about easy here is analytic.
- **Multiplayer emits no telemetry at all.** Elite HP scales with player count
  while loot does not obviously scale to match; that asymmetry is unmeasured.
- **Damage is not attributed by attacking archetype** (`damageTaken.arch` is
  null), so "which enemy killed you" is inferred from level composition rather
  than recorded.

---

## 8. Follow-up investigation

Where this capture narrows a question without closing it. Each names the next
measurement rather than the next opinion.

1. **Is level 17 survivable by anyone, or only by this bot's standards?** The
   sharpest open question. 163 of 166 deaths is not a bot artifact — but three
   Pro/normal runs did finish, so it is not literally impossible either. The
   measurement: a human playthrough of levels 15–17 recorded with `?eventLog=1`,
   compared against the bot's damage-taken profile. If a human also dies, the
   level is the problem; if not, the gap localises the bot's weakness.
2. **Does the Elite clamp actually fix it?** §9's first recommendation is the only
   one §4 supports, and it is untested. Clamp Elite HP, re-run the same six cells,
   and compare completion rate. This capture is the baseline; the comparison is
   `report-balancing-ab.mjs`. **Do not point that tool at a directory of chunk
   files** — its `loadSide` merges last-file-wins and would silently report one
   chunk as the whole cell.
3. **Why does level 10 kill Casual (17–21%) and never Pro (0%)?** The only level
   where the profile axis separates cleanly, and it has no Elites at all —
   `stage10_kernel_module.rs`, 20 enemies, ratio 9.57 on hard. Whatever kills
   Casual there is a different mechanism from §4's, and it is the one place this
   capture shows skill mattering directly.
4. **Would a rocket-capable bot change the level-15 number?** §4 shows it cannot
   change level 17. Level 15 is closer: 2,130 rocket damage against 6,600 Elite HP
   is not enough to win, but might be enough to move 53.8% measurably. The
   measurement is a bot variant that opens Elite engagements beyond 6 tiles rather
   than a scoring tweak — §5 shows the issue is engagement range (83% inside 2
   tiles), not weapon choice at a given range. **Two previous A/Bs on the rocket
   constants both came back null**, because both were designed from a probe of
   `pickRangedWeapon` in isolation; a probe of a pure function proves the function
   changed, not that the situation it needs ever occurs.
5. **Is easy finishable?** Untested here, and the one cell that might have a
   non-zero completion rate. Analytically its clear ratios are the loosest in the
   campaign (11–306). Three cells, ~10h at the measured throughput.
6. **Does the economy hold on a real repo?** §3's self-sustain numbers are from
   the authored campaign; §6 says real repos are 8–127× looser analytically, but
   no bot has ever played one. The measurement now exists —
   `doc/dev/capturing-another-campaign.md` — and needs a staged flat campaign.
7. **Splash weapons still have no hit rate.** ghidra's effectiveness is inferred
   from 25 kills over 62 pulls. A `splashHit` event carrying the enemies caught
   would make it directly measurable, and would close the one remaining hole in
   §5's table.

---

## 9. Balancing changes

Ordered by effect per unit of risk, each naming the constant and what evidence
would show it worked. **Split by what this capture actually supports.**

### Supported by data — a measured problem of measured size

1. **Clamp Elite HP.** The single change §4 supports. Either an absolute ceiling
   or a fraction of the level's obtainable damage. Hard level 15 puts 6,600 Elite
   HP against a total rocket reserve of 2,130 damage; level 17 puts 9,675 against
   2,430. Note the danger is specifically *not* level 1, where `startingAmmo`
   scales with the level's own enemy HP and an unbounded Elite funds its own
   counter-play — from level 2 on, carryover replaces that and nothing scales.
   *Worked when:* completion rate rises above 0.83% [0.3–2.4] and level 17's death
   rate drops below 98.2% [95–99], on a re-run of the same six cells.

2. **Cap incoming DPS per level, or thin level 17's roster.** Level 17 is a
   different failure from level 15: 77 enemies, 1,268 DPS on hard, melee damage
   exceeding ranged. Clamping Elite HP alone may not save it, because its problem
   is arrival rate rather than any single enemy's health. *Worked when:* level 17's
   death rate separates from 100% by more than its interval — and note §6 shows
   real repos generate 432-enemy levels, so a per-level enemy cap has value well
   beyond the demo campaign.

3. **Scale drops by what the enemy cost.** Multiply the drop roll's amount by
   something like `maxHp / 100`, or exclude Edge Cases from the ammo roll the way
   `health` already is (`healthHandledSeparately` in `loot.ts`). Edge Cases return
   5.3–11.8× their cost and are 65% of the roster; 85.6% of all collected supply
   is drops. *Worked when:* drop reliance falls below 85.6% and hard's regular
   self-sustain rises off 0.5 without normal's exceeding ~1.2.

4. **Trim health placement.** 26.9% of health pickups (3,417 of 12,695) granted
   nothing. Either place fewer, or make the pickup conditional on the player being
   below full. *Worked when:* that share drops without total healing falling.

### Permitted but unconfirmed — plausible, and this capture cannot settle them

5. **Soften the c=40 cliff.** An 8.2× single-enemy jump for one point of
   complexity is a discontinuity in the game's central mapping, and a ramp between
   ~30 and ~50 would keep the boss-tier idea without the edge. But the capture
   never varies complexity — it plays one fixed campaign — so this rests entirely
   on §2's generator analysis. It is a design argument, not a measured one.

6. **Decide what ghidra is for.** It is 0.03% of trigger-pulls across 3,212
   level-visits where it was owned. But it lands 0.40 kills per pull, the best in
   the game, and §4 proves the rockets could not have saved the levels anyway. So
   "ghidra is broken" is not supported; "ghidra is unreachable given how this bot
   fights" is. Whether a *human* reaches for it is unmeasured — see §8.1.

7. **Reconsider Friday Hotfix's `maxRange: 3.5`.** Fights against regular enemies
   happen at a median of 4.6 tiles, outside its reach, which is consistent with
   its 5.4% kill share. But this weapon has already had two readings retracted for
   small-sample error, and 11,874 pulls still only puts 30 pellets in the 4–6 tile
   bucket. Suggestive, not established.

8. **Give hard a floor.** `ammoDropRate: 0.7` compounding with `hp: 1.5` is the
   obvious candidate for hard's 0.5× self-sustain. **The original form of this
   recommendation is withdrawn:** it claimed the compounding "empties the reserve
   by level 14", and §3 shows the hard carry curve is flat and rises 27% across the
   campaign, with zero forced-melee shots in 205,746 pulls. There is no starvation
   to fix. Whether 0.5× self-sustain is *wrong* is a design question this capture
   cannot answer — the players who died were not short of ammunition.
