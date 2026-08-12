# Phase 3b — Code-Bug Candidates

> **Resolved 2026-08-12 — F25 is not a bug.** The maintainer's answer: the coop
> overshoot is **intentional, for now, to promote actual cooperation in coop.**
> `ELITE_MEMBER_HP_CAP` bounds the generator; `eliteScalingFor` is a separate
> axis layered above it, and exceeding the solo-calibrated ceiling is the
> mechanism rather than a defect in it — an Elite sized for one player is
> trivial for four. So the code is right and the **player-facing docs** were the
> loose ones. `decisions.md` (Enemy Scaling), `game-design.md`,
> `enemies.ts:53`'s docblock and `multiplayerScaling.ts` now all record it,
> including an explicit "do not clamp this" for the next reader who finds the
> same apparent contradiction. What remains open is only that `1 + 0.5n` is a
> placeholder: no coop telemetry has run at anything like the 112,311-kill scale
> behind the single-player cap. **F26 is also retracted** (see `07`); F27 stands
> and is in `notes`.

Cases where the documentation appears **correct** and the implementation appears
wrong. **Report only.** No fixes, no patches, no suggested diffs. Each entry
states the documented intent, the implemented behaviour, and the risk of
"fixing" it — particularly to determinism and replay compatibility.

Three candidates, ranked by how load-bearing the documented intent is.

---

## F25 — Multiplayer Elite scaling multiplies past the HP cap the generator calls absolute

### Documented intent

`src/map/generation/enemies.ts:53-68`, on `ELITE_MEMBER_HP_CAP = 350`:

> "**No enemy this generator produces may exceed this, whatever the source file
> does.** Straight from measurement, with one conversion that is easy to get
> wrong: the observed killable band is **runtime** HP, and HP here is **base**
> HP, which `DIFFICULTY_MULTIPLIERS` then scales. The bot kills enemies up to
> ~500 runtime HP reliably (21%, median TTK 3.4s over 3,551 kills) and the
> largest it has ever killed on `hard` is **338**, across 112,311 kills there.
> **So the ceiling that matters is 500 *after* Hard's 1.5x — hence 350 here, or
> 525 on Hard, which is the top of the band the data actually covers.**"

