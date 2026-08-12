# Phase 5 — Execution Report

Approved: **batches 1-4**, with **D1 = Option B** (inventory-scoped edits;
comment text and user-visible prose only, no executable code or markup
structure).

Executed in the plan's suggested order: **2 → 4 → 1 → 3**.

---

## Findings resolved — 16

| Batch | ID | Sev | Surface | What changed |
|---|---|---|---|---|
| 2 | F02 | **S0** | `README.md:51` | "highest complexity" → "the *least*-complex scoring file", with the reason appended so the rule is self-defending |
| 2 | F03 | **S0** | `README.md:30`, `:112` | "a single elite boss" / "a gold-tinted elite boss" → Elite **pack**: 2× room budget, capped, split across up to 8, led by a gold-tinted Elite at 2× damage |
| 2 | F24 | S3 | `README.md:30` | HP cell now says "split across its pack" |
| 2 | F06 | S1 | `README.md:193` | 14 → **16** `verify:*` scripts |
| 2 | F08 | S1 | `README.md:421` | "0/10 and 4/10" → "0 and 4 slots respectively, of the 10 the allowlist had at the time" |
| 2 | F12 | S1 | `README.md:251` | "14 Playwright verify scripts in CI" → "14 verify scripts in CI (10 of them Playwright-driven)" |
| 4 | F07 | S1 | `architecture.md:69` | 14 → **16** `scripts/verify-*.mjs` |
| 4 | F09 | S1 | `adding-a-language.md:66` | "Ten languages have one" → "Ten refinement bundles cover twelve of the thirteen generic adapters (`javascriptLike` serves JavaScript, TypeScript and TSX alike)" |
| 4 | F10 | S1 | `adding-a-language.md:77` | Exception-less languages: added **plain C** |
| 4 | F18 | S2 | `adding-a-language.md` §2 | New paragraph fixing 15 adapters / 14 languages, and why README says 14/12 |
| 1 | F01 | **S0** | `index.html:339-343` | Network-calls sentence replaced with the three real cases (GitHub, multiplayer signaling + relay, same-origin texture pack) plus "a local workspace never touches the network at all" |
| 1 | F14 | S2 | `index.html:317-319` | Weapon list rewritten to "three to start — four more to unlock", naming gdb, ghidra and Friday Hotfix |
| 1 | F21 | S3 | `index.html:305` | "HP = complexity" → "HP scales with complexity" |
| 3 | F04 | **S0** | `weapons.ts:146-151` | "hard 3.5-tile `maxRange` … cannot reach past a couple of tiles" → the 2.5→6.5 decay curve, pointing at the entry below for the measurement |
| 3 | F05 | **S0** | `multiplayerScaling.ts:19-25` | "base 4x" → "base 2x (lowered from 4x in 2026-07)", plus the corrected mechanism: the multiplier scales the room budget, which is capped and re-split, so what is multiplied is the capped member share |
| 3 | F13 | S1 | `enemies.ts:168` | `damageMultiplierFor` → `damageMultiplier`; bare line number dropped rather than corrected |

**All 5 S0 findings are resolved.** Also 6 of 8 S1, 3 of 7 S2, 2 of 4 S3.

### One scope note worth recording

**F03 had two sites, not one.** Phase 3 cited `README.md:112`; the same stale
"gold-tinted elite boss" claim also sat in the mapping table at `README.md:30`,
which Phase 4 had scheduled only for F24's HP clarification. Both were corrected
in the same edit. This is one finding with two instances, not a
misclassification, so the batch was not halted — but the ledger under-counted
the surface area, and Phase 6 should note that a single stale claim can appear in
more than one enumeration of the same file.

---

## Findings deferred — 14

