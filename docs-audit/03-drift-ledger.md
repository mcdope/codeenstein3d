# Phase 3 — Drift Ledger

Every inventoried surface (Phase 1) diffed against the Phase 2 baseline.
Doc claims quoted verbatim, shortened where marked `…`.

**30 findings**: 5 × S0, 8 × S1, 7 × S2, 4 × S3, 3 × CODE-BUG-CANDIDATE,
3 × UNVERIFIED.

---

## Ledger

| ID | Doc path:line | Claim (verbatim, short) | Ground truth (path:line) | Type | Sev | Proposed fix |
|---|---|---|---|---|---|---|
| F01 | `index.html:335-337` | "The only network calls this app ever makes are the ones you opt into on the GitHub tab, to fetch the repo you asked for." | Also: signaling server + TURN relay (`multiplayer/signalingClient.ts`; enumerated in `doc/user/privacy.md:21,23,25`) and a same-origin fetch for online texture packs (`privacy.md:49`) | CONTRADICTORY | **S0** | Replace with privacy.md's own three-case enumeration |
| F02 | `README.md:51` | "Smart entrypoint detection — finds `main`, **highest complexity**, or any parsable file" | Picks the **least** complex file; `main.ts:2390-2392` says "This picks the least complex file, and it used to pick the most"; implemented `main.ts:2447-2455` | STALE | **S0** | "…finds `main`, else the least-complex scoring file, else any parsable file" |
| F03 | `README.md:112` | "High complexity = more health, pack spawns, or **a single elite boss** (2× HP, gold tint, 2× damage)" | Elite is a **pack** of `ceil(min(50c,2800)/350)` ≤ 8 members, each ≤ 350 base HP, only `index === 0` flagged (`enemies.ts:137-145,173`) | STALE | **S0** | "…or an Elite pack: 2× the room's HP budget, capped and split, led by a gold-tinted Elite dealing 2× damage" |
| F04 | `src/engine/weapons.ts:146-150` | Friday Hotfix is "a tight jet … enforced by a **hard 3.5-tile `maxRange`** … genuinely cannot reach past a couple of tiles" | Full damage to 2.5 tiles, decaying linearly to 0 at 6.5 (`weapons.ts:288-297`, same file) | STALE | **S0** | Restate as the 2.5→6.5 falloff; the per-entry comment at `:288` is already correct |
| F05 | `src/engine/multiplayerScaling.ts:20-21` | Elite MP HP "stacks with … `ELITE_HP_MULTIPLIER`'s own **base 4x**, which is already baked into `enemy.maxHp`" | `ELITE_HP_MULTIPLIER = 2` (`enemies.ts:51`), lowered 4→2 on 2026-07-30 per its own comment at `:33` | STALE | **S0** | "base 2x"; and note the multiplier now shapes the room budget, which is then capped and re-split |
| F06 | `README.md:193` | "There are **14 further** `npm run verify:*` scripts" | 16 `verify:*` keys (`package.json:20-53`) | STALE | S1 | 16 |
| F07 | `doc/dev/architecture.md:69` | "There are **14** `scripts/verify-*.mjs` scripts in total" | 16 files (`ls scripts/verify-*.mjs`) | STALE | S1 | 16 |
| F08 | `README.md:421` | "…dropped after resolving **0/10 and 4/10** slots respectively" | Same paragraph states the total is **20** (3 structural × 5 stylesets + 5 shared) | STALE | S1 | Re-express as `/20`, or state that the figures are from the 10-slot era |
| F09 | `doc/dev/adding-a-language.md:66` | "**Ten languages** have one; `bash` deliberately doesn't." | 10 refinement *exports* (`refinements.ts:37-305`) wired into **12 of 13** generic adapters — `javascriptLike` serves javascript/typescript/tsx (`languages.ts:33-35`) | INCOMPLETE | S1 | "Ten refinement bundles cover twelve of the thirteen generic adapters; `bash` deliberately has none" |
| F10 | `doc/dev/adding-a-language.md:77` | "Legitimate for a language with no exception construct (**Go, Rust, Bash**)" | Four, not three: "Go, Bash, Rust, **and plain C**" (`parser/types.ts:186-188`); `doc/user/level-design.md:50` states all four correctly | INCOMPLETE | S1 | Add plain C |
| F11 | `.github/workflows/verify.yml:56` | job name: "unit tests (Vitest, **100% coverage gate**)" | `lines 99.9 / statements 99.9 / functions 99.5 / branches 99.5` (`vitest.config.ts:104-109`), with `:94-103` explaining why it is not 100% | STALE | S1 | Rename to "unit tests (Vitest, coverage gate)" — `README.md:188` and `testing.md:67` already state the real numbers |
| F12 | `README.md:251` | "14 **Playwright** verify scripts in CI" | 14 verify scripts run in CI, but 4 need no browser (`verify.yml:50-53`) | INCOMPLETE | S1 | "14 verify scripts in CI, 10 of them Playwright-driven" |
| F13 | `src/map/generation/enemies.ts:168` | "`damageMultiplierFor` (`enemyAi.ts:220`)" | Function is `damageMultiplier`, declared `enemyAi.ts:219` | STALE | S1 | Correct the name; drop the line number |
| F14 | `index.html:316-318` | "…with the echo pistol, the Regex Shotgun, gdb …, ghidra …, and the SIGKILL Knife for melee." | 7 weapons — omits **Friday Hotfix** and **Toolchain** (`weapons.ts:166-310`) | MISSING | S2 | Add both, or say "and more you unlock" |
| F15 | *(no surface)* | — | **46 `CODEENSTEIN_*` env vars appear in no prose doc.** 16 are covered by `multiplayer-server.mjs --help`; **30 have no documentation of any kind**: `CODEENSTEIN_CAMPAIGN_*` (5), `CODEENSTEIN_CAPTURE_*` (10), `CODEENSTEIN_MP_CAMPAIGN_*` (8), plus `_PERF_HEADLESS`, `_REPLAY_SPEED`, `_REPLAY_TRACE`, `_TELEMETRY_DEV_PORT`, `_TRANSITION_NAV_DEADLINE_MS`, `_VITE_NO_WATCH` | MISSING | S2 | Add the capture/campaign families to `balancing-telemetry.md`'s existing env table |
| F16 | *(no surface)* | — | `CODEENSTEIN_DEV_URL` defaults to `:5173` in 7 sites but `:5183` in `verify-replay.mjs:93` and `verify-campaign-playthrough.mjs:95` | MISSING | S2 | Document the split in `testing.md`'s verify-script section |
| F17 | *(no surface)* | — | No `--version` anywhere; `package.json:4` is `0.0.0`; release identity is the tag `beta-6` only | MISSING | S2 | One line in `README.md` Status: releases are git tags, the package version is unused |
| F18 | *(no surface)* | — | **Adapter counts are stated nowhere.** Every surface counts "languages" (14 / 12); the real figures are 15 adapters, 13 generic (`registry.ts:23-27`, `languages.ts:32-46`) | MISSING | S2 | State both numbers once in `adding-a-language.md`, and define which one "language" means |
| F19 | *(no surface)* | — | `report-level-budget.mjs` has 6 flags (`:47-52`) documented nowhere, and **rejects `--help`** with `unknown argument: --help` | MISSING | S2 | Document the flags where `balancing:budget` is described |
| F20 | *(no surface)* | — | `verify:multiplayer-campaign` and `verify:event-log` are **not wired into CI**; nothing says which of the 16 CI runs | MISSING | S2 | Mark the two manual-only scripts in `testing.md` |
| F21 | `index.html:303` | "Function → Room + Enemy (**HP = complexity**)" | `HP_PER_COMPLEXITY = 25` (`enemies.ts:11`), and the pool is split across a pack | INCOMPLETE | S3 | "HP scales with complexity" — the card is deliberately simplified, so avoid a false equation |
| F22 | `docker/.env.example` ↔ `scripts/multiplayer-server.mjs` | Template uses `ALLOWED_ORIGIN`, `STATS_TOKEN`, `TURN_SECRET`, … | Server reads `CODEENSTEIN_MULTIPLAYER_*`; `docker-compose.yml:31-41` maps between them | TERMINOLOGY | S3 | One mapping table in `docker/README.md`; the indirection itself is sound |
| F23 | across surfaces | "elite boss" / "boss-tier Elite" / "Elite pack" / "gold-tinted Elite" / "Elite anchor" | One concept: `Enemy.elite` on the pack anchor (`enemies.ts:173`) | TERMINOLOGY | S3 | Canonical glossary in Phase 4 |
| F24 | `README.md:30` | "A function/method (**HP = `cyclomatic_complexity × 25`**)" | That is the room's *pool*, split across the pack; `README.md:111` says so 81 lines later | INCOMPLETE | S3 | Add "split across its pack" to the table cell |
| F25 | `src/map/generation/enemies.ts:53-68` | "**No enemy this generator produces may exceed this**, whatever the source file does" (`ELITE_MEMBER_HP_CAP = 350`, "525 on Hard") | Engine multiplies past it: `engine.ts:1209-1214` applies `eliteScalingFor(playerCount)` after the difficulty pass — 4 players on Hard gives `350 × 1.5 × 2.5 = 1313` | CODE-BUG-CANDIDATE | — | **Report only.** See `03b` |
| F26 | — | — | `CODEENSTEIN_DEV_URL`'s two different built-in defaults (see F16) | CODE-BUG-CANDIDATE | — | **Report only.** See `03b` |
| F27 | `multiplayer-server.mjs --help` | "Environment variables (all optional, **sane defaults otherwise**…)" | Only `CODEENSTEIN_TELEMETRY_SEED` validates (`run-balancing-telemetry.mjs:199-205`). `CODEENSTEIN_MULTIPLAYER_PORT=abc` yields `NaN`, silently | CODE-BUG-CANDIDATE | — | **Report only.** See `03b` |
| F28 | `README.md:179` | "about **170 MB** from **three external hosts**" | 5 catalog entries (`onlineWadCatalog.ts:46-86`); host set consistent with 3, but total size needs a network fetch | UNVERIFIED | — | Leave as-is |
| F29 | `doc/dev/history.md`, `decisions.md`, `balancing-telemetry.md` (measurement claims) | e.g. "1,332 Elites spawned and 2 died", "-25.3% route length" | Derived from capture runs whose raw NDJSON is gitignored and partly deleted | UNVERIFIED | — | Leave as-is; do not "improve" |
| F30 | `CHANGELOG.md:5-33` (`## Unreleased`, 21 entries) | Player-facing claims about behaviour changes | Not audited against git history in this phase | UNVERIFIED | — | Out of scope unless Phase 4 approves a CHANGELOG pass |

