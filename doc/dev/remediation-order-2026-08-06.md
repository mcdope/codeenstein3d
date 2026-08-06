# Remediation order — 2026-08-06

The 2026-08-06 multi-repository sweep (`balance-review-2026-08-04.md`, Part II)
left a pile of confirmed defects across the bot, the harness and the balance.
They are **not independent**: several invalidate the measurements the others
need, so the order matters more than the grouping.

This is a *sequence over the existing backlog*, not a new backlog. Every item
still lives in `notes`; nothing here duplicates its detail. Pick items up from
`notes`, use this file to decide **when**.

## The three constraints that fix the order

1. **Bot fixes precede any balance re-measurement.** §14 of the review shows
   every Elite lethality number on record is contaminated by bot policy — the
   bot knife-traded Elites, and fixing its positioning moved engagement distance
   ninefold. Re-tuning enemy HP before the bot is right means tuning against a
   broken instrument.
2. **Measurement-integrity fixes precede everything.** A capture that routes
   against the wrong map, or selects levels on 41×-inflated numbers, produces
   confident nonsense. These are the cheapest items on the list and they gate
   the trustworthiness of every number produced after them.
3. **`defaultHighscore.ts` is regenerated exactly once, at the end.** Any change
   folded into `SIMULATION_BALANCE` alters the balance hash and invalidates
   replays (see the flamethrower item's own note). Regenerating between stages
   just means doing a ~35-minute run several times.

## The order

### Stage A — measurement integrity

Cheap, no measurement needed to validate, unblocks trusting anything after.

- **Entrypoint/planner disagreement** (`notes`: "The browser and the route
  planner can disagree about which file is level 1"). The grid-equality check
  already exists in `scripts/diagnose-level-wedge.mjs` as of `baac849`; this
  item is promoting it into the capture pre-flight so a mismatch *refuses to
  start* rather than being discovered 58 runs later.
- **`stage-campaign.mjs` selects on staged-order metadata** (review §16.3). Its
  min-clear-ratio must-include is currently chosen against a number observed to
  be 41× off.

**Exit criterion:** a deliberately mis-staged campaign (put a zero-complexity
file at slot 1) is rejected by the pre-flight instead of producing runs.

### Stage B — bot correctness

All of these change bot behaviour, so they invalidate every existing baseline.
Land them **together**, then re-measure once.

- **Loot treadmill** (`notes`: "Bot stalls and oscillates", re-scoped). The
  largest single defect found: 87% of distance walked on a wedged level is loot
  detouring. Includes the tile-centre/pickup-radius half, which is near-trivial
  and worth doing even alone.
- **ghidra against big targets** (`notes`: its own item). Note its stated
  ceiling — it buys correct weapon choice, not a dead Elite.
- **Decide whether to enable the standoff.** `STANDOFF_MIN_TARGET_HP` shipped
  inert in `f31918c`. Arm 2 showed it works mechanically and does not move
  lethality; enabling it is a judgement call about whether the bot should
  *represent* a competent player, not a fix on its own.

**Exit criterion:** serilog completes at a rate comparable to sinatra's 88%, and
curl runs without excluding `.sh`.

### Stage C — re-measure

Re-run the sweep. This is the first set of numbers not contaminated by Stage B's
defects, and it is what Stage D is tuned against.

Worth folding in while re-running, both from review §16's follow-ups:
- capture `normal` alongside `hard` — currently **zero** `normal` data exists
  for any real repository, and lanes idle ~50% of a run anyway;
- re-solve every capture in staged order before deriving anything from solver
  metadata.

### Stage D — balance

Only meaningful once C exists.

- **Elite HP clamp** (`notes`: the Elite item). Its justification was rewritten
  on 2026-08-06 — the "arithmetic impossibility" framing is withdrawn, and the
  case now rests on the controlled comparison (3,300 HP kills 0/156, 25,050 HP
  kills 47/47 at a matched crowd).
- **Flamethrower reach/falloff** (`notes`: its own item).
- **Write the attrition item.** Review §16.7: regular and Edge Case enemies deal
  75–100% of all damage taken in every repository and have no backlog entry,
  while the one archetype that does have one accounts for at most a quarter.
  This replaces the refuted "level size is the real outlier" bullet.

### Last — regenerate `defaultHighscore.ts`

After every simulation change above has landed, and not before.

## Independent of all of it

- **`fetch-online-wads.mjs` should degrade rather than fail the build.** No
  measurement impact, no ordering constraint — do it whenever.
- **Lane parallelism idles** (`notes`). A throughput fix, not a correctness one;
  it makes Stage C cheaper if done first, but nothing depends on it.

## What this sequence deliberately does not assume

That the balance is wrong. Stage C may show that once the bot stops
knife-trading Elites and stops walking 14,000 tiles for loot, the remaining
lethality is defensible — in which case Stage D shrinks to the clamp's
killability argument alone. The sweep's own negative result (§11: nothing the
solver computes orders Elite lethality) is unresolved either way, and encounter
geometry remains the only surviving explanation.
