// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Fixture-driven, deliberately — same shape as `check-secrets.test.mjs`.
 *
 * The obvious alternative, pointing these at the real `dist/`, is the trap this
 * whole script exists because of. `dist/` is gitignored and the `test` CI job
 * never runs `npm run build`, so such a test would either fail in CI or — far
 * worse — skip, and report success while asserting nothing. That is precisely
 * the failure mode of the 2026-07-25 manual grep this replaces.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = new URL("./check-bundle-hygiene.mjs", import.meta.url).pathname;

/** A minimal bundle that satisfies every REQUIRED needle and no BANNED one. */
const CLEAN =
  'const a=window.__codeensteinPerfStats;new URLSearchParams(s).get(`perfDebug`);new URLSearchParams(s).get(`ablate`);';

const dirs = [];
function bundle(contents, name = "index-abc123.js") {
  const root = mkdtempSync(join(tmpdir(), "bundle-hygiene-"));
  dirs.push(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  if (contents !== null) writeFileSync(join(root, "assets", name), contents);
  return root;
}
const run = (dir) => spawnSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("check-bundle-hygiene", () => {
  it("passes a bundle with the diagnostics and no hooks", () => {
    const r = run(bundle(CLEAN));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("bundle hygiene: clean");
  });

  it.each([
    "__codeensteinTestHooks",
    "__codeensteinCampaignTestHooks",
    "__codeensteinReplayTestHooks",
    "__codeensteinMultiplayerTestHooks",
  ])("fails when %s ships, and names it", (global) => {
    const r = run(bundle(`${CLEAN}window.${global}={};`));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(global);
    expect(r.stderr).toContain("shipping to players");
  });

  it.each(["debugInjectDesync", "debugSetGodMode", "debugClearExitRoomEnemies"])(
    "fails when the %s handle wiring ships",
    (member) => {
      const r = run(bundle(`${CLEAN}const h={${member}:(a,b)=>e.${member}(a,b)};`));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${member}:`);
    },
  );

  it.each(["debugInjectDesync", "debugSetGodMode", "debugClearExitRoomEnemies"])(
    "still allows %s as a class method, which cannot be tree-shaken",
    (member) => {
      // The distinction the trailing colon exists for. These are members of
      // RaycasterEngine, a live class, so they ship no matter what — banning the
      // bare name would make this check permanently and unfixably red.
      const r = run(bundle(`${CLEAN}class E{${member}(a,b){this.x=b}}`));
      expect(r.status, r.stderr).toBe(0);
    },
  );

  it("fails when a required diagnostic stops shipping", () => {
    // The half that stops the absence checks being satisfiable by a build that
    // simply lost everything.
    const r = run(bundle(CLEAN.replace("__codeensteinPerfStats", "__gone")));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("__codeensteinPerfStats is missing");
  });

  it("does not accept `ablated(` in place of the ?ablate URL read", () => {
    // `ablate` is a substring of `ablated(`, which appears ~25x in the real
    // bundle as an ordinary method call. A bare substring needle would pass
    // here with the feature deleted.
    const r = run(bundle(CLEAN.replace("new URLSearchParams(s).get(`ablate`);", "this.ablated(`telemetry`);")));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ablate");
  });

  it("does not accept double-quoted literals, which oxc never emits", () => {
    // Guards the needles themselves: written as `"ablate"` they match nothing
    // in a real bundle, so the check would be permanently, silently green.
    const r = run(bundle(CLEAN.replace(/`perfDebug`/, '"perfDebug"')));
    expect(r.status).toBe(1);
  });

  it("fails on a directory with no bundle rather than passing vacuously", () => {
    const r = run(bundle(null));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no .js files");
    expect(r.stderr).toContain("npm run build");
  });

  it("scans every chunk, not only index-*.js", () => {
    // A future lazy-load could relocate a hook block into its own chunk; this
    // project already forces a split for `defaultHighscore`.
    const root = bundle(CLEAN);
    writeFileSync(join(root, "assets", "lazy-def456.js"), "window.__codeensteinTestHooks={};");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("__codeensteinTestHooks");
  });
});
