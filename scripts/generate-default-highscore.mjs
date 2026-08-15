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
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { Bot } from "./lib/bot.mjs";
import { runQualifyLoop } from "./lib/qualifyLoop.mjs";
import { assertPlanMatchesEngine } from "./lib/planEngineMatch.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { DEV_SERVER_URL, PROFILES, devServerOptions, planLevels, waitForTestHooks, dismissOverlay, installDifficulty, installPlayerName } from "./run-balancing-telemetry.mjs";
import { ensureDevServer } from "./lib/devServer.mjs";

/**
 * The server attempts navigate to. Starts as the imported default and is
 * reassigned by `main()` once `ensureDevServer` resolves — the same shape
 * `run-balancing-telemetry.mjs` uses for its own `DEV_SERVER_URL`.
 *
 * **This script used to skip that step**, importing the URL but never starting
 * anything. `planLevels()` starts a server for route planning and stops it
 * again, so by the time the bot phase ran there was nothing listening: every
 * attempt died on `ERR_CONNECTION_REFUSED` and the qualify loop reported
 * "browser appears dead: 3 consecutive fully-crashed batches" — three batches
 * and several minutes after the actual cause, naming the wrong thing entirely.
 * It only worked when someone happened to have a dev server already up.
 */
let devUrl = DEV_SERVER_URL;
import { profilesHash } from "./lib/profiles.mjs";
import { envNumber } from "./lib/envNumber.mjs";

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
const REQUIRED_QUALIFYING_RUNS = envNumber("CODEENSTEIN_HIGHSCORE_QUALIFYING_RUNS", 3, { integer: true, min: 1 });
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
const ATTEMPT_CAP = envNumber("CODEENSTEIN_HIGHSCORE_ATTEMPT_CAP", 40, { integer: true, min: 1 });
// 0-based — "level 4/5/6" in 1-based campaign numbering. Casual only needs
// to prove it survives the unarmed early game (the same threshold
// run-balancing-telemetry.mjs uses for every profile); Gamer/Pro raise the
// bar to match their claimed skill level, per user directive.
const QUALIFY_LEVEL_INDEX_BY_PROFILE = { Casual: 3, Gamer: 4, Pro: 5 };
// Each attempt plays a *full* campaign (up to 17 levels), unlike
// run-balancing-telemetry.mjs's much shorter per-attempt cost — kept lower
// than that script's default concurrency to avoid oversubscribing a single
// machine's headless Chromium.
//
// **Per profile, and all profiles now run at once**, so the real figure in
// flight is this times the profile count (3 x 4 = 12). Sized against a
// measurement rather than a guess: a 16-core box sat at **31% busy** running
// one profile's four attempts, so three profiles' worth is roughly 93% —
// measured at 91% in practice. That is full but not oversubscribed, and the
// machine stays usable while it runs (confirmed by the box's owner, streaming
// video throughout) — which is the constraint that actually matters, since
// this runs on a desktop rather than a build server. Do not lower the default
// on the strength of the number alone; lower it if your machine has fewer
// cores. The wall-clock floor is one profile's own qualify loop either way.
const ATTEMPT_CONCURRENCY = envNumber("CODEENSTEIN_HIGHSCORE_CONCURRENCY", 4, { integer: true, min: 1 });

const VIRTUAL_STEP_MS = 50;
const RECORD_STEP_MS = 1000 / 60; // see module doc comment
const FINAL_APPROACH_TICKS = 80; // extra push onto the exit tile's exact center
/** Mirrors `run-balancing-telemetry.mjs`'s own limit — see its doc comment. */
const TELEPORT_REPLAN_LIMIT = 4;

/**
 * Wall-clock helpers for the progress lines.
 *
 * Attempts run `ATTEMPT_CONCURRENCY` at a time, so a run's cost is really
 * "how many batches did each profile need", and a batch's duration is set by
 * its slowest attempt. None of that was recoverable afterwards: the lines
 * below carried no time at all, so answering "is this run slower than the
 * last one?" meant reconstructing batch boundaries from dev-server console
 * timestamps and inferring the rest. These make it a measurement.
 */
