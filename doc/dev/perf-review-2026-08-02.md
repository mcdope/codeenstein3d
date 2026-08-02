# Performance review — 2026-08-02

Audit of the "does not hold 60fps" report on the reference machine (Ryzen 7 5800 / 64 GB / RTX 4060 Ti, Chrome 151, X11). **The audit was run on that exact machine** — this box is the reference machine, so every number below is on-target hardware, not an approximation of it.

**Result: reproduced on the first attempt, root-caused, and the cause is a single mechanism.**

Every per-frame **stroked or non-rectangular canvas draw** — `beginPath`/`moveTo`/`lineTo`/`arc` followed by `fill()`/`stroke()`, **and `strokeRect()`** — forces Chrome's GPU-process canvas rasteriser out of its batched quad path and into a coverage/stencil pass. On an accelerated 2D canvas that already carries the raycaster's ~2,600 quads plus a full-canvas `putImageData`, that pass misses the vsync deadline. The penalty is **fixed per frame and effectively all-or-nothing**: one path fill costs the same as sixty-four, and the frame affords exactly one `strokeRect`.

> **Correction (2026-08-02, during Phase 3).** This document originally scoped the mechanism to *non-rectangular* geometry and listed `strokeRect` under "examined and found fine", on the strength of a synthetic measurement. **That negative result was wrong**, and implementing the fix is what exposed it: converting all 26 path ops to pre-rendered sprites moved idle from 51.3 to 51.8fps — nothing — because the six `strokeRect`s left behind were carrying the same penalty on their own. A rect *outline* is not a rect. See §6 for the corrected entry and the in-situ numbers. The synthetic that cleared `strokeRect` drew it at integer coordinates with an integer line width; the game draws at fractional ones. Sub-pixel placement turned out not to be the trigger either (rounding every coordinate in situ changed nothing) — `strokeRect` is simply in the same class as a path stroke.

The game issues **26 path ops + 9 stroke ops per frame** standing still (minimap player triangle, minimap compass badge, compass needle, weapon viewmodel). Suppressing exactly those, changing nothing else, takes the live game from **45.5 fps / 86 dropped frames** to **59.7 fps / 2 dropped frames**.

JS is not the problem and never was: engine busy time is 6.1–6.5 ms p50 in every scenario, unchanged by the fix. This is a rendering cost, and it is CPU-side (GPU-process rasterisation), exactly as the brief predicted — but it is not pixel throughput. It is draw-call *shape*.

---

## 1. Headline numbers

Live game, demo campaign level 1 (88×88 map, 32 enemies, 6 mines), Chrome headed, maximised window, 60 Hz vsync. Two variants per scenario: as shipped, and with `path`+`stroke` canvas methods no-oped at the prototype (nothing else changed — same JS, same sim, same everything).

| scenario | variant | fps | p50 | p95 | p99 | worst | dropped | engine busy p50/p95/p99/max |
|---|---|---|---|---|---|---|---|---|
| idle | as shipped | **51.3** | 16.7 | 33.4 | 33.4 | 33.4 | **70 / 411** | 6.4 / 8.9 / 10.1 / 10.9 |
| idle | no path/stroke | **59.1** | 16.7 | 16.8 | 33.3 | 33.4 | **7 / 473** | 6.4 / 8.8 / 10.2 / 13.0 |
| combat (sustained fire) | as shipped | **48.8** | 16.7 | 33.4 | 33.4 | 33.5 | **90 / 391** | 5.9 / 8.7 / 10.3 / 11.9 |
| combat | no path/stroke | **59.4** | 16.7 | 16.8 | 33.3 | 33.4 | **5 / 475** | 6.5 / 9.2 / 10.7 / 11.7 |
| automap open (Tab) | as shipped | **44.3** | 16.7 | 33.4 | 33.4 | 33.5 | **126 / 354** | 6.2 / 8.8 / 10.3 / 10.8 |
| automap open | no path/stroke | **58.5** | 16.7 | 16.8 | 33.4 | 33.4 | **12 / 469** | 6.5 / 8.9 / 12.6 / 13.6 |

Separate runs of the idle scene landed between 43.2 and 51.3 fps as shipped; the variance is run-to-run, the effect is not. Across nine independent measurements the shipped build never exceeded 52 fps and the path-suppressed build never fell below 57.7 fps.

**The failure shape is not a long stall.** Worst frame is 33.4 ms in every cell — exactly two vsync intervals. The distribution is bimodal 16.7 / 33.4 with roughly one frame in three landing on the double. There is no GC spike, no long task, no outlier to hunt. That is why "average fps" reads as a soft 45–50 and why it feels like judder rather than a hitch.

### The isolating experiment

Same live game, same frame, `path`+`stroke` suppressed, then **one** `arc()` + `fill()` added back per frame, and separately **3,000** extra `fillRect`s added back per frame:

| cell | fps | p95 | dropped |
|---|---|---|---|
| as shipped | 46.2 | 33.4 | 83 / 278 |
| paths suppressed | **59.3** | 16.8 | **4 / 356** |
| paths suppressed **+ 1 arc fill** | **43.7** | 33.4 | **98 / 263** |
| paths suppressed + 200 fillRect | 57.8 | 16.8 | 13 / 348 |
| paths suppressed + 800 fillRect | 59.0 | 16.8 | 6 / 355 |
| paths suppressed **+ 3,000 fillRect** | **59.2** | 16.8 | **5 / 356** |

One arc fill per frame: **−15.6 fps**. Three thousand extra rect fills per frame: **−0.1 fps, i.e. free**.

