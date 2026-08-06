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

**Scope.** This document has two halves, added at different times.

**Part I (§1–§9), 2026-08-04.** The analytic half covers the 17-level
`demo-campaign/` at all three difficulties plus 8 real repositories (6,700
generated enemies). The empirical half is a **360-run capture of the full
17-level campaign** — Casual/Gamer/Pro × {normal, hard}, 60 runs per cell, no
level cap: **45,596 kills, 205,746 trigger-pulls, 820,785 events**. Easy was not
captured and rests on analytic numbers only.

**Part II (§10–§16), 2026-08-06.** A **multi-repository sweep**: seven real
codebases staged into 15-level campaigns and captured end to end
(wolf3d, ripgrep, codeenstein3d, sinatra, serilog, laravel, curl) at
Casual/Gamer/Pro × hard, 20 runs per cell — **405 runs** — plus a paired bot
A/B on wolf3d and an analytic sweep over **23 repositories**.

**Part II changes what Part I means.** `demo-campaign/` turns out not to be
representative of real repositories, two of Part I's five ranked findings do not
survive, and one whole class of Part I's conclusions is confounded by bot
behaviour rather than balance. Part I is kept intact — it is the regression
baseline and the only campaign measured at n=360 — but **read §10 before acting
on anything in §1–§9.** Claims that Part II overturns are marked inline.

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

> **Status after Part II.** Finding 1 holds for this campaign but does not
> generalise — sinatra completes 88% of runs. Finding 2 is **falsified as
> stated**: levels 12 and 13 also hold Elites and kill 0 of 156 each (§11).
> Finding 3 is **confounded** — the bot fires ghidra twice across 25 Elite
> deaths, so it was never tested against a bot that uses the weapon (§14).
> Findings 4 and 5 hold and generalise.

| # | Finding | Evidence | Where it lives |
|---|---|---|---|
| 1 | **The campaign is effectively unfinishable, and neither difficulty nor skill fixes it.** *(does not generalise — §10)* | 3 completions in 360 runs (0.83% [0.3–2.4]) — all three from one cell. Level 17 kills **163 of 166** [95–99]; on hard, 70 of 70 | `enemies.ts`, `difficulty.ts` |
| 2 | ~~**Two levels do all the killing, and they are the two with Elites.**~~ **Falsified — §11.** Four levels hold Elites; two of them kill nobody | Levels 1–14 kill almost nobody; level 15 is 46.2% [41–52], level 17 is 98.2%. Levels 14 and 16 have no Elites and a 0% death rate | `enemies.ts:89-101` |
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

> **Both claims in that last sentence are revised by Part II.** Elites are **not
> rare in real code** — across 23 repositories they run to 10.9 per 1,000
> enemies (vim) with a single enemy at **50,325 HP**, and 0.13% reflects the
> original 8-repo corpus, which was uniformly modern method-decomposed code
> (§13). And Elites are **not** the mechanism behind every death that matters:
> across 405 runs on real repositories, Edge Cases deal 56–91% of all lethal
> damage (§10). Both halves of this paragraph were true of `demo-campaign` and
> false of the corpus.

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

