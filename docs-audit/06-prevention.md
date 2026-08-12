# Phase 6 — Drift Prevention Proposal

Read-only. Nothing implemented.

Every proposal is scored against **the 30 findings this audit actually
produced**, not against plausibility. A mechanism that would have caught
nothing is listed as catching nothing.

Constraint honoured throughout: **no new runtime dependencies**. Every proposal
below runs on `vitest`, `node`, or nothing — all already present as
devDependencies.

---

## The finding that should drive this

**This project already built the exact mechanism, for the exact failure class,
and it already works.**

`scripts/lib/constantMirrors.test.mjs` exists because a mirrored constant
drifted silently:

> "`ROCKET_TRAVEL_SPEED` was 5, mirroring `PROJECTILE_SPEED` — the *enemy
> bolt's* speed — while being used to model the flight time of the player's own
> ghidra rocket, which travels at 18. The bot was out by 3.6x for however long
> that stood, and nothing in the build could notice, because **a mirror with no
> link is exactly as correct as whoever last typed it.**"

That last sentence is the whole of this audit's diagnosis. A documented constant
is a mirror with no link. F04 (`3.5` tiles), F05 (`4x`), F06/F07 (`14` scripts),
F09 (`Ten`), F12 (`14 Playwright`), F11 (`100%`) are all the same defect the
`ROCKET_TRAVEL_SPEED` test was written to stop — just mirrored into prose
instead of into `combatPolicy.mjs`.

The mechanics are already solved too: that file imports real `.ts` modules from
a `.mjs` test through Vite's transform, runs in CI via `vitest run`, and is
excluded from the `src/` coverage denominator so it costs nothing against the
gate.

**So the top recommendation is not to build something new. It is to point the
existing mechanism at documentation.**

---

## Ranked proposals

| # | Proposal | Findings it would have caught | Cost | Verdict |
|---|---|---|---|---|
| **P1** | Doc-pin tests (extend `constantMirrors` to prose) | **7** — F06, F07, F09, F11, F12, F18, + F03's numbers | ~1 test file | **Do this first** |
| **P2** | Generate the CLI/config reference from code | **3** — F15, F16, F19 (all S2, all *never-written*) | 1 script + CI diff check | **Do this second** |
| **P3** | A "retuning a constant" checklist | **3 of 5 S0s** — F03, F04, F05 | Editorial, zero tooling | **Do this** — highest S0 yield anywhere |
| **P4** | De-duplicate README's four enumerations | F03 (2 sites), F06/F07, F09/F18 | Editorial | Do, alongside P1 |
| **P5** | `AGENTS.md` at repo root | **0 directly** | ~1 page | Do — changes priors, not a detector |
| **P6** | Symbol/line-reference resolver check | **1** — F13 | ~40 lines | Optional |
| **P7** | Doc-tested examples | **0** | Moderate | **Don't** — see below |

---

### P1 — Doc-pin tests *(highest cost/benefit)*

A `scripts/lib/docPins.test.mjs`, built on `constantMirrors.test.mjs`'s exact
pattern: import the real module, compute the truth, assert the doc says it.

Shape, per pin:

```
read doc file → assert it contains the value derived from code
```

Concrete pins the audit justifies:

| Pin | Truth source | Docs asserted |
|---|---|---|
| `verify:*` script count | `package.json` scripts + `ls scripts/verify-*.mjs` | `README.md`, `architecture.md` |
| verify scripts *in CI*, and how many need a browser | `.github/workflows/verify.yml` | `README.md` |
| adapter count / generic count / language count | `registry.ts`, `languages.ts` | `adding-a-language.md`, `README.md` |
| refinement coverage (10 bundles → 12 of 13 adapters) | `refinements.ts`, `languages.ts` | `adding-a-language.md` |
| coverage thresholds | `vitest.config.ts` | `README.md`, `testing.md`, **and the CI job name** |
| Elite constants (40, 2×, 350, 8) | `enemies.ts` | `README.md`, `mechanics.md`, `game-design.md` |
| supported extension table | `registry.ts`'s built map | `troubleshooting.md` |
| feature-flag defaults | the 8 `*_ENABLED` constants | `architecture.md` |