This is the whole finding in two rows.

---

## 2. What one frame does

Phase 0 deliverable — the per-frame call map, with the measured per-frame call counts from the live idle scene in brackets.

```
frame()                                          engine.ts:2209   rAF entry, raw dt
└─ advance(dt)                                   engine.ts:2672
   ├─ simulate(dt)                               engine.ts:2265           [~0.10 ms total]
   │  ├─ input.pollGamepad() per player          engine.ts:2266
   │  ├─ replayRecorder.record(...)              engine.ts:2288   guarded, no alloc without a recorder
   │  ├─ handleMovement per player               engine.ts:2493
   │  ├─ markVisited / updateRoomDiscovery       engine.ts:3040/3077   O(r²)=121 tiles, O(enemies)
   │  ├─ collectKeys / collectLoot / doors       engine.ts:2497-2500
   │  ├─ updateEnemyAi(dt)                       engine.ts:2501
   │  │  └─ updateEnemies                        enemyAi.ts:97    per enemy: nearest-target scan,
   │  │     ├─ PathField.ensure                  pathField.ts:36    one shared BFS, reflood only on
   │  │     │                                                       player tile change / gridVersion
   │  │     ├─ hasLineOfSight (aggro only)       enemyAi.ts:237   ray-march, skipped once aggroed
   │  │     └─ chaseToward (5 candidate slides)  enemyAi.ts:427
   │  ├─ updateProjectiles / advanceRockets      engine.ts:2503-2504
   │  ├─ hazard / acid / trap damage             engine.ts:2505-2525
   │  ├─ updateViewmodel per player              engine.ts:2547
   │  ├─ updateFiring(dt)                        engine.ts:2551
   │  └─ updateBlood/Explosions/Particles        engine.ts:2558-2561
   └─ render() → renderNormalFrame()             engine.ts:2757
      ├─ renderScene(...)                        raycaster.ts:228         [~6.1 ms — all of busy]
      │  ├─ renderBackground(...)                raycaster.ts:389
      │  │  └─ PER PIXEL, 640×400 = 256,000 px:  raycaster.ts:423-477
      │  │     ceiling rows: 4 byte writes       raycaster.ts:427-430
      │  │     floor rows: 2×floor, grid[][],
      │  │       texture select, 2×floor uv,
      │  │       3 multiplies, 4 byte writes     raycaster.ts:445-473
      │  │     └─ ctx.putImageData(640×400)      raycaster.ts:479        [1 call, 1 MB upload]
      │  └─ PER COLUMN, x = 0..639:              raycaster.ts:261-376
      │     ├─ castWallRay (DDA)                 raycaster.ts:147
      │     ├─ ctx.drawImage(tex, 1px column)    raycaster.ts:309        [640 calls]
      │     ├─ ctx.fillRect (fog overlay)        raycaster.ts:320        [~640 calls]
      │     ├─ ctx.fillRect (secret/branch/lore) raycaster.ts:324-335
      │     └─ shadedTexel + 2× fillRect (AA)    raycaster.ts:344-375    [~1,280 calls,
      │                                                                   2 rgb() strings/column]
      ├─ renderWorldBillboards(camera, zBuffer)  engine.ts:3012
      │  └─ 11 collect*Billboards, spread into
      │     one array, sorted by depth           engine.ts:3013-3032
      │     └─ PER SPRITE: projectPoint          sprites.ts:94
      │        PER ENEMY: 1 fillRect per screen
      │          column of the sprite            sprites.ts:181-184
      │        + drawEnemyOverlay (HP bar,
      │          name fillText)                  sprites.ts:241
      ├─ findTargetUnderCrosshair                engine.ts:2766   ← re-projects EVERY enemy a
      │                                                             second time this frame
      ├─ renderBlood / traces / flames /
      │  explosions / particles                  engine.ts:2782-2787
      │  ├─ drawBulletTraces → ctx.stroke()      effects.ts:229-232   ⚠ PATH STROKE (per trace)
      │  ├─ flameJet → 21-pt polygon fill        effects.ts:292-303   ⚠ PATH FILL (2 per stream)
      │  └─ renderExplosions → 2× arc + fill     effects.ts:353-359   ⚠ PATH FILL (2 per explosion)
      ├─ drawWeapon(...)                         viewmodel.ts:70      ⚠ PATH FILL + stroke, every
      │                                                                 weapon, every frame
      ├─ renderMinimap(...)                      raycaster.ts:597
      │  ├─ cached wall layer drawImage          raycaster.ts:668   (F1 from the 2026-07 audit)
      │  ├─ ~40 marker fillRects                 raycaster.ts:687-772
      │  ├─ player triangle: beginPath…fill      raycaster.ts:783-788 ⚠ PATH FILL
      │  └─ compass badge: arc + fill + stroke   raycaster.ts:794-800 ⚠ PATH FILL + STROKE
      ├─ drawCompass(...)                        hud.ts:392
      │  └─ needle: translate/rotate/…/fill      hud.ts:408-418       ⚠ PATH FILL
      ├─ drawCrosshair                           hud.ts:24            fillRect only
      ├─ buildStats() + drawHud(stats)           engine.ts:4491 / hud.ts:433
      │                                                              [13 fillText, 8 ctx.font, 1 strokeRect]
      └─ handlers.onStats(stats)                 engine.ts:2895
```

Measured canvas call counts per frame:

| | idle | combat | automap open |
|---|---|---|---|
| `putImageData` | 1 | 1 | 1 |
| `drawImage` | 643 | 643 | 642 |
| `fillRect` | 1,961 | 2,017 | 2,102 |
| `fillText` | 13 | 13 | 10 |
| `stroke`/`strokeRect` | 9 | 9 | 3 |
| `save`/`restore`/`translate`/`rotate`/`clip` | 8 | 8 | 3 |
| **path ops** (`beginPath`/`moveTo`/`lineTo`/`arc`/`closePath`/`fill`/`rect`) | **26** | **34** | **8** |

The per-column hot path, from memory as the brief asked: `renderScene`'s `for (let x = 0; x < width; x++)` at `raycaster.ts:261` → `castWallRay` DDA → one `drawImage` 1-pixel column blit → one alpha `fillRect` fog overlay → two `shadedTexel` string-building AA `fillRect`s. 640 iterations, ~4 canvas calls each.

---

## 3. Pixel throughput accounting

The brief asked for this explicitly. **No hidden DPR multiplication exists.**

- Canvas backing store: **640 × 400 = 256,000 px**, set once at `main.ts:451-452` from `SCENE_WIDTH`/`SCENE_HEIGHT`. `devicePixelRatio` is never read anywhere in `src/` — verified by grep. The backing store is DPR-independent by construction.
- `devicePixelRatio` on this machine: **2**. Screen reported as 3072 × 1728 CSS (6144 × 3456 device; mutter fractional scaling to a 3840 × 2160 panel).
- CSS box at default maximised window: **2233.6 × 1395.5 CSS px** → **4467 × 2791 = 12.47 M device px** presented. That is a **48.7× area upscale** of the 640 × 400 backing store, performed by the compositor.
- **CPU-written pixels per frame: 256,000** — `renderBackground` writes every pixel of the `ImageData` every frame (1,024,000 byte writes: 128,000 ceiling px as a flat colour, 128,000 floor px with per-pixel texture sampling), then one full-canvas `putImageData`.
- GPU-side coverage per frame: ~640 textured 1-px column quads + ~1,960 rect fills, all within the 256,000-px target.

**The 48.7× compositor upscale is free.** Measured directly: sweeping the canvas CSS box from 640 × 400 (1.02 M device px) to 2233 × 1395 (12.47 M device px), interleaved forward and backward, moves fps by nothing — 46.0 / 46.6 / 44.1 / 44.9 / 43.7 / 43.7 going up, 47.6 / 46.0 / 45.6 / 45.5 / 44.0 / 43.2 coming back. Dropped frames stayed 61–83 out of ~220–237 in every cell. Browser *window* size is likewise irrelevant: 800×600 → 3072×1700 (1.4 → 19.8 M device px) gave 53.4 / 49.0 / 50.8 / 52.2 / 57.0 fps — if anything the biggest window did best.

---

## 4. Mechanism

Chrome's 2D canvas is GPU-accelerated. Draw calls are recorded into a Skia display list on the renderer main thread (this is what the engine's `busy` measures — **recording**, not rasterising), then shipped to the GPU process and replayed there.

Rect fills and image blits batch into a single quad stream. An anti-aliased **non-rectangular** path fill or stroke cannot: it needs a coverage pass, which forces the batch to flush and the render target to resolve. With ~2,600 pending quads plus a 1 MB `putImageData` upload already in the frame, that flush pushes the frame past the vsync deadline, and the next `requestAnimationFrame` slips a whole interval.

CDP trace of the live game, 8-second window, aggregated by thread:

| thread | busy over 8 s | notable |
|---|---|---|
| **CrGpuMain** | **7,973 ms / 8,000 ms — 99.7 % saturated** | `RasterDecoderImpl::DoEndRasterCHROMIUM` n=454, **mean 10.9 ms**, max 31.2 ms; `SkiaOutputSurfaceImplOnGpu::SwapBuffers` n=383 mean 4.9 ms |
| CrRendererMain | 3,367 ms — 42 % | `FireAnimationFrame` n=383 mean 7.59 ms (this is our JS) |
| Compositor | 205 ms — 2.6 % | idle |
| VizCompositorThread | 207 ms — 2.6 % | idle |
| ThreadPoolForegroundWorker | 164 ms — 2 % | `RasterTask` n=64 mean 0.30 ms |

The GPU process main thread is pegged; the renderer main thread and both compositor threads are idle. `DoEndRasterCHROMIUM` — replaying the canvas display list — is running at 10.9 ms mean against a 16.7 ms budget.

**Why `busy` shows nothing.** `FramePerfLogger` measures between `beginFrame()` and the `hud` mark (`perfDebug.ts:231-249`), i.e. the time to *record* canvas ops. The rasterisation happens afterwards, in another process. `busy` is 6.1–6.5 ms p50 in every scenario, shipped and fixed alike. The metric the harness is built around is structurally blind to this class of bug.

**Why headless shows nothing.** Same measurement, same scenarios, `headless: true`:

| scenario | variant | fps | p95 | dropped |
|---|---|---|---|---|
| idle | as shipped | 60.0 | 16.7 | **0 / 480** |
| combat | as shipped | 60.0 | 16.8 | **0 / 480** |
| automap open | as shipped | 60.0 | 16.8 | **0 / 480** |

Headless Chromium rasterises the canvas in software, where the path-flush penalty does not exist. Every cell is a flat 60 fps with zero dropped frames. **The 2026-07 audit's conclusion that Task 241 was "environmental" was a measurement artefact of exactly these two blind spots** — headless collection plus a busy-time-only A/B metric. Finding T241 should be reopened; the reported symptom (120 → ~30 fps, worse while shooting) matches this mechanism, and combat adds path ops (26 → 34/frame: bullet traces, explosion arcs, flame polygons).