> **Correction (2026-08-06). "Death rate tracks Elite count" is false, and the
> counterexample was already in this capture.** The table above starts at level
> 14, which is exactly the window in which the claim looks true. Levels 12 and
> 13 each carry an Elite and kill nobody:
>
> | level | file | enemies | total HP | Elite HP | Elites | clear ratio | deaths |
> |---:|---|---:|---:|---:|---:|---:|---:|
> | 12 | `stage12_render_engine.cpp` | 18 | 3,993 | **3,300** | 1 | 5.06 | **0 / 156** |
> | 13 | `stage13_batch_job.scala` | 20 | 3,992 | **3,075** | 1 | 5.18 | **0 / 156** |
> | 15 | `stage15_god_object.java` | 13 | 7,207 | 6,600 | 2 | 2.84 | 46.2% [41–52] |
> | 17 | `stage17_the_monolith.php` | 77 | 13,343 | 9,675 | 3 | 2.12 | 98.2% [95–99] |
>
> Four levels hold Elites; two kill nobody in 156 runs each. That was a
> selection error in the reporting, not a property of the data. §11 shows the
> narrower reading — that lethality tracks Elite *HP concentration* — does not
> survive the multi-repo sweep either.
>
> Note level 12's 0% is *earned*: `ELITE_HP_MULTIPLIER` was cut 4→2 on
> 2026-07-30 because it killed 12/12, halving its Elite from 6,600 to 3,300.

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
  > **Revised 2026-08-06, and this is the most important limitation on the
  > page.** The clause after the dash is wrong. §14 shows the bot knife-trades
  > Elites — 305 knife swings against a 3,000 HP Elite, 2 rocket shots across 25
  > deaths, ending each level holding *more* rockets than it started. Every
  > Elite death rate in this document is an upper bound produced by a bot
  > fighting those encounters in the worst available way. Separately, **30% of
  > all runs in the Part II sweep (121 of 405) ended in a bot wedge rather than
  > a death**, which no completion-rate figure here distinguishes.
- **Easy was not captured.** Everything about easy here is analytic.
- **Multiplayer emits no telemetry at all.** Elite HP scales with player count
  while loot does not obviously scale to match; that asymmetry is unmeasured.
- ~~**Damage is not attributed by attacking archetype**~~ — **fixed 2026-08-06.**
  The event log is now schema 2 and `damageTaken.by` carries per-attacker
  archetype and amount, so "which enemy killed you" is recorded rather than
  inferred. Every archetype share in Part II rests on it.

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

---

# Part II — the multi-repository sweep (2026-08-06)

Part I measured **one campaign**. Everything it concluded about *the generator*
was inferred from `demo-campaign/`'s behaviour. Part II stages seven real
codebases into 15-level campaigns and captures each end to end, which is the
first test of whether any of it generalises.

**Method.** For each repository, `scripts/stage-campaign.mjs` selects ~15 levels
(cheapest-first, with three must-includes: max DPS, max Elite HP, min clear
ratio), commits them to a `capture/<repo>` branch, and
`scripts/run-balancing-capture.mjs` runs Casual/Gamer/Pro × hard × 20 attempts
across three machines. **405 runs**, every event log passed
`verify:event-log`. Archetype attribution uses event-log schema 2
(`damageTaken.by`), shipped for this sweep.

Reproduce any single repository with:

```sh
node scripts/stage-campaign.mjs --repo balancing_corpus/<id> --solved <solved.json>
npm run balancing:budget -- --dir demo-campaign --all-difficulties
CODEENSTEIN_CAPTURE_OUT=balancing_capture_<id> \
CODEENSTEIN_CAPTURE_PROFILES=Casual,Gamer,Pro CODEENSTEIN_CAPTURE_DIFFICULTIES=hard \
CODEENSTEIN_CAPTURE_ATTEMPTS=20 node scripts/run-balancing-capture.mjs
npm run verify:event-log -- balancing_capture_<id>/events
```

---

## 10. What actually kills, per repository

**A run can fail two unrelated ways, and pooling them hides the finding.** It can
*die*, or it can get *stuck* — wedge on a level it never finishes, which the
harness records as `reason: "stuck"` (`run-balancing-telemetry.mjs:497,530`). A
campaign that is too hard and a bot that cannot navigate one look identical in a
completion rate.

| repo | runs | completed | **died** | **stuck** | Elite | Edge Case | normal |
|---|---:|---:|---:|---:|---:|---:|---:|
| wolf3d | 60 | 0 | **60** | 0 | 39% | **57%** | 4% |
| ripgrep | 45 | 0 | 32 | **13** | **0%** | **91%** | 9% |
| codeenstein3d | 60 | 1 | **59** | 0 | 33% | **56%** | 11% |
| **sinatra** | 60 | **53** | **1** | 6 | — | 20% | 80% |
| **serilog** | 60 | **0** | **0** | **60** | — | — | — |
| laravel | 60 | 0 | 47 | 13 | **98%** | 2% | — |
| curl | 60 | 0 | 31 | **29** | 95% | 5% | — |
| **total** | **405** | **54** | **230** | **121** | | | |