Reinforced by `enemies.ts:44-49` ("An Elite was not a hard fight, it was
terrain"), `doc/dev/game-design.md:23` ("no enemy is ever bigger than the player
can actually kill, so a boss fight is a fight you can lose rather than one you
cannot win"), and `CHANGELOG.md:5` ("The largest enemy the generator can produce
fell from 50,400 to 525").

The intent is explicit and unusually well-specified: **525 runtime HP is the
documented ceiling**, derived empirically, and the conversion between base and
runtime HP is called out as the thing that is easy to get wrong.

### Implemented behaviour

`src/engine/engine.ts:1198-1215` applies two multiplier passes at construction,
in order:

```
1. difficulty pass   — every enemy:  hp,maxHp ×= DIFFICULTY_MULTIPLIERS[d].hp
2. elite pass        — elites only:  hp,maxHp ×= eliteScalingFor(playerCount).hp
```

`eliteScalingFor` (`multiplayerScaling.ts:42-48`) returns
`hp = 1 + 0.5 × (playerCount − 1)`.

Runtime HP of an Elite anchor at the generator's cap:

| Players | Normal (×1) | Hard (×1.5) |
|---|---|---|
| 1 | 350 | 525 ← the documented ceiling |
| 2 | 525 | 788 |
| 3 | 700 | 1 050 |
| 4 | 875 | **1 313** |

At the shipped maximum of 4 players (`index.html:154-157`), on Hard, an Elite
anchor carries **2.5× the documented ceiling** — and 1 313 is well outside the
band the measurement covers at all (the largest ever killed on Hard was 338).

### Why this is a candidate rather than a confirmed bug

The generator's claim is literally true as written: *"no enemy **this
generator** produces"*. The generator does cap at 350; the **engine** scales
past it afterwards. Two readings are available:

- **The cap is about the generator's output only**, and player-count scaling is a
  separate, intentional axis layered on top — in which case the code is correct
  and only the *framing* in `game-design.md` and the CHANGELOG (which speak about
  what the player faces, not about a layer boundary) is loose.
- **The cap is about what the player faces**, since that is what the entire
  measurement justifying 350 is about (time-to-kill under fire versus how long
  the player survives) — in which case the elite pass defeats it.

`multiplayerScaling.ts:29-34` weakens the case for the first reading: the two
scaling constants are described as *"reasoned starting points … **not validated
ones**"*, explicitly deferring to future telemetry. So the number that breaches a
measured ceiling is itself acknowledged as unmeasured.

Note also that the co-located comment misstates the base it composes with — see
**F05** in the main ledger (`multiplayerScaling.ts:20-21` says `ELITE_HP_MULTIPLIER`
is 4×; it is 2×). The two findings share a code path.

### Risk if "fixed"

**High, and specifically a lockstep/replay risk.**

- Enemy `maxHp` is set inside the `RaycasterEngine` constructor and is part of
  the simulated state both peers advance in lockstep. Changing how it is computed
  changes simulation state on one side only unless both peers ship the change
  simultaneously — a guest on an older build would desync immediately. The build
  version check (`src/multiplayer/buildVersionCheck.ts`) is what currently stands
  between that and a silent divergence.
- Any recorded multiplayer replay carrying an Elite would no longer reproduce.
  Single-player replays are unaffected (`eliteScalingFor(1)` is the identity, so
  the pass does not run).
- Clamping the product would change **single-player Hard nothing** and
  **multiplayer everything above 2 players**, i.e. it is a balance change to the
  least-measured mode in the project. `multiplayer-game-state-spec.md` §4 is the
  spec that would have to move with it.

**Recommendation for Phase 4: this is a decision for the maintainer, not a doc
edit.** The doc is not obviously wrong; the ambiguity is real. Either the intent
is "generator output only" — in which case `game-design.md`'s and the
CHANGELOG's phrasing want a multiplayer caveat — or the intent is "what the
player faces", in which case this is a genuine gameplay bug and belongs in
`notes`, not in this audit's remit.

---

## F26 — `CODEENSTEIN_DEV_URL` has two different built-in defaults

### Documented intent

`CODEENSTEIN_DEV_URL` is read at 10 sites as *the* dev-server URL override —
one name, one meaning. Nothing anywhere documents a per-script difference, and
`doc/dev/testing.md`'s verify-script section treats "start a dev server, then run
the script" as one uniform procedure.

### Implemented behaviour

| Default | Sites |
|---|---|
| `http://localhost:5173` | `verify-multiplayer-connect.mjs:64`, `-disconnect.mjs:33`, `-netcode.mjs:28`, `-reconciliation.mjs:35`, `-transition.mjs:79`, `verify-wad-textures.mjs:70`, `lib/multiplayerSessionBootstrap.mjs:223` |
| `http://localhost:5183` | `verify-campaign-playthrough.mjs:95`, `verify-replay.mjs:93` |

A third port appears as a *separate* variable: `CODEENSTEIN_TELEMETRY_DEV_PORT`
defaults to `5199` (`run-balancing-telemetry.mjs:58`), as does
`CODEENSTEIN_PERF_PORT` (`run-perf-benchmark.mjs:63`).

### Why this is a candidate

The 5199 pair is clearly deliberate — those harnesses start their **own** dev
server on a private port to avoid colliding with a developer's. The 5173/5183
split has no such explanation anywhere in the code or docs, and both groups
expect an *externally started* server. Vite's own default is 5173, which makes
5183 the anomaly.

Consequence when unset: a developer running `npm run dev` (port 5173) and then
`npm run verify:replay` gets a connection failure whose cause is invisible,
while every multiplayer verify script works. That matches the shape of a
copy-paste divergence rather than a design.

### Risk if "fixed"

**Low, but not zero.** Aligning the two outliers to 5173 would make them
collide with a developer's own `npm run dev` server if that is what 5183 was
protecting against — which is exactly what the 5199 harnesses do avoid, and
those two are the ones that drive long campaign/replay runs. Changing it without
knowing which of those two intentions was meant risks trading a silent
connection failure for a silent *wrong-server* run.

No determinism or replay exposure: this is harness plumbing, not simulation.

---

## F27 — Numeric environment variables are not validated

### Documented intent

`scripts/multiplayer-server.mjs --help`, in its executed output:

> "Environment variables (**all optional, sane defaults otherwise**; values below
> are this invocation's currently-effective ones)"

`docker/README.md` and `doc/dev/multiplayer-deployment.md` present the same
variables as ordinary tunables.

### Implemented behaviour

Every numeric read is `Number(process.env.X ?? <default>)` with no range or
`NaN` check — e.g. `multiplayer-server.mjs:44`:

```js
const PORT = Number(process.env.CODEENSTEIN_MULTIPLAYER_PORT ?? 8787);
```

`CODEENSTEIN_MULTIPLAYER_PORT=abc` yields `NaN`, which propagates silently.
The same shape applies to all 20 numeric server variables, to every
`CODEENSTEIN_CAMPAIGN_*` / `_CAPTURE_*` / `_TELEMETRY_*` numeric, and to the
`POC_*` trio.

**Exactly one variable in the codebase validates**:
`CODEENSTEIN_TELEMETRY_SEED` (`run-balancing-telemetry.mjs:199-205`), which
range-checks `0..0xffffffff` and exits non-zero with a message naming the bad
value. That is also the one variable where a bad value would silently corrupt an
experiment rather than crash it — so the validation exists precisely where its
absence would be undetectable.

### Why this is a weak candidate

The `--help` sentence promises a sane default when a variable is **unset**,
which is true. It does not promise validation of a set-but-invalid value. So the
doc is not strictly wrong — it is silent, and the silence reads as a guarantee it
does not make. `CODEENSTEIN_TELEMETRY_SEED`'s existence shows the project does
validate when it judges the failure mode bad enough.

Listed here rather than as a `MISSING` doc finding because the asymmetry looks
like an oversight in the code (one validated variable out of ~60 numeric ones)
rather than a documentation gap.

### Risk if "fixed"

**Low.** Adding validation is additive and affects no simulation path. The only
caution is that a deployment currently running with a typo'd variable would
start failing loudly at next restart — which is the point, but is a behaviour
change for anyone whose config has been silently wrong.

No determinism or replay exposure.

---

## Summary

| ID | Documented intent holds? | Determinism/replay risk if changed | Disposition |
|---|---|---|---|
| **F25** | Ambiguous — turns on whether the cap means "generator output" or "what the player faces" | **High** — multiplayer lockstep state and MP replays | **Maintainer decision required.** Not a doc edit |
| **F26** | Yes — one variable, one meaning, no documented split | None | Report; likely a `notes` item |
| **F27** | Silent rather than wrong | None | Report; lowest priority |

None of the three should be fixed as part of this audit. F25 is the only one
whose resolution changes what the docs should say, and it needs a decision on
intent before any wording can be chosen — carried into Phase 4 as a blocking
question.