---

## 5. Findings, ranked by measured gain per unit of risk

### P1 — Per-frame non-rectangular path geometry on the scene canvas
**Measured cost:** 45.5 → 59.7 fps idle; 48.8 → 59.4 combat; 44.3 → 58.5 automap. Eliminates 84 of 86, 85 of 90, and 114 of 126 dropped frames respectively. **Effectively the entire gap to 60 fps.**
**Effort:** M overall — but see the ordering note below, it cannot be done piecemeal.
**Determinism risk:** **none.** Every call site is render-side. No PRNG draw, no simulation state, no ordering. Replay hashes and lockstep are untouched by construction.

Call sites, all per frame:

| # | site | what | when |
|---|---|---|---|
| 1 | `raycaster.ts:783-788` | minimap player-marker triangle: `beginPath`/`moveTo`/2×`lineTo`/`closePath`/`fill` | always |
| 2 | `raycaster.ts:794-800` | minimap compass badge: `beginPath`/`arc`/`fill` + `stroke` | always |
| 3 | `hud.ts:408-418` | compass needle: `save`/`translate`/`rotate`/`beginPath`/3×`lineTo`/`closePath`/`fill` | always |
| 4 | `viewmodel.ts` (`drawKnife` 221-249, `drawChainsaw` 267-312, and the grip/flash paths every weapon shares — 418-427, 453-455, 476-504, 523-533) | weapon silhouette polygon fills + path strokes | always |
| 5 | `effects.ts:229-232` | `drawBulletTraces` — `beginPath`/`moveTo`/`lineTo`/`stroke` per live tracer | firing |
| 6 | `effects.ts:292-303` | `flameJet` — 21-point polygon fill, ×2 per flame stream | flamethrower |
| 7 | `effects.ts:353-359` | `renderExplosions` — 2 `arc`+`fill` per live explosion | rockets/mines |
| 8 | `automap.ts:121-123` | `beginPath`/`rect`/`clip` viewport clip | automap open |
| 9 | `automap.ts:239-244` | automap player triangle | automap open |

**Proposed fix, per site:** replace each with pre-rendered sprites blitted via `drawImage`, or with rect decomposition.
- Sites 1, 3, 9 (rotating triangles): build a small rotation atlas once per level — e.g. 64 pre-rendered orientations of the marker/needle into one offscreen canvas — and `drawImage` the nearest. 64 steps is 5.6° of quantisation on a ~10 px glyph; visually indistinguishable, and it removes the `rotate()` transform too.
- Site 2 (compass badge circle): static geometry, never changes. Pre-render once into an offscreen canvas, `drawImage` it.
- Site 4 (viewmodel): pre-render each weapon's silhouette per `(viewKind, flash)` into an offscreen canvas at level start; per frame `drawImage` it at the bob/recoil offset. Weapons whose recoil changes barrel *length* rather than just position (`drawPistol` barrelTop/barrelH) need either a handful of pre-rendered recoil steps or a static-part/rect-part split.
- Site 5 (tracers): a tracer is a thin quad between two points — pre-render a 1×N line sprite and blit it with a transform, or rasterise with a short run of `fillRect`s.
- Sites 6, 7 (flames, explosions): pre-render the flame silhouette and a radial-glow sprite; blit scaled. Explosion rings are already alpha-faded circles, which is exactly what a scaled sprite does well.
- Site 8 (`clip()`): the automap already computes `tileX0..tileX1`/`tileY0..tileY1` bounds (`automap.ts:133-136`) and clamps every marker draw. The clip is belt-and-braces; drop it in favour of explicit clamping on the few draws that need it.

**Ordering note, and it is the most important engineering constraint here:** the penalty is **per frame, not per call**, so **partial fixes buy approximately nothing**. Proved three ways — the synthetic sweep (1 triangle fill costs the same as 64: 51.3 vs 45.9 fps, with n=8 landing at 54.0, i.e. noise), the in-situ add-back (+1 arc → 43.7 fps), and the negative results in §6 (suppressing `text` alone, `stroke` alone, `path` alone, or `state` alone each moved the live game by ≤ 3.5 fps). **Ship this as one change that removes every per-frame path call, or expect to measure no gain at all.** Sites 5–7 are combat-only and 8–9 are automap-only, so they can follow in a second commit — but 1, 2, 3 and 4 all fire on every normal frame and must land together.

**Verification requirement for Phase 3:** the replacement must be re-measured with the same probe. A rotated `drawImage` produces a rotated quad, which *should* batch, but that is an expectation, not a measurement — confirm it before declaring the fix done.

#### Outcome — implemented 2026-08-02 (the four always-on sites)

Sites 1–4 shipped, plus every `strokeRect` on the always-on path once the retraction above came to light. New module `src/engine/pathSprites.ts`: `Glyph`s pre-render once into detached offscreen canvases (rotating ones into a 128-step atlas, so no live `rotate()` either), and `outlineRect()` replaces `strokeRect` with four `fillRect`s. Rotated-`drawImage` was avoided entirely in favour of the atlas, so the open question above never had to be answered.

Measured, same probe, same machine, 8s per cell:

| scenario | before | after | dropped before | dropped after |
|---|---|---|---|---|
| idle | 51.3 fps | **58.9** | 70 / 411 (17.0%) | **9 / 472 (1.9%)** |
| automap closed | 47.9 fps | **58.6** | 96 / 384 (25.0%) | **11 / 470 (2.3%)** |
| combat (sustained fire) | 48.8 fps | **56.3** | 90 / 391 (23.0%) | **29 / 451 (6.4%)** |
| automap open | 44.3 fps | **47.3** | 126 / 354 (35.6%) | 102 / 379 (26.9%) |

The internal control is the strong evidence: in both always-on scenarios the "suppress path/stroke" cell is now **indistinguishable from as-shipped** (58.9 vs 59.1; 58.6 vs 58.5) — there is nothing left in that class to remove. Engine busy time is unchanged throughout (6.2–6.6ms p50), as expected for a change that touches no JS cost.

The two scenarios still short of 60 are short by exactly the sites deferred out of this commit: combat retains 1 path op (site 5, bullet-tracer `stroke()`) and its control cell reaches 58.6; the automap retains 8 (sites 8–9) and its control cell reaches 59.3.

**Visual delta**, measured rather than asserted — pre-rendered-sprite build vs the module's own direct-draw fallback (which is the pre-change drawing), screenshotted per weapon and pixel-diffed. Run-to-run noise floor is ~30% of pixels at max channel delta 10–12, so only the max matters: **guns max delta 41** (localised entirely to the compass badge's anti-aliased circle edge — a difference heatmap thresholded above the noise floor is black everywhere else, HUD and weapon included), **melee max delta 190**, which is the fully-baked knife/chainsaw glyph snapping to whole pixels. That snap is inherent to blitting a sprite at a fractional destination with `imageSmoothingEnabled = false`, and is a real if small trade-off: the melee weapon's thrust animation is now quantised to 1px steps. Mitigation if it ever reads as steppy: enable smoothing for those blits, or split the melee weapons the way the guns are split (live rects + baked paths). Not done, because it was not visible in play.

