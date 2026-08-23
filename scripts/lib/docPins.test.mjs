// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Pins the numbers and enumerations that documentation mirrors out of `src/`.
 *
 * **Why this exists.** `constantMirrors.test.mjs` next door was written because
 * `ROCKET_TRAVEL_SPEED` sat in `combatPolicy.mjs` as a hand-typed copy of a
 * constant it did not track, and nothing in the build could notice: *a mirror
 * with no link is exactly as correct as whoever last typed it.* Prose is the
 * same mirror with the same absent link. The 2026-08-20 docs audit found the
 * identical defect a dozen times over — `README.md` still said one extra enemy
 * per **10** complexity a day after the constant became 5, `mechanics.md`
 * still said **four** ammo pools with the shotgun on `bullets`,
 * `adding-a-weapon.md` still charged the `ammoBonus` divisor at **4**, and
 * `balancing-telemetry.md`'s balance reference still opened with "there are no
 * magazines, no reload" five days after magazines shipped.
 *
 * So this file points the existing mechanism at documentation. Two kinds of
 * check, and the second is the one worth having:
 *
 * 1. **Value pins** — a phrase is *built from* the real constant and asserted
 *    to appear in the doc. Retune the constant and the doc no longer contains
 *    the generated sentence, so the test names the file and the exact wording
 *    to write.
 * 2. **Enumeration pins** — every member of a real collection (ammo pools,
 *    gore tiers, feature flags, reloadable weapons) must appear in the doc that
 *    claims to list them. These catch the *never-written* half, which no value
 *    pin can: the three floor-cast feature flags were absent from
 *    `architecture.md`'s table for three weeks because nothing knew to look.
 *
 * **What this deliberately does not do.** It does not check prose for meaning,
 * and it cannot tell you a sentence has become misleading — only that a number
 * or a name no longer matches. A pin is a tripwire on the mechanical half of
 * doc drift, not a substitute for reading the page.
 *
 * **Failure is a doc edit, not a test edit.** If a pin goes red because a
 * constant moved deliberately, fix the sentence in the named file. Change the
 * pin only when the *wording* around the number changes.
 *
 * Vitest resolves the `.ts` imports through Vite's transform, exactly as
 * `constantMirrors.test.mjs` does, so a plain-`.mjs` test reads the real
 * modules. `scripts/**` is outside the `src/` coverage denominator but is still
 * executed by `vitest run`, so this runs in CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DIFFICULTY_MULTIPLIERS, ROLLBACKS_BY_DIFFICULTY } from "../../src/difficulty";
import { AMMO_META, AMMO_TYPES, CARRYOVER_CAP_MULTIPLE, STARTING_SHELLS } from "../../src/engine/ammo";
import {
  ATTACK_DAMAGE,
  EDGE_CASE_DAMAGE_MULTIPLIER,
  ELITE_DAMAGE_MULTIPLIER,
  ENEMY_WEAPONS,
  PROJECTILE_DAMAGE,
} from "../../src/engine/combatConstants";
import { GORE_MULTIPLIERS } from "../../src/engine/effects";
import { TOOL_SLOTS } from "../../src/engine/hudLayout";
import {
  AMMO_SCALE_REFERENCE_HP,
  ELITE_BONUS_WEAPON_DROP_CHANCE,
  NORMAL_KILL_WEAPON_DROP_CHANCE,
  HEALTH_SCALE_REFERENCE_HP,
  REGULAR_KILL_NO_DROP_CHANCE,
  SHELLS_DROP_AMOUNT,
} from "../../src/engine/loot";
import { MISS_CHANCE_TOOLCHAIN_DROP_CHANCE } from "../../src/engine/lootApply";
import { NUMBER_KEY_WEAPONS, WEAPONS } from "../../src/engine/weapons";
import { MAX_TREE_PAGES } from "../../src/fs/remoteHost";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * A module-private constant's value, read from its own definition.
 *
 * Most of the generation constants documentation quotes (`MAX_SECRET_ROOMS`,
 * `COMPLEXITY_PER_EXTRA_ENEMY`, the Elite ceiling) are deliberately
 * module-private and have long doc comments explaining why. Widening their
 * visibility just to test a sentence would be the tail wagging the dog, and
 * re-typing the value here would reproduce the exact defect this file exists to
 * stop. Reading the definition is the third option: still linked, no API
 * change. Throws rather than returning `undefined` if the name moves, because a
 * renamed constant is itself a reason to re-read the docs that cite it.
 */
