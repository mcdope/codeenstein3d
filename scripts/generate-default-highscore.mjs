// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot dev tool: for each bot skill profile (Casual/Gamer/Pro — see
 * `scripts/run-balancing-telemetry.mjs`'s `PROFILES`), plays the bundled
 * `demo-campaign/` via a real, non-cheated headless-Chromium `Bot`
 * (`scripts/lib/bot.mjs`) until 3 runs qualify — reaching campaign level 4
 * for Casual, level 5 for Gamer, level 6 for Pro (0-based
 * `QUALIFY_LEVEL_INDEX_BY_PROFILE`, proving the profile can survive the
 * unarmed early game at its own claimed skill level) — then keeps the
 * single highest-scoring qualifying run per profile. Writes the resulting 3
 * entries as `src/engine/defaultHighscore.ts` — a small pre-populated
 * leaderboard shown to a first-time player whose own `localStorage`
 * highscore board is empty (see `loadHighscoresForDisplay` in
 * `src/engine/highscores.ts`).
 *
 * Not CI-wired — there's no CI in this repo yet, and even once there is, a
 * multi-playthrough bot run has no place gating every push. Run manually
 * (`npm run generate:default-highscore`) against a locally running dev
 * server, review the printed summary and the resulting file's diff, and
 * commit if it looks right — the same one-shot, hand-reviewed-then-committed
 * workflow `demo-campaign/` itself and its own verifier scripts already use.
 *
 * Shares its navigation/combat/loot decision-making with
 * `scripts/run-balancing-telemetry.mjs` via `scripts/lib/bot.mjs`'s `Bot`
 * class — see that script's module doc comment for the low-level bot
 * rationale (why firing is `Backquote`-only, why routes are precomputed in
 * Node before any browser launches, etc.) and `scripts/lib/qualifyLoop.mjs`
 * for the shared retry-until-N-qualifying-runs machinery. Difficulty is
 * deliberately fixed at `"normal"` for every profile (the engine's own
 * default) — skill level here means `PROFILES`, an orthogonal axis from
 * in-game difficulty; only `PROFILES` varies across the 3 generated entries.
 *
 * Each attempt records replay frames at real-display-frame granularity
 * (`RECORD_STEP_MS`, distinct from the bot's own `VIRTUAL_STEP_MS` decision
 * cadence) — a replay shipped for real playback needs this, unlike a
 * telemetry-only run: `startReplay` (`src/main.ts`) consumes exactly one
 * recorded frame per real render tick regardless of that frame's own `dt`,
 * so fewer-but-coarser frames covering the same virtual duration play back
 * proportionally faster than real speed. See `scripts/lib/bot.mjs`'s
 * `recordStepMs` doc comment.
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { Bot } from "./lib/bot.mjs";
import { runQualifyLoop } from "./lib/qualifyLoop.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { DEV_SERVER_URL, PROFILES, planLevels, waitForTestHooks, dismissOverlay, installDifficulty } from "./run-balancing-telemetry.mjs";
import { profilesHash } from "./lib/profiles.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const CAMPAIGN_NAME = "demo-campaign";
const OUTPUT_FILE = path.join(REPO_ROOT, "src/engine/defaultHighscore.ts");

// The loop stops the moment this many runs qualify, so it doubles as the
// sample the kept entry is the maximum *of* — at the default 3 a profile
// typically uses only 4 of its 40 permitted attempts, and the board is a
// best-of-3 rather than a best-of-many. Raising it is the way to get a
// stronger and more representative board (the score spread across whole
// regenerations is wide: Gamer measured 48774-63089 across two runs), at
// roughly proportional cost. Env var rather than a bumped default because
// the default is what keeps a routine regeneration cheap.
const REQUIRED_QUALIFYING_RUNS = process.env.CODEENSTEIN_HIGHSCORE_QUALIFYING_RUNS
  ? Number(process.env.CODEENSTEIN_HIGHSCORE_QUALIFYING_RUNS)
  : 3;
