# Phase 7 — Deferred Findings Closeout

All 14 findings deferred at Phase 5 are now disposed of. **All four blocking
decisions are answered** — two resolved by checking rather than asking, one by
treating it as documentation, and D3 by the maintainer. The pass also retracted
**three findings as invalid** and reclassified two more, all because Phase 3
filed claims without reading the doc that already covered them.

Final state across all 30: **24 fixed, 3 retracted as invalid, 1 open in
`notes`, 2 left alone deliberately.**

---

## Decisions resolved by checking

| Decision | Question | Resolution |
|---|---|---|
| **D2** | Does branch protection reference the CI job name? | `gh api …/branches/master/protection` → **404 Branch not protected**; `…/rulesets` → **`[]`**. Nothing references it. Rename is safe, and F11 was never actually blocked |
| **D4** | Is the missing `--version` aspirational? | Treated as documentation, not a feature request: README now records that the tag *is* the release identity. Building a real `--version` remains available and is not implied by this edit |
| **D5** | Re-measure or annotate the WAD slot figures? | Annotated as historical (Batch 2, already shipped) |
| **D3** | What does `ELITE_MEMBER_HP_CAP` bound? | **Answered: generator output.** The coop overshoot is intentional, to promote actual cooperation in coop — see below |

---

## Retractions — 3 invalid, 2 reclassified

This is the part of the audit that most needs saying plainly.

### F16 — `CODEENSTEIN_DEV_URL` split "documented nowhere" — **INVALID**

`doc/dev/testing.md:21-31` documents it in a per-script table, marks it *"same
variable, **different default**, not a hardcoded port"*, **and** gives the
rationale at `:31` (5183 avoids colliding with a manual dev session; CI overrides
it to reuse the server it already started).

Phase 3 filed this from a name-level grep across `doc/` without reading the
table. The first version of the Phase 7 edit asserted the split "looks like
divergence rather than design" — which contradicts `testing.md` and would have
introduced a *new* S1. Caught before commit and rewritten to defer to
`testing.md` as the authority.

### F26 — `CODEENSTEIN_DEV_URL` as a code-bug candidate — **INVALID**

Same root cause. `testing.md:31` establishes the split is deliberate, so there is
no bug. Retracted from `03b`; not written to `notes`.

### F20 — CI coverage of verify scripts undocumented — **INVALID**

`testing.md:79` states `verify-multiplayer-campaign.mjs` is **"not CI-wired"**
with the reason (an uncapped full-campaign run has no bounded worst-case
wall-clock). `verify:event-log` is an offline analysis tool over capture output,
documented at `balancing-telemetry.md:1075` and
`capturing-another-campaign.md:329`, and nothing ever claimed it was in CI.

### F23 (partial) — `"Bug"` as a terminology violation — **INVALID**

`doc/user/level-design.md:44`'s *weak "Bug" enemy* is correct: `lore.ts:165`
literally names the entity `"Bug"`, and it carries neither `elite` nor
`edgeCase`. The Phase 4 glossary wrongly treated it as a non-canonical synonym
for Edge Case. **They are different things**, and the glossary entry is withdrawn.

This also refines Phase 2 §5.2: there are three enemy *tiers*, but **four spawn
sources** — Regular, Elite, Edge Case, and the TODO-encounter `"Bug"`, which is
tier-identical to Regular while having its own entity name and HP constant.

### F19 — `report-level-budget.mjs` flags "documented nowhere" — **DOWNGRADED**

Three of the six (`--dir`, `--all-difficulties`, `--json`) were already in
`balancing-telemetry.md`. `MISSING` → `INCOMPLETE`; the row now lists all six and
notes the absent `--help`.

### Why this happened, and what it costs

Every one of these shares one cause: **Phase 3 located `MISSING` findings by
grepping for identifiers, then asserted absence without reading the prose that
would have contained them.** Grep proves a *name* is absent; it does not prove a
*fact* is undocumented. The `MISSING` class was the least reliable output of this
audit, and its S2 findings should be read with that discount.

The `STALE`/`CONTRADICTORY` findings do not share the weakness — each was
established by reading code and doc side by side, and all five S0s survived
re-checking.

---

## Findings fixed in this pass — 6

| ID | Sev | Surface | Change |
|---|---|---|---|
| F11 | S1 | `.github/workflows/verify.yml:56` | Job name → `unit tests (Vitest, coverage gate)`, plus a comment pointing at `vitest.config.ts` as the authority and stating why no number is repeated in the name |
| F15 | S2 | `doc/dev/balancing-telemetry.md` | ~40 new rows: all `CODEENSTEIN_CAPTURE_*` (12), `_CAMPAIGN_*` (8), the `MP_CAMPAIGN_` delta, and 14 others — every default read from the constant declarations. Plus a note that the server's ~25 vars are covered by its generated `--help`, and a section recording that only one variable in the codebase validates its input |
| F17 | S2 | `README.md` Status | Releases are git tags; `package.json`'s `0.0.0` is unused; nothing in the app reports a version |
| F19 | S2→S3 | `doc/dev/balancing-telemetry.md` | All six `balancing:budget` flags, and that `--help` is rejected |
| F22 | S3 | `doc/dev/multiplayer-deployment.md` §6 | Mapping table between `docker/.env`'s unprefixed names and the server's `CODEENSTEIN_MULTIPLAYER_*`, naming `docker-compose.yml` as where they meet |
| F23 | S3 | `README.md:54` | "packed or elite bosses" → "ordinary packs or Elite packs" — the last surviving instance |