function constantFromSource(rel, name) {
  const source = read(rel);
  const match = source.match(new RegExp(`^(?:export )?const ${name}\\s*(?::[^=]+)?=\\s*([0-9.]+);`, "m"));
  if (!match) throw new Error(`${name} not found in ${rel} — renamed or removed? Re-read the docs citing it.`);
  return Number(match[1]);
}

/**
 * Every `export const X_ENABLED` under `src/`, with its file and its default.
 *
 * **`value` is `null` when the default is not a boolean literal**, and that
 * case is the reason this comment is long. The regex used to be
 * `= (true|false);`, which reads as "every flag" and is not: it silently
 * skipped `TEST_HOOKS_BUILD_ENABLED = import.meta.env.DEV`, so 13 flags existed
 * while the pinned table had 12 rows and the enumeration pin passed. An
 * enumeration pin that quietly excludes members is worse than none, because it
 * reads as coverage. Match the declaration, then decide what to assert about
 * the default — never filter the collection by what is convenient to assert.
 */
function featureFlags() {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        const rel = full.slice(repoRoot.length).replace(/^\//, "");
        for (const m of readFileSync(full, "utf8").matchAll(/^export const ([A-Z0-9_]+_ENABLED) = ([^;]+);/gm)) {
          const literal = /^(true|false)$/.test(m[2].trim()) ? m[2].trim() : null;
          found.push({ name: m[1], value: literal, expr: m[2].trim(), file: rel });
        }
      }
    }
  };
  walk(join(repoRoot, "src"));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Asserts `phrase` — built from a real constant — appears in the doc. */
function pin(rel, phrase) {
  const text = read(rel);
  expect(
    text.includes(phrase),
    `${rel} no longer contains the pinned wording:\n\n  ${phrase}\n\nA constant moved. Fix the sentence in ${rel} (not this test) unless the wording itself changed.`,
  ).toBe(true);
}

const RELOADABLE = WEAPONS.filter((w) => w.magazineSize !== undefined);

describe("README — level generation and arsenal", () => {
  it("states the enemy-density curve at the real threshold", () => {
    const per = constantFromSource("src/map/generation/enemies.ts", "COMPLEXITY_PER_EXTRA_ENEMY");
    // The exact sentence that was wrong for a day: it read "per 10" while the
    // constant said 5, which is a 2x error in the first thing a reader learns
    // about how their code becomes a fight.
    pin("README.md", `one enemy below complexity ${per}, then one more per ${per} on top`);
  });

  it("states the HP rate and Elite tier at the real constants", () => {
    const hp = constantFromSource("src/map/generation/enemies.ts", "HP_PER_COMPLEXITY");
    const threshold = constantFromSource("src/map/generation/enemies.ts", "ELITE_COMPLEXITY_THRESHOLD");
    const members = constantFromSource("src/map/generation/enemies.ts", "ELITE_MAX_MEMBERS");
    pin("README.md", `cyclomatic_complexity × ${hp}\` HP`);
    pin("README.md", `At complexity ≥ ${threshold} the room becomes an **Elite pack**`);
    pin("README.md", `split across up to ${members} members`);
  });

  it("lists each weapon's magazine at the size the weapon table gives it", () => {
    const [pistol, shotgun, gdb, ghidra] = ["echo pistol", "Regex Shotgun", "gdb", "ghidra"].map(
      (n) => WEAPONS.find((w) => w.name === n).magazineSize,
    );
    pin("README.md", `(${pistol} pistol, ${shotgun} shells, ${gdb} gdb, ${ghidra} rocket)`);
  });
});

