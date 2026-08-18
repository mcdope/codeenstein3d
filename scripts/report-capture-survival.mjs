// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Pools a capture directory correctly and prints the two numbers every recent
 * bot A/B was actually judged on: **per-level reach/clear rate** and
 * **levels-reached-per-attempt**.
 *
 * ## Why this exists
 *
 * Neither number was produced by anything committed. They were computed ad hoc
 * each time and then lost, which is how a verdict ends up resting on a figure
 * nobody can regenerate.
 *
 * Worse, the obvious tool is actively wrong for this input.
 * `report-balancing-ab.mjs`'s `loadSide` merges a directory's `*.json` with
 * `{ ...merged.profiles[name], ...profile }` — a spread at the *difficulty*
 * level. A capture writes one file per chunk (`Casual-hard-001.json`,
 * `-002`, …), each carrying the same `profiles.Casual.hard` key, so **the last
 * chunk read silently replaces every earlier one**. No error, output that looks
 * entirely normal, computed from a fraction of the data. That tool is built for
 * the 4-combo telemetry protocol, where one file *is* the whole side.
 *
 * ## What "pooling" means here, and what it cannot mean
 *
 * Counts add: `attemptsUsed`, `trueQualifyingCount`, and each level's
 * `sampleCount`. Means do **not** — a chunk's `campaignAggregate` is an average
 * over that chunk's runs, and averaging averages over unequal denominators is
 * how you get a number that is nobody's experience. So this pools counts only
 * and says so; anything mean-shaped belongs to `report-aim-error.mjs` and the
 * event log, which pool at the event level.
 *
 * `sampleCount` is "attempts that produced a snapshot for this level", i.e.
 * attempts that *reached* it. Reach is the honest primitive: an attempt that
 * reached level N necessarily cleared N-1, while "cleared" for the deepest
 * level an attempt touches is ambiguous (it may have died there). So the
 * conditional rate printed is reach(N+1)/reach(N) — the share of attempts that
 * got *through* N — and `levelsReachedPerAttempt` is the summary scalar, which
 * is monotone in the same direction as levels-cleared-per-attempt and needs no
 * such judgement call.
 *
 * ## Reading it
 *
 *   node scripts/report-capture-survival.mjs <dir> [<dir> …]
 *
 * With two or more directories it prints them side by side. It does **not**
 * compute significance: with a null-control arm in the set, the control-vs-
 * control difference is the noise floor, and that is the comparison to read
 * first. A treatment inside it is a null however small its p-value looks.
 */
import fs from "node:fs";
import path from "node:path";

/** Every chunk JSON in a capture directory, or the file itself. */
function chunkFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(target, f));
}

/**
 * Pool one capture directory into `{ combos, flags, chunkCount }`.
 *
 * Every chunk's `meta.flags` is checked against the first: a capture whose
 * chunks disagree about `effectiveStepMs` is not one arm, it is two, and
 * silently pooling them would be exactly the mistake this file exists to stop.
 */
export function poolCapture(target) {
  const files = chunkFiles(target);
  if (files.length === 0) throw new Error(`no chunk JSON in ${target}`);

  const combos = new Map();
  let flags = null;
  const flagMismatches = [];

  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const f = json.meta?.flags ?? {};
    if (flags === null) {
      flags = f;
    } else {
      for (const key of ["effectiveStepMs", "effectiveRecordStepMs", "effectiveTicksScale", "extraQuery"]) {
        if (JSON.stringify(flags[key]) !== JSON.stringify(f[key])) {
          flagMismatches.push(`${path.basename(file)}: ${key} ${JSON.stringify(flags[key])} -> ${JSON.stringify(f[key])}`);
        }
      }
    }

    for (const [profileName, profile] of Object.entries(json.profiles ?? {})) {
      for (const [difficulty, combo] of Object.entries(profile)) {
        if (difficulty === "crossDifficultyFlags") continue;
        const key = `${profileName}/${difficulty}`;
        const acc = combos.get(key) ?? { key, attempts: 0, qualifying: 0, reach: [], filenames: [] };
        acc.attempts += combo.attemptsUsed ?? 0;
        // `trueQualifyingCount`, never `qualifyingRunCount` — the latter is
        // floored at the target and stops counting once the cell is satisfied.
        acc.qualifying += combo.trueQualifyingCount ?? 0;
        for (const level of combo.levels ?? []) {
          const i = level.levelIndex;
          acc.reach[i] = (acc.reach[i] ?? 0) + (level.runtime?.sampleCount ?? 0);
          acc.filenames[i] ??= level.filename;
        }
        combos.set(key, acc);
      }
    }
  }
  return { combos: [...combos.values()], flags, chunkCount: files.length, flagMismatches };
}

