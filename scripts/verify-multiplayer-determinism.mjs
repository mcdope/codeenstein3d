// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Cross-browser floating-point determinism check, wired into CI (step 10).
 * Converted from `scripts/poc-cross-browser-determinism.mjs`, which was
 * explicitly a standalone research spike ("not wired into CI, not a
 * `verify:*` script" per its own original header) that first measured
 * whether `Math.sin`/`cos`/`atan2`/`sqrt`/`hypot` — used throughout
 * `src/engine/player.ts`/`enemyAi.ts`/`raycaster.ts` — are bit-identical
 * enough across engines for lockstep, since IEEE-754 basic arithmetic is
 * bit-exact by spec but transcendental `Math.*` functions are NOT required
 * to be. This script keeps that PoC's exact simulation/hashing approach
 * (still deliberately standalone: it does not import or bundle anything
 * under `src/`) but replaces "print findings" with a real regression
 * assertion — see `MIN_SAFE_DIVERGENCE_ITERATIONS`'s own doc comment below
 * for what it actually guards and why.
 *
 * Never opens WebRTC (each engine just runs the same synthetic seeded-math
 * loop independently and the results are diffed in Node) — so unlike every
 * `verify-multiplayer-connect`/`-netcode`/`-reconciliation`/`-disconnect`/
 * `-transition`/`-multiguest` sibling, Firefox's confirmed CI-only WebRTC
 * ICE-gathering limitation doesn't apply here; all three engines run
 * together in one CI job (see `.github/workflows/verify.yml`'s dedicated
 * `verify-determinism` job, not the per-browser `verify-browser` matrix).
 *
 * Needs all three Playwright browser binaries installed locally:
 *   npx playwright install chromium firefox webkit
 *
 * Usage: node scripts/verify-multiplayer-determinism.mjs
 * Env overrides: POC_SEED, POC_ITERATIONS, POC_SAMPLE_EVERY (same names the
 * original PoC used, kept for anyone who already has them set locally).
 */
import { createHash } from "node:crypto";
import { chromium, firefox, webkit } from "playwright";

const SEED = Number(process.env.POC_SEED ?? 0xc0ffee);
const ITERATIONS = Number(process.env.POC_ITERATIONS ?? 500_000);
const SAMPLE_EVERY = Number(process.env.POC_SAMPLE_EVERY ?? 500);

/** Below this, a divergence is a genuine regression alarm, not the known/
 * accepted baseline — real historical data (this exact script's own default
 * settings, captured in `multiplayer-research.md`'s "Cross-browser
 * determinism: measured, not theoretical" section) found Chromium/Firefox/
 * WebKit each first diverging from the Node reference within roughly the
 * first 500-1000 iterations (sample indices 6-9 in the flat 4-values-per-
 * sample array, at `SAMPLE_EVERY=500` — index 6 lands in the push recorded
 * at iteration 500). That divergence is real, already-known, and exactly
 * why periodic reconciliation exists (`RECONCILE_INTERVAL_TICKS`) — this
 * check is not trying to prevent it. What it *is* trying to catch: a future
 * code change that makes divergence appear *dramatically* earlier (e.g. an
 * accidentally nondeterministic code path landing in the hot loop, diverging
 * within the first few iterations instead of hundreds) — a qualitatively
 * different, much worse failure mode than ordinary engine-version ULP drift.
 * Set a full order of magnitude below the historical ~500-1000 floor so
 * routine browser/Node version updates (which will keep shifting the exact
 * divergence point run to run) never false-positive this. */
const MIN_SAFE_DIVERGENCE_ITERATIONS = 50;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Runs entirely standalone in whichever JS engine calls it (plain Node, or
 * serialized into a browser page via `page.evaluate` — hence: no closures,
 * no imports, a single array argument in, a plain array of numbers out).
 * Verbatim from the original PoC — see its own doc comment (preserved below)
 * for the full "why sparse sampling is still rigorous" reasoning.
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
  // purpose (this script must not import or modify real game code), kept
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

/** Converts a flat-array sample index (4 values pushed per sample) back to
 * the iteration number it was captured at — every push except possibly the
 * very last happens at a clean multiple of `SAMPLE_EVERY`. */
function iterationForSampleIndex(flatIndex, sampleEvery) {
  return Math.floor(flatIndex / 4) * sampleEvery;
}

async function main() {
  console.log("Cross-browser floating-point determinism check (multiplayer-research.md, step 10)");
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
  console.log("");

  const reference = results[0];
  for (const r of results.slice(1)) {
    if (r.hash === reference.hash) {
      check(`${r.name}: bit-identical to ${reference.name} over all ${ITERATIONS.toLocaleString()} iterations`, true);
      continue;
    }
    const firstDiffIndex = r.values.findIndex((v, i) => v !== reference.values[i]);
    const firstDiffIteration = iterationForSampleIndex(firstDiffIndex, SAMPLE_EVERY);
    console.log(
      `  [info] ${r.name} diverges from ${reference.name} at sample #${firstDiffIndex} (~iteration ${firstDiffIteration}): ` +
        `${reference.name}=${reference.values[firstDiffIndex]} vs ${r.name}=${r.values[firstDiffIndex]}`,
    );
    // A divergence at/after MIN_SAFE_DIVERGENCE_ITERATIONS is the known,
    // accepted baseline this check exists to keep an eye on, not to prevent
    // — reconciliation is the real fix for it. Divergence *before* that
    // floor is what actually fails this check (see the constant's own doc
    // comment for why).
    check(
      `${r.name}: if it diverges from ${reference.name} at all, not before iteration ${MIN_SAFE_DIVERGENCE_ITERATIONS} (a real regression alarm, not a claim of eternal bit-identity)`,
      firstDiffIteration >= MIN_SAFE_DIVERGENCE_ITERATIONS,
      `first diverged at ~iteration ${firstDiffIteration}`,
    );
  }

  console.log(
    "\nDivergence here (past the safety floor) is expected and already designed for — see `RECONCILE_INTERVAL_TICKS`/" +
      "periodic reconciliation, not this check, for the actual correctness guarantee.",
  );
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-determinism crashed:", err);
  process.exit(1);
});
