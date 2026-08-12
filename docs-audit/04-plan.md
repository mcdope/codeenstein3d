# Phase 4 — Remediation Plan

Ordered batch plan for the 30 Phase 3 findings. Nothing edited yet.

**24 findings proposed for fix** across 7 batches; **6 proposed as
explicitly not-fixed**. Three batches are blocked on a decision from you
(§Decisions) — all three because the fix touches a file that is arguably
source, not documentation.

---

## The scope question that gates three batches

Prime directive 2 says: *"Do not modify any source file in this task. Not one
line. Only files under the documentation surfaces identified in Phase 1."*

Phase 1 inventoried in-code docblocks (`I-01`…`I-12`) and user-facing strings
(`U-01`…`U-12`) **as documentation surfaces** — because that is what they are.
But they live inside `.ts` and `.html` files. The two clauses of directive 2
point in opposite directions here, and it is not my call to pick one.

**This is not academic: 3 of the 5 S0 findings (F01, F04, F05) live in those
files.** Under the strict reading, the majority of the actively-misleading
content found in this audit cannot be corrected.

See **Decision D1**. Batches 1, 3 and 5 do not start until it is answered.

---

## Batch plan

### Batch 1 — `index.html` user-facing copy *(blocked on D1)*

**Files:** `index.html`
**Resolves:** F01 (S0), F14 (S2), F21 (S3)

| Finding | Line | Exact edit intent |
|---|---|---|
| F01 | `339-340` | Replace the single sentence with the three cases `doc/user/privacy.md` already enumerates: GitHub fetches (opt-in), the multiplayer signaling server + optional TURN relay (only when hosting/joining), and the same-origin fetch for an online texture pack. Keep it to 2-3 sentences and keep the existing "Full privacy details" link. Do not restate privacy.md — summarise it without contradicting it |
| F14 | `317-318` | Add **Friday Hotfix** and **Toolchain** to the weapon list, or replace the enumeration with "the echo pistol, the Regex Shotgun and the SIGKILL Knife to start — four more to unlock". Prefer the second: it stays correct if the arsenal changes again |
| F21 | `305` | `Function→Room + Enemy (HP = complexity)` → `Function→Room + Enemy (HP scales with complexity)`. Deliberately *not* introducing `× 25` — this card is a simplification by design; the fix is to stop asserting a false equation, not to add precision it doesn't want |

**Constraint:** prose inside existing elements only. No element, id, class, or
attribute may change — `src/ui/introTour.ts` anchors on ids, and
`src/main.ts` queries this DOM.
**Verification:** `npm run typecheck`, `npx vitest run --dir src`. No test
asserts on this prose (checked), so the suite is a regression net, not a gate.

---

### Batch 2 — `README.md` *(unblocked, pure Markdown)*

**Files:** `README.md`
**Resolves:** F02 (S0), F03 (S0), F24 (S3), F06 (S1), F08 (S1), F12 (S1)

| Finding | Line | Exact edit intent |
|---|---|---|
| F02 | `51` | "finds `main`, highest complexity, or any parsable file" → "finds `main`, else the **least**-complex scoring file, else any parsable file". Add a half-clause on *why* (level 1 should not be the hardest map) — this is the finding most likely to be re-broken, and the rationale is what stops that |
| F03 | `112` | "or a single elite boss (2× HP, gold tint, 2× damage)" → "or an **Elite pack**: 2× the room's HP budget, capped and split across up to 8 members, led by a gold-tinted Elite dealing 2× damage". Mirror `doc/user/mechanics.md:16`'s wording rather than inventing a third phrasing |
| F24 | `30` | Append "— split across its pack" to the HP cell, so the table cell and `:111` agree without a reader having to reconcile them |
| F06 | `193` | "14 further" → "16 further" |
| F08 | `421` | Keep the historical figures; mark them as such: "…resolving 0 and 4 slots respectively **of the 10 the allowlist had at the time**". Do **not** re-measure — see Decision D5 |
| F12 | `251` | "14 Playwright verify scripts in CI" → "14 verify scripts in CI, 10 of them Playwright-driven" |

**Note:** F02 and F03 are the two highest-value single-line edits in the whole
plan. If you approve only one batch, approve this one.

---

### Batch 3 — stale in-code docblocks *(blocked on D1)*

**Files:** `src/engine/weapons.ts`, `src/engine/multiplayerScaling.ts`,
`src/map/generation/enemies.ts`
**Resolves:** F04 (S0), F05 (S0), F13 (S1)