| ID | Sev / Type | Why deferred |
|---|---|---|
| F11 | S1 | Batch 5 not approved — blocked on **Decision D2** (renaming the `verify.yml` job may break branch-protection required checks) |
| F15, F16, F17, F19, F20 | S2 | Batch 6 not selected. F17 additionally needs **Decision D4** |
| F22, F23 | S3 | Batch 7 not selected |
| F25, F26, F27 | CODE-BUG-CANDIDATE | Report-only by design. F25 needs **Decision D3** before any wording can be chosen |
| F28, F29, F30 | UNVERIFIED | Per directive 3: not guessed at, not deleted, not "improved" |

---

## Files changed — 7

```
 README.md                        | 14 +++++++-------
 doc/dev/adding-a-language.md     | 14 +++++++++++---
 doc/dev/architecture.md          |  2 +-
 index.html                       | 14 +++++++++-----
 src/engine/multiplayerScaling.ts | 10 +++++++---
 src/engine/weapons.ts            | 11 ++++++-----
 src/map/generation/enemies.ts    |  2 +-
 7 files changed, 42 insertions(+), 25 deletions(-)
```

**No CHANGELOG entry added.** Every edit corrects documentation about behaviour
that already shipped; nothing user-visible changed. Per directive 5 there was
nothing to record, and no entry was invented.

## Verification

| Check | Result |
|---|---|
| Every changed line in `src/**/*.ts` is a comment line | **Confirmed** by inspecting `git diff -U0` — 3 files, 20 lines, all inside `/** */` or `//` |
| No `id`/`class` in `index.html` changed | **Confirmed** — `diff` of all id/class attributes before vs. after is empty |
| No element, attribute, or markup structure changed in `index.html` | **Confirmed** — only `<li>`, `<span class="intro-mapping-*">` and `<strong>` appear in the diff, all pre-existing |
| `npm run typecheck` | **Pass**, exit 0 |
| `npx vitest run --dir src` | **Pass** — 120 files, 2 926 tests, 37.57 s (identical to the Phase 2 baseline) |
| Working tree | Only the 7 files above; no stray artifacts |

The D1 = Option B constraint held exactly: **no executable code, no identifier,
no markup structure was touched.**

---

## Residual risk

1. **F11 leaves a live contradiction in CI.** The job name still says "100%
   coverage gate" while `vitest.config.ts:104-109` enforces 99.9/99.9/99.5/99.5.
   `README.md:188` and `testing.md:67` state the real numbers, so a reader has
   two correct sources against one wrong one — but the wrong one is the label
   that appears on every PR.

2. **30 environment variables remain undocumented** (F15). This is the largest
   remaining gap by volume, and it is a *never-written* gap rather than rot, so
   it will not surface through any drift-detection mechanism Phase 6 proposes.

3. **F25 is still an open question about behaviour, not documentation.** Until
   D3 is answered, `game-design.md:23` and `CHANGELOG.md:5` continue to state a
   525 HP ceiling that multiplayer exceeds (1 313 at 4 players on Hard). Nothing
   was changed there, deliberately — the edit depends entirely on which reading
   of the cap is intended.

4. **F03's two-site discovery suggests the ledger may under-count instances
   generally.** Phase 3 located findings by claim, not by exhaustive
   grep-per-claim. Other corrected claims may have surviving duplicates in
   surfaces I did not re-scan after editing — most plausibly in `README.md`,
   which carries four independent enumerations of the same facts by design.

5. **`doc/dev/history.md` and `decisions.md` were not audited claim-by-claim**
   (F29). At 612 KB and 71 KB they are the two largest prose surfaces, and their
   measurement claims are unverifiable read-only. They were left entirely
   untouched, which is the right call, but it means "no findings" there reflects
   *not looked at in depth*, not *verified clean*.

6. **Batches 6 and 7 were planned against pre-edit text.** If they are approved
   later, the glossary work (F23) in particular should be re-checked against the
   corrected `README.md`, which now uses "Elite pack" — already the canonical
   term.

**STOP — Phase 5 complete. Awaiting `APPROVED`.**