**Why it is first.** It catches the most findings, it is the cheapest thing on
the list, and the repo has already accepted the pattern — including its
awkwardness (a `.mjs` test importing `.ts`). It needs no new dependency and adds
no coverage burden.

**Honest limits.** It catches numbers in *prose files*. It does **not** reliably
catch stale prose inside a `.ts` docblock (F04, F05) — asserting on comment text
is brittle and would fail on rewording. Those need P3, not P1. And a pin only
exists for a fact someone thought to pin, so it cannot catch the never-written
class (F15-F20) at all — that is P2's job.

**Failure mode to design around**: a pin that asserts a bare number (`"16"`)
will match incidentally elsewhere in a large file. Pins should assert on a
distinctive surrounding phrase, and should fail with the computed value in the
message so the fix is obvious.

---

### P2 — Generate the CLI/config reference from code

**The audit contains a controlled experiment for this.** Of the ~115
`CODEENSTEIN_*` variables:

- The 25 read by `multiplayer-server.mjs` are printed by its own `--help`,
  **generated from the live values at invocation time**. Zero findings against
  them, and Phase 2 §1.3 notes they *cannot* drift by construction.
- The other ~90 are documented by hand or not at all. **30 have no documentation
  of any kind** (F15), and the one hand-written default that diverged is
  `CODEENSTEIN_DEV_URL` (F16).

Same repo, same authors, same period — the generated surface stayed correct and
the hand-maintained one rotted.

**Proposal**: a `scripts/generate-config-reference.mjs` that walks the
`process.env.X ?? default` read sites and emits a Markdown table, committed to
`doc/dev/`, with a CI step running the generator and `git diff --exit-code`. The
same treatment fits the per-script flag tables (F19).

**Why second, not first**: extracting defaults from arbitrary
`Number(process.env.X ?? 8787)` expressions needs either a small AST pass
(`esbuild` is already a devDependency and can parse) or a discipline that read
sites follow one shape. That is real work, where P1 is an afternoon.

**Why it matters disproportionately**: it is the *only* proposal here that
addresses the never-written class. No drift detector can flag a doc that does
not exist; only generation produces one.

---

### P3 — A "retuning a balance constant" checklist

`doc/dev/` already has two touchpoint checklists — `adding-a-weapon.md` and
`adding-a-language.md` — and `adding-a-language.md:118-120` explicitly names the
four README enumerations that must be updated together. **There is no equivalent
for changing a constant**, which is exactly the operation that produced 3 of the
5 S0 findings.

F03, F04 and F05 share one shape: *a balance constant was retuned, the comment
next to it was updated, and the surfaces quoting it were missed.* In F04's case
the correct and incorrect statements are 140 lines apart in the same file.

Proposed `doc/dev/retuning-a-constant.md`, or a section in `decisions.md`:

1. `grep` the old value across `src/`, `scripts/`, `doc/`, `README.md`,
   `index.html` — **the file-level docblock of the module you just edited is the
   most-missed site.**
2. Check whether another module's docblock composes with it
   (`multiplayerScaling.ts` ← `ELITE_HP_MULTIPLIER`).
3. Check the four README enumerations.
4. Check `scripts/lib/combatPolicy.mjs`'s mirror — `constantMirrors.test.mjs`
   already fails loudly here, so this step is free.
5. Add a doc-pin (P1) for the constant if one does not exist.

**Zero tooling cost, highest S0 yield on this page.** Its weakness is equally
plain: it is discipline, and discipline is what failed. It is worth doing
because it is nearly free and because step 5 converts each application into
permanent automated coverage.

---

### P4 — De-duplicate rather than detect

`README.md` maintains four independent enumerations of the language set; F03
turned out to have **two** sites for one claim, one of which the ledger missed
until Phase 5. Prevention by removal beats prevention by detection: a fact stated
once cannot drift against itself.

Candidates: fold README's parser-details count into a link to
`adding-a-language.md`; let `doc/user/troubleshooting.md`'s extension table be
the single extension authority; have `index.html`'s privacy card *link* to
`privacy.md` rather than summarise it (which is precisely the F01 failure — a
summary contradicting the authority it links to, two lines below).

---

### P5 — `AGENTS.md` at the repo root