/** Total level-reaches per attempt — the summary scalar. */
function levelsReachedPerAttempt(combo) {
  if (!combo.attempts) return null;
  const total = combo.reach.reduce((a, b) => a + (b ?? 0), 0);
  return total / combo.attempts;
}

function pct(n, d) {
  if (!d) return "  --";
  return `${((n / d) * 100).toFixed(0)}%`.padStart(4);
}

function main(argv) {
  if (argv.length === 0) {
    console.error("usage: node scripts/report-capture-survival.mjs <capture-dir> [<capture-dir> …]");
    return 2;
  }
  const arms = argv.map((dir) => ({ dir, ...poolCapture(path.resolve(dir)) }));

  for (const arm of arms) {
    const f = arm.flags ?? {};
    console.log(
      `\n## ${path.basename(arm.dir)}  (${arm.chunkCount} chunks)  ` +
        `step=${f.effectiveStepMs} record=${f.effectiveRecordStepMs} ticksScale=${f.effectiveTicksScale}` +
        `${f.extraQuery ? ` query=${f.extraQuery}` : ""}`,
    );
    if (arm.flagMismatches.length) {
      console.log("  !! CHUNKS DISAGREE ON CONFIGURATION — this is not one arm:");
      for (const m of arm.flagMismatches) console.log(`     ${m}`);
    }
    for (const c of arm.combos) {
      console.log(`  ${c.key}: ${c.attempts} attempts, ${c.qualifying} qualifying, ${levelsReachedPerAttempt(c)?.toFixed(2)} levels/attempt`);
    }
  }

  // Per-level reach, side by side. Rows are levels; one block per combo so two
  // profiles with different curves are never averaged into a shape neither has.
  const comboKeys = [...new Set(arms.flatMap((a) => a.combos.map((c) => c.key)))].sort();
  for (const key of comboKeys) {
    console.log(`\n## ${key} — attempts reaching each level\n`);
    const cols = arms.map((a) => ({ name: path.basename(a.dir).replace(/^balancing_capture_step_/, ""), combo: a.combos.find((c) => c.key === key) }));
    const depth = Math.max(...cols.map((c) => c.combo?.reach.length ?? 0));
    const head = cols.map((c) => c.name.padStart(14)).join("");
    console.log(`  lvl  file                  ${head}`);
    for (let i = 0; i < depth; i++) {
      const file = (cols.find((c) => c.combo?.filenames[i])?.combo.filenames[i] ?? "").slice(0, 20).padEnd(21);
      const cells = cols
        .map((c) => {
          const n = c.combo?.reach[i] ?? 0;
          const d = c.combo?.attempts ?? 0;
          return `${String(n).padStart(5)}${pct(n, d).padStart(9)}`;
        })
        .join("");
      console.log(`  ${String(i + 1).padStart(3)}  ${file}${cells}`);
    }
  }
  console.log(
    "\nCounts are pooled; means are not (a chunk's campaignAggregate averages over that\n" +
      "chunk's runs, and averaging those over unequal denominators is meaningless).\n" +
      "With a null-control arm present, read control-vs-control FIRST — that spread is\n" +
      "the noise floor, and anything inside it is a null however small its p looks.",
  );
  return 0;
}

/* v8 ignore start -- CLI entry, exercised by running the script @preserve */
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* v8 ignore stop */
