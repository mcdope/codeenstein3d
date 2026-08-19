// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Grades whether the bot's three skill tiers are actually distinguishable.
 *
 *   node scripts/report-profile-separation.mjs <dir-or-file> [difficulty]
 *
 * Takes either one telemetry JSON containing all three profiles, or a
 * directory of per-profile captures (what a per-profile sweep writes) — the
 * same two shapes `report-balancing-ab.mjs` accepts for one side.
 *
 * **Exits non-zero when the ladder fails**, so it can gate a change the way
 * `report-balancing-ab.mjs` gates a regression. A tier ladder nobody checks
 * stops being a ladder: `enemyAccuracy` was inverted for an unknown length of
 * time, and every per-tier conclusion drawn in that window was noise.
 */
import fs from "node:fs";
import path from "node:path";
import { formatSeparation, gradeSeparation, LADDER } from "./lib/profileSeparation.mjs";

/** Merge one file or a directory of files into `{ profile: { difficulty: combo } }`. */
/**
 * Refuse a *chunked capture* directory instead of silently reading one chunk of it.
 *
 * A capture writes one file per invocation, every one carrying the same
 * `profiles.<name>.<difficulty>` key — so a spread-merge keeps only the last
 * file read, with no error and entirely normal-looking output computed from a
 * fraction of the data. Measured 2026-08-19 against a live capture: 5 attempts
 * reported where there were 10, from three chunks; a finished arm has ~33.
 *
 * This tool compares *aggregates* (means over a run set), and means cannot be
 * pooled by merging — they would need re-weighting by each chunk's own sample
 * counts. Rather than guess at that, refuse and point at the tool that pools
 * counts correctly.
 */
function assertNotChunkedCapture(target, files) {
  if (files.length < 2) return;
  const seen = new Map();
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [profileName, byDifficulty] of Object.entries(json.profiles ?? {})) {
      for (const difficulty of Object.keys(byDifficulty)) {
        if (difficulty === "crossDifficultyFlags") continue;
        const key = `${profileName}/${difficulty}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }
  const chunked = [...seen.entries()].filter(([, n]) => n > 1);
  if (chunked.length === 0) return;
  const [example, n] = chunked[0];
  throw new Error(
    `${target} looks like a chunked capture: ${example} appears in ${n} of ${files.length} files.\n` +
      `This tool merges by profile/difficulty, so it would silently report only the last chunk.\n` +
      `Use \`npm run report:capture-survival <dir>\` for per-level rates and levels-per-attempt,\n` +
      `and \`npm run report:aim-error <dir>\` for hit rates — both pool a capture correctly.`,
  );
}

function loadCapture(target) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith(".json")).map((f) => path.join(target, f))
    : [target];
  assertNotChunkedCapture(target, files);
  const merged = {};
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, byDifficulty] of Object.entries(json.profiles ?? {})) {
      merged[name] = { ...(merged[name] ?? {}), ...byDifficulty };
    }
  }
  return merged;
}

function main() {
  const [target, difficultyArg] = process.argv.slice(2);
  if (!target) {
    console.error("usage: node scripts/report-profile-separation.mjs <dir-or-file> [difficulty]");
    process.exit(2);
  }
  const merged = loadCapture(target);
  // Default to whichever difficulty every present profile actually shares, so
  // a capture that only ran `normal` doesn't need the argument spelled out.
  const shared = LADDER.map((n) => Object.keys(merged[n] ?? {})).filter((ks) => ks.length > 0);
  const difficulty = difficultyArg ?? (shared.length > 0 ? shared[0].find((d) => shared.every((ks) => ks.includes(d))) : undefined);
  if (!difficulty) {
    console.error("could not determine a difficulty shared by every profile — pass one explicitly");
    process.exit(2);
  }

  const byProfile = Object.fromEntries(LADDER.map((n) => [n, merged[n]?.[difficulty]]));
  const attempts = LADDER.map((n) => byProfile[n]?.attemptsUsed).filter(Boolean);
  console.log(`profile separation @ difficulty=${difficulty}  (attempts: ${attempts.join("/") || "?"})\n`);

  const result = gradeSeparation(byProfile);
  for (const line of formatSeparation(result)) console.log(line);
  process.exit(result.pass ? 0 : 1);
}

main();
