# Phase 3a — S0 Findings Expanded

Five findings rated S0: actively misleading, such that a competent reader —
human or agent — following the doc would write incorrect code, ship a false
statement, or undo a deliberate change.

---

## F01 — `index.html:335-337`: the network-calls claim omits multiplayer

> "The only network calls this app ever makes are the ones you opt into on the
> GitHub tab, to fetch the repo you asked for."

**Ground truth.** The app makes at least three further classes of request, all
enumerated correctly in the project's own `doc/user/privacy.md`:

| Request | Site | privacy.md |
|---|---|---|
| Signaling / lobby server (join code, SDP offer/answer, client IP) | `src/multiplayer/signalingClient.ts` | `:21`, `:23` |
| TURN relay, when the deployment has one and NAT blocks a direct link | server-issued credentials, `multiplayer-server.mjs:181-200` | `:25` |
| Online texture pack — same-origin fetch for a bundled static file | `src/wad/onlineWadCatalog.ts` | `:49` |

**How it misleads.** This is a privacy claim, on the app's first-run intro
panel, in the surface a non-technical player is most likely to read and least
likely to cross-check. It is linked directly to `privacy.md` two lines below —
so the app presents a summary that its own linked authority contradicts. A
player on the hosted build who hosts or joins a multiplayer session has their IP
seen by the signaling server, and possibly their entire gameplay stream routed
through a TURN relay, having been told no such call exists.

The failure mode is not a bad code change; it is shipping a false privacy
statement. That is why it outranks the other four despite being the least
technically interesting.

**Note on scope.** `README.md:181` says the multiplayer tab stays hidden until
the build is pointed at a signaling server, so on a plain local clone the
sentence is *accidentally* true. It is false on the hosted build the intro panel
was written for.

---

## F02 — `README.md:51`: entrypoint detection is inverted

> "**Smart entrypoint detection** — finds `main`, highest complexity, or any
> parsable file"

**Ground truth.** `findEntrypointByScanning` tracks the **least**-complex file
defining a `main`/`Main` callable, and separately the **least**-complex file
overall with `complexity > 0` (`src/main.ts:2447-2460`). The function's own
docblock is unambiguous (`main.ts:2390-2400`):

> "**This picks the least complex file, and it used to pick the most.** … Scoring
> by highest complexity therefore opened every repo without a conventional
> entrypoint name on its single hardest map. Measured on `id-Software/wolf3d`
> (2026-08-05): the scan chose `WL_ACT2.C`, a **446-enemy, 4,742-DPS,
> 13,686-tile** level, as the opening."

**How it misleads.** The README states the exact rule that was deliberately
removed, and it names the ordering ("highest complexity") rather than merely
being vague. An agent asked to "fix entrypoint detection to match the README",
or one reasoning about level-1 difficulty from the README's description, would
reintroduce a measured, documented regression whose cost is recorded in the code
it would be editing. The change is recent enough (2026-08-05) that the README
predates it by one day.

---

## F03 — `README.md:112`: the Elite is described as a single boss

> "High complexity = more health, pack spawns, or **a single elite boss** (2× HP,
> gold tint, 2× damage)"

**Ground truth** (`src/map/generation/enemies.ts:131-145,173`):

```
eliteTotal = min(complexity × 25 × 2, 8 × 350)   →  min(50c, 2800)
count      = ceil(eliteTotal / 350)              →  up to 8 members
hp         = round(eliteTotal / count)           →  ≤ 350 base, ≤ 525 on Hard
elite flag = (elite && index === 0)              →  anchor only
```

**How it misleads.** This is the single largest recent balance change in the
project, and the README describes the state before it. The measured case for the
change is recorded in `enemies.ts:40-49`: across seven repositories **1,332
Elites spawned and 2 died**, none on Hard, and every one of the 514 cleared runs
on an Elite-bearing level left the Elite alive. `ELITE_MEMBER_HP_CAP`'s comment
(`:53-68`) derives the 350 empirically. The CHANGELOG's top entry is about it.

Three consequences:

1. **It contradicts three other docs that are correct** — `doc/user/mechanics.md:16`
   ("an **Elite pack** … led by a gold-tinted Elite"),
   `doc/user/level-design.md:38`, and `doc/dev/game-design.md:23` ("The pack
   stays a pack, though: no enemy is ever bigger than the player can actually
   kill"). A reader who trusts the README over the others gets the one wrong
   answer available.
2. **It contradicts itself.** `README.md:111`, the line immediately above,
   correctly describes HP being split across a pack "rather than inflating a
   single body". Line 112 then says a single body.
3. **It is the most plausible cause of an incorrect change.** "Make the elite a
   real boss again" is a natural reading of line 112, and implementing it means
   removing the cap and the re-split — restoring an encounter with a measured
   0.15% kill rate.

---

## F04 — `src/engine/weapons.ts:146-150`: Friday Hotfix's range is the pre-change value

> "**Friday Hotfix**: fully automatic flamethrower — a tight jet … enforced by a
> **hard 3.5-tile `maxRange`**, so it melts anything at point-blank range but
> **genuinely cannot reach past a couple of tiles** no matter how the Cone of
> Fire spread happens to land."

**Ground truth**, 140 lines below in the same file (`weapons.ts:288-297`):

> "Full damage to 2.5 tiles, decaying to nothing at 6.5, replacing a flat
> 3.5-tile cutoff. Deliberately a *redistribution* rather than a buff… Measured
> over the 2026-08-04 capture, it was locked to the wrong band — fights against
> regular enemies happen at a median 4.6 tiles, outside its reach entirely."

**How it misleads.** Both comments are in `weapons.ts`. The module-level
docblock — the thing anyone opening the file reads first, and the thing an agent
grepping for "Friday Hotfix" hits first — states the exact behaviour that was
just replaced, including the number (`3.5`) and the design rationale for it
("genuinely cannot reach"). The per-entry comment states the replacement and
explains why. A reader who takes the header as the spec and the entry as the
drift would revert a measured, deliberate change; the header even supplies a
rationale to justify doing so.

This is the clearest instance in the repo of the dominant drift pattern: a
constant retuned, the adjacent comment updated, the file header missed.

---

## F05 — `src/engine/multiplayerScaling.ts:20-21`: `ELITE_HP_MULTIPLIER` stated as 4×

> "Multiplies an Elite's `hp`/`maxHp` once, at engine construction — stacks with
> (multiplies on top of) `ELITE_HP_MULTIPLIER`'s own **base 4x**, which is
> already baked into `enemy.maxHp` at map-generation time."

**Ground truth.** `ELITE_HP_MULTIPLIER = 2` (`enemies.ts:51`). Its own comment
records the change: *"Lowered 4 -> 2 after playtesting (2026-07-30) confirmed the
level-12 Elite was badly overpowered."*

**How it misleads.** This is arithmetic input, in the one module whose entire job
is composing multipliers. Anyone reasoning about total Elite HP in a multiplayer
session — to tune `ELITE_HP_SCALE_PER_EXTRA_PLAYER`, to explain a telemetry
figure, or to decide whether 4-player Elites are survivable — starts from a base
that is **2× too large**, and every downstream number inherits the error.

The second half of the sentence is now imprecise for a further reason: since the
Elite split, `ELITE_HP_MULTIPLIER` shapes the *room budget*, which is then capped
at `8 × 350` and re-divided. What is "baked into `enemy.maxHp`" is the cap, not
the multiplier. So the sentence misstates both the value and the mechanism.

Related: this same code path is where **F25** (see `03b`) lives — the MP scaling
multiplies past the cap that `enemies.ts:53` calls absolute. A reader misled by
the 4× figure is standing in exactly the place where the cap actually breaks.

---

## Which S0s most likely caused recent incorrect code changes

Ranked by likelihood, with the reasoning stated rather than asserted.

### 1. F03 (README "single elite boss") — most likely

- It describes the **most recently changed** and **most heavily measured**
  subsystem in the project.
- It is **self-contradictory within one file** (line 111 vs. 112), so a reader
  resolving the contradiction has a 50% chance of picking the stale half.
- It is contradicted by **three** other docs, meaning any agent that reads
  README plus one other doc gets conflicting instructions and must arbitrate —
  and README is the surface an agent reads first.
- The wrong reading ("restore the single big Elite") is an *actionable* change
  with a clear implementation, not just a misunderstanding.

### 2. F04 (weapons.ts header) — most likely of the in-code surfaces

- In-code comments are what agents trust most, because they are co-located with
  the code and normally maintained with it.
- The stale header is the **first** description of Friday Hotfix in the file and
  carries a design rationale, which makes it read as the intended spec rather
  than as an outdated note.
- The correct comment is 140 lines away, so a targeted edit to the weapon's
  range would plausibly never see it.

### 3. F02 (README entrypoint) — high impact, narrower blast radius

- Unambiguous and specific ("highest complexity"), so it will be believed.
- But the code's own docblock is emphatic and sits directly above the
  implementation, so anyone actually editing `findEntrypointByScanning` will see
  the correction. The risk is concentrated in readers who *reason about* level-1
  difficulty without opening `main.ts` — e.g. someone tuning the demo campaign
  or explaining why a repo opened where it did.

### 4. F05 (`multiplayerScaling.ts` 4×) — silent, cumulative

- Unlikely to cause a wrong *edit*; very likely to cause a wrong *number* in an
  analysis, a balance decision, or a doc written downstream of it.
- Its danger is that the error is invisible: nothing fails, the arithmetic just
  comes out double.

### 5. F01 (`index.html` privacy) — highest severity, lowest code risk

- Would not cause an incorrect code change at all. It is here because shipping a
  false privacy claim is a worse outcome than a wrong constant, and because the
  fix is trivial and already written in `privacy.md`.

**Common thread across F03, F04 and F05: all three are the stale half of a
balance retune whose live half is correct and nearby.** The remediation that
matters is not rewriting these three lines — it is that a constant change did
not sweep the surfaces that quote it. Phase 6 should treat that as the primary
target.
