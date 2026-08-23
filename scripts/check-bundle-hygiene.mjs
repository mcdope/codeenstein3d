#!/usr/bin/env node
// Bundle hygiene: fails the build if a `?testHooks=1` automation hook reaches
// `dist/`, or if a deliberately-shipped diagnostic stops reaching it.
//
// Written 2026-08-23, after the guarantee it enforces had been quietly false for
// a month. `doc/dev/history.md`'s "ensure debughooks … are omitted from
// dist/prod builds" item gated every hook behind `isTestHooksActive()` and
// verified by hand that a build stripped them. The next day `398b406` bumped
// vite 6.4.3 -> 8.1.5; vite 8 minifies with rolldown+oxc, which does not inline
// a cross-module call, so the function body kept folding while every call site
// — and every hook object — shipped.
//
// **The original check could not have caught that, and that is the lesson this
// script is built around.** It grepped for the string `"testHooks"`, which lives
// *inside* the folded function body and was therefore absent both before and
// after the regression. It measured the one thing that stayed true. So:
//
//   - assert on the hook GLOBALS, which are the payload, not on a substring of
//     the gate that survives independently of them;
//   - assert in BOTH directions. Absence alone is satisfiable by a build that
//     mangles or drops everything, so the diagnostics that are *meant* to ship
//     are pinned too — otherwise the day they break, this script reports success;
//   - treat "found no bundle to scan" as a failure, never a pass. A check that
//     silently passes on an empty directory is the same class of bug all over.
//
// Usage:
//   node scripts/check-bundle-hygiene.mjs            scan ./dist
//   node scripts/check-bundle-hygiene.mjs --dir <d>  scan <d> (used by the tests)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Globals that must NOT survive a production build.
 *
 * Each is a `window.__codeenstein*` assignment guarded by
 * `TEST_HOOKS_BUILD_ENABLED && isTestHooksActive()`. Deliberately the property
 * names rather than the `"testHooks"` URL param: the param string lives inside
 * `isTestHooksActive`'s folded body and disappears whether or not the guarded
 * blocks do, which is exactly how the 2026-07-26 regression stayed invisible.
 */
const BANNED = [
  "__codeensteinTestHooks",
  "__codeensteinCampaignTestHooks",
  "__codeensteinReplayTestHooks",
  "__codeensteinMultiplayerTestHooks",
];

/**
 * Things that must KEEP shipping, so the absence check above cannot be
 * satisfied by a build that simply lost everything.
 *
 * `__codeensteinPerfStats` is the load-bearing one: it is a *property name*, so
 * it is what a global-mangling change would take out — the one realistic route
 * to a falsely-green absence result. The two URL reads are string literals and
 * survive mangling; they pin a different property, that `?perfDebug=1` and
 * `?ablate` are still reachable in production, which is deliberate (see
 * `engine.ts`'s `resolveAblations` and `perfDebug.ts`) and has been mistaken for
 * an oversight before.
 *
 * Written as regexes with the backticks oxc actually emits. A needle of
 * `"ablate"` matches nothing in the real bundle, and a bare `ablate` matches
 * `ablated(` ~25 times — i.e. it would pass with the feature deleted. Both
 * mistakes are easy and silent, hence the anchoring.
 */
const REQUIRED = [
  { needle: /__codeensteinPerfStats/, why: "the ?perfDebug=1 stats global (a real player-facing diagnostic)" },
  { needle: /\.get\(`perfDebug`\)/, why: "the ?perfDebug URL read" },
  { needle: /\.get\(`ablate`\)/, why: "the ?ablate URL read (must exist in the exact build being measured)" },
];

function jsFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag === -1 ? "dist" : process.argv[dirFlag + 1];

// Every chunk, not just `index-*.js`. There are four today, and this project
// already forces a chunk split with a dynamic import (see `defaultHighscore`),
// so a future lazy-load could relocate a hook block out of the file a
// single-glob check happened to look at.
const files = jsFilesUnder(dir);

if (files.length === 0) {
  console.error(`BUNDLE HYGIENE FAILED — no .js files under ${dir}/`);
  console.error(`
`.trimStart() + "Nothing was scanned, so nothing was proven. Run `npm run build` first.\n");
  process.exit(1);
}

const joined = files.map((f) => readFileSync(f, "utf8")).join("\n");
const failures = [];

for (const name of BANNED) {
  const hits = joined.split(name).length - 1;
  if (hits > 0) failures.push(`${name} appears ${hits}x — a test hook is shipping to players`);
}
for (const { needle, why } of REQUIRED) {
  if (!needle.test(joined)) failures.push(`${needle.source} is missing — ${why}`);
}

if (failures.length === 0) {
  console.log(`bundle hygiene: clean (${files.length} chunk(s), ${BANNED.length} banned, ${REQUIRED.length} required)`);
  process.exit(0);
}

console.error(`\nBUNDLE HYGIENE FAILED — ${failures.length} problem(s) in ${dir}/:\n`);
for (const f of failures) console.error(`  ${f}`);
console.error(`
A banned global means a call site lost its \`TEST_HOOKS_BUILD_ENABLED &&\` term.
Gating on \`isTestHooksActive()\` alone is NOT enough — it is a cross-module call
the minifier does not inline, which is how these shipped for a month unnoticed.
Add the constant back rather than removing this check.

A missing required needle means a diagnostic that is meant to reach production
stopped doing so, or the bundle's shape changed. Do not "fix" it by deleting the
assertion; that would leave the absence checks above satisfiable by an empty build.
`);
process.exit(1);
