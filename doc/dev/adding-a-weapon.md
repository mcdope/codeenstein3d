# Adding a Weapon

A weapon is *data* — one entry in `WEAPONS` (`src/engine/weapons.ts`) — but roughly a dozen other places enumerate that table independently, and only a few of them are enforced by the compiler or a test. Skipping one doesn't break the build; it produces a weapon that fires silently, or draws a pistol, or that the playtest bot never picks up. Every previous addition (gdb, ghidra, Friday Hotfix, Toolchain) rediscovered this list by hand. This is that list.

For *why the arsenal is shaped the way it is* — four ammo pools, why Toolchain has no forced unlock, why fire cadence is a design axis — see [Game Design](game-design.md#weapon-and-economy-intent) and [Design Decisions](decisions.md). This document is the procedure, not the rationale.

## Three decisions before you touch anything

**1. Where in the `WEAPONS` array.** **Append.** A `WEAPONS` index is a persisted identity: `PlayerState.weaponIndex` and `ownedWeapons` are written into campaign saves, `EngineCarryover`, multiplayer wire state, and recorded replays. Inserting in the middle silently re-points every existing save and replay at a different gun. Appending is safe — the derived mappings below all extend cleanly.

**2. Ranged or melee.** The two are different code paths end to end, not a flag (see [Melee weapons are a different path](#melee-weapons-are-a-different-path) below). The discriminator is `meleeRange`: any weapon that sets it is structurally excluded from number keys, from `NUMBER_KEY_WEAPONS`, and from `updateFiring` entirely.

**3. Whether it needs a new ammo pool.** Reusing `"bullets"`/`"smg"`/`"rockets"`/`"gas"` is a small change. A *new* `AmmoType` is by far the largest part of this checklist (step 6) — roughly 15 files, several of which hand-write the four pools as four parallel fields rather than iterating `AMMO_TYPES`. Both of the last two ranged weapons brought their own pool, so this is the common case, not the exotic one.

---

## The checklist

### 1. Define the weapon in `WEAPONS`

`src/engine/weapons.ts` — append a `Weapon` literal. The interface's own doc comments describe each field; the ones with non-obvious consequences:

- `fireIntervalSec` — **every ranged weapon must define it**, enforced by `weapons.test.ts` ("rate-caps every ranged weapon, leaving only melee uncapped"). Without it the weapon's real rate of fire is whatever a mouse hand, an autoclicker, or a bot dispatching one keydown per tick can produce; that is exactly what turned the shotgun into an automatic weapon.
- `auto` — polls `isFireHeld()` every frame instead of `consumeFire()`'s once-per-press.
- `meleeRange` vs `maxRange` — both bound reach in `resolveShot` (`rangeLimit = weapon.meleeRange ?? weapon.maxRange`), but `meleeRange` additionally *makes the weapon melee* everywhere else. Don't reach for it to mean "short-ranged gun"; that's `maxRange` (only Friday Hotfix uses it).
- `fullDamageRange` — pairs with `maxRange` to make it a decay curve instead of a wall: full `damagePerPellet` out to here, falling linearly to zero at `maxRange` (`rangeDamageScale`). Without it `maxRange` stays all-or-nothing. **If you add one, mirror it into the bot** — `WEAPON_STATS` *and* `expectedDamagePerShot`, which multiplies by the same curve. Mirroring the number alone is worse than not mirroring at all: the old hard cutoff at least made the bot score zero out of reach, whereas an unmirrored curve has it scoring full damage at a range where the engine lands a fraction of it.
- `maxConeDeviationPx` — per-weapon override of the shared Cone-of-Fire falloff; omit unless you specifically want this weapon to stay accurate further out than the pistol curve allows.

**What breaks if skipped:** nothing else works; this is the source of truth everything below mirrors.

### 2. Index constant and membership arrays

Same file. Add `<NAME>_WEAPON_INDEX`, then decide membership:

- `STARTING_WEAPONS` — owned from the first frame of every run.
- `UNLOCKABLE_WEAPONS` — enters the ordinary per-kill 1% bonus roll, the Elite 60% bonus roll, secret-room weapon slots, *and* `main.ts`'s forced-unlock net. It is all-or-nothing; Toolchain is deliberately absent from it precisely so it gets the drop paths without the safety net (see the constant's doc comment and `TOOLCHAIN_MIN_LEVEL`).
- Neither — then it needs a bespoke acquisition path (step 5) or it is unobtainable.

**No edit needed** for `NUMBER_KEY_WEAPONS` (derived: `WEAPONS` filtered by `meleeRange === undefined`), `MELEE_WEAPON` (derived: first `meleeRange`-having entry), or the `IDKFA` cheat (iterates `WEAPONS.length`). These were all written to absorb a new entry automatically.

**What breaks if skipped:** a weapon that exists in the table and can never be obtained. Number keys are fine, but `canWieldViaNumberKey` also checks `ownedWeapons`, so an unearnable slot is simply dead.

### 3. `WeaponViewKind` — sound and silhouette

`viewKind` is reused as **both** the viewmodel identity and the sound identity. Reusing an existing kind is legitimate and costs nothing; a new kind costs two edits, one of which the compiler will *not* remind you about:

- `src/engine/viewmodel.ts` — `MUZZLE_GEOMETRY` is typed `Record<RangedViewKind, MuzzleGeometry>`, so **tsc fails** if you add a non-melee kind and forget it. `drawWeapon`'s own `switch`, however, ends in `case "pistol": default:` — a missing case silently draws a pistol.
- `src/engine/audio.ts` — `playShoot(kind: WeaponViewKind)` switches with **no `default`**, and the function returns `void`, so an unhandled kind is legal TypeScript that falls straight off the end. The weapon fires in complete silence, and nothing anywhere reports it.

**What breaks if skipped:** the two classic silent gaps — a weapon with no sound, or one wearing the pistol's model.

**How the silhouette must be drawn.** Rectangles go straight onto the context; **polygons, curves and outlines do not**. Every non-rectangular shape is a pre-rendered `Glyph` (`src/engine/pathSprites.ts`) blitted with `drawGlyph`, and every rect outline goes through `outlineRect` instead of `ctx.strokeRect`.

This is not style. A *single* `fill()` of a path anywhere in a frame costs ~10ms of frame budget on a GPU-accelerated canvas, because it drops the rasteriser out of its batched-quad path — and `drawWeapon` sets `ctx.lineJoin = "round"`, which puts plain `ctx.strokeRect` in the same class (one round-joined outline: 48fps; the same call under the default miter join: 59fps). Measured — `doc/dev/perf-review-2026-08-02.md`, finding P1. The trap is that **none of this is visible at the call site**: `ctx.strokeRect(…)` looks identical whether or not something upstream set the join, and nothing will flag a new weapon that costs a quarter of the frame budget.

Two further rules that follow from it:

- Shapes rigid relative to the gun's anchor (grips, blades, magazines) bake whole; anything whose *geometry* moves with recoil needs one glyph per quantised recoil step, as `flameNozzleGlyph` does.
- **A glyph pre-renders on a detached context that inherits nothing** — not `lineJoin`, not `lineCap`, not `imageSmoothingEnabled`. Any state your shape relies on has to be set inside the glyph's own `draw`. Getting this wrong is silent: the shape still draws, just with the wrong joins.

### 4. Firing behaviour in `engine.ts`

`fire()` and `updateFiring()` are written against `Weapon` fields, so an ordinary hitscan weapon needs **no engine edit at all**. Three places branch on something other than a plain field, and are worth checking against your weapon:

- `isRocket` → `fire()` spawns a real projectile via `rockets.ts` and returns early, skipping hitscan resolution entirely.
- `const isFlame = w.ammoType === "gas"` in `fire()` — the flame-stream visual and the burn effect passed to `damageEnemy` key off the **ammo type**, not `viewKind`. A new flame-like weapon on a different pool draws thin tracers instead.
- `forcedMelee` in `fire()` hand-writes the pools it considers "dry" (`bullets`/`smg`/`gas`; `rockets` is not in the list). It is telemetry-only (`killsForcedByMelee`), so getting it wrong misreports a statistic rather than changing play — but it is a hand-maintained pool list, so a new pool belongs in it.

**What breaks if skipped:** usually nothing. Check it, don't assume it.

### 5. How the player gets it

- `src/engine/lootApply.ts` — `grantOrTopUpWeapon` (grant, or top up ammo if already owned — note it only equips non-melee weapons), and `dropEliteLoot`/`rollMissChanceToolchain`, which is where Toolchain's non-`UNLOCKABLE_WEAPONS` paths live. A bespoke acquisition rule goes here.
- `src/main.ts` — `FORCED_UNLOCK_LEVELS` (the level-4/8/12 safety net; add a row only if the weapon should be guaranteed) and `computeMissingWeaponIndices`, which is what feeds secret-room weapon slots.
- `src/map/generation/secretRooms.ts` consumes that as `missingWeaponIndices`, an **opaque list of numbers**. This is deliberate and load-bearing: the map layer must never import engine weapon concepts (see [Architecture](architecture.md#why-difficultyts-and-prngts-live-at-src-root)). Keep it opaque — resist the urge to pass a `Weapon` or an index constant down there.
- Three scripts feed the generator that same list — `scripts/verify-campaign-playthrough.mjs`, `scripts/verify-demo-campaign.mjs`, `scripts/run-balancing-telemetry.mjs`. All three used to hardcode `[3, 4, 5]` and silently stopped exercising any weapon added after that; they now destructure the real `UNLOCKABLE_WEAPONS` out of `loadEngineModules()`, which bundles `src/engine/weapons.ts` for Node. **Nothing to update here** — but don't reintroduce a literal.

**What breaks if skipped:** the weapon never appears in a real run, and the verify/telemetry scripts keep reporting green about an arsenal that no longer matches the game.

### 6. A new ammo pool (skip if reusing one)

`AmmoType` is a four-member union that a lot of code enumerates by hand. In rough dependency order:

| file | what to add |
|---|---|
| `src/engine/weapons.ts` | the `AmmoType` union member |
| `src/engine/ammo.ts` | `AMMO_TYPES` (fixed iteration order — replay determinism depends on it not being `Object.keys`), `AMMO_META`, a `STARTING_*` reserve, `startingAmmo()` |
| `src/engine/loot.ts` | `LOOT_WEIGHTS`/`NORMAL_LOOT_WEIGHTS`/`BONUS_LOOT_WEIGHTS` rows, `*_DROP_AMOUNT` + `ELITE_*_DROP_AMOUNT`, and a `has<Weapon>` parameter on `rollLoot` so the pool is excluded from the roll until the weapon is owned |
| `src/map/types.ts` | `LootKind` and `AmmoPickup["kind"]` |
| `src/engine/sprites.ts` | `lootColors` — a `switch` over `LootDrop["kind"]` with a real return type, so **tsc catches this one** |
| `src/engine/hud.ts` | the `ammoType` if/else chain that picks the ammo label and value |
| `src/engine/scoring.ts` | `final<Pool>`/`starting<Pool>` on `ScoreInput`, the per-pool fraction, **and the `/ 4` divisor** in `ammoBonus` |
| `src/engine/engine.ts` | `EngineStats`' per-pool fields (hand-written, not `AmmoPools`) |
| `src/main.ts` | the campaign save shape, carryover, and the stats plumbing between them |
| `src/map/mapGenerator.ts` | a `has<Pool>` generation option, defaulted, threaded to `vendorDepots.ts` (and `pickups.ts`/`secretRooms.ts`/`exceptionZones.ts` if the pool should appear there) |
| `src/engine/reconciliationSnapshot.ts`, `src/multiplayer/multiplayerSessionHost.ts` | **nothing** — both now declare `ammo: AmmoPools` |

Those last two used to spell the shape out field by field as `{ bullets; rockets; smg; gas }`, and are worth understanding rather than just noting as fixed. They are populated by spreading a real `AmmoPools` (`ammo: { ...p.ammo }`), and a spread inside an object literal is **not** subject to TypeScript's excess-property check — verified directly, not assumed — so a fifth pool compiled clean against the old four-field type.

It would *not*, however, have been dropped on the wire: the producer spreads every property and the consumer applies them with `Object.assign(p.ammo, ps.ammo)`, with no field-by-field sanitizer in between, so the extra pool travelled fine at runtime. The defect was purely that the declared type stopped describing the value — every *typed* reader would have been blind to the new pool while the data was sitting right there. Both now say `AmmoPools`, so the type follows the pools automatically.

**What breaks if skipped:** partially — a pool that exists but never drops, or drops and never displays, or displays and is silently worth zero score. The compiler catches the `sprites.ts` case and nothing else here.

### 7. The playtest bot's mirror — the step everyone misses

`scripts/lib/combatPolicy.mjs` is a **hand-maintained plain-JS copy** of the weapon table. `src/` cannot import from `scripts/` and the module is deliberately kept liftable back into `src/engine/combatPolicy.ts` later, so this duplication is intentional — but it means nothing links the two, and nothing fails when they drift.

- `WEAPON_STATS` (ranged) / `MELEE_WEAPON_STATS` (melee) — the mirrored numbers.
- The `*_WEAPON_INDEX` constants and `STARTING_WEAPONS`.
- `NUMBER_KEY_WEAPONS` — here a **hardcoded literal**, not derived as it is in `weapons.ts`. `numberKeyCodeFor()` maps a weapon index to the `Digit<n>` the bot actually presses; get this wrong and the bot presses a key that equips something else.
- `AUTO_RANGED_WEAPON_INDICES` — mirrors `auto: true`.
- `hasAmmoFor()` — an explicit per-index chain of pool checks.
- `scripts/lib/profiles.mjs` — **each profile's `weaponPriority`**. `pickRangedWeapon`'s scoring loop iterates *that array*, so a weapon absent from it is never scored at all by that profile, regardless of how good it is. Membership is load-bearing; the order is only a tiebreak (the constant's own doc comment says so, because the reverse is the natural misreading).

**What breaks if skipped:** absolutely nothing visible. The bot simply never fires the weapon, `npm run balancing:telemetry` reports a balance picture for an arsenal the game doesn't have, and `npm run generate:default-highscore` bakes a leaderboard played without it.

### 8. Regenerate the default highscore

The whole `WEAPONS` table is folded into `SIMULATION_BALANCE` (`src/engine/engine.ts`) and therefore into every recorded run's `balanceHash` (`src/engine/balanceHash.ts`). **Any weapon addition — or any tuning change to an existing one — invalidates every replay recorded before it**, including the shipped `defaultHighscore.ts` board, which then refuses to play back.

Run `npm run generate:default-highscore` and review the diff. Note that this is a long, unattended job (it plays the demo campaign until three runs qualify per profile), and that `defaultHighscore.ts` also carries a `PROFILES_HASH` staleness guard checked by `scripts/lib/profiles.test.mjs` — so if step 7 changed a profile's `weaponPriority`, `vitest run` fails until this regeneration lands.

`SIMULATION_BALANCE` itself needs **no edit**: it holds `WEAPONS` wholesale rather than a list of individually-named weapon constants, precisely so a new weapon is in scope automatically.

**What breaks if skipped:** "Watch Replay" on the shipped board stops working, with a balance-mismatch message rather than a crash.

### 9. Tests

`src/engine/weapons.test.ts` holds the table's invariants and will fail on a mis-shaped entry:

- every non-`meleeRange` weapon defines a positive `fireIntervalSec`, and `MELEE_WEAPON.fireIntervalSec` is `undefined`;
- named index constants point at the weapon they claim to (assertion by `name` — add one for yours);
- `STARTING_WEAPONS` is exactly `[0, 1, 2]` and disjoint from `UNLOCKABLE_WEAPONS`;
- `UNLOCKABLE_WEAPONS` is asserted **by exact equality**, so adding a member requires updating that test deliberately rather than by accident;
- `NUMBER_KEY_WEAPONS` contains every non-melee weapon exactly once.

Also remember the coverage gate (99.9% lines/statements, [Testing](testing.md)). Both firing paths carry `/* v8 ignore next -- @preserve */` fallbacks documented as *"not reachable via current WEAPONS data"* — an `auto` weapon that omits `fireIntervalSec` makes them reachable, which changes what those annotations mean.

### 10. A new input (probably not needed)

The two existing bindings — number keys/mousewheel for ranged, `Space` for melee — cover any weapon that fits the two shapes above. Only if you add a genuinely new *action* does this apply: `InputSnapshot` (`src/engine/input.ts`) is what `replay.ts` records and replays frame by frame, and it is also the multiplayer wire format, so a new field additionally needs `src/multiplayer/inputValidation.ts` (and possibly a cap in `netcodeConstants.ts`, alongside `MAX_INPUT_KEYS`/`MAX_WHEEL_STEPS_PER_TICK`). A new *held key* goes in `RECORDED_KEYS` or it is not recorded at all.

One real ceiling worth knowing: `digitKeyIndex` (`input.ts`) matches `/^(?:Digit|Numpad)([1-9])$/`, so the number row tops out at nine ranged weapons.

**What breaks if skipped:** a new input that isn't in `InputSnapshot` is invisible to replay (runs diverge on playback) and to multiplayer (the action only happens on the peer that pressed it).

### 11. Docs

- `doc/user/mechanics.md` — the weapon table and the ammo-pool paragraph beneath it.
- `doc/user/controls.md` — only if it changes a binding.
- `doc/user/hud-and-ui.md`, `doc/user/tips.md` — if it changes the ammo readout or introduces a real tactic.
- `README.md` — the feature list, the "N weapons" line, the ammo-pool line, and the controls section all enumerate the arsenal.
- `CHANGELOG.md` — under `## Unreleased`, player-facing voice.
- [`game-design.md`](game-design.md#weapon-and-economy-intent) — if the weapon's *role* is new (a distinct combat identity, a new economy shape). [`decisions.md`](decisions.md) if you deliberately did **not** do something, and [`history.md`](history.md) if you measured an approach and reverted it — a reversal leaves no trace in the code, so it has to be written down.
- `notes` — close the open item, per the workflow in this doc set's [README](README.md).

---

## Melee weapons are a different path

`meleeRange` is not a modifier on the ranged path; it selects a different one. What actually differs:

| | ranged | melee |
|---|---|---|
| equipped via | number key / mousewheel, `NUMBER_KEY_WEAPONS` | never equipped — `canWieldViaNumberKey` rejects any `meleeRange`-having index |
| fired by | `updateFiring()`, gated on `weaponCooldown` | its own block in `simulate()`, gated on `meleeCooldown` — **bypasses `updateFiring` entirely** |
| which weapon | `WEAPONS[p.weaponIndex]` | `currentMeleeWeapon(ownedWeapons)` — the knife until Toolchain is owned, then Toolchain permanently. It *replaces* the knife on `Space` rather than adding a slot |
| input | `consumeFire()` / `isFireHeld()` | `consumeMelee()` (one-shot per press) or, for an `auto` melee weapon, `isMeleeHeld()` |
| `fireIntervalSec` | required | optional — the knife omits it, and `weapons.test.ts` asserts `MELEE_WEAPON.fireIntervalSec` is `undefined` |
| viewmodel | `weaponIndex`'s `viewKind`, drives `recoil` | a separate `meleeRecoil` overlay, so a swing can't stomp a ranged weapon's in-flight recoil animation |
| ammo | spends `ammoType`'s pool | `ammoType` omitted → infinite, and a duplicate pickup grants nothing |

Two consequences worth stating outright. Quick-melee is deliberately **always available** — it never touches `weaponCooldown`, so a player waiting out the shotgun's pump always has something to swing; that is the same safety-net role the knife plays for an empty ammo pool. And `Space` is not an arbitrary choice: melee was originally on Left-Ctrl, which combined with `W` spells the browser-reserved, unblockable `Ctrl+W` and closed the whole browser mid-swing.

A *third* melee weapon would need more than a table entry: `currentMeleeWeapon` hardcodes the two-way knife/Toolchain choice, and `MELEE_WEAPON` is defined as the first `meleeRange`-having entry in the array.

---

## Enforced vs. silent, at a glance

Worth internalising, because it predicts which mistakes you'll actually make:

**The compiler catches** — exactly two things: `MUZZLE_GEOMETRY` (a `Record` over a viewKind union, TS2741) and `lootColors` (a switch whose declared return type doesn't include `undefined`, TS2366). Both confirmed by direct experiment against this repo's `tsconfig.json`.

**Tests catch** — the `fireIntervalSec` invariant, `UNLOCKABLE_WEAPONS`' exact membership, `NUMBER_KEY_WEAPONS`' completeness, and (indirectly, via `PROFILES_HASH`) a bot-profile change without a highscore regeneration.

**Nothing catches** — `audio.ts`'s `playShoot` (a `void` switch with no `default`), `viewmodel.ts`'s `drawWeapon` default case, `loot.ts`'s weight tables, `hud.ts`'s ammo chain, `scoring.ts`'s `/ 4`, and the entire `combatPolicy.mjs`/`profiles.mjs` bot mirror. That last one is the whole reason this document exists. (The wire ammo shapes and the `[3, 4, 5]` literals in `scripts/` used to be in this list; both were fixed rather than documented, by reusing `AmmoPools` and the real `UNLOCKABLE_WEAPONS` respectively.)