// Bounded, deliberately. This was `Infinity` on the reasoning that a manual,
// hand-reviewed tool can afford to "keep retrying until 3 qualifying runs
// land, however long that takes" — but an unbounded retry loop cannot fail,
// it can only hang, and the distinction matters when the campaign itself has
// become unwinnable. A level the bot reliably wedges on makes every attempt
// non-qualifying, and this script then spins forever with no error and no
// output: 2h40m was lost to exactly that once, and more again later.
//
// A cap converts that silent hang into a real failure with a diagnosis (see
// the per-profile summary below). Generous enough that a merely unlucky run
// still succeeds — the historical worst case needed well under half of it —
// and overridable for the rare case where someone genuinely wants to grind.
const ATTEMPT_CAP = process.env.CODEENSTEIN_HIGHSCORE_ATTEMPT_CAP
  ? Number(process.env.CODEENSTEIN_HIGHSCORE_ATTEMPT_CAP)
  : 40;
// 0-based — "level 4/5/6" in 1-based campaign numbering. Casual only needs
// to prove it survives the unarmed early game (the same threshold
// run-balancing-telemetry.mjs uses for every profile); Gamer/Pro raise the
// bar to match their claimed skill level, per user directive.
const QUALIFY_LEVEL_INDEX_BY_PROFILE = { Casual: 3, Gamer: 4, Pro: 5 };
// Each attempt plays a *full* campaign (up to 17 levels), unlike
// run-balancing-telemetry.mjs's much shorter per-attempt cost — kept lower
// than that script's default concurrency to avoid oversubscribing a single
// machine's headless Chromium.
const ATTEMPT_CONCURRENCY = process.env.CODEENSTEIN_HIGHSCORE_CONCURRENCY ? Number(process.env.CODEENSTEIN_HIGHSCORE_CONCURRENCY) : 4;

const VIRTUAL_STEP_MS = 50;
const RECORD_STEP_MS = 1000 / 60; // see module doc comment
const FINAL_APPROACH_TICKS = 80; // extra push onto the exit tile's exact center
/** Mirrors `run-balancing-telemetry.mjs`'s own limit — see its doc comment. */
const TELEPORT_REPLAN_LIMIT = 4;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Node-side port of `decompressFromStorage` (`src/engine/storageCompression.ts`)
 * — no browser API needed, `localStorage`'s raw string is read via
 * `page.evaluate` and decompressed here in plain Node. */
function decompressHighscoreBlob(raw) {
  const COMPRESSED_PREFIX = "gz1:";
  if (!raw.startsWith(COMPRESSED_PREFIX)) return JSON.parse(raw);
  const bytes = Buffer.from(raw.slice(COMPRESSED_PREFIX.length), "base64");
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}

/** Same per-file AST hash `CampaignReplayRecorder.startLevel` records into
 * `ReplayLevelSegment.astHash` (`hashRun` in `src/engine/highscores.ts`),
 * computed independently in Node. */
