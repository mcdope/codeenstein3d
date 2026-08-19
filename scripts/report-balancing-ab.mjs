// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Compare two `run-balancing-telemetry.mjs` output files and print the guard
 * and win metrics side by side.
 *
 *   node scripts/report-balancing-ab.mjs <baseline.json> <candidate.json>
 *   node scripts/report-balancing-ab.mjs ab/base ab/cand      # directories
 *
 * Directory mode exists because the documented A/B protocol runs one file per
 * profile×difficulty combo (`CODEENSTEIN_TELEMETRY_PROFILE` /
 * `_DIFFICULTY` narrow each run to one combo, so a full sweep is several
 * files). Given two directories it merges every `*.json` in each into one
 * `profiles` tree before diffing, so both single-file and per-combo layouts
 * work without the operator having to think about which they produced.
 *
 * Exits non-zero if any combo breaches a rollback threshold, so this can gate a
 * stage in a shell chain. **Read the numbers anyway** — a passing guard means
 * "not obviously worse", never "the stage achieved its win". See
 * `scripts/lib/abReport.mjs` for why the two kinds of metric are kept apart.
 *
 * Not CI-wired, for the same reason nothing else in the balancing stack is: a
 * matched-scale A/B is hours of bot play, not a per-push check.
 */
import fs from "node:fs";
import path from "node:path";
import { diffTelemetry, formatComboDiff, checkRollback } from "./lib/abReport.mjs";

/**
 * Load one side of the comparison. A directory is merged into a single
 * telemetry-shaped object; a file is read as-is.
 *
 * Merging is a deliberate deep-ish merge at the profile level rather than a
 * shallow `Object.assign`: two per-combo files for the same profile carry the
 * same profile key with different difficulty keys under it, and a shallow
 * merge would drop the first one.
 */
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

export function loadSide(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return JSON.parse(fs.readFileSync(target, "utf8"));

  const files = fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`no .json files in ${target}`);
  assertNotChunkedCapture(target, files.map((f) => path.join(target, f)));

  const merged = { meta: null, profiles: {} };
  for (const f of files) {
    const json = JSON.parse(fs.readFileSync(path.join(target, f), "utf8"));
    merged.meta ??= json.meta ?? null;
    for (const [profileName, profile] of Object.entries(json.profiles ?? {})) {
      merged.profiles[profileName] = { ...(merged.profiles[profileName] ?? {}), ...profile };
    }
  }
  return merged;
}

function main(argv) {
  const [basePath, candPath] = argv;
  if (!basePath || !candPath) {
    console.error("usage: node scripts/report-balancing-ab.mjs <baseline.json|dir> <candidate.json|dir>");
    return 2;
  }

  const base = loadSide(basePath);
  const cand = loadSide(candPath);
  const { combos, missing, flags } = diffTelemetry(base, cand);

  // Surfaced before any numbers, because a scoping mismatch doesn't skew the
  // comparison — it invalidates it, and reading the table first anchors you to
  // a conclusion you then have to un-learn.
  if (flags.comparable && flags.mismatches.length > 0) {
    console.error("REFUSING TO COMPARE — the two runs were not scoped the same way:");
    for (const m of flags.mismatches) console.error(`  ${m}`);
    console.error("Re-run one side with matching settings. A difference here changes what was measured, not just how much of it.");
    return 2;
  }
  if (!flags.comparable) {
    console.log("note: one side predates run-flag recording, so identical scoping could not be verified.\n");
  }

  if (combos.length === 0) {
    console.error("no profile/difficulty combos present in both sides — nothing to compare");
    return 2;
  }

  for (const { label, diff } of combos) {
    console.log(formatComboDiff(label, diff));
    console.log("");
  }

  if (missing.length > 0) {
    console.log(`NOT COMPARED (present in baseline only): ${missing.join(", ")}`);
    console.log("");
  }

  const breached = combos.filter(({ diff }) => checkRollback(diff).length > 0);
  if (breached.length > 0) {
    console.log(`ROLLBACK: ${breached.length} of ${combos.length} combos breached a guard threshold.`);
    return 1;
  }
  console.log(`Guards pass on all ${combos.length} compared combos. Now read the win metrics above — passing guards is not a win.`);
  return 0;
}

// Only run when invoked directly, so the tests can import `loadSide` without
// the CLI firing on import — the same guard `multiplayer-server.mjs` uses.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