describe("player guide — mechanics, controls and the HUD", () => {
  it("counts the ammo pools", () => {
    // Said "four" for five days after `shells` shipped, in the same file whose
    // loot section listed shells three paragraphs further down.
    pin("doc/user/mechanics.md", `draw from ${numberWord(AMMO_TYPES.length)} separate ammo pools`);
  });

  it("gives the reloading paragraph every reloadable weapon's real magazine", () => {
    const sizes = Object.fromEntries(RELOADABLE.map((w) => [w.name, w.magazineSize]));
    pin(
      "doc/user/controls.md",
      `**${sizes["echo pistol"]}** rounds for the echo pistol, **${sizes["Regex Shotgun"]}** shells for the Regex Shotgun, **${sizes.gdb}** for gdb`,
    );
  });

  it("names every ammo pool's status-bar shorthand", () => {
    // The status bar's table is fixed-width, so a new pool needs a `short`
    // *and* a mention here — neither is derivable from the other.
    const doc = read("doc/user/hud-and-ui.md");
    for (const type of AMMO_TYPES) {
      const short = AMMO_META[type].short;
      expect(doc.includes(`\`${short}\``), `hud-and-ui.md never mentions the '${short}' ammo row`).toBe(true);
    }
  });

  it("lists every gore tier the settings dropdown can show", () => {
    const tiers = Object.keys(GORE_MULTIPLIERS).map((t) => t[0].toUpperCase() + t.slice(1));
    pin("doc/user/hud-and-ui.md", tiers.join(" / "));
    pin("README.md", `(${tiers.join("/")}`);
  });

  it("states the difficulty table at the real multipliers", () => {
    const d = DIFFICULTY_MULTIPLIERS;
    pin("doc/user/mechanics.md", `| Easy | ×${d.easy.hp} | ×${d.easy.damage} |`);
    pin("doc/user/mechanics.md", `| Hard | ×${d.hard.hp} | ×${d.hard.damage} |`);
    pin("doc/user/mechanics.md", `up to ±${d.easy.enemyAimSpreadDeg}° per shot`);
  });

  it("states the rollback counts at the real values", () => {
    const r = ROLLBACKS_BY_DIFFICULTY;
    // Hard is 0, which the player docs spell "none" rather than printing a
    // zero — so the pin renders it the same way. Still driven by the real
    // constant: give Hard a rollback back and every one of these stops
    // matching until the prose is updated too.
    const word = (n) => (n === 0 ? "none" : String(n));
    pin("doc/user/mechanics.md", `| ×0.7 | ×0.85 | Sloppy — random deviation up to ±10° per shot | ×1.3 | ${r.easy} |`);
    pin("doc/user/mechanics.md", `| ×1 | ×1 | Slightly off — up to ±4° | ×1 | ${r.normal} |`);
    pin("doc/user/mechanics.md", `| ×1.5 | ×1.5 | Dead-on — no deviation at all | ×0.7 | ${word(r.hard)} |`);
    pin("doc/user/mechanics.md", `**${r.easy} on Easy, ${r.normal} on Normal, and ${word(r.hard)} at all on Hard**`);
    pin("doc/user/getting-started.md", `**${r.easy} on Easy, ${r.normal} on Normal, ${word(r.hard)} on Hard**`);
    pin("doc/user/hud-and-ui.md", `(${r.easy} / ${r.normal} / ${word(r.hard)})`);
    pin("README.md", `(${r.easy} Easy / ${r.normal} Normal / ${r.hard} Hard)`);
  });

  it("states the drop odds at the real rates", () => {
    pin("doc/user/mechanics.md", `roughly 1 in ${1 / REGULAR_KILL_NO_DROP_CHANCE} regular kills drop no ammo/swap`);
    pin("doc/user/mechanics.md", `very small (${NORMAL_KILL_WEAPON_DROP_CHANCE * 100}%) chance`);
    pin("doc/user/mechanics.md", `separate ${ELITE_BONUS_WEAPON_DROP_CHANCE * 100}% chance`);
    pin("doc/user/mechanics.md", `small extra chance (${MISS_CHANCE_TOOLCHAIN_DROP_CHANCE * 100}%)`);
  });

  it("states the generator's caps at the real caps", () => {
    pin("doc/user/level-design.md", `caps out at ${constantFromSource("src/map/generation/lore.ts", "MAX_LORE_TERMINALS")} lore terminals`);
    pin("doc/user/level-design.md", `caps at ${constantFromSource("src/map/generation/switchboards.ts", "MAX_CASE_ROOMS_PER_HUB")} spurs`);
    pin("doc/user/level-design.md", `capped at ${numberWord(constantFromSource("src/map/generation/vendorDepots.ts", "MAX_VENDOR_DEPOTS"))}`);
    pin("doc/user/mechanics.md", `tops out at ${constantFromSource("src/map/generation/secretRooms.ts", "MAX_SECRET_ROOMS")} of them`);
  });

  it("states the remote-host page cap at the real cap", () => {
    pin("doc/user/troubleshooting.md", `stops after ${MAX_TREE_PAGES} pages`);
    pin("CHANGELOG.md", `stop after ${MAX_TREE_PAGES} pages`);
  });
});