Archetype columns are the share of *lethal* damage, blank where nothing died.
Stuck slots: ripgrep 8×10; sinatra 12/14/15; serilog 14×44 and 12×16;
laravel 13×13; curl 12×20, 11×8.

**Four findings, in descending order of how much they should change what you do.**

**1. 30% of all runs (121 of 405) ended in a bot wedge, not a death.** No
completion-rate figure anywhere in Part I distinguishes these. serilog's `0/60`
and wolf3d's `0/60` are opposite results: wolf3d dies 60 times out of 60, while
serilog **never dies at all** — every `levelEnd` it emits is `cleared`, 748 of
them — and still never finishes, because the bot wedges on slot 14. serilog's
campaign is not hard; it is unnavigable. See §15.

**2. Edge Cases do the bulk of the killing.** 56–91% of lethal damage in every
repository that killed anyone. This is broad attrition across *many* slots, and
it is the mechanism with **no backlog item**. ripgrep is the pure case: 0% Elite
damage, its single Elite never reached, and it still lost every run.

**3. Elites kill rarely but absolutely.** Elite damage concentrates on a single
slot per repository — wolf3d s8 (94% on that slot), codeenstein3d s13 (69%),
laravel s14 (98%), curl s13 (95%) — and those slots kill 100%, 97%, 100%, 100%.
laravel is the starkest: thirteen slots kill nobody, *including one with 394
enemies at 6,372 DPS*, and then an 18-enemy slot holding a 25,050 HP Elite kills
47 of 47.

**4. Both zero-Elite repositories are effectively non-lethal.** sinatra and
serilog are the only campaigns here with 0 Elite HP on every slot, and between
them they produced **one death in 120 runs**. Every repository that killed anyone
in bulk has Elites. That is the cleanest evidence in this document that the Elite
mechanism is real — and note it arrives through *deaths*, not completions,
because serilog's completion rate is destroyed by an unrelated bot bug.

**The spread is the headline.** Same generator, same difficulty, same bot: one
repository is completed by **88%** of runs and four by ~0–2%, for **three
different reasons** — Elite walls, Edge Case attrition, and navigation failure.
Whatever is wrong is not a global constant that one multiplier moves, and any
change validated only against `demo-campaign` is tuned against a single point in
a very wide distribution.

---

## 11. Elite HP does not order lethality

This section was expected to produce a survivable-HP threshold. It produces the
opposite, and that is worth more.

Every observed Elite level, sorted by Elite HP:

| repo / level | Elite HP | Elites | other enemies | total DPS | clear ratio | deaths |
|---|---:|---:|---:|---:|---:|---|
| wolf3d s8 `OLDSCALE.C` | **3,000** | 1 | 39 | 592 | 4.78 | **100%** (25/25) |
| demo L13 | 3,075 | 1 | 19 | 301 | 5.18 | **0%** (0/156) |
| demo L12 | 3,300 | 1 | 17 | 266 | 5.06 | **0%** (0/156) |
| curl s13 `chkspeed.c` | **3,825** | 1 | **6** | **125** | 3.07 | **100%** (26/26) |
| codeenstein3d s15 | 4,275 | 1 | 267 | 4,111 | 4.79 | cleared (n=1) |
| demo L15 | 6,600 | 2 | 11 | 256 | 2.84 | 46.2% [41–52] |
| codeenstein3d s13 | 7,425 | 2 | 55 | 817 | 3.02 | 97% (28/29) |
| demo L17 | 9,675 | 3 | 74 | 1,268 | 2.12 | 98.2% [95–99] |
| laravel s14 | **25,050** | 1 | 17 | 296 | 26.74 | **100%** (47/47) |

**The smallest Elite in the table is among the deadliest.** wolf3d's 3,000 HP
Elite kills every run that reaches it while demo-campaign's *larger* 3,075 and
3,300 HP Elites kill nobody across 156 runs each. In every lethal case the Elite
was **still alive when the player died** (25/25, 26/26, 28/28, 47/47), so the
mechanism is "could not kill it in time" — but "in time" is not set by its HP.