### And one finding that only existed after measuring

**F28 was `UNVERIFIED`; it is now a fixed S1.** `README.md:179` claimed the WAD
catalog is "about 170 MB from three external hosts". Resolved by `HEAD`-ing the
four catalog URLs and measuring `public/wads/` on disk:

| | Measured |
|---|---|
| Hosts | **3** ✓ (`github.com`, `raw.githubusercontent.com`, `youfailit.net`) |
| Downloaded | **47.4 MB** (24.1 + 11.3 + 4.2 + 7.7) |
| On disk after extraction | **99 MB** |

"About 170 MB" is wrong on both readings. Corrected to "about 47 MB of
downloads … extracting to roughly 99 MB".

The lesson is worth more than the fix: `UNVERIFIED` was the right call at Phase 3
with the tools then in use, but two `curl -I` calls and a `du` settled it. **A
finding parked as unverifiable should be re-tested when the constraint that
parked it no longer applies.**

---

## F25 — answered, and it turned the finding inside out

**D3's answer: the coop overshoot is intentional, for now, to promote actual
cooperation in coop.**

That resolves the ambiguity in the direction where **the code was right and the
player-facing documentation was the loose part** — the opposite of where the
audit's instinct pointed. `ELITE_MEMBER_HP_CAP` bounds what the generator emits,
exactly as its comment says. `eliteScalingFor` is a separate axis layered above
it, and overshooting the solo-calibrated ceiling is the *mechanism*: an Elite
sized for one player is trivial for four, and an encounter anybody can solo is
not a coop encounter.

Documented in four places, because a reader can arrive at this contradiction
from any of them:

| Surface | What it now says |
|---|---|
| `decisions.md` → Enemy Scaling | The full rationale, plus an explicit **"do not fix this by clamping the product"** — naming this audit as the thing that flagged it, so the next person to spot it stops there |
| `game-design.md` | "no enemy is ever bigger than *one* player can actually kill", with coop named as the deliberate exception |
| `enemies.ts:53` docblock | "This bounds the generator, not the runtime, and coop deliberately exceeds it" |
| `multiplayerScaling.ts` | What the constants are *for*, which was the one thing the file never said |

**What stays open is narrower than the finding was.** The purpose is settled;
the numbers are not. `1 + 0.5n` rests on no measurement — no coop telemetry
campaign has run at anything near the 112,311-kill scale behind the
single-player cap — so it is a placeholder with a clear job, and every doc above
says so rather than implying it was tuned. That is a balance question waiting on
data, not a correctness one.

The lockstep constraint still holds and is recorded: enemy `maxHp` is simulation
state, so any change here moves with a build-version bump or not at all.

## Recorded as open work — 1

- **Unvalidated numeric env vars** (was F27) — one of ~60 validates. In `notes`.

`notes` was appended to and then had the answered F25 item removed once D3
landed; no pre-existing line was ever touched.

---

## Left alone deliberately — 2

| ID | Why |
|---|---|
| **F29** | Measurement claims in `history.md` / `decisions.md`. Raw capture data is gitignored and partly deleted. They are an evidence record, not a spec — append, never retro-edit. Unchanged, as planned |
| **F30** | CHANGELOG `## Unreleased`. **Spot-audited rather than skipped**: every claim checkable against code holds — `stage06` at 2 keys (confirmed by running `report:gate-budget`), the flamethrower's 3.5 → 2.5/6.5 change, the 4.6-tile median, `complexity 805 × 25 × 2 = 40,250`, and `525 = 350 × 1.5`. The rest are bot-telemetry figures with the same unverifiability as F29. No discrepancy found, so no edit — and per directive 5, no entry invented |

---

## Two surfaces this audit never saw

CI on PR #87 ran **20 checks**, but Phase 1 inventoried only two workflow files.
The rest come from GitHub-side configuration, not the repository:

- **9 × CodeQL `Analyze (…)` jobs + a `CodeQL` gate** — GitHub's default setup,
  configured in repo settings.
- **GitGuardian Security Checks** — a third-party app.

Neither is checked in, so no repository-scoped audit could have found them. If
the Phase 6 prevention work happens, the CI surface is **larger than
`.github/workflows/`** and the inventory should say so.

---

## Final disposition — all 30

| Outcome | Count | IDs |
|---|---|---|
| **Fixed** | **24** | Phase 5: F01-F10, F12-F14, F18, F21, F24 (16). Phase 7: F11, F15, F17, F19, F22, F23, F25, F28 (8) |
| **Retracted as invalid** | **3** | F16, F20, F26 |
| **Open work in `notes`** | **1** | F27 |
| **Left alone deliberately** | **2** | F29, F30 |

Two of the 24 carry a correction as well as a fix: **F19** was `MISSING` and is
really `INCOMPLETE` (half its flags were documented), and **F23** was half
invalid (the `"Bug"` instance was correct; only `README.md:54` was real).

**No finding remains deferred and no decision remains open.** F25's resolution
was the one that mattered most, and it went the way the audit did not expect:
the code was right, and the documentation around it was the loose part.
