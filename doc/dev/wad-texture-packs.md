# WAD Texture Packs

How this game sources textures from a DOOM WAD, exactly which lump names it looks for, and what a WAD has to contain to work as a texture pack for it.

The game's own art has no external asset files: every texture is procedurally generated at startup (`src/engine/textures.ts`). (The online catalog's WADs *are* real files, but they're third-party downloads fetched at build time into `public/wads/`, not authored assets — see [Licensing](#licensing).) Loading a WAD is purely an override — it swaps real composited wall/door textures and floor flats into the same slots. Nothing about gameplay, level layout, or replay determinism changes; texture choice is cosmetic and session-only (see [Architecture § Rendering](architecture.md#rendering)).

**This game reads textures out of a WAD. It does not read levels out of one.** There is no `LINEDEFS`/`SECTORS`/`THINGS`/`NODES` parsing anywhere in the codebase — levels are always generated from your source code. A WAD here is a skin, not a mapset.

> `src/wad/textureAllowlist.ts` is the source of truth for every name below. If this table and that file disagree, the file is right — and `npm run report:wad-stylesets` will tell you which.

## The slots

The game renders per-level **stylesets** (see [Design Decisions § Per-Level Stylesets](decisions.md#per-level-stylesets)). There are 20 slots in total:

- **15 structural slots** — `wall`, `floor`, `door` for each of the five stylesets. These are what make one level look different from the next.
- **5 gameplay-signal slots** — shared by every styleset, because their colour *is* their meaning. A pack that recolours these to taste will make the game harder to read, not prettier.

Each slot has an ordered candidate list. **The first name present in the WAD wins**; the rest are fallbacks for WADs that don't have the first choice. "Present" is a low bar on purpose — see [Failure behaviour](#failure-behaviour) for exactly when a candidate is skipped rather than used, which is narrower than you might expect.

### Structural slots (per styleset)

Wall and door names are composite textures (`TEXTURE1`/`TEXTURE2` entries). Floor names are flats.

| styleset | look | wall candidates | floor candidates | door candidates |
|---|---|---|---|---|
| `stone` | warm tan brick | `STONE2`, `STONE3`, `BROWN1`, `STONE`, `BROWNGRN` | `FLAT5_4`, `FLOOR7_2`, `FLOOR0_3`, `FLAT10` | `DOOR3`, `DOOR1`, `BIGDOOR4` |
| `rust` | oxide red, industrial | `METAL`, `BROWN96`, `BROWNPIP`, `SUPPORT3`, `METAL1` | `FLOOR0_1`, `FLAT5_2`, `FLOOR3_3`, `FLAT5_5` | `BIGDOOR1`, `BIGDOOR2`, `DOOR1` |
| `tech` | grey steel panelling | `STARTAN3`, `TEKWALL4`, `SUPPORT2`, `STARTAN1`, `TEKWALL1` | `FLOOR4_8`, `FLOOR0_6`, `FLAT14`, `FLOOR5_1` | `SPCDOOR1`, `BIGDOOR2`, `DOOR3` |
| `marble` | pale blue-grey stone | `MARBLE1`, `MARBLE2`, `GRAY4`, `GRAYTALL`, `GRAY1`, `GRAYBIG`, `MARBFACE` | `FLAT1`, `FLOOR1_1`, `CEIL3_5`, `FLAT18` | `BIGDOOR5`, `BIGDOOR6`, `DOOR3` |
| `techCool` | teal computer bank | `COMPBLUE`, `COMPTALL`, `SHAWN2`, `TEKGREN2`, `STARTAN2` | `CEIL5_1`, `FLOOR1_1`, `FLAT1`, `CEIL3_5` | `BIGDOOR2`, `DOOR3`, `DOOR1` |

`techCool` is reserved for bonus (`.h` header-file) levels and never appears on a normal one — its look is the "this is a restock arena, not a fight" signal.

### Gameplay-signal slots (shared by all stylesets)

| slot | what it marks | kind | candidates |
|---|---|---|---|
| `loreWall` | lore terminal you can interact with | composite | `COMPUTE2`, `COMPUTE1`, `COMPSTA2`, `COMPSTA1`, `SKINMET1` |
| `hazardFloor` | acid — damages you while you stand in it | flat | `NUKAGE3`, `NUKAGE2`, `NUKAGE1`, `FWATER1` |
| `teleporterFloor` | goto/label teleporter pad | flat | `GATE1`, `GATE2`, `GATE3`, `GATE4` |
| `spikeSafeFloor` | spike trap, currently retracted | flat | `FLOOR7_1`, `FLAT5_2`, `CEIL5_2` |
| `spikeActiveFloor` | spike trap, currently lethal | flat | `BLOOD1`, `BLOOD2`, `LAVA1` |

Two tile kinds deliberately have **no slot of their own** and cannot be re-skinned separately:

- **Secret walls** reuse the styleset's plain `wall` plus a very subtle tint. They are meant to be *findable*, not obvious — giving them their own texture would give every secret away on sight.
- **Switchboard branch doors** reuse `door` plus an amber wash, so "just push it" stays distinguishable from "needs a key you may not have".

## What the loader actually needs

Everything below is enforced by `src/wad/` and is where a hand-built pack most often fails.

### Required lumps

| lump | required for | notes |
|---|---|---|
| `PLAYPAL` | **everything** | Without it, nothing decodes at all. Only palette 0 (the first 768 bytes) is read — no damage-flash or radsuit palettes, and `COLORMAP` is never read. |
| `PNAMES` | wall/door slots **and `loreWall`** | `int32` count, then `char[8]` names. |
| `TEXTURE1` and/or `TEXTURE2` | wall/door slots **and `loreWall`** | Either alone is fine. On a name collision **`TEXTURE2` wins** — it's merged in second. |
| patch lumps | wall/door slots **and `loreWall`** | Looked up by name **anywhere in the directory** — `P_START`/`P_END` markers are *not* required, unlike flats. The first lump matching the name wins. |
| `F_START` … `F_END` | floor + the four flat signal slots | `F1_START`/`F1_END` is accepted as an alternate pairing, but **only the first pair found is used** — in a WAD carrying both, the `F1_` range is never scanned. `FF_START`/`FF_END`, the conventional PWAD flat marker pair, is **not** recognised at all and will resolve zero flats. A flat outside the recognised markers is invisible to the loader. |

Note that `loreWall` is a composite wall texture, so a WAD with no `PNAMES`/`TEXTUREx` loses lore-terminal walls along with walls and doors.

A texture-only resource pack with no `PLAYPAL` of its own cannot work standalone here — there's no "ride alongside an IWAD" mode; the loader takes exactly one buffer and never merges two.

### Format constraints

- **Magic must be `IWAD` or `PWAD`.** Anything else is a hard, reported failure.
- **Flats must be exactly 4096 bytes** (64×64, raw palette indices). A lump inside the flat markers with any other size is silently skipped as an unsupported variant — this is the single most common reason a floor slot doesn't fill.
- **Wall/door textures may be any size.** They are *not* resampled to 64×64; the renderer reads each bitmap's real dimensions at sample time, so a 128×128 `BIGDOOR2` works as-is.
- **Tall patches are not supported.** The cumulative-topdelta encoding used by patches taller than 254px isn't implemented. No stock Doom/Doom2 IWAD wall patch needs it; an unusual custom PWAD might.
- **Transparent pixels get filled, not preserved.** Areas of a composite texture no patch covers are opaque-filled with a flat base colour — that slot's own (`wall`, `floor` and `door` each have a different one per styleset), or, for the five signal slots, a shared constant belonging to no styleset. The renderer's hot path is alpha-free by design; there are no see-through walls.
- **Names are compared uppercased**, NUL-padded to 8 chars, as in the WAD spec.

### Failure behaviour

Nothing about a bad or partial WAD breaks the game:

- **Fatal** means a throw from the header, lump directory or `PLAYPAL` — bad magic, a directory offset that runs off the buffer. The previously active textures are left untouched and the error is reported in the sidebar status line. Nothing else is fatal.
- **A candidate is skipped, and the next name on that slot's list tried, only if decoding it *throws*** — e.g. a patch or flat whose `filepos` runs past the end of the file. This is narrower than "the texture looks wrong":
  - a patch index with no `PNAMES` entry, or a `PNAMES` name with no matching lump in the directory, is **silently skipped inside the composite**. You keep the first candidate, now with holes where that patch would have been — and those holes get opaque-filled. The next name on the list is never reached.
  - so a mis-wired `TEXTURE1` entry yields a flat-filled texture rather than a fallback to your second choice. If a slot renders as a slab of solid colour, suspect this rather than the allowlist.
- A slot with no match anywhere falls back silently to the procedural default.

### The fallback chain (structural slots only)

For a styleset's `wall`/`floor`/`door`, in order:

1. that styleset's own candidate list;
2. **every other styleset's list for the same slot**, in `stone → rust → tech → marble → techCool` order;
3. that styleset's procedural default.

Step 2 is deliberate. Resolving each styleset in isolation would let a sparse WAD leave one styleset fully WAD-textured and the next fully procedural, so the campaign visibly flips between real textures and programmer art from level to level — which reads as a bug. Borrowing degrades instead to "two stylesets look alike", which is merely less variety. The rationale is recorded in [Design Decisions § Per-Level Stylesets](decisions.md#per-level-stylesets).

The five signal slots have no cross-slot fallback — they either resolve from their own list or use the procedural default.

## Checking your pack

```bash
npm run report:wad-stylesets -- /path/to/your.wad
```

Every WAD in `public/wads/` (the online catalog, populated by `npm run fetch:online-wads`) is always reported on; paths you pass are *added* to that set rather than replacing it, which is usually what you want — it puts your pack side by side with known-good references. `CODEENSTEIN_EXTRA_WADS` takes a colon-separated list for the same purpose, handy for a local IWAD you always want folded in. A path that doesn't exist prints a `[SKIP]` line rather than being dropped silently.

It drives the game's own parser — not a name-presence check — and prints:

- **the resolution matrix**: which name each styleset's wall/floor/door actually won, per WAD;
- **`distinct across stylesets: n/5 walls, n/5 floors`** — the number that matters. `5/5` means every level look is genuinely different. Lower means the fallback chain had to borrow, so some stylesets will look alike;
- **`styleset variety`**: how often each styleset resolved a wall it actually owns rather than a borrowed one;
- **a per-candidate decode probe**: for every allowlisted name in all 20 lists — the 15 structural ones and the 5 shared signal ones — how many of the reported WADs it decodes in, probed independently of whether it won its slot. A name that never *wins* is fine (it may sit behind a first choice that's always present); a name that never *decodes anywhere* is dead weight.

Two more checks worth running when changing `textureAllowlist.ts`:

```bash
npm run verify:wad-parser     # pure Node, synthetic fixtures
npm run verify:wad-textures   # Playwright; needs a dev server (see testing.md)
```

`verify:wad-parser` covers a full match, the cross-styleset borrow, an allowlist miss, a missing `PLAYPAL`, a missing flat block, bad magic and truncation. It does *not* exercise the per-candidate corrupt-and-skip path — `buildTestWad` has no corrupt-lump option — nor the `TEXTURE2` merge; both are covered under Vitest in `src/wad/loadWad.test.ts` instead.

`verify:wad-textures` drives a real browser, which is the only instrument that can speak to appearance at all (`doc/dev/testing.md` § what the suite structurally cannot catch — the canvas mock draws nothing). Be precise about what it proves: it samples a **mean colour over a band of the frame**, then asserts that at least 3 distinct means appear across 8 sampled campaign levels, and that relaunching one level reproduces its mean exactly. That is a strong check for "the styleset reached the renderer and is stable", and a weak one for "these two frames are identical" — two visibly different frames sharing a mean would pass.

## Adding or changing a candidate name

1. Add it to the right list in `src/wad/textureAllowlist.ts`, positioned by preference — first entry is the one you actually want.
2. Run `npm run report:wad-stylesets` against every catalog WAD plus a real IWAD if you have one. **Presence of the name is not the bar; it must decode to real, fully-opaque pixels.**
3. Watch `distinct across stylesets` — a new name that makes two stylesets resolve the same texture is a regression in variety, even if every slot still fills.
4. `src/wad/textureAllowlist.test.ts` pins name shape (uppercase, ≤8 chars, no duplicates) and that each styleset keeps a distinct first-choice wall and floor.

Worked example: `marble` originally listed only `MARBLE*`/`GRAY1`/`GRAYBIG`/`MARBFACE`. Run against the five catalog WADs plus a local commercial Doom IWAD (via `CODEENSTEIN_EXTRA_WADS`), the report showed it resolving its own wall in just 4 of those 6 — the DOOM shareware IWAD and HACX ship no `MARBLE*` at all, so on those it borrowed `stone`'s `STONE2` and the two stylesets rendered identically. Adding `GRAY4`/`GRAYTALL` (present and decodable in all six) took it to 6/6 and `5/5` distinct walls everywhere. Your own numbers will differ with your WAD set; what matters is the ratio, not the count.

## Adding a whole new slot

Adding a new textured tile kind is mostly mechanical, and the WAD side is the small part:

1. `src/map/types.ts` — a new `Tile` value, if the tile kind is new.
2. `src/engine/textures.ts` — a new field on `StyleTextures` (varies per styleset) or `SignalTextures` (shared), a procedural default generator, and its base colour.
3. `src/wad/textureAllowlist.ts` — the candidate list; `src/wad/loadWad.ts` — resolve it into `styles` or `signals`.
4. `src/engine/raycaster.ts` — the wall-hit or floor-cast dispatch; `src/map/exportView.ts` — the matching branch, so the PNG map export stays honest.
5. `scripts/lib/wadSlotSummary.mjs` — add the slot to `STRUCTURAL_SLOTS`/`SIGNAL_SLOTS`. It mirrors those lists rather than importing them, and only the *styleset ids* are drift-guarded, so a forgotten slot here silently under-counts in the reports instead of failing.
6. `scripts/fixtures/buildTestWad.mjs` — a fixture lump, so `verify:wad-parser` covers it.

Consider first whether it needs a slot at all: secret walls and branch doors both get by on "shared texture + identifying tint overlay", which costs nothing and keeps a WAD-sourced pack correct for free.

## Licensing

If you're packaging a WAD for distribution with a fork, note that the online catalog's entries were each license-checked individually and one (HACX) is non-commercial-use-only — see the [Credits & Third-Party Licenses](../../README.md#credits--third-party-licenses) section of the main README.

`src/wad/onlineWadCatalog.ts`'s doc comment records the admission bar and two rejected candidates, both instructive for pack authors: **Blasphemer** is a Heretic-engine WAD whose lump names don't overlap Doom's at all (0 slots matched), and **OTEX** was rejected for lump-name incompatibility rather than for its missing `PLAYPAL` — the palette was worked around with a donor splice and it still resolved only a handful of walls and doors. Compatible *names* are what matter here, not merely being a valid WAD.