### Every candidate metric was tested, and every one fails

- **Elite HP** — fails on rows 1–4 above.
- **Crowd size / crowd DPS.** The hypothesis that the Elite tanks while the crowd
  kills fitted wolf3d (39 others, 592 DPS) against demo L12 (17, 266). **curl s13
  destroys it**: six other enemies and 125 total DPS, and it still kills 100%
  with 95% of lethal damage from the Elite.
- **`Elite HP × total DPS`.** Fitted on eight points, it ordered nine of ten and
  correctly predicted laravel s14 out-of-sample. curl s13 then scored **0.48M** —
  *lower* than demo L12's 0.88M, which kills nobody — and killed everybody.
  **Retracted.**
- **`Elite HP × Elite DPS`.** Elite DPS is a flat 50 per Elite, so this adds no
  information: wolf3d s8 and demo L13 both score 0.15M, with outcomes 100% and 0%.
- **Clear ratio.** "Below ~5 is lethal" fits every row until laravel s14 kills
  100% at **26.74**.

**No quantity the solver computes separates a lethal Elite level from a harmless
one.** With nine Elite levels observed, any rule with two free parameters can be
made to fit and would mean nothing, so no such rule is offered here.

**Where the variable actually lives.** Not in the solver's model. §14 is the
strongest candidate: the bot knife-trades every Elite it meets, so survival
depends on the encounter's geometry and on bot policy — neither of which the
solver represents, and both of which vary wildly between two levels with
identical Elite statistics. **Until §14's bot fix lands, none of these lethality
numbers can be attributed to level design with confidence.**

---

## 12. Level size is not the axis

The open backlog carries a drafted item asserting that "the corpus's real outlier
is level size, not Elite HP", citing ripgrep's `flags/defs.rs` at 432 enemies /
8,061 DPS. **The sweep refutes it.**

| level | enemies | total DPS | clear ratio | deaths |
|---|---:|---:|---:|---|
| sinatra s15 `base.rb` | **439** | 7,184 | 5.47 | **0%** (0/54) |
| laravel s12 `Eloquent/Model.php` | **394** | 6,372 | 80.37 | **0%** (0/60) |
| curl s12 `libssh2.c` | 213 | 3,655 | 12.68 | **0%** (0/46) |
| ripgrep s3 `core/logger.rs` | **17** | 231 | 6.39 | **33%** (15/45) |
| curl s13 `chkspeed.c` | **7** | 125 | 3.07 | **100%** (26/26) |

The three largest levels in the sweep kill nobody. The two smallest levels in
this table kill 33% and 100%. Enemy count correlates with death rate at ρ = 0.57
pooled, but that is survivorship — deeper slots are reached only by stronger runs
— and it **inverts within repositories**, which is where it would have to hold.

Density does not rescue it either. `levelStart.walkableTiles` has been logged all
along, so enemies-per-walkable-tile is computable from captures already on disk:

| metric | pooled | wolf3d | ripgrep | codeenstein3d |
|---|---:|---:|---:|---:|
| enemies / tile | 0.110 | **0.690** | 0.146 | −0.044 |
| Edge Cases / tile | 0.115 | **0.762** | 0.024 | −0.226 |
| `clearRatio` | −0.708 | **−0.024** | −0.505 | −0.871 |

Density does not generalise (pooled ρ = 0.11; sinatra's *densest* slot killed one
player in 57 visits) — but it is the strongest signal available on wolf3d, which
is precisely where `clearRatio` is blind. **The two metrics succeed on disjoint
repositories.** At 8–15 slots per repository that is suggestive, not established.

---

## 13. What the solver can and cannot see

### `clearRatio` works — but only if you solve the campaign you actually played

An error worth recording, because it nearly produced a much stronger and wholly
wrong claim. Per-slot death rates were first joined to the **full-repo** solver
output. But a staged campaign is 15 levels drawn from a repository's full
enumeration, and the solver models ammunition as accumulating across the campaign
it is given. ripgrep's `crates/core/logger.rs` sits at `campaignLevelIndex: 27`
in the 87-level solve and at **slot 3** in what the bot played:

| `crates/core/logger.rs`, hard | clear ratio |
|---|---:|
| full-repo solve (index 27) | **261.43** |
| staged-order solve (slot 3) | **6.39** |

A 41× overstatement, on the exact level being cited as the headline
counterexample. Re-solving each staged campaign in its own order corrects it.

Spearman ρ against observed death rate, 43 slots with n ≥ 5, **staged-order**:

| metric | pooled | wolf3d | ripgrep | codeenstein3d |
|---|---:|---:|---:|---:|
| **`clearRatio`** | **−0.708** | −0.024 | −0.505 | −0.871 |
| total HP | +0.625 | +0.048 | +0.288 | +0.852 |
| total DPS | +0.538 | −0.024 | +0.450 | +0.802 |

`clearRatio` is the strongest single metric available and points the right way.
**It fails on exactly one repository — wolf3d, the Elite-driven one** — where a
*better*-supplied level (4.78) kills 100% against demo L15's 2.84 killing 46%.

**Live tooling bug this exposed:** `stage-campaign.mjs` selects and orders levels
using full-repo metadata. Its max-DPS and max-Elite-HP must-includes are
level-local and unaffected, but **the min-clear-ratio pick is chosen on a number
observed to be 41× off**. No capture is corrupted — the bot played real levels
honestly — but that slot's recorded rationale is unreliable.

### Sustain is a constant of the generator

`healthSecs` = (pre-placed + expected drop health) ÷ total enemy DPS — how many
seconds of sustained full contact a level's own health supply buys. Across 59
staged slots: **median 1.11, with 45 of 59 between 0.95 and 1.50.** The 14
outliers are near-empty levels where a single pickup dominates. It does not scale
with size — the two largest levels in the sweep read 0.80 and 0.92.

Health drops scale with kills and kills scale with enemy count, so **the generator
cannot produce a level meaningfully better or worse supplied with health than any
other.** This is a property of solver output, not of the runs, so it carries no
survivorship confound. It is why ammunition is the binding constraint the solver
can see — and why anything that kills faster than attrition is invisible to it.

### Elite occurrence is procedural style, not language, age or size

Elites per 1,000 enemies across 23 repositories:

| repo | lang | per 1k | max Elite HP (hard) |
|---|---|---:|---:|
| vim | C | **10.9** | **50,325** |
| stb | C headers | 6.2 | 25,800 |
| curl | C | 5.5 | 23,025 |
| wolf3d | C (1992) | 4.3 | 16,725 |
| doom | C (1993) | 3.8 | 8,925 |
| **codeenstein3d** | TypeScript | 3.1 | 7,425 |
| git | C | 2.5 | 13,575 |
| quake | C (1996) | 2.2 | 7,125 |
| commons-lang / django | Java / Python | 0.7 / 0.5 | ~5,000 |
| ripgrep / laravel | Rust / PHP | 0.2 / ~0.0 | 3,525 / 25,050 |
| leveldb, sinatra, serilog, flask | C++, Ruby, C#, Python | **0.0** | — |

Seven of the top eight are C. Everything decomposed into methods sits at or near
zero **including the mature and enormous** — django is 935 levels at 0.5, laravel
1,694 levels with a single Elite. So the driver is long procedural functions, not
age and not scale. Part I's 0.13% figure came from a corpus that was uniformly
modern method-decomposed code.

**Nothing in any of the 23 repositories is analytically unkillable.**
`balancing:budget`'s gate passes everywhere. vim's worst level (`src/regexp_bt.c`,
six Elites totalling 134,025 HP) sits at clear ratio 4.85, and its 50,325 HP Elite
is 7.1% of that level's obtainable damage. Framing these as "arithmetic
impossibilities" is wrong; the case against them is time-to-kill under fire, which
is §14's territory.

---

## 14. The Elite death rates measure bot policy

**Read this before acting on anything Elite-related, here or in Part I.**

