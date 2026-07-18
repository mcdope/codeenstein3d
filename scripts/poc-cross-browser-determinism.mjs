#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Research spike for `multiplayer-research.md`'s biggest open netcode risk:
 * "is cross-browser floating-point math bit-identical enough for lockstep?"
 * Lockstep only works if every peer's simulation, fed the same seed and the
 * same inputs, produces the exact same result — and this project's engine
 * leans on `Math.sin`/`Math.cos`/`Math.sqrt`/`Math.atan2`/`Math.hypot` plus
 * the seeded `mulberry32` PRNG throughout `player.ts`/`enemyAi.ts`/
 * `raycaster.ts`. IEEE-754 basic arithmetic (+-*\/) is bit-exact by spec
 * everywhere; the transcendental `Math.*` functions are NOT required to be
 * bit-identical across engines by spec. This script is the standalone check
 * for whether that theoretical risk is a real one in practice.
 *
 * Deliberately standalone: it does NOT import, bundle, or modify anything
 * under `src/` — `runDeterminismSimulation` below is a self-contained
 * function (no closures, so it round-trips cleanly through Playwright's
 * `page.evaluate`) that reproduces `mulberry32` verbatim from `src/prng.ts`
 * and a synthetic loop shaped like this engine's real hot paths (player
 * turn → direction vector, enemy steering via `Math.atan2` + `Math.cos`/
 * `Math.sin`, `Math.hypot` distance checks — see `src/engine/player.ts` and
 * `src/engine/enemyAi.ts`) without touching any real game code. Purely a
 * research spike — not wired into CI, not a `verify:*` script.
 *
 * Needs all three Playwright browser binaries installed locally:
 *   npx playwright install chromium firefox webkit
 *
 * Usage: node scripts/poc-cross-browser-determinism.mjs
 * Env overrides: POC_SEED, POC_ITERATIONS, POC_SAMPLE_EVERY
 */
import { createHash } from "node:crypto";
import { chromium, firefox, webkit } from "playwright";

const SEED = Number(process.env.POC_SEED ?? 0xc0ffee);
const ITERATIONS = Number(process.env.POC_ITERATIONS ?? 500_000);
// Only a sparse sample of the (heavy) loop's running state is shipped back
// out of each browser page — see the doc comment on `runDeterminismSimulation`
// for why sparse sampling of the *accumulating* state is still a rigorous
// check, not a weaker one.
const SAMPLE_EVERY = Number(process.env.POC_SAMPLE_EVERY ?? 500);

/**
 * Runs entirely standalone in whichever JS engine calls it (plain Node, or
 * serialized into a browser page via `page.evaluate` — hence: no closures,
 * no imports, a single array argument in, a plain array of numbers out).
 *
 * `iterations` is the actual workload size ("heavy" — hundreds of thousands
 * of trig/sqrt/hypot calls chained through mutating state, mirroring how a
 * real lockstep tick would chain many enemies' AI + the player's own turn
 * math frame after frame). Only every `sampleEvery`-th step's state gets
 * pushed into the returned array, plus the very last one — small transfer
 * size, but not a weaker test: once any engine's `Math.*` output disagrees
 * with another's by even one ULP, that disagreement lands in `facing`/`x`/
 * `y`, which every subsequent iteration keeps *accumulating from* — so a
 * divergence anywhere in the run shows up in every sample taken after it,
 * not just at the exact moment it happens. Sparse sampling only risks
 * missing a divergence that happens and then somehow un-happens, which
 * floating-point drift does not do.
 */