const clock = () => new Date().toTimeString().slice(0, 8);
const since = (startMs) => {
  const total = Math.round((Date.now() - startMs) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}m${String(total % 60).padStart(2, "0")}s`;
};

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Decodes the raw `localStorage` string the browser wrote, in whichever
 * format it used. Deliberately delegates to the *real* `replayCodec.ts` /
 * `storageCompression.ts` semantics (bundled via `loadEngineModules`) rather
 * than re-implementing them here — a second copy of a binary frame codec is
 * exactly the kind of silently-drifting mirror `doc/dev/balancing-telemetry.md`
 * warns about. Only the legacy `gz1:`/plain paths stay inline, since those are
 * two lines and frozen. */
async function decompressHighscoreBlob(raw) {
  const { isBinaryBoard, unpackBoardFromStorage } = await loadEngineModules();
  if (isBinaryBoard(raw)) return unpackBoardFromStorage(raw);
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
    // The generated highscore is only meaningful if the bot played the campaign
    // it planned; a plan/engine entrypoint mismatch would bake a run against the
    // wrong maps into `defaultHighscore.ts`. See `planEngineMatch.mjs`.
    await assertPlanMatchesEngine(page, map, { levelNo: i + 1, levelPlans });
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
    // The recorded entry's own `playerName`, so the shipped board says which
    // bot profile set each row — see `installPlayerName`'s doc comment.
    await installPlayerName(page, profileName);
    await page.goto(`${devUrl}/?testHooks=1&botRotSpeedMul=${profile.rotSpeedMultiplier}`);
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
    const entry = highscoreRaw ? (await decompressHighscoreBlob(highscoreRaw))[0] : null;

    await context.close();
    return { ...run, entry };
  } catch (err) {
    console.log(`  [${profileName}] [attempt crashed] ${err.message}`);
    if (context) await context.close().catch(() => {});
    return { reachedExitForLevel: [], diedAtLevelIndex: null, reason: `attemptCrashed: ${err.message}`, entry: null };
  }
}

/**
 * `--backfill-rot-speed`: stamps `rotSpeedMultiplier` onto an already-shipped
 * board's segments instead of replaying the whole campaign to regenerate it.
 *
 * The field was added to `ReplayLevelSegment` after this board was recorded,
 * and without it every one of these replays plays back at 1.0 while having
 * been recorded at its profile's 2.0/3.5/5.0 — the view points where the run
 * never looked and the run dies in seconds. The value is *recoverable* rather
 * than lost, though: `main()` below pushes `keptEntries` in
 * `Object.entries(PROFILES)` order, one entry per profile, and `PROFILES_HASH`
 * pins that those profiles haven't moved since. So entry *i* was provably
 * played by profile *i*, and its multiplier is `PROFILES[i].rotSpeedMultiplier`.
 *
 * That is an argument from write-order, not from data in the file, which is
 * the one thing that could make it wrong. It is also exactly what
 * `npm run verify:replay` checks — a back-filled board either reproduces its
 * own recorded scores frame-for-frame or it does not. Run it afterwards; if it
 * fails, regenerate for real rather than guessing at the mapping.
 *
 * Saves a ~33-minute regeneration that is itself wedge-prone, and (unlike one)
 * changes nothing about the runs themselves — same frames, same seeds, same
 * scores.
 */
async function backfillRotSpeed() {
  const { unpackBoardFromStorage } = await loadEngineModules();
  const source = fs.readFileSync(OUTPUT_FILE, "utf8");
  const match = source.match(/DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED = "([^"]+)"/);
  if (!match) {
    console.error(`Could not find DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED in ${OUTPUT_FILE}.`);
    process.exit(1);
  }

  const entries = await unpackBoardFromStorage(match[1]);
  const profiles = Object.entries(PROFILES);
  if (entries.length !== profiles.length) {
    console.error(
      `Board has ${entries.length} entries but there are ${profiles.length} profiles — the index-to-profile mapping this back-fill relies on does not hold. Regenerate instead.`,
    );
    process.exit(1);
  }

  const expectedHash = profilesHash();
  const shippedHash = source.match(/PROFILES_HASH = "([^"]+)"/)?.[1];
  if (shippedHash !== expectedHash) {
    console.error(
      `PROFILES_HASH in ${OUTPUT_FILE} is ${shippedHash} but the profiles now hash to ${expectedHash} — this board was recorded by profiles that have since changed, so the multipliers below would be the wrong ones. Regenerate instead.`,
    );
    process.exit(1);
  }

  let stamped = 0;
  entries.forEach((entry, i) => {
    const [profileName, profile] = profiles[i];
    for (const segment of entry.replay?.levels ?? []) {
      segment.rotSpeedMultiplier = profile.rotSpeedMultiplier;
      stamped += 1;
    }
    console.log(`  entry ${i} (${profileName}, score ${entry.score}): ${entry.replay?.levels?.length ?? 0} segment(s) at ${profile.rotSpeedMultiplier}x`);
  });

  await writeDefaultHighscoreFile(entries);
  console.log(`\nStamped ${stamped} segment(s) across ${entries.length} entries — wrote ${OUTPUT_FILE}.`);
  console.log("Now run `npm run verify:replay` (with a dev server up) to confirm the board actually plays back.");
}

/**
 * `--backfill-player-name`: stamps `playerName` onto the already-shipped
 * board's three entries instead of replaying the whole campaign.
 *
 * Same recoverable-by-write-order argument as `--backfill-rot-speed` above,
 * and the same two guards on it: one entry per profile in
 * `Object.entries(PROFILES)` order, with `PROFILES_HASH` pinning that those
 * profiles have not moved. Unlike that back-fill, this one cannot break
 * playback if the mapping were somehow wrong — a name is cosmetic, it feeds
 * no simulation input — but the mapping is the same one, so it is checked the
 * same way rather than trusted because the stakes are lower.
 *
 * Regenerating instead would cost ~33 minutes, is wedge-prone at
 * demo-campaign L6, and would replace three runs that are otherwise perfectly
 * good with three different ones purely to add a label.
 */
async function backfillPlayerName() {
  const { unpackBoardFromStorage } = await loadEngineModules();
  const source = fs.readFileSync(OUTPUT_FILE, "utf8");
  const match = source.match(/DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED = "([^"]+)"/);
  if (!match) {
    console.error(`Could not find DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED in ${OUTPUT_FILE}.`);
    process.exit(1);
  }

  const entries = await unpackBoardFromStorage(match[1]);
  const profiles = Object.entries(PROFILES);
  if (entries.length !== profiles.length) {
    console.error(
      `Board has ${entries.length} entries but there are ${profiles.length} profiles — the index-to-profile mapping this back-fill relies on does not hold. Regenerate instead.`,
    );
    process.exit(1);
  }

  const expectedHash = profilesHash();
  const shippedHash = source.match(/PROFILES_HASH = "([^"]+)"/)?.[1];
  if (shippedHash !== expectedHash) {
    console.error(
      `PROFILES_HASH in ${OUTPUT_FILE} is ${shippedHash} but the profiles now hash to ${expectedHash} — this board was recorded by profiles that have since changed, so the names below would be the wrong ones. Regenerate instead.`,
    );
    process.exit(1);
  }

  entries.forEach((entry, i) => {
    const [profileName] = profiles[i];
    entry.playerName = profileName;
    console.log(`  entry ${i} (score ${entry.score}): playerName = ${profileName}`);
  });

  await writeDefaultHighscoreFile(entries);
  console.log(`\nStamped ${entries.length} entries — wrote ${OUTPUT_FILE}.`);
}

async function main() {
  if (process.argv.includes("--backfill-rot-speed")) {
    await backfillRotSpeed();
    return;
  }
  if (process.argv.includes("--backfill-player-name")) {
    await backfillPlayerName();
    return;
  }
  const levelPlans = await planLevels();
  const reachableCount = levelPlans.filter((l) => l.routePlain.ok).length;
  console.log(`${reachableCount}/${levelPlans.length} levels have a planned route (bot may still die to combat before reaching some of them).\n`);

  console.log(
    `Launching headless Chromium — ${Object.keys(PROFILES).length} profiles in parallel, ` +
      `${ATTEMPT_CONCURRENCY}-way attempt concurrency each (${Object.keys(PROFILES).length * ATTEMPT_CONCURRENCY} attempts in flight)...\n`,
  );
  // Start (or adopt) the server the attempts will navigate to. `planLevels()`
  // above ran its own and stopped it again, so without this there is nothing
  // listening. `stop()` is a no-op for a server we did not start, so an
  // explicitly configured `CODEENSTEIN_DEV_URL` is never shut down under its
  // owner.
  const server = await ensureDevServer(devServerOptions("highscore"));
  devUrl = server.url;
  // Released on `exit` rather than only on the happy path. The qualify loop
  // throws on a dead browser, and `main()` also `process.exit(1)`s on a partial
  // set — a `finally` would cover the first and be skipped by the second, so
  // neither alone is enough. Leaking here is worse than it looks: the *next*
  // run would find :5199 already answering, "reuse" that stale server, and
  // quietly play a build from before whatever change prompted the re-run —
  // which reads as bad data rather than as a leaked process.
  //
  // Safe as a plain `exit` handler because `stop()` is synchronous
  // (`child.kill`, see `devServer.mjs`) — an async teardown would silently not
  // run here. Does **not** cover SIGTERM/Ctrl-C, which terminate without
  // running exit handlers; that case still leaves vite up, and the next run's
  // "reusing already-running server" line is the tell.
  //
  // **And it is not sufficient on its own, which is why the happy path stops
  // the server explicitly at the end of `main()`.** `ensureDevServer` spawns
  // vite with piped stdio, and those pipes are live handles: node will not
  // exit while they are open. So on a successful run this handler waits for an
  // exit that waits for this handler — the script wrote its output, had no
  // browser left, and then sat at 0% CPU until it was killed. Measured at ~13
  // minutes of work followed by an indefinite hang. Every `process.exit(1)`
  // path above is unaffected, because an explicit exit does run this handler,
  // which is exactly why the bug only ever showed up on success.
  process.on("exit", () => void server.stop?.());
  const browser = await chromium.launch();

  /** One profile's qualify loop, start to kept entry. Returns `null` when the
   * profile never qualified — the caller turns that into the refuse-to-ship
   * check below, exactly as the serial version did. */
  const runProfile = async ([profileName, profile]) => {
    const qualifyLevelIndex = QUALIFY_LEVEL_INDEX_BY_PROFILE[profileName];
    const profileStart = Date.now();
    console.log(`${profileName} — qualifying = reach level ${qualifyLevelIndex + 1} — started ${clock()}`);

    const { qualifyingRuns, attemptsUsed, failureReasons } = await runQualifyLoop({
      runAttempt: () => runOneAttempt(browser, profileName, profile, levelPlans),
      isQualifying: (run) => Boolean(run.reachedExitForLevel[qualifyLevelIndex] && run.entry),
      requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
      attemptCap: ATTEMPT_CAP,
      concurrency: ATTEMPT_CONCURRENCY,
      onProgress: (attempts, qualifying) =>
        console.log(`  ${clock()} [${profileName}] attempt ${attempts}, qualifying ${qualifying}/${REQUIRED_QUALIFYING_RUNS} (${since(profileStart)} into this profile)`),
      onAttemptResult: (run, attempt) => {
        if (!(run.reachedExitForLevel[qualifyLevelIndex] && run.entry)) {
          const where = run.diedAtLevelIndex !== null ? ` at level ${run.diedAtLevelIndex + 1}` : "";
          console.log(`  ${clock()} [${profileName}] attempt ${attempt} did not qualify: ${run.reason}${where}`);
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
      return null;
    }

    const best = qualifyingRuns.reduce((a, b) => (b.entry.score > a.entry.score ? b : a));
    console.log(
      `  ${profileName}: kept score=${best.entry.score} levelsCleared=${best.entry.levelsCleared} levelName=${best.entry.levelName} ` +
        `(best of ${qualifyingRuns.length} qualifying runs, ${attemptsUsed} attempts, ${since(profileStart)})\n`,
    );
    return best.entry;
  };

  // Profiles are independent samples — nothing one produces feeds another — so
  // running them serially left the machine idle. Measured on a 16-core box
  // during a real batch: 31% busy at `ATTEMPT_CONCURRENCY` 4, i.e. roughly
  // three profiles' worth of headroom sitting unused while the run took ~40
  // minutes. The ceiling here is the profile count (3), because each profile
  // stops the moment it has its qualifying runs; adding lanes past that would
  // idle them.
  //
  // `Promise.all` preserves input order in its result, which is load-bearing
  // rather than incidental: `keptEntries` must stay in `Object.entries(PROFILES)`
  // order, because both `--backfill-*` modes and `verify:replay` identify an
  // entry's profile purely by its index in the shipped board.
  const settled = await Promise.all(Object.entries(PROFILES).map(runProfile));
  const keptEntries = settled.filter((entry) => entry !== null);

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

  await writeDefaultHighscoreFile(keptEntries);
  console.log(`\nWrote ${OUTPUT_FILE} — review with \`git diff\` before committing.`);

  // The one path that reaches here without calling `process.exit` — so it is
  // the one path where the `exit` handler above cannot run. See its comment.
  server.stop?.();
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
async function writeDefaultHighscoreFile(entries) {
  const { packBoardForStorage } = await loadEngineModules();
  const packed = await packBoardForStorage(entries);
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
 * The entries are stored binary-frame-packed, then gzipped and base64'd
 * (\`bin1:\` prefix — see \`replayCodec.ts\`) rather than as a plain array
 * literal — see \`writeDefaultHighscoreFile\` in the generator script for why
 * (~350x smaller, and far cheaper for a bundler to parse).
 * \`loadHighscoresForDisplay\` (\`./highscores.ts\`) decodes it at read time via
 * \`readBoard\`, which also still accepts the older \`gz1:\` and bare-JSON forms.
 */

/** Fingerprint of the bot profiles these runs were played by, at generation
 * time — see \`profilesHash\` in \`scripts/lib/profiles.mjs\`. A mismatch means
 * this file is stale and \`npm run generate:default-highscore\` should be re-run. */
export const PROFILES_HASH = "${profilesHash()}";

/** \`HighscoreEntry[]\`, binary-frame-packed + gzip + base64 — decode with
 * \`unpackBoardFromStorage\` from \`./replayCodec\`. */
export const DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED = "${packed}";
`;
  fs.writeFileSync(OUTPUT_FILE, header);
}

main().catch((err) => {
  console.error("generate-default-highscore crashed:", err);
  process.exit(1);
});