The bot does not fight Elites. It knife-trades with them. wolf3d slot 8, pooled
over all 25 deaths:

| weapon used against the 3,000 HP Elite | shots | damage |
|---|---:|---:|
| **SIGKILL Knife** | **305** | **12,200** |
| Toolchain | 88 | 7,040 |
| Friday Hotfix | 73 | 3,328 |
| Regex Shotgun | 44 | 4,275 |
| gdb | 9 | 120 |
| **ghidra (rockets)** | **2** | **135** |

- Median engagement distance against the Elite: **0.54 tiles**; 82% of shots
  inside 2 tiles. (codeenstein3d s13: 0.82t, 78%.)
- **84%** of the bot's outgoing damage on that level went into the Elite. It
  killed it **0 times in 25**.
- At death, **24 of 29 Edge Cases and all 10 normals were still alive.**
- **94%** of the damage the bot took came from the Elite it was standing on.
- It **has** the rockets and does not fire them: median **4 at level start, 5 at
  level end**, ghidra owned in all 25 runs.

**Why, in code.** `shouldCloseToMelee` "only ever asks how far away the target is,
never how big it is" (`combatPolicy.mjs:269-270`) — nothing declines a knife trade
against 3,000 HP. Having closed to ~0.5t, `rocketAimUnsafe` blocks every rocket
inside `ROCKET_SAFE_DISTANCE` (4 tiles, `:314`, enforced `:1170`) and
`pickRangedWeapon` "never selects ghidra within ROCKET_SAFE_DISTANCE". **The bot
disables its own best anti-Elite weapon by closing**, then grinds 3,000 HP with a
40-damage knife while taking doubled melee damage.

### The A/B

`MELEE_MAX_TARGET_HP` exists for exactly this question, shipped inert at
`Infinity`, and had never been run. Its comment states the question verbatim:
*"whether those two levels are genuinely brutal or whether the bot simply fights
them badly, and no amount of re-tuning enemy HP settles it."*

Same staged wolf3d campaign, same three cells, 20 runs each, event log verified.
The knob is surgically scoped: across wolf3d levels 1–8 the **only** enemy above
500 HP is that single Elite (0 of 5,319 normals, 0 of 13,016 Edge Cases).

| | baseline | `MELEE_MAX_TARGET_HP:500` |
|---|---:|---:|
| median Elite engagement | 0.54t | **1.25t** |
| knife swings at the Elite | 305 | **0** |
| ghidra shots | 2 | 1 |
| rockets held, start → end | 4 → 5 | 4 → 5 |
| level-8 deaths | 100% [87–100] 25/25 | 89% [72–96] 24/27 |
| **Elite kills** | **0** | **0** |
| damage dealt / taken, Elite share | 84% / 94% | 64% / 85% |

**The knob bound and the lethality result is null.** Level-8 survival goes 0/25 →
3/27 (**Fisher p = 0.236**), and runs reaching level 9+ go 0/60 → 3/60
(**p = 0.244**). Median campaign depth appears to move 4 → 6, but p25 (3) and p75
(8) are identical in both arms — the distribution is bimodal and the median is a
poor summary. **Three runs getting further is not an effect.**

**Why it is null was predicted before the run.** The knob stops the bot *closing*;
it does not stop the Elite closing. Engagement settles at 1.25t — still inside
`ROCKET_SAFE_DISTANCE` — so ghidra stayed blocked and the Elite was never killed
in either arm. The bot lands in a **dead zone**: too far to knife, too close to
rocket, left with shotgun and Friday Hotfix against 3,000 HP.

Per the knob's own comment, read this as **"closing is not the whole mechanism"**
— not as "the bot fights these levels fine."

**What the real fix has to be.** Hold range from a target you cannot burst down.
The only retreat that exists, `NAV_BACKPEDAL_RETREAT`, is gated on
`CRITICAL_HEALTH_FRACTION: 0.2` — it fires below 20% health, which against doubled
melee damage is a hit or two from death. There is no "this target is too big, keep
distance" rule anywhere. That is a code change, not a knob, and §8.4 already named
the target: *"a bot variant that opens Elite engagements beyond 6 tiles."* §8.4
also records that **two prior rocket A/Bs came back null** because they probed
`pickRangedWeapon` in isolation — *"a probe of a pure function proves the function
changed, not that the situation it needs ever occurs."* This A/B avoided that by
measuring engagement distance in real runs; any successor must do the same.