**Would have caught zero findings.** It is not a detector, and it should not be
sold as one. What it changes is where an agent starts.

Phase 1 recorded that `.claude/` has no tracked files, so an agent reading this
repo starts from `README.md` — which this audit found to be the single worst
surface, holding 2 of 5 S0s. That is the argument for `AGENTS.md`: not that it
prevents drift, but that it stops the drifted surface from being the first thing
read.

Contents worth stating, all established by Phases 2-3:

- **Code is ground truth; tests are ground truth; docs are the suspect.**
- The five invariants, stated as Phase 2 found them — including the two
  corrections this audit produced: **density invariance is not enforced anywhere
  in code** (§10.1), and **language neutrality holds at the contract level but
  not the capability level** (§6.3). An agent told these are guaranteed
  properties will reason wrongly.
- `generate()`'s stage order is the RNG draw order; reordering changes every map
  and every recorded replay (`mapGenerator.ts:16-19`).
- One runtime dependency. Adding a second is a decision, not a step.
- Where to look: `decisions.md` for *why*, `history.md` for *what it cost*,
  `notes` for *what's open* — the routing table `doc/dev/README.md` already has.
- **Counts to distrust**: adapters (15) ≠ languages (14). Say which you mean.

Root `AGENTS.md` rather than `docs/AGENTS.md`: the root is where agent harnesses
look, and this repo has no `docs/` directory (it is `doc/`).

---

### P6 — Symbol/line-reference resolver check *(optional)*

F13 cited `damageMultiplierFor (enemyAi.ts:220)`; the symbol was renamed and the
line had moved. A node script could extract `` `identifier` (`path:line`) ``
references from comments and assert the file exists, the symbol exists, and —
optionally — the line matches.

**One finding, S1.** Worth it only if bundled into P1's test file. The cheaper
half of the lesson is editorial and needs no tooling: **never write a line
number in a comment.** They are wrong by default; every edit above them
invalidates them silently.

---

### P7 — Doc-tested examples *(recommend against)*

The brief asks for this to be considered. Considered, and it does not fit.

**It would have caught none of the 30 findings.** This project's documentation is
explanatory prose — mappings, rationale, measured results — not API examples. The
few code blocks that exist are shell invocations (`npm run dev`, the `docker
compose` pair) that are already covered: CI runs the npm scripts directly, and
executing the docker examples would mean standing up containers in CI for a
manually-deployed backend.

Including it would add CI surface with no evidence of benefit. If the doc set
later grows API examples, revisit.

---

## Recommended sequence

1. **P5 `AGENTS.md`** — an hour, unblocks nothing but corrects the starting
   priors immediately, including this audit's two invariant corrections.
2. **P1 doc-pins** — one test file, catches 7 of 30 findings forever, reuses a
   pattern the repo has already accepted.
3. **P3 retuning checklist** — free, and its final step feeds P1.
4. **P4 de-duplication** — editorial, do it while the Phase 5 edits are fresh.
5. **P2 generated config reference** — the largest build, and the only thing
   that addresses the 30 undocumented variables.
6. **P6** — fold into P1 if convenient.

**Combined, P1-P4 would have caught 13 of the 30 findings and 3 of the 5 S0s,
and P2 addresses 3 more that no detector could reach.** That is 16 of 30. The
remainder are the unverifiable measurement claims (F28-F30) and the code-bug
candidates (F25-F27), neither of which is a documentation-process problem.

## What none of this fixes

- **F25's open question.** Whether `ELITE_MEMBER_HP_CAP` bounds generator output
  or what the player faces is a design decision. No mechanism resolves it.
- **Summaries that contradict their own authority** (F01). Automatable only in
  the degenerate case. P4's "link, don't summarise" is the real answer.
- **`history.md` and `decisions.md`.** 683 KB of claims whose evidence is
  gitignored and partly deleted. They are an evidence record, not a spec; they
  should be appended to and never retro-edited, and no check should be pointed at
  them.
- **The audit's own blind spot.** Phase 3 located findings by claim rather than
  by exhaustive grep-per-claim, which is how F03's second site survived to Phase
  5. A doc-pin (P1) asserting on *all* occurrences rather than the first would
  have closed that — worth building in from the start.

**STOP — Phase 6 complete.**