describe("developer docs — the reference tables a change has to move with it", () => {
  it("documents every feature flag, with its shipping default and owning file", () => {
    // The check that catches the never-written half. Three floor-cast flags
    // shipped during the 2026-08 frame-budget audit and none reached this
    // table; nothing could notice, because a missing row looks like nothing.
    const doc = read("doc/dev/architecture.md");
    for (const flag of featureFlags()) {
      expect(doc.includes(`\`${flag.name}\``), `architecture.md's Feature Flags table has no row for ${flag.name} (${flag.file})`).toBe(true);
      const row = doc.split("\n").find((l) => l.includes(`\`${flag.name}\``) && l.startsWith("|"));
      expect(row, `${flag.name} is mentioned in architecture.md but not as a table row`).toBeTruthy();
      // A non-literal default (`import.meta.env.DEV`) has no `true`/`false` to
      // pin, so the row is only required to quote the expression. The row must
      // still exist — that is the half this pin is actually for.
      const expected = flag.value === null ? flag.expr : flag.value;
      expect(
        row.includes(`\`${expected}\``),
        `architecture.md gives ${flag.name} the wrong default (source says ${expected})`,
      ).toBe(true);
      expect(row.includes(`\`src/${flag.file.replace(/^src\//, "")}\``), `architecture.md points ${flag.name} at the wrong file (source: ${flag.file})`).toBe(true);
    }
  });

  it("pins the quantities the 2026-08-24 audit found rotting unpinned", () => {
    // Every one of these had drifted in at least one doc, and nothing could
    // notice. Edge Case HP was the worst: stated correctly in two places and
    // contradicted in two others, all in the same file.
    const enemies = "src/map/generation/enemies.ts";
    const lo = constantFromSource(enemies, "EDGE_CASE_HP_MIN");
    const hi = constantFromSource(enemies, "EDGE_CASE_HP_MAX");
    pin("doc/dev/balancing-telemetry.md", `${lo}\u2013${hi} uniform`);
    pin("doc/dev/game-design.md", `(${lo}-${hi} HP since the enemy-health pass)`);

    const cap = constantFromSource(enemies, "ELITE_MEMBER_HP_CAP");
    const members = constantFromSource(enemies, "ELITE_MAX_MEMBERS");
    pin("doc/dev/balancing-telemetry.md", `\`ELITE_MAX_MEMBERS = ${members}\``);
    pin("doc/dev/balancing-telemetry.md", `\`ELITE_MEMBER_HP_CAP = ${cap}\``);
    // The derived room ceiling, written with a thousands separator the way the
    // prose does. Pinned separately because it is the number a reader acts on.
    expect(
      read("doc/dev/balancing-telemetry.md").includes(`${(cap * members).toLocaleString("en-US")} base`),
      `balancing-telemetry.md's Elite room ceiling is stale (source: ${cap} x ${members})`,
    ).toBe(true);

    pin("doc/dev/balancing-telemetry.md", `\`CARRYOVER_CAP_MULTIPLE = ${CARRYOVER_CAP_MULTIPLE}\``);
    pin("doc/dev/decisions.md", `\`CARRYOVER_CAP_MULTIPLE = ${CARRYOVER_CAP_MULTIPLE}\``);
    pin("doc/dev/balancing-telemetry.md", `\`AMMO_SCALE_REFERENCE_HP = ${AMMO_SCALE_REFERENCE_HP}\``);
    pin("doc/dev/balancing-telemetry.md", `\`HEALTH_SCALE_REFERENCE_HP = ${HEALTH_SCALE_REFERENCE_HP}\``);
    pin("doc/dev/decisions.md", `\`AMMO_SCALE_REFERENCE_HP = ${AMMO_SCALE_REFERENCE_HP}\``);
  });

  it("lists every highscore-board column the panel actually renders", () => {
    // Enumeration pin: `hud-and-ui.md` describes the board in prose, and the
    // Difficulty and RB columns were added without it. Reads the real <th>
    // list so a future column cannot be added silently either.
    const header = read("src/ui/highscorePanel.ts").match(/<tr>(<th[^]*?)<\/tr>/)[1];
    const columns = [...header.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(columns.length, "highscorePanel.ts's header row did not parse").toBeGreaterThan(5);
    // Scoped to the Highscores section, not the whole page. Mutation-testing
    // this pin is what showed why: matched against the whole file, adding a
    // "Streak" column passed, because the end-of-level stats table two
    // sections up happens to contain the word "Streaks". A document-wide
    // substring search over short column names is close to vacuous.
    const page = read("doc/user/hud-and-ui.md");
    const start = page.indexOf("\n## Highscores\n");
    expect(start, "hud-and-ui.md has no Highscores section").toBeGreaterThan(-1);
    const after = page.indexOf("\n## ", start + 1);
    const doc = page.slice(start, after === -1 ? undefined : after).toLowerCase();
    // `#` and `Hash` are described rather than named, so they are exempt by
    // name; everything else must appear as a word in the prose.
    const described = new Set(["#", "Hash"]);
    const missing = columns.filter((c) => !described.has(c) && !doc.includes(c.toLowerCase()));
    expect(missing, `hud-and-ui.md's highscore paragraph never mentions: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists every localStorage key the game writes in privacy.md", () => {
    // Enumeration pin, and the one with teeth: privacy.md is the page a reader
    // checks to see what persists, and it had fallen three keys behind. Reads
    // the literals out of `src/` rather than a maintained list.
    const keys = new Set();
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
          for (const m of readFileSync(full, "utf8").matchAll(/"(codeenstein-[a-z-]+)"/g)) keys.add(m[1]);
      }
    };
    walk(join(repoRoot, "src"));
    // Two exemptions, each for a stated reason rather than convenience:
    // `-rollbacks-disabled` is harness-only (nothing in the UI writes it, and
    // it is read solely under `isTestHooksActive()`), and `-workspace` /
    // `-bgm-folder` are `showDirectoryPicker` ids the browser owns, not
    // localStorage — privacy.md covers those in prose instead of the table.
    const notStored = new Set(["codeenstein-rollbacks-disabled", "codeenstein-workspace", "codeenstein-bgm-folder"]);
    const doc = read("doc/user/privacy.md");
    const missing = [...keys].filter((k) => !notStored.has(k) && !doc.includes(k)).sort();
    expect(missing, `privacy.md's storage table never mentions: ${missing.join(", ")}`).toEqual([]);
  });

  it("counts the engine and multiplayer modules", () => {
    const count = (dir) =>
      readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).length;
    pin("doc/dev/architecture.md", `(${count("src/engine")} modules)`);
    pin("doc/dev/architecture.md", `(${count("src/multiplayer")} modules)`);
  });

  it("counts the verify scripts and how many drive a browser", () => {
    const pkg = JSON.parse(read("package.json"));
    const scripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith("verify:"));
    const isBrowser = ([, cmd]) => {
      const file = cmd.match(/scripts\/([\w.-]+\.mjs)/)[1];
      return /playwright|browserEngine/.test(read(`scripts/${file}`));
    };
    const browser = scripts.filter(isBrowser).length;
    pin("README.md", `There are ${scripts.length} further \`npm run verify:*\` scripts — ${browser} of them driving the real app through Playwright`);

    // The CI subset is its own number and drifts separately: two scripts are
    // deliberately not wired (`verify:event-log`, `verify:multiplayer-campaign`).
    const workflow = read(".github/workflows/verify.yml");
    const inCi = scripts.filter(([name]) => workflow.includes(`npm run ${name}\n`) || workflow.includes(`npm run ${name} `));
    pin("README.md", `plus ${inCi.length} verify scripts in CI\n(${inCi.filter(isBrowser).length} of them Playwright-driven)`);
  });

  it("counts the ammo pools in the add-a-weapon checklist, including the score divisor", () => {
    // Both went stale together when `shells` landed, and the divisor is the
    // expensive one: leaving it at 4 silently rescales every score in the game.
    pin("doc/dev/adding-a-weapon.md", `\`AmmoType\` is a ${numberWord(AMMO_TYPES.length)}-member union`);
    pin("doc/dev/adding-a-weapon.md", `(currently \`/ ${AMMO_TYPES.length}\`, one per pool`);
    pin("doc/dev/adding-a-weapon.md", `\`TOOL_SLOTS\``);
  });

  it("keeps the TOOLS grid one cell per number-key weapon", () => {
    // Not prose-only: `hud.test.ts` pins the same equality. Repeated here so
    // the doc claim and the layout constant fail together rather than one at a
    // time, which is what makes the checklist entry above worth trusting.
    expect(TOOL_SLOTS).toBe(NUMBER_KEY_WEAPONS.length);
  });

  it("states the balance reference's weapon table at the real weapon values", () => {
    const doc = read("doc/dev/balancing-telemetry.md");
    for (const w of RELOADABLE) {
      const row = doc.split("\n").find((l) => l.startsWith("|") && l.includes(`| ${w.name} |`));
      expect(row, `balancing-telemetry.md's weapon table has no row for ${w.name}`).toBeTruthy();
      expect(
        row.includes(`| ${w.magazineSize} / ${w.reloadSec.toFixed(1)} s |`),
        `${w.name}'s magazine/reload row is stale (source: ${w.magazineSize} / ${w.reloadSec.toFixed(1)}s)`,
      ).toBe(true);
      expect(row.includes(`${w.ammoType}`), `${w.name}'s pool is stale in balancing-telemetry.md (source: ${w.ammoType})`).toBe(true);
      // Added 2026-08-24. This pin looked like it covered the weapon table and
      // did not: it read `magazineSize`/`reloadSec`/`ammoType` and nothing
      // else, so gdb's 12 -> 16 moved the Dmg/pellet column with nothing
      // watching, and the doc happened to be right only because the same
      // commit edited it by hand.
      expect(
        row.includes(`| ${w.damagePerPellet} | ${w.pellets} |`),
        `${w.name}'s damage/pellets are stale in balancing-telemetry.md (source: ${w.damagePerPellet} / ${w.pellets})`,
      ).toBe(true);
    }
  });

  it("states the balance reference's archetype bolt damage per archetype", () => {
    // Read 8 / 16 / 3.2 for a day after `ENEMY_WEAPONS` made each archetype's
    // bolt its own weapon — the Elite's was out by a factor of two.
    const dmg = (a) => ENEMY_WEAPONS[a].damage;
    expect(dmg("elite")).toBe(PROJECTILE_DAMAGE * 2 * ELITE_DAMAGE_MULTIPLIER);
    expect(dmg("edgeCase")).toBe(PROJECTILE_DAMAGE * 0.5 * EDGE_CASE_DAMAGE_MULTIPLIER);
    // Rounded for the doc, and only for the doc. Since `PROJECTILE_DAMAGE`
    // went 8 -> 12 the Edge Case bolt is `12 * 0.5 * 0.4`, which in binary
    // floating point is 2.4000000000000004 rather than 2.4 — the old 8 was
    // exact by luck. That last bit is **load-bearing and must not be
    // "fixed"**: writing the value as `PROJECTILE_DAMAGE / 5` gives an exact
    // 2.4 whose `damage / meanCooldown` then lands one ULP away from
    // `PROJECTILE_DAMAGE * multiplier / 1.9`, breaking `enemyWeapons.test.ts`'s
    // exact-equality DPS invariant. So the constant keeps its noise and the
    // prose keeps its readable number; the two assertions above are what tie
    // the doc's figure to the real one.
    const shown = (a) => Number(dmg(a).toFixed(4));
    pin("doc/dev/balancing-telemetry.md", `| Bolt dmg | ${shown("normal")} | **${shown("elite")}** | **${shown("edgeCase")}** |`);
    pin("doc/dev/balancing-telemetry.md", `| Bolt speed | ${ENEMY_WEAPONS.normal.speed} | **${ENEMY_WEAPONS.elite.speed}** | **${ENEMY_WEAPONS.edgeCase.speed}** |`);
  });

  it("states the balance reference's archetype melee damage per archetype", () => {
    // The row directly above the bolt one, and unpinned until 2026-08-23 —
    // when `ATTACK_DAMAGE` went 10 -> 15 it went stale in silence while its
    // pinned neighbour failed loudly. Same table, same failure mode, so it
    // gets the same guard. Melee is the one place the archetype multipliers
    // are still applied at the call site (`damageMultiplier` in `enemyAi.ts`)
    // rather than baked into a weapon, which is why this is arithmetic here
    // and a table lookup above.
    const melee = (mult) => ATTACK_DAMAGE * mult;
    pin(
      "doc/dev/balancing-telemetry.md",
      `| Melee dmg | ${melee(1)} | ${melee(ELITE_DAMAGE_MULTIPLIER)} | ${melee(EDGE_CASE_DAMAGE_MULTIPLIER)} |`,
    );
  });

  it("states the balance reference's starting reserves and shell drops", () => {
    pin("doc/dev/balancing-telemetry.md", `shells = ${STARTING_SHELLS}`);
    pin("doc/dev/balancing-telemetry.md", `\`SHELLS_DROP_AMOUNT = ${SHELLS_DROP_AMOUNT}\``);
  });

  it("states the balance reference's difficulty table at the real multipliers", () => {
    const d = DIFFICULTY_MULTIPLIERS;
    pin("doc/dev/balancing-telemetry.md", `| easy | ${d.easy.hp} | ${d.easy.damage} | ${d.easy.ammoDropRate} | ${d.easy.enemyAimSpreadDeg}° |`);
    pin("doc/dev/balancing-telemetry.md", `| hard | ${d.hard.hp} | ${d.hard.damage} | ${d.hard.ammoDropRate} | ${d.hard.enemyAimSpreadDeg}° |`);
  });
});