---

## Summary: counts by type × severity

| Type | S0 | S1 | S2 | S3 | n/a | Total |
|---|---|---|---|---|---|---|
| `STALE` | 4 | 5 | — | — | — | **9** |
| `CONTRADICTORY` | 1 | — | — | — | — | **1** |
| `INCOMPLETE` | — | 3 | — | 2 | — | **5** |
| `MISSING` | — | — | 7 | — | — | **7** |
| `TERMINOLOGY` | — | — | — | 2 | — | **2** |
| `PHANTOM` | — | — | — | — | — | **0** |
| `CODE-BUG-CANDIDATE` | — | — | — | — | 3 | **3** |
| `UNVERIFIED` | — | — | — | — | 3 | **3** |
| **Total** | **5** | **8** | **7** | **4** | **6** | **30** |

**No `PHANTOM` findings.** Every documented feature, flag, script, and mechanic
I checked exists in code. Nothing describes something that never was.

## Drift density by surface

| Surface | Findings | Size | Density | Note |
|---|---|---|---|---|
| `README.md` | **6** (F02, F03, F06, F08, F12, F24) | 423 lines | 1 per 71 lines | **Worst surface in the repo**, and it holds 2 of the 5 S0s |
| `index.html` (user copy) | 3 (F01, F14, F21) | 378 lines | 1 per 126 lines | Holds the remaining S0 |
| `doc/dev/adding-a-language.md` | 2 (F09, F10) | 138 lines | 1 per 69 lines | Highest *rate*, but both are S1 count/omission errors |
| `src/engine/weapons.ts` | 1 (F04) | 400 lines | — | Module header contradicts its own entry 140 lines below |
| `src/engine/multiplayerScaling.ts` | 1 (F05) | 48 lines | — | Stale constant |
| `src/map/generation/enemies.ts` | 1 (F13) + F25 | 326 lines | — | Stale symbol reference |
| `doc/dev/architecture.md` | 1 (F07) | 95 lines | — | Otherwise exemplary — its Feature Flags table is 100% accurate |
| `.github/workflows/verify.yml` | 1 (F11) | 450 lines | — | Job *name* only; the job itself is correct |