| Finding | Line | Exact edit intent |
|---|---|---|
| F04 | `weapons.ts:146-150` | Replace the "hard 3.5-tile `maxRange` … cannot reach past a couple of tiles" clause with the current curve: full damage to 2.5 tiles, decaying to nothing at 6.5. Keep the "tight jet, narrower than the shotgun's cone" characterisation — that is still true (`spreadPx: 45` vs 70). Do not duplicate the rationale already at `:288-297`; point at it |
| F05 | `multiplayerScaling.ts:20-21` | "base 4x" → "base 2x". Also correct the mechanism in the same sentence: `ELITE_HP_MULTIPLIER` now scales the *room budget*, which is then capped at `ELITE_MAX_MEMBERS × ELITE_MEMBER_HP_CAP` and re-split, so what is baked into `enemy.maxHp` is the capped member share, not the raw multiplier |
| F13 | `enemies.ts:168` | `damageMultiplierFor` → `damageMultiplier`; **drop the `enemyAi.ts:220` line number entirely** rather than correcting it to 219 — a bare line reference is a guaranteed future finding |

**Hard constraint:** comment text only. Not one character outside a `//` or
`/* */`. No `v8 ignore` pragmas exist in these three files (checked), so no
coverage behaviour can shift.
**Verification:** `npm run typecheck`, then `npx vitest run --dir src`
(2 926 tests) — and inspect `git diff` to confirm every changed line is a
comment line before reporting the batch done.

---

### Batch 4 — `doc/dev/` counts and omissions *(unblocked, pure Markdown)*

**Files:** `doc/dev/architecture.md`, `doc/dev/adding-a-language.md`
**Resolves:** F07 (S1), F09 (S1), F10 (S1), F18 (S2)

| Finding | Line | Exact edit intent |
|---|---|---|
| F07 | `architecture.md:69` | "14 `scripts/verify-*.mjs` scripts in total" → "16" |
| F09 | `adding-a-language.md:66` | "Ten languages have one; `bash` deliberately doesn't." → "Ten refinement bundles cover twelve of the thirteen generic adapters (`javascriptLike` serves JavaScript, TypeScript and TSX); `bash` deliberately has none." |
| F10 | `adding-a-language.md:77` | "(Go, Rust, Bash)" → "(Go, Rust, Bash, and plain C)", matching `parser/types.ts:186-188` and `doc/user/level-design.md:50` |
| F18 | `adding-a-language.md`, after §2 | Add two sentences stating both counts and which is which: **15 adapters** (2 bespoke + 13 generic) against **14 languages** — TSX is its own adapter but not its own language, which is why the README's enumerations say 14/12 and `registry.ts` says 15/13. This is the definition the glossary below depends on |

---

### Batch 5 — CI job name *(blocked on D2)*

**Files:** `.github/workflows/verify.yml`
**Resolves:** F11 (S1)

Line `56`: `name: unit tests (Vitest, 100% coverage gate)` → `unit tests
(Vitest, coverage gate)`.

Deliberately **not** "99.9/99.5 coverage gate" — encoding thresholds in a job
name recreates the same drift the moment they move. `vitest.config.ts:104-109`
is the single source; `README.md:188` and `testing.md:67` already quote it
correctly and stay.

**Why this is blocked:** a GitHub Actions job *name* is what branch-protection
required-status-checks match on. Renaming it can silently un-block a protected
branch, or block it forever on a check name that no longer exists. I cannot see
your repository settings. See **Decision D2**.

---

### Batch 6 — missing documentation *(unblocked, pure Markdown; largest batch)*

**Files:** `doc/dev/balancing-telemetry.md`, `doc/dev/testing.md`, `README.md`
**Resolves:** F15 (S2), F16 (S2), F17 (S2), F19 (S2), F20 (S2)

| Finding | Target | Exact edit intent |
|---|---|---|
| F15 | `balancing-telemetry.md`, existing env-var table | Add the 30 undocumented variables: `CODEENSTEIN_CAPTURE_*` (10), `CODEENSTEIN_CAMPAIGN_*` (5), `CODEENSTEIN_MP_CAMPAIGN_*` (8), plus `_TELEMETRY_DEV_PORT`, `_REPLAY_SPEED`, `_REPLAY_TRACE`, `_PERF_HEADLESS`, `_TRANSITION_NAV_DEADLINE_MS`, `_VITE_NO_WATCH`. Name, default, and one line of purpose each — defaults exactly as Phase 2 §2.2 recorded them. Add one sentence noting the 16 `CODEENSTEIN_MULTIPLAYER_*` server variables are documented by `multiplayer-server.mjs --help`, which generates from live values and therefore cannot drift |
| F16 | `testing.md`, verify-scripts section | State that `CODEENSTEIN_DEV_URL` defaults to `:5173` for most scripts but `:5183` for `verify:replay` and `verify:campaign:playthrough`, and that the telemetry/perf harnesses start their own server on `:5199` instead. **Document the split as it is — do not present it as intentional** (see F26 in `03b`) |
| F17 | `README.md` Status section | One sentence: releases are git tags (`beta-1`…`beta-6`); `package.json`'s `version` is unused (`0.0.0`, `private: true`); nothing in the app reports a version. See **Decision D4** first |
| F19 | `balancing-telemetry.md`, where `balancing:budget` is described | Document `report-level-budget.mjs`'s six flags (`--dir`, `--difficulty`, `--all-difficulties`, `--json`, `--max-levels`, `--kill-rate`) and note it has no `--help` |
| F20 | `testing.md` | Mark `verify:multiplayer-campaign` and `verify:event-log` as manual-only — 14 of the 16 verify scripts run in CI |