describe("every internal doc link resolves", () => {
  // Not a constant mirror, but the same failure shape: a link is a claim about
  // another file, nothing checks it, and a renamed heading breaks it silently.
  // Found immediately on landing — two links written the same hour pointed at
  // an anchor that had never existed.
  //
  // Anchors follow GitHub's slugger: lowercase, inline markup stripped,
  // everything but `[a-z0-9 -]` dropped, then each *remaining* space becomes one
  // hyphen — so "Credits & Third-Party Licenses" is `credits--third-party-licenses`,
  // with the doubled hyphen the ampersand left behind. Collapsing runs of spaces
  // instead reports a dozen false failures, which is how this comment got here.
  const slug = (heading) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/ /g, "-");

  const markdownFiles = () => {
    const out = [];
    const skip = /node_modules|\.git|balancing_|perf_runs|docs-audit|dist|coverage|\.verify|level_maps|demo-campaign/;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (skip.test(full)) continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".md")) out.push(full.slice(repoRoot.length).replace(/^\//, ""));
      }
    };
    walk(repoRoot);
    return out;
  };

  const headingsOf = (rel) =>
    new Set(
      read(rel)
        .split("\n")
        .filter((l) => /^#{1,6} /.test(l))
        .map((l) => slug(l.replace(/^#+ /, ""))),
    );

  it.each(markdownFiles())("%s", (rel) => {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const broken = [];
    for (const [, target] of read(rel).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (target.startsWith("#")) {
        if (!headingsOf(rel).has(slug(target.slice(1)))) broken.push(`${target} (no such heading in this file)`);
        continue;
      }
      const [path, fragment] = target.split("#");
      const resolved = join(repoRoot, dir, path).slice(repoRoot.length).replace(/^\//, "");
      let exists = true;
      try {
        statSync(join(repoRoot, resolved));
      } catch {
        exists = false;
      }
      if (!exists) broken.push(`${target} (no such file)`);
      else if (fragment && resolved.endsWith(".md") && !headingsOf(resolved).has(slug(fragment)))
        broken.push(`${target} (${resolved} has no such heading)`);
    }
    expect(broken, `${rel} has broken links:\n  ${broken.join("\n  ")}`).toEqual([]);
  });
});

/** Small numbers as the docs write them, since prose says "five" not "5". */
function numberWord(n) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  if (!words[n]) throw new Error(`no word for ${n} — extend this list`);
  return words[n];
}