---

## 15. The bot wedges, and it costs more than any balance issue

**121 of 405 runs (30%) ended stuck, not dead.** Two distinct failure signatures.

**Stall — serilog, 60 of 60 runs.** Zero deaths across all 15 slots and zero
completions. Slot 12 logs **743 `stall` anomalies**; slot-13 stalls read
`activity=loot threatDist≈1.25 hpFrac 1.00->1.00` — wedged mid-loot beside an
enemy that is neither killing it nor being killed. ripgrep lost 13 of 45 runs and
curl 29 of 60 the same way.

**Oscillation — curl, 58 of 58 runs on level 1.** The first curl capture never
produced a single `levelEnd`. Two different shell-script slot-1 files were tried,
with an identical signature both times:

```
oscillation (2400 ticks) activity=route travelled=120.3t net=0.36t
ratio=332.9x signFlips=800/2399 navDist=0.71t  hpFrac 0.90->0.90
```

`navDist=0.71` is **√2/2**, the diagonal offset between tile centres, against an
`ARRIVE_EPS` of **0.15** (`combatPolicy.mjs:164`). The bot orbits a waypoint one
diagonal step away, at full health, for 2,400 ticks — walking 120 tiles to achieve
0.36 tiles of progress. Both levels are *tiny* (226 and 265 walkable tiles), so
this is geometry, not scale. Excluding `.sh` produced a campaign whose first three
levels clear normally, so **curl's capture excludes 26 shell levels as a
workaround for a bot bug, not a balance decision.** Evidence is preserved at
`balancing_capture_curl_WEDGED_lvl1/`.

Both are the open backlog item *"Bot circles in open space and beside armed spikes
— oscillation up ~50%"*, filed as navigation tuning measured in ticks per 1,000
decisions. **That framing is wrong by an order of magnitude**: this is the sole
reason a repository scores 0% completion with zero deaths, and it costs more runs
across the sweep than every balance problem combined.

**A pre-flight lesson.** The entrypoint check used `CODEENSTEIN_TELEMETRY_LEVEL_LIMIT=1`
and proved only that the right map *loaded*. It now uses `LEVEL_LIMIT=3` and
asserts a `levelEnd` with outcome `cleared` — proving a level can be **finished**,
not merely entered. The first curl capture burned 58 runs because the old check
could not tell the difference.

---

## 16. Conclusions and follow-up

### What to fix, ranked

**1. Give the bot a threat-sized standoff, and re-measure every Elite level.**
(§14) First because it gates everything else: while it stands, no Elite lethality
number in this document measures level difficulty. `MELEE_MAX_TARGET_HP:500` works
as designed and is not sufficient — the fix is holding range beyond ~4.5t (§8.4
says beyond 6t), which is a code change.
*Acceptance:* median Elite engagement above 4.5t, ghidra shots per Elite fight
above zero (baseline: 2 across 25 deaths), then re-run wolf3d s8 and demo 15/17.

**2. Fix the stall and oscillation bugs.** (§15) They cost **121 of 405 runs**,
more than every balance issue combined, and they are the cheapest completion-rate
win available because nothing about the balance needs to change.
*Acceptance:* serilog completes at a rate comparable to sinatra's 88%; curl runs
without excluding `.sh`.

**3. Fix `stage-campaign.mjs` to select on staged-order metadata.** (§13) Cheap,
and it invalidates the recorded rationale for one of three must-include slots in
every campaign staged so far.