function computeAstHash(parsed, campaignName) {
  const bytes = Buffer.from(`${campaignName} ${JSON.stringify(parsed)}`, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Plays one full campaign attempt via a fresh `Bot`, advancing through
 * every level with the same overlay-dismiss + exit-change/campaign-complete
 * poll `run-balancing-telemetry.mjs`'s `playRun` uses — trimmed of
 * telemetry-snapshot pulls, since this generator only needs
 * `reachedExitForLevel` (to check qualification); the actual score comes
 * from the `codeenstein-highscores` entry the engine itself records on
 * death/completion (read separately by the caller, once this returns).
 */
async function driveFullCampaign(bot, page, levelPlans) {
  const reachedExitForLevel = new Array(levelPlans.length).fill(false);
  for (let i = 0; i < levelPlans.length; i++) {
    const { map, routePlain } = levelPlans[i];
    bot.startLevel(map);
    const route = routePlain;

    const player0 = await bot.readState();
    if (player0.state !== "playing") {
      return { reachedExitForLevel, diedAtLevelIndex: i, reason: player0.state === "over" ? "died" : "stuck" };
    }
    const prevExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());

    // Same mid-route-teleport handling as `run-balancing-telemetry.mjs` — see
    // the longer note there. `driveLegs` reporting `reason: "teleported"` is
    // not "the route finished": every remaining waypoint was planned against a
    // position the bot is no longer at, so re-plan from where the pad actually
    // dropped it rather than blind-walking at the exit from an arbitrary
    // corner of the map.
    let legOutcome = route.ok ? await bot.driveLegs(route.legs) : { state: "stuck" };
    for (let replan = 0; replan < TELEPORT_REPLAN_LIMIT && legOutcome.state === "playing" && legOutcome.reason === "teleported"; replan++) {
      const here = await bot.readState();
      const resumed = planRoute(map, { x: Math.floor(here.x), y: Math.floor(here.y) });
      if (!resumed.ok) break;
      legOutcome = await bot.driveLegs(resumed.legs);
    }

    if (legOutcome.state === "over") return { reachedExitForLevel, diedAtLevelIndex: i, reason: "died" };
    if (legOutcome.state === "stuck") return { reachedExitForLevel, diedAtLevelIndex: i, reason: "stuck" };
    if (legOutcome.state === "playing") {
      const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
      // `driveToExit`, not `driveToward`: the exit stays inert while any enemy
      // homed to its own room is alive (`checkExit()`), so reaching the tile is
      // not the same as finishing the level. See `Bot#driveToExit`.
      const pushed = await bot.driveToExit(exitCenter, FINAL_APPROACH_TICKS);
      if (pushed.state === "over") return { reachedExitForLevel, diedAtLevelIndex: i, reason: "died" };
      if (pushed.state !== "won") return { reachedExitForLevel, diedAtLevelIndex: i, reason: "stuck" };
    }
    // else legOutcome.state === "won" already — fall through.

    reachedExitForLevel[i] = true;

    await dismissOverlay(page); // Commit Summary overlay
    const advance = await page
      .waitForFunction(
        (prevExit) => {
          const hooks = window.__codeensteinTestHooks;
          if (!hooks) return null;
          const exit = hooks.getExit();
          if (exit.x !== prevExit.x || exit.y !== prevExit.y) return "advanced";
          if (localStorage.getItem("codeenstein-highscores")) return "campaign-complete";
          return false;
        },
        prevExit,
        { timeout: 20000, polling: 100 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => "timeout");

    if (advance === "campaign-complete") return { reachedExitForLevel, diedAtLevelIndex: null, reason: "campaign-complete" };
    if (advance !== "advanced") return { reachedExitForLevel, diedAtLevelIndex: null, reason: "stuck" };
    await dismissOverlay(page); // next level's briefing
  }
  return { reachedExitForLevel, diedAtLevelIndex: null, reason: "campaign-complete" };
}

/**
 * Drives one full campaign attempt in its own fresh, isolated browser
 * context and returns `{ reachedExitForLevel, diedAtLevelIndex, reason,
 * entry }` — `entry` is the `HighscoreEntry` the engine itself recorded to
 * `localStorage` on death/completion, or `null` if none was recorded (e.g.
 * died on level 1 — `recordRunHighscore` skips a 0-levels-cleared run
 * entirely). A crashed context/page is caught and surfaced as a discarded,
 * non-qualifying attempt (`reason: "attemptCrashed: ..."`) rather than an
 * uncaught rejection — same convention as
 * `run-balancing-telemetry.mjs`'s `runOneAttempt`, which `runQualifyLoop`'s
 * circuit breaker relies on to detect a truly dead browser.
 */
async function runOneAttempt(browser, profileName, profile, levelPlans) {
  let context;
  try {
    context = await browser.newContext(); // fresh, isolated localStorage per attempt
    const page = await context.newPage();
    // Same opt-in shape as `run-balancing-telemetry.mjs`'s own forwarder. Worth
    // having here specifically because `advanceToNextLevel` (`src/main.ts`)
    // skips a level whose `parseFile` returns null and says nothing about it in
    // Node — the only trace is a `[parser] Skipping "<file>"` warning inside the
    // page, and a skipped level is otherwise invisible until someone counts the
    // replay segments.
    if (process.env.CODEENSTEIN_CONSOLE_FORWARD) {
      page.on("console", (msg) => console.log(`  [console] ${msg.text()}`));
      page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
    }
    page.on("pageerror", (err) => console.log(`  [${profileName}] [pageerror] ${err.message}`));

    await installVirtualClock(page);
    await installDifficulty(page, "normal");
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1&botRotSpeedMul=${profile.rotSpeedMultiplier}`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    const bot = new Bot(page, profile, { realtime: false, stepMs: VIRTUAL_STEP_MS, recordStepMs: RECORD_STEP_MS });
    const run = await driveFullCampaign(bot, page, levelPlans);

    const highscoreRaw = await page
      .waitForFunction(() => localStorage.getItem("codeenstein-highscores"), undefined, { timeout: 15000, polling: 100 })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    const entry = highscoreRaw ? decompressHighscoreBlob(highscoreRaw)[0] : null;

    await context.close();
    return { ...run, entry };
  } catch (err) {
    console.log(`  [${profileName}] [attempt crashed] ${err.message}`);
    if (context) await context.close().catch(() => {});
    return { reachedExitForLevel: [], diedAtLevelIndex: null, reason: `attemptCrashed: ${err.message}`, entry: null };
  }
}

async function main() {
  const levelPlans = await planLevels();
  const reachableCount = levelPlans.filter((l) => l.routePlain.ok).length;
  console.log(`${reachableCount}/${levelPlans.length} levels have a planned route (bot may still die to combat before reaching some of them).\n`);

  console.log(`Launching headless Chromium (concurrency ${ATTEMPT_CONCURRENCY})...\n`);
  const browser = await chromium.launch();
  const keptEntries = [];

  for (const [profileName, profile] of Object.entries(PROFILES)) {
    const qualifyLevelIndex = QUALIFY_LEVEL_INDEX_BY_PROFILE[profileName];
    console.log(`${"=".repeat(72)}\n${profileName} — qualifying = reach level ${qualifyLevelIndex + 1}\n${"=".repeat(72)}`);

    const { qualifyingRuns, attemptsUsed, failureReasons } = await runQualifyLoop({
      runAttempt: () => runOneAttempt(browser, profileName, profile, levelPlans),
      isQualifying: (run) => Boolean(run.reachedExitForLevel[qualifyLevelIndex] && run.entry),
      requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
      attemptCap: ATTEMPT_CAP,
      concurrency: ATTEMPT_CONCURRENCY,
      onProgress: (attempts, qualifying) => console.log(`  [${profileName}] attempt ${attempts}, qualifying ${qualifying}/${REQUIRED_QUALIFYING_RUNS}`),
      onAttemptResult: (run, attempt) => {
        if (!(run.reachedExitForLevel[qualifyLevelIndex] && run.entry)) {
          const where = run.diedAtLevelIndex !== null ? ` at level ${run.diedAtLevelIndex + 1}` : "";
          console.log(`  [${profileName}] attempt ${attempt} did not qualify: ${run.reason}${where}`);
        }
      },
    });

    // A capped loop can now come back empty, which `reduce` with no initial
    // value would turn into an opaque "Reduce of empty array" — report what
    // actually went wrong instead, since the failure is nearly always "the bot
    // cannot get through level N", and that is the one fact worth surfacing.
    if (qualifyingRuns.length === 0) {
      const byReason = new Map();
      for (const f of failureReasons) {
        const where = typeof f.diedAtLevelIndex === "number" ? ` at level ${f.diedAtLevelIndex + 1}` : "";
        const label = `${f.reason}${where}`;
        byReason.set(label, (byReason.get(label) ?? 0) + 1);
      }
      const summary = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n}x ${label}`);
      console.error(`  ${profileName}: NO qualifying run in ${attemptsUsed} attempts (cap ${ATTEMPT_CAP}).`);
      console.error(`    failures: ${summary.join(", ") || "(none recorded)"}`);
      console.error(`    A single level dominating that list is the campaign blocking the bot, not bad luck.\n`);
      continue;
    }

    const best = qualifyingRuns.reduce((a, b) => (b.entry.score > a.entry.score ? b : a));
    console.log(
      `  ${profileName}: kept score=${best.entry.score} levelsCleared=${best.entry.levelsCleared} levelName=${best.entry.levelName} ` +
        `(best of ${qualifyingRuns.length} qualifying runs, ${attemptsUsed} attempts)\n`,
    );
    keptEntries.push(best.entry);
  }

  await browser.close();

  // Every profile must land, not just one. The shipped file is the three
  // example runs the Highscores dialog shows before a player has any of their
  // own, so a partial write silently degrades that from three skill tiers to
  // whatever happened to survive — and, uncapped, this could never happen, so
  // nothing downstream is written to expect it. Bail instead.
  const profileCount = Object.keys(PROFILES).length;
  if (keptEntries.length < profileCount) {
    console.error(`\nOnly ${keptEntries.length} of ${profileCount} profiles produced a qualifying run — refusing to ship a partial set.`);
    console.error("Check the per-profile failure summaries above: if one level dominates, that level is unplayable for the bot");
    console.error("and needs fixing before this can regenerate. Raise CODEENSTEIN_HIGHSCORE_ATTEMPT_CAP only if the failures look genuinely scattered.");
    process.exit(1);
  }

  console.log("Re-verifying kept entries' replay astHash values against fresh on-disk hashes...");
  const { parseFile } = await loadEngineModules();
  for (const entry of keptEntries) {
    check(`${entry.levelName}: entry.source === "demo"`, entry.source === "demo");
    check(`${entry.levelName}: replay.version === 2`, entry.replay?.version === 2);
    check(`${entry.levelName}: replay has >=1 level segment`, (entry.replay?.levels?.length ?? 0) >= 1);
    // The segments must be a *prefix* of the campaign, in order. Nothing else
    // downstream can notice a hole: every individual segment stays valid, so
    // the astHash/frames checks below all pass while the payload quietly
    // skips a level. A shipped `defaultHighscore.ts` carried exactly that —
    // the Casual entry ran level 9 -> level 11 because
    // `stage10_kernel_module.rs` overflowed the replay frame cap and the old
    // `CampaignReplayRecorder.finish()` filtered the gap out of the middle.
    const played = (entry.replay?.levels ?? []).map((seg) => seg.filePath.split("/").pop());
    const expectedPrefix = levelPlans.slice(0, played.length).map((plan) => plan.filename);
    check(
      `${entry.levelName}: replay levels are a contiguous campaign prefix`,
      played.length > 0 && played.every((name, i) => name === expectedPrefix[i]),
      `got [${played.join(", ")}] — expected [${expectedPrefix.join(", ")}]`,
    );
    for (const seg of entry.replay?.levels ?? []) {
      const filename = seg.filePath.split("/").pop();
      const text = fs.readFileSync(path.join(CAMPAIGN_DIR, filename), "utf8");
      const parsed = await parseFile(filename, text);
      const expected = computeAstHash(parsed, CAMPAIGN_NAME);
      check(`${filename} astHash matches fresh on-disk parse`, seg.astHash === expected, `${seg.astHash} !== ${expected}`);
      check(`${filename} replay segment has recorded frames`, Array.isArray(seg.frames) && seg.frames.length > 0);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed — not writing ${OUTPUT_FILE}. Investigate before regenerating.`);
    process.exit(1);
  }

  writeDefaultHighscoreFile(keptEntries);
  console.log(`\nWrote ${OUTPUT_FILE} — review with \`git diff\` before committing.`);
}

// A qualifying run's replay can carry tens of thousands of recorded frames
// (the smarter `Bot` survives much deeper into the campaign than the old
// simple bot did before dying) — a plain JSON array literal for 3 such
// entries measured ~84MB, which is both a real production problem (this
// file is bundled directly into the shipped JS, dynamically imported the
// moment a first-time player opens an empty Highscores dialog) and a dev/test
// problem (parsing tens of thousands of array-literal objects into an AST is
// slow enough to time out `highscores.test.ts` and blow up test-runner
// memory). Fixed by reusing the exact same `gz1:` gzip+base64 scheme
// `compressForStorage` already uses for localStorage — this data is highly
// repetitive JSON (mostly-identical per-frame objects), so it compresses
// ~100x smaller, and the shipped module becomes a single string literal
// (trivial to parse) instead of a giant nested array (expensive to parse).
function writeDefaultHighscoreFile(entries) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(entries)), { level: 9 }).toString("base64");
  const header = `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shipped fallback leaderboard, shown only when a player's own localStorage
 * highscore board is empty (see \`loadHighscoresForDisplay\` in
 * \`./highscores.ts\`) — so a first-time visitor sees a populated Highscores
 * dialog (with working "Watch Replay" buttons) instead of "No runs recorded
 * yet".
 *
 * Generated by \`scripts/generate-default-highscore.mjs\`
 * (\`npm run generate:default-highscore\`): for each bot skill profile
 * (Casual/Gamer/Pro — see \`scripts/run-balancing-telemetry.mjs\`'s
 * \`PROFILES\`), plays the bundled \`demo-campaign/\` until 3 runs qualify
 * (reach campaign level 4/5/6 respectively), keeping the single
 * highest-scoring qualifying run per profile. Regenerate this file if
 * \`demo-campaign/\`'s source files ever change — each entry's
 * \`replay.levels[].astHash\` is a SHA-256 of that level's parsed AST plus the
 * campaign name, and \`startReplay\` (\`src/main.ts\`) refuses to play back a
 * replay whose recomputed hash no longer matches, so an edited demo-campaign
 * file silently breaks these entries' "Watch Replay" buttons until this file
 * is regenerated.
 *
 * Regenerate it just as surely if the **bot's skill profiles** change. These
 * runs were played by those profiles, so a retune leaves this board describing
 * a bot that no longer exists — and unlike an edited campaign file, nothing
 * about the replays themselves goes wrong, so no existing check notices.
 * \`PROFILES_HASH\` below is what closes that: \`scripts/lib/profiles.test.mjs\`
 * recomputes it from the live profiles and fails when the two diverge.
 *
 * The entries are stored gzip+base64-encoded (\`gz1:\` prefix, same scheme as
 * \`storageCompression.ts\`'s \`compressForStorage\`) rather than as a plain
 * array literal — see \`writeDefaultHighscoreFile\` in the generator script
 * for why (~100x smaller, and far cheaper for a bundler to parse).
 * \`loadHighscoresForDisplay\` (\`./highscores.ts\`) decompresses it with
 * \`decompressFromStorage\` at read time.
 */

/** Fingerprint of the bot profiles these runs were played by, at generation
 * time — see \`profilesHash\` in \`scripts/lib/profiles.mjs\`. A mismatch means
 * this file is stale and \`npm run generate:default-highscore\` should be re-run. */
export const PROFILES_HASH = "${profilesHash()}";

/** \`HighscoreEntry[]\`, gzip+base64-encoded — decompress with
 * \`decompressFromStorage\` from \`./storageCompression\`. */
export const DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED = "gz1:${compressed}";
`;
  fs.writeFileSync(OUTPUT_FILE, header);
}

main().catch((err) => {
  console.error("generate-default-highscore crashed:", err);
  process.exit(1);
});