function runDeterminismSimulation([seed, iterations, sampleEvery]) {
  // Verbatim copy of `mulberry32` from src/prng.ts — duplicated here on
  // purpose (this PoC must not import or modify real game code), kept
  // byte-for-byte identical to that module's algorithm.
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rng = mulberry32(seed);
  const samples = [];

  // Player-turn-like state (src/engine/player.ts: Math.cos/Math.sin of an
  // accumulating turn angle).
  let facing = 0;
  // Enemy-position-like state (src/engine/enemyAi.ts: steer toward a target
  // via Math.atan2 for heading, Math.cos/Math.sin for the resulting step,
  // Math.hypot for distance-to-target checks).
  let x = 0;
  let y = 0;
  let targetX = rng() * 200 - 100;
  let targetY = rng() * 200 - 100;

  for (let i = 0; i < iterations; i++) {
    // Re-pick a roam target periodically — same shape as an idle enemy's
    // roam-target repick in enemyAi.ts.
    if (i % 97 === 0) {
      targetX = rng() * 200 - 100;
      targetY = rng() * 200 - 100;
    }

    // Player-turn-like: accumulate a turn delta, derive the facing vector.
    facing += (rng() - 0.5) * 0.1;
    const dirX = Math.cos(facing);
    const dirY = Math.sin(facing);

    // Raycasting-step-like: a march step whose length depends on the facing
    // vector's magnitude (always ~1, but computed via Math.sqrt like a real
    // per-ray distance calc) and a PRNG-jittered scale.
    const step = Math.sqrt(dirX * dirX + dirY * dirY) * (0.5 + rng() * 0.5);

    // Enemy-steering-like: heading toward the current roam target, then move.
    const heading = Math.atan2(targetY - y, targetX - x);
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    const distToTarget = Math.hypot(targetX - x, targetY - y);

    if (i % sampleEvery === 0 || i === iterations - 1) {
      samples.push(facing, x, y, distToTarget);
    }
  }

  return samples;
}

/** Bit-exact fingerprint of a plain-number array: builds a `Float64Array`
 * (so every value's raw IEEE-754 bytes are preserved exactly) and hashes
 * its underlying buffer. Deliberately done once, here, in Node — every
 * engine's result is hashed by this same code, so the comparison never
 * accidentally depends on the hashing step itself differing per engine. */
function hashValues(values) {
  const floats = Float64Array.from(values);
  return createHash("sha256").update(Buffer.from(floats.buffer)).digest("hex");
}

async function runInBrowser(browserType, name) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const version = browser.version();
    const values = await page.evaluate(runDeterminismSimulation, [SEED, ITERATIONS, SAMPLE_EVERY]);
    return { name, version, values, hash: hashValues(values) };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("Cross-browser floating-point determinism PoC (multiplayer-research.md)");
  console.log(`seed=${SEED} iterations=${ITERATIONS.toLocaleString()} sampleEvery=${SAMPLE_EVERY} (${Math.ceil(ITERATIONS / SAMPLE_EVERY)} samples)\n`);

  const nodeValues = runDeterminismSimulation([SEED, ITERATIONS, SAMPLE_EVERY]);
  const results = [
    { name: "Node (reference)", version: process.version, values: nodeValues, hash: hashValues(nodeValues) },
    await runInBrowser(chromium, "Chromium"),
    await runInBrowser(firefox, "Firefox"),
    await runInBrowser(webkit, "WebKit"),
  ];

  console.log("Results:");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(16)} ${String(r.version).padEnd(22)} sha256=${r.hash}`);
  }

  const distinctHashes = new Set(results.map((r) => r.hash));
  console.log("");
  if (distinctHashes.size === 1) {
    console.log(
      `[PASS] All ${results.length} engines produced a bit-identical result over ${ITERATIONS.toLocaleString()} iterations.`,
    );
    console.log("       No evidence of cross-browser float divergence for this workload — lockstep is viable as designed.");
    process.exitCode = 0;
  } else {
    console.log(
      `[FAIL] ${distinctHashes.size} distinct results across ${results.length} engines — plain lockstep would silently desync.`,
    );
    const reference = results[0];
    for (const r of results.slice(1)) {
      if (r.hash === reference.hash) {
        console.log(`  - ${r.name} matches ${reference.name}.`);
        continue;
      }
      const firstDiffIndex = r.values.findIndex((v, i) => v !== reference.values[i]);
      console.log(
        `  - ${r.name} diverges from ${reference.name} at sample #${firstDiffIndex} ` +
          `(${reference.name}=${reference.values[firstDiffIndex]} vs ${r.name}=${r.values[firstDiffIndex]})`,
      );
    }
    console.log("       See multiplayer-research.md's netcode section for the fallback (periodic authoritative reconciliation).");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