**4. Cap Elite HP — supported, but not first.** Justified by *practical*
killability, not by "arithmetic impossibility" (§13 retracts that framing: nothing
is analytically unkillable). The controlled comparison is laravel s14 versus demo
L12 — crowd held at ~18 enemies and ~280 DPS, **3,300 HP kills 0/156 while 25,050
HP kills 47/47**. But §11 shows HP does not order lethality generally, and §14
shows the measurement is contaminated by bot policy, so **the size of any clamp's
benefit cannot be read off these numbers.** *Do not lower
`ELITE_COMPLEXITY_THRESHOLD`* — Elites already occur at ~5× the assumed rate.

**5. Do not write the "level size is the real outlier" backlog item as drafted.**
(§12) Its headline example is refuted by a level of the same size that every run
cleared.

### Permitted but not confirmed

**6. Soften the Elite HP cliff between complexity ~30 and ~50.** Real and firing
217 times across the corpus, but no capture has isolated its effect.

**7. Write an Edge Case attrition item.** Edge Cases deal 56–91% of all lethal
damage and have no backlog entry. This is a hypothesis about what to investigate,
not a measured fix.

### Overlap with the open backlog

| # | Backlog item | Relationship | Action |
|---|---|---|---|
| 1 | **Elites too strong, and not rare** | Confirms "not rare" (23 repos); **substantially weakens "too strong"** — §11 shows HP does not order lethality, §14 shows bot contamination, §13 shows nothing is analytically unkillable | Keep; rewrite the justification, **delete the "arithmetic impossibility" framing**, demote below the bot fixes |
| 2 | its *"acceptance is measurable without a bot run"* | **Partly contradicted.** A sweep can verify a ceiling; it cannot verify a lethality change — on the Elite repo, solver output has ρ = −0.02 against observed deaths | Split the criterion: sweep for the ceiling, bot capture for any lethality claim |
| 3 | its *"the real outlier is level size … wants its own item"* | **Refuted** (§12) | Delete the bullet; write the Edge Case item in its place |
| 4 | its *"do not lower the threshold without addressing the cliff"* | **Reinforced** — the 23-repo sweep raises the c≥40 share to 0.77% | Unchanged |
| 5 | **Bot circles in open space / oscillation (NOT fixed)** | **Strong overlap, and the item understates it by an order of magnitude** (§15) — this wedged 60/60 serilog runs and 58/58 curl runs | **Re-scope and re-prioritise.** It is not navigation polish; it is the top completion-rate blocker |
| 6 | **Lane parallelism idles** | No finding overlap, but it gates follow-up 3 below | Cross-reference |
| 7 | **Flamethrower reach/falloff** | No overlap; its evidence is the Part I capture | Unchanged |
| 8 | **`fetch-online-wads.mjs` should degrade** | No overlap | Unchanged |

### Recommended further investigation

1. **Re-solve every capture in staged order before trusting any solver-derived
   number.** (§13) ~20 s per repository, and it is the error that nearly produced
   a wrong headline here.
2. **Log the geometry density cannot capture** — chokepoint width, sightline
   length from spawn, spawn clustering. The cheap spatial metric already exists
   and is not sufficient (§12). *Acceptance:* |ρ| > 0.6 on wolf3d **and**
   non-negative on codeenstein3d — one number that works where both current ones
   fail.
3. **Capture `normal` alongside `hard`.** Near-free in wall-clock (lanes idle
   ~50% of a run), and **zero** `normal` data exists for any real repository, so
   every Part II statement is hard-only.
4. **Isolate the wolf3d/curl inversion** (§11) — the highest-value single
   experiment. A 3,000 HP Elite kills 25/25 and a 3,825 HP one kills 26/26, while
   3,075 and 3,300 HP Elites kill 0/156. Compare the encounters directly: room
   dimensions, spawn distance, whether the Elite is reachable before it reaches
   you, cover, and weapons held on arrival.
5. **Re-run the Part I demo capture after any clamp** — it is the only campaign at
   n=360 and the regression baseline.
6. **Record `n` and profile mix beside every per-slot rate.** Deep slots are
   reached almost exclusively by Pro, biasing every pooled per-slot number toward
   "safe". The per-repo tables in §10 split on profile; the pooled correlations in
   §12 and §13 do not, and that limitation should not have to be rediscovered.