### Surfaces verified accurate — no findings

`doc/user/mechanics.md` (every constant checked: aggro 7.5, secrets cap 5,
drop odds 0.2/0.01/0.6, shotgun 7 pellets @ 0.85 s, pistol ~6.6/s, difficulty
table, Edge Case speed vs. sprint) · `doc/user/controls.md` (all 3 cheat codes
exact — `IDBEHOLD` appears only as a negative test case at
`engine.test.ts:2901`) · `doc/user/troubleshooting.md` (all 37 extensions and
the full shebang list) · `doc/user/level-design.md` (lore cap 6, spur cap 5,
depot cap 4, pillars 1-3, map cap 160, the four exception-less languages) ·
`doc/user/privacy.md` · `doc/dev/game-design.md` (describes the Elite pack
correctly) · `doc/dev/testing.md` (coverage numbers correct) ·
`doc/dev/architecture.md` Feature Flags table (all 8 flags correct) ·
`docker/README.md` · `docker/.env.example` ↔ `docker-compose.yml` mapping ·
`package.json`.

## Assessment: concentrated, not systemic

**The stated premise — that drift is widespread — is not what the evidence
shows.** Drift is sharply concentrated in two pockets:

1. **`README.md`.** Six findings including two S0s. It is the oldest-unchanged
   high-traffic surface (last substantive edit 2026-08-04, `5c36dc5`) and it
   carries four independently-maintained enumerations that must each be updated
   by hand — `adding-a-language.md:118-120` names all four and warns about
   exactly this. Two of its findings (F03, F08) are internally
   self-contradictory: the correct statement sits in the same file as the wrong
   one.

2. **In-code module headers that outlived a constant change.** F04, F05, F13.
   All three sit *next to* correct code, and in F04's case the correct comment
   is 140 lines below the wrong one in the same file. The pattern is a balance
   constant being retuned with the per-entry comment updated and the file-level
   docblock missed.

**The `doc/user/` set is in excellent condition** — 8 surfaces, 3 findings, all
in `index.html` rather than the Markdown, and every numeric claim I checked in
`mechanics.md`, `controls.md`, `troubleshooting.md` and `level-design.md`
matched code exactly. Several of these docs are *more* current than `README.md`
and were used as the corroborating source against it.

**Two structural observations:**

- **The S2 block (F15-F20) is a different problem from the S0/S1 block.** Those
  are not rotted docs; they are surfaces that were never written — 30 env vars,
  the adapter counts, the CI coverage split. No amount of doc *maintenance*
  would have produced them.
- **On the project invariants**: no doc anywhere asserts density invariance
  (Phase 2 §10.1 established the code does not enforce it either, so there is
  nothing to contradict); no doc contradicts determinism, replay/lockstep,
  no-new-runtime-deps, or language neutrality. **All five invariants survive the
  audit unviolated by documentation.** The nearest miss is F25, which is a code
  finding, not a doc one.