**Sizing:** ~40 new table rows. This is the largest batch by volume and the
lowest by risk. It can be split (6a: F15+F19 env/CLI; 6b: F16+F20 testing.md;
6c: F17 README) if you want smaller units.

---

### Batch 7 — terminology *(unblocked, pure Markdown)*

**Files:** `docker/README.md`, plus the glossary applied across `README.md`,
`doc/user/mechanics.md`, `doc/dev/game-design.md`
**Resolves:** F22 (S3), F23 (S3)

| Finding | Edit intent |
|---|---|
| F22 | Add a short mapping table to `docker/README.md`: `ALLOWED_ORIGIN` → `CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN`, `STATS_TOKEN` → `…_STATS_TOKEN`, `TURN_SECRET` → `…_TURN_SECRET`, `TURN_URLS` → `…_TURN_URLS`, `TURN_TTL_SECONDS` → `…_TURN_TTL_SECONDS`, `SIGNALING_SUBNET` → `…_TRUSTED_PROXY_IPS`, noting `docker-compose.yml:31-41` is where the mapping lives. The indirection is sound; only its discoverability is the problem |
| F23 | Apply the glossary below. **Minimal-diff: change a term only where it is currently one of the non-canonical forms in a definitional sentence.** Do not sweep prose that merely reads naturally |

---

## Canonical glossary

One chosen term per concept, with the rationale. Only the first two derive from
`TERMINOLOGY` findings; the rest are recorded because Phase 2/3 found the same
concept named differently across surfaces and a Phase 5 editor needs a
tiebreaker.

| Concept | **Canonical term** | Rejected variants | Rationale |
|---|---|---|---|
| The encounter at complexity ≥ 40 | **Elite pack** | "elite boss", "a single elite boss", "boss-tier encounter" | It is a pack by construction (`enemies.ts:141-145`). "Boss" is precisely the wrong noun — the whole point of the 2026-08 change was that it stopped being one. Already used by `mechanics.md:16` and `game-design.md:23` |
| The one flagged member of that pack | **Elite** (or *the Elite anchor* where the distinction matters) | "the boss", "the elite boss" | `Enemy.elite` is true for exactly one member (`enemies.ts:173`). "Anchor" is the code's own word (`:165-166`) and should be used only when contrasting with the rest of the pack |
| The corridor-dwelling small enemy | **Edge Case** | "Bug", "bug enemy", "trash" | Matches `Enemy.edgeCase` and the in-game name. `doc/user/level-design.md:44` says "a weak 'Bug' enemy" — the one place to change |
| A parser adapter | **adapter** (count: **15**) | "language", "parser", "grammar" | An adapter is the registered unit (`registry.ts:23`); a *language* is the human-facing set (14); a *grammar* is the wasm. TSX is a separate adapter and not a separate language — that is the whole source of the 15/14 and 13/12 confusion |
| The container-side settings | **`docker/.env` names** vs **server env vars** | using either name for both | Two real namespaces bridged by `docker-compose.yml`. Neither is "the" name; always say which side you mean |
| The HP figure derived from complexity | **HP budget** (of a room), then **member HP** | "HP", "enemy HP" used for both | `complexity × 25` is a room-level pool that is then split; conflating the two is what produced F03 and F24 |

---

## Findings proposed as NOT fixed