**Still stroked, deliberately not converted here** (all outside "always-on", and two of them pin `strokeRect` in existing tests that would have to change — reported rather than edited, per the audit's own rule):
- `hud.ts:86/117/147` — cheat / out-of-ammo / acid-overflow toasts, 1 `strokeRect` each, transient. One is affordable; the out-of-ammo and acid toasts can genuinely overlap, and two are not.
- `hud.ts:300` — lore overlay, modal.
- `sprites.ts:653` — weapon-drop pulsing ring; `sprites.ts:815` — teleporter pad ring. **These two are per-frame whenever such an entity is in view**, and are the `stroke: 1` still visible in the after-measurement's idle counters. Two visible teleporters would cost a frame. Converting them is a 2-line change plus updating the two `sprites.test.ts` cases that assert `strokeRect` was called once.

#### Outcome — sites 5–9 and the two rings, 2026-08-02

Everything above is now converted. `pathSprites.ts` gained two more primitives:

- `fillLine` — a straight line rasterised as one `fillRect` per pixel along its major axis, replacing `moveTo`/`lineTo`/`stroke` for bullet tracers. Steps whole pixels so the rects tile rather than overlap: tracers draw at partial alpha, and overlapping translucent squares band the line into darker blotches.
- `drawDisc` — an opaque disc sprite per colour, blitted scaled under `globalAlpha`, replacing `arc`+`fill` for explosion blast rings. Equivalent by construction for a solid fill; smoothing is enabled for that blit specifically, since the sprite is a smooth shape being scaled to an arbitrary radius.
- Flame jets became a scanline fill (one `fillRect` per row). The jet's silhouette is exactly one horizontal span per row — both edges are functions of the same `t` — so the shape is reproduced without a path at all, and sampling every row makes the taper *smoother* than the old 10-segments-per-edge polygon.
- The automap player marker joined the rotation-atlas glyphs; the two rings went to `outlineRect`.

| scenario | original | after sites 1–4 | after 5–9 | dropped now |
|---|---|---|---|---|
| idle | 51.3 fps | 58.9 | **58.6** | 9 / 470 |
| combat (sustained fire) | 48.8 fps | 56.3 | **59.1** | **7 / 474** |
| automap open | 44.3 fps | 47.3 | **59.0** | **8 / 473** |
| automap closed | 47.9 fps | 58.6 | **59.0** | 8 / 472 |

Every control cell ("suppress all path and stroke") is now within noise of as-shipped — 58.3 / 58.5 / 58.6 / 59.0 against 58.6 / 59.1 / 59.0 / 59.0 — i.e. there is nothing of this class left anywhere in the render path.

**New negative result: an axis-aligned rect `clip()` is free.** The automap keeps `beginPath`/`rect`/`clip` (2 ops in the `path` class) and measures 59.0 fps with it against 58.6 without. Skia takes a rectangular clip as a scissor, not a coverage mask. It was on the fix list as site 8 and does not need to be — the automap's whole deficit was its player-marker triangle. Non-rect clips were not tested and should not be assumed to share this.

**Correctness of the three rewritten primitives**, checked by rendering the real (dev-server-imported) implementation and the code it replaced onto identical canvases and diffing:

| primitive | differing pixels | max channel delta | mean |
|---|---|---|---|
| tracer line | 2,756 / 256,000 (1.08%) | 176 | 40.2 |
| explosion disc | 1,925 (0.75%) | 96 | 20.4 |
| flame jet | 989 (0.39%) | 137 | 15.8 |

In all three the differences sit on the shape's outline and the interiors match — these are aliased edges where the originals were anti-aliased, the same trade the glyph work already makes. The tracer is the most affected because a 2px line is nearly all edge.

**Tests changed, and why** (the audit's rule is "report, don't silently fix", so: six existing cases pinned the replaced primitive and were rewritten to assert the same intent against the new one, none weakened):
- `effects.test.ts` ×3 — tracer colour now asserted on `fillStyle` instead of `strokeStyle`, plus that the rasterised run covers both endpoints exactly once; the flame jet's "two layered jets" now asserted by the two colours reaching the canvas instead of two `fill()` calls.
- `sprites.test.ts` ×2 — the weapon-drop and teleporter rings now assert four `outlineRect` edge fills in the ring's own colour instead of one `strokeRect`.
- `automap.test.ts` ×1 — the player marker's facing now asserted on the rotation it is drawn at (across all four cardinal directions, which is stricter than the old two-comparison check) plus the glyph's tip lying on +X, instead of on hand-rotated vertex coordinates.

### P2 — The benchmark harness cannot see this class of bug
**Measured cost:** not a frame cost — a tooling gap that cost this project one wrong "environmental" conclusion (finding T241, 2026-07-18) and however long the symptom has been live since.
**Mechanism:** two independent blind spots. (a) `busy` measures display-list *recording*; rasterisation happens in the GPU process afterwards and is invisible to it. (b) `scripts/run-perf-benchmark.mjs` defaults to and recommends headless (`performance.md`: "Headed and headless busy medians match; prefer headless for unattended collection") — and headless uses software canvas raster, where the penalty does not exist at all. Both statements in that doc are true and both conclusions drawn from them were wrong.
**Proposed fix:** add a **presented-frame** metric alongside busy — dropped-frame count and the interval p95/p99 from the injected rAF sampler, which `scripts/lib/perfSampler.mjs` already collects but which the report treats as secondary to busy. Add a headed cell that is not optional. Update `doc/dev/performance.md`'s "prefer headless" guidance to "headless for JS-cost A/B only; headed is mandatory for anything touching draw-call shape."
**Effort:** M. **Risk:** none (scripts only).

### P3 — Add a regression guard for per-frame path calls
**Measured cost:** preventative.
**Mechanism:** this bug is invisible in code review, invisible in unit tests, invisible in the headless harness, and costs 25 % of the frame budget. It will come back the next time someone draws a circle.
**Proposed fix:** a dev-mode (`import.meta.env.DEV`) counter on the scene context that tallies `fill`/`stroke`/`arc`/`clip` calls per frame and warns above zero, plus a Vitest case that renders one frame against a mock context and asserts the count. Same shape as the existing `?perfDebug=1` gating, so it never ships in `dist/`.
**Effort:** S. **Risk:** none.

### P4 — Automap issues one `fillRect` per visible tile per frame
**Measured cost:** **not reproduced at scale — flagged, not proven.** On the demo level 1 the automap adds only ~140 fillRects over the idle scene (2,102 vs 1,961) because `map.visited` gates it and the player had explored little; at that size it is free (§6 shows 3,000 extra fillRects cost nothing). But `automap.ts:33` sets `CELL_PX = 3` and the loop at `automap.ts:138-182` is bounded by the viewport, not the map: a fully-explored map fills 205 × 106 ≈ **21,700 fillRects per frame**.
**Mechanism:** `drawAutomap`'s nested tile loop, exactly the shape that finding F1 fixed for the corner minimap in July and which was never applied to the automap.
**Proposed fix:** same as F1 — cache the static tile layer to an offscreen canvas keyed on `(map, gridVersion, visitedRevision)` and `drawImage` it, drawing only dynamic markers live. Needs a `visited` revision counter, since fog-of-war grows continuously.
**Effort:** M. **Risk:** none (render-side). **Do not do this before P1** — measure it after P1 lands, because at 3,000 free fillRects the honest prior is that this is *not* worth doing, and the 21,700 figure is extrapolated, not measured.

### P5 — `findTargetUnderCrosshair` re-projects every enemy a second time per frame
**Measured cost:** below the noise floor. `billboards+targeting` averages 0.082 ms/frame on the 32-enemy demo level.
**Mechanism:** `engine.ts:2766` calls `findTargetUnderCrosshair` → `findTargetAtColumn` → `projectLivingEnemies` (`sprites.ts:307`), allocating a fresh `{enemy, proj}` per living enemy — but `collectEnemyBillboards` (`sprites.ts:152`) already projected every one of them three lines earlier and threw the results away.
**Proposed fix:** have `renderWorldBillboards` return the enemy projections it already computed and pass them to `findTargetInProjections`. Pure dedup.
**Effort:** S. **Risk:** none — `findTargetInProjections` is already the shared primitive, and the projection inputs are identical within one frame.
**Recommendation: do not ship on perf grounds.** It measures under 3 % and would be reverted by the Phase 3 rule. Worth doing only as a readability change on its own merits.

### P6 — Per-frame allocation churn
**Measured cost:** **zero, on this machine.** Over an 8-second traced window there were **no main-thread GC events at all** — V8 GC appeared only on background threads, totalling 2.8 ms marking + 1.0 ms scavenge + 0.8 ms sweeping across 8 seconds. Heap held at 13–15 MB.
**Mechanism (for the record, since the churn is real):** `renderWorldBillboards` (`engine.ts:3013-3030`) spreads 11 arrays into one and sorts it, each `collect*Billboards` builds two or three intermediate arrays plus one closure per visible entity, `this.map.ammoPickups.filter(...)` allocates per frame, `sortedPlayerIds()` (`engine.ts:1252`) spreads-and-sorts on every one of its ~8 call sites per frame, `shadedTexel` (`raycaster.ts:126`) builds two `rgb()` strings per column (1,280/frame ≈ 77 k/s), and `projectPoint` returns a fresh object per particle per frame.
**Proposed fix:** none. This was already partially addressed as F7+F10 in July and the remainder was correctly judged Low then. It is still Low.
**Effort:** n/a. **Risk:** n/a. **Recommendation: no action.** Listed so the next audit does not re-derive it.

---

## 6. Examined and found fine — negative results

Each of these was a live hypothesis, measured, and refuted. They are worth as much as the findings.

- **Compositor upscale / responsive canvas scaling.** Refuted. Canvas CSS box 640×400 → 2233×1395 (1.02 → 12.47 M device px, 12× area), interleaved both directions: no effect on fps or dropped frames. `RESPONSIVE_CANVAS_SCALING_ENABLED` is not implicated. The July F-SCALE verification (done at 1920×1080) holds at 6K too.
- **Browser window size / total composited area.** Refuted. 800×600 → 3072×1700 (1.4 → 19.8 M device px): 53.4 / 49.0 / 50.8 / 52.2 / **57.0** fps. Non-monotonic; the largest window scored best.
- **devicePixelRatio double-rendering.** Not happening. `devicePixelRatio` is not referenced anywhere in `src/`; the backing store is a fixed 640×400.
- **Raw canvas draw-call throughput.** Refuted, decisively. A sweep from 0 to 5,120 draw calls per frame — uniform `fillRect`, 1-px `drawImage` column blits, `fillRect` with a fresh `fillStyle` string per call, and `fillRect` with a `globalAlpha` change per call — held **60.0 fps with 0–2 dropped frames in every single cell**, all four op classes. Chrome batches these fine. Confirmed in situ: +3,000 fillRects on the live game cost 0.1 fps.
- **`putImageData` and the CPU/GPU ping-pong.** Refuted as the driver. A factorial over {no work, CPU-only pixel work, 2,560 draw ops, `putImageData`, `putImageData` + 2,560 ops} × {640×400, 1280×800, 2240×1400 CSS} — **all fifteen cells held 60.0 fps** (worst: 59.3, 3 dropped). The `putImageData`-then-draw-on-top pattern is fine on its own. Suppressing `putImageData` alone on the live game moved fps 48.8 → 50.0.
- **Canvas context flags.** No meaningful help. `willReadFrequently: true` (software canvas) 56.0, `desynchronized: true` 54.2, `alpha: false` 54.8, offscreen-`putImageData`-then-`drawImage` indirection 52.4, against a 53.6–55.0 baseline. None of these is the answer; all are within run-to-run spread. Do not reach for them.
- ~~**`strokeRect`.** Free.~~ **RETRACTED — this was wrong, and it was the other half of the bug.** The synthetic said free (0 → 64 `strokeRect`s per frame on top of the bulk workload: 60.0 / 59.3 / 59.7 / 59.3 / 59.7 / 58.7 / 59.7 fps), and the caveat "confirm in situ during Phase 3" is what caught it. **In situ, `strokeRect` behaves exactly like a path stroke**: suppressing the six the game issued per frame took it from 47.0 to 58.8 fps, and replacing them with four `fillRect`s each gave 59.2 fps. The affordable budget is **one `strokeRect` per frame** (58.5 fps); **two breaks the frame** (47.3 fps). Sub-pixel placement is *not* the trigger — rounding every coordinate and the line width to whole pixels in situ moved nothing (47.5 fps against a 49.0 baseline). The synthetic was drawing at integer coordinates with an integer line width, which is not what the game does, but that difference turned out to be a red herring for the wrong reason: the correct reading is simply that a rect outline is stroked geometry, not rectangle geometry. **Lesson for the next audit: a negative result from a synthetic replica is worth less than it looks — the replica is defined by what you thought mattered.**
- **Text rendering / font switching.** Not the driver. 13 `fillText` + 8 `ctx.font` assignments per frame; suppressing `fillText`/`strokeText` alone moved the live game 48.8 → 48.4 fps (nothing), and additionally suppressing the `font` setter got to 49.0. Real but immaterial next to P1.
- **`save`/`restore`/`translate`/`rotate`/`clip`.** Not the driver alone: suppressing the whole state class moved 45.5 → 48.3 fps.
- **Page DOM, layout, and the console sidebar.** Not implicated. Hiding the console sidebar: 85 → 80 dropped. Hiding the left sidebar: 85 → 90. Hiding both: 85 → 83. Trace confirms it: forced style-and-layout totalled **107 ms across 8 seconds (1.3 %)**, max 3.3 ms; `Paint` 45 ms; `Commit` 292 ms. The July F8 finding (console-sidebar DOM mirroring is not a frame cost) still holds.
- **GC pressure.** Zero main-thread GC events in an 8-second traced window (see P6).
- **Simulation, AI, pathfinding, collision, firing.** All negligible and all correctly measured by the existing tooling: `sim` 0.096 ms/frame, `input-poll` 0.026, `input-actions` 0.009, `viewmodel` 0.005, `firing` 0.012, `billboards+targeting` 0.082, `particle-effects` 0.010, `hud` 0.136. The whole simulation is ~1.5 % of the frame budget. The July F2 result (pathField reflood is not a cost) is reconfirmed.
- **Netcode / multiplayer.** Not measured — single-player reproduces the symptom completely, so multiplayer cannot be the cause. Multiplayer inherits P1 unchanged (it renders through the same `renderNormalFrame`), and would additionally pay for teammate billboards, which are rect-only.
- **Engine frame cap (Task 79).** Not re-proposed. It was tried and reverted because gating every rAF tick added contention. The diagnosis here explains *why* that failed and why it could never have worked: the budget was being consumed in the GPU process, so skipping simulation ticks could not recover it. Not revisited.

---

## 7. Features currently disabled for frame-time reasons

### `PLAYER_STATS_ENABLED` (`playerStats.ts:29`) — **ship it on**
The doc comment claims "the ~20 individual recording call sites measurably slow real gameplay". **Not reproducible.** `?testHooks=1` gates the identical `telemetryEnabled` flag (`engine.ts:990`), so the feature can be A/B'd with no source change at all. Sustained-fire combat, telemetry OFF vs ON vs OFF:

| | fps | dropped | busy p50 | `sim` phase |
|---|---|---|---|---|
| headed, OFF | 46.4 | 109 / 371 | 6.3 | 0.096 ms |
| headed, **ON** | **46.5** | **108 / 373** | **6.3** | **0.093 ms** |
| headed, OFF | 44.5 | 123 / 356 | 6.2 | 0.097 ms |
| headless, OFF | 60.0 | 0 / 480 | 7.3 | 0.067 ms |
| headless, **ON** | **60.0** | **0 / 480** | **5.7** | **0.054 ms** |

The recording sites cost less than the run-to-run noise — the `sim` phase is 0.1 ms of a 16.7 ms budget either way. **Recommendation: flip `PLAYER_STATS_ENABLED` to `true`.** Caveats, stated rather than assumed: this measures the per-frame recording sites, which is what the doc comment blames; it does not measure the level-end derivation (already gated to the terminal frame, `engine.ts:4510`) or the DOM stats screen's own render. Both are one-shot, not per-frame. Recovered feature value: the level-end player stats screen, currently dead code in normal play.

### `DECORATIONS_ENABLED` (`map/generation/props.ts:16`) — **very likely shippable, one measurement short**
`drawDecoration` (`sprites.ts:713-770`) is **100 % `fillRect`** — 2 to 5 rects per prop, zero path geometry, so it is in the class this audit measured as free. In-situ proxy: adding 200 extra `fillRect`s per frame to the live game cost **57.8 vs 59.3 fps** (13 vs 4 dropped, within spread), and 3,000 extra cost nothing at all. Each decoration also adds one `projectPoint` allocation and one closure to the billboard sort.
**This is a proxy, not the feature.** I could not enable the real thing without a source edit, which Phase 2 forbids. **Recommendation: flip it on behind a measurement in Phase 3** — enable, run `report:wad-stylesets`-style level generation across the demo campaign to get real prop counts, then re-measure. The prior from the numbers above is that it is free.

---

## 8. Appendix — WebGL, costed not recommended

Out of scope by the brief (constraint 3) and unnecessary by the measurement. Recording as a costing only.

A WebGL2 renderer would make P1 moot by construction (no Skia, no coverage passes, everything is a quad in one draw call) and would collapse the floor cast into a fragment shader. It would also cost: a new renderer for walls/floor/sprites/HUD/minimap/automap/viewmodel/effects — every draw site in §2 — plus context-loss handling, a text-rendering solution (canvas 2D has one, WebGL does not), and a fallback path for machines where WebGL is blocked. Realistically L+ effort and a large surface for visual regressions, against a P1 fix measured at S–M effort that recovers the full 60 fps.

It also violates Dependency Minimalism in spirit even without adding a package: the "pure native Canvas 2D — no WebGL, no 3D libraries" line at `raycaster.ts:10` is a stated design property of this project, not an accident.

**Recommendation: do not.** Revisit only if a future feature (real sprite art, higher internal resolution, lighting) makes the 2D path genuinely insufficient — and then as its own project.

---

## 9. Reproducing this

The probes are throwaway Playwright scripts in the session scratchpad, not committed. Each is single-purpose and drives the user's own dev server on `:5173` read-only:

- `inspect-canvas.mjs` — DPR, backing store vs CSS box, one 6 s frame-timing sample
- `sweep-canvas-size.mjs` — canvas CSS size A/B, interleaved both directions
- `windowsize.mjs` — browser window size A/B, fresh browser per cell
- `controls.mjs` / `factorial.mjs` / `opcost.mjs` / `ctxmode.mjs` / `opsweep.mjs` / `pathcost.mjs` — synthetic isolation of op class, op count, context flags, and path-vs-rect cost
- `opclass.mjs` / `opclass2.mjs` / `scenarios.mjs` / `marginal.mjs` — live-game attribution by suppressing canvas method classes at the `CanvasRenderingContext2D` prototype
- `trace.mjs` — CDP `Tracing.start` over `devtools.timeline`/`cc`/`gpu`/`viz`, aggregated per thread
- `telemetry-cost.mjs` — `?testHooks=1` A/B for `PLAYER_STATS_ENABLED`

The technique worth keeping: **suppressing a class of canvas methods at the prototype, on the live game, and measuring dropped frames.** It attributes real frame cost to real call sites with no source change, and it is the only thing in this audit that found the answer. The synthetic replicas all failed to reproduce the bug — they were missing the path calls — which is itself the lesson: subtract from the real thing rather than rebuilding it.

If any of these are worth keeping, folding them into `scripts/run-perf-benchmark.mjs` as a headed presented-frame cell is P2 above.
