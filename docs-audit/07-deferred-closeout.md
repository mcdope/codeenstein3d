# Phase 7 — Deferred Findings Closeout

All 14 findings deferred at Phase 5 are now disposed of. Two of the four blocking
decisions were resolved **by checking rather than by asking**, and the pass
retracted **four findings** as invalid — three of them because Phase 3 filed a
`MISSING` claim without reading the doc that already covered it.

Final state: **19 of 30 findings fixed, 5 retracted as invalid, 4 recorded as
open work, 2 left alone deliberately.**

---

## Decisions resolved by checking

| Decision | Question | Resolution |
|---|---|---|
| **D2** | Does branch protection reference the CI job name? | `gh api …/branches/master/protection` → **404 Branch not protected**; `…/rulesets` → **`[]`**. Nothing references it. Rename is safe, and F11 was never actually blocked |
| **D4** | Is the missing `--version` aspirational? | Treated as documentation, not a feature request: README now records that the tag *is* the release identity. Building a real `--version` remains available and is not implied by this edit |
| **D5** | Re-measure or annotate the WAD slot figures? | Annotated as historical (Batch 2, already shipped) |
| **D3** | What does `ELITE_MEMBER_HP_CAP` bound? | **Still yours.** Recorded in `notes` with both readings and the replay/lockstep constraint, rather than guessed at |

---

## Retractions — 5 findings were wrong

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

Four of five retractions share one cause: **Phase 3 located `MISSING` findings by
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

## Recorded as open work — 2

Appended to `notes`, which is where this repo keeps open items:

- **`ELITE_MEMBER_HP_CAP`'s meaning** (was F25) — both readings, the 1,313-HP
  arithmetic, and the explicit warning that enemy `maxHp` is lockstep simulation
  state, so changing it desyncs mixed-build sessions and invalidates every
  multiplayer replay carrying an Elite.
- **Unvalidated numeric env vars** (was F27) — one of ~60 validates.

`notes` was appended to, never rewritten; no existing line was touched.

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
| **Fixed** | **19** | F01-F15, F17-F19, F21-F24, F28 (see 05 for the first 16) |
| **Retracted as invalid** | **5** | F16, F20, F26, F23-partial, + F19's `MISSING` classification |
| **Open work in `notes`** | **2** | F25, F27 |
| **Left alone deliberately** | **2** | F29, F30 |

No finding remains deferred. One decision (**D3**) remains yours, and it is a
design question about behaviour, not about documentation.