| ID | Type | Why not |
|---|---|---|
| **F25** | CODE-BUG-CANDIDATE | MP elite scaling exceeds the documented HP ceiling. The doc is not clearly wrong — the ambiguity is real, and resolving it needs a decision on intent, then possibly a *code* change that would break MP lockstep and replays. **Blocked on Decision D3**; until then no wording can be chosen |
| **F26** | CODE-BUG-CANDIDATE | `CODEENSTEIN_DEV_URL`'s two defaults. Documenting it (F16) is in Batch 6; *fixing* it is a code change outside this audit's remit. Belongs in `notes` |
| **F27** | CODE-BUG-CANDIDATE | Unvalidated numeric env vars. The `--help` text is silent rather than wrong. Adding validation is a code change; adding a doc caveat would document a wart rather than fix it. Belongs in `notes` |
| **F28** | UNVERIFIED | `README.md:179` "about 170 MB from three external hosts". Confirming needs a live download of the WAD catalog. The host count is consistent with the code; the size is not checkable read-only. Per directive 3: do not guess, do not delete |
| **F29** | UNVERIFIED | Measurement claims in `history.md`, `decisions.md`, `balancing-telemetry.md` ("1,332 Elites spawned and 2 died", "-25.3% route length"). The raw capture NDJSON is gitignored and partly deleted. These are the repo's evidence record; per directive 3, leave them untouched. Rewriting them would destroy the only trace of work whose artifacts are gone |
| **F30** | UNVERIFIED | The 21 `## Unreleased` CHANGELOG entries. Auditing them against git history is a separate exercise, and directive 5's rule ("add entries only for user-visible facts you can verify from git history; never invent") argues for leaving existing entries alone rather than re-litigating them. **Recommend explicitly out of scope** |

**Additionally: no CHANGELOG entry is proposed for any batch.** Every fix in
this plan corrects documentation about behaviour that already shipped. Nothing
here is a user-visible change, so per directive 5 there is nothing to add.

---

## Decisions required from you

### D1 — Scope: may Phase 5 edit comments and user-facing strings inside `.ts` / `.html`? **(blocks Batches 1, 3, 5)**

The tension is set out at the top of this document. Three of five S0s are
affected.

- **Option A — strict.** Markdown, `LICENSE`, `notes` only. Batches 1, 3 and 5
  are dropped; **F01, F04, F05, F14, F21, F13, F11 stay broken** and carry into a
  follow-up task.
- **Option B — inventory-scoped (recommended).** Any Phase-1 inventoried
  documentation surface, under a hard rule: **comment text and user-visible
  prose only; not one character of executable code, markup structure, or
  identifier changes.** Enforced by inspecting `git diff` per batch and by
  running `npm run typecheck` + the 2 926-test suite before reporting done.

I recommend **B**, because directive 1 ("code is ground truth, docs are the
suspect") and directive 3 (every claim cites `path:line`) both treat in-code
docblocks as documentation throughout this audit — and because leaving a
docblock that contradicts the code two lines below it is the exact failure this
task exists to fix.

### D2 — CI job rename **(blocks Batch 5)**

Does `.github/workflows/verify.yml`'s job name `unit tests (Vitest, 100%
coverage gate)` appear in branch-protection required checks? If yes, renaming it
needs the protection rule updated in the same change, which I cannot do.
Options: (a) rename + you update protection, (b) leave the name and instead add
a comment above the job pointing at `vitest.config.ts` as the authority,
(c) leave entirely.

### D3 — F25: what does `ELITE_MEMBER_HP_CAP` mean? **(blocks nothing; determines a future doc edit)**

Is the 350/525 ceiling a statement about **generator output** (in which case the
code is right and `game-design.md:23` + `CHANGELOG.md:5` want a "single-player"
caveat), or about **what the player faces** (in which case the docs are right and
the multiplayer elite pass is a gameplay bug for `notes`)? Reminder from `03b`:
`multiplayerScaling.ts:29-34` calls its own constants "reasoned starting points,
not validated ones".

### D4 — F17: is the absence of a version *aspirational*?

Should the README simply record that releases are git tags (a doc edit, in Batch
6), or do you want a real `--version` / in-app build identifier (a backlog item
for `notes`, and the doc edit changes accordingly)? `vite.config.ts` already
defines `__BUILD_TIME__` / `__BUILD_REF__`, so the raw material exists.

### D5 — F08: the WAD slot figures

Confirm annotating "0/10 and 4/10" as historical (my proposal) rather than
re-measuring. Re-measuring would need Blasphemer and OTEX, which were dropped
from the catalog and are not fetched by `fetch-online-wads.mjs`, so the numbers
are not reproducible read-only.

---

## Suggested execution order

1. **Batch 2** (README S0/S1) — unblocked, highest value, 6 findings, pure Markdown
2. **Batch 4** (doc/dev counts) — unblocked, 4 findings, pure Markdown
3. **Batch 1** + **Batch 3** (index.html + in-code S0s) — on D1 = Option B
4. **Batch 7** (terminology) — unblocked, but runs after 1-4 so the glossary is applied to already-corrected text
5. **Batch 6** (missing docs) — unblocked, largest, lowest risk; last because it is additive and independent
6. **Batch 5** (CI job name) — on D2

Approve as `APPROVED batches 2,4` (unblocked-only), `APPROVED batches 1-4,6,7`
(with D1=B), or any subset.

**STOP — Phase 4 complete. Awaiting `APPROVED` + batch selection.**
