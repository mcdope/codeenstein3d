// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Reports how `src/wad/textureAllowlist.ts` actually behaves against real
 * WADs, by driving this repo's own parser (`src/wad/`) — not by checking
 * whether a name merely appears in the lump directory.
 *
 * This is how that file's bar ("every candidate decodes to real, fully-opaque
 * pixels against a real WAD") is checked whenever it changes. Two sections,
 * answering two different questions:
 *
 * 1. **The resolution matrix** — which name each styleset's wall/floor/door
 *    *won* per WAD. What matters here is the "distinct walls" count: if two
 *    stylesets resolve the same texture, the cross-styleset fallback had to
 *    borrow, and those two levels will look alike. That's a graceful
 *    degradation, not a bug, but it's the thing worth watching.
 * 2. **The per-candidate decode probe** — for every allowlisted name
 *    independently, does it decode in each WAD? A name that never wins a slot
 *    is *not* dead weight (it may simply sit behind a first choice that's
 *    always present); a name that never *decodes anywhere* is.
 *
 * A report, not a pass/fail gate: a sparse WAD legitimately leaves slots on
 * the procedural default, which is exactly what the fallback chain exists for.
 *
 * Sources, all optional — it reports on whatever is present:
 *   - `public/wads/*.wad`   (the online catalog, populated by `npm run fetch:online-wads`)
 *   - any paths passed as CLI arguments
 *   - `$CODEENSTEIN_EXTRA_WADS` (colon-separated)
 *
 * Usage:
 *   node scripts/report-wad-styleset-coverage.mjs [extra.wad ...]
 *   CODEENSTEIN_EXTRA_WADS=~/doom.wad node scripts/report-wad-styleset-coverage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { loadWadModule, REPO_ROOT } from "./lib/loadWadModule.mjs";
import { SIGNAL_SLOTS, STRUCTURAL_SLOTS, STYLE_SET_IDS, summarizeWadSlots } from "./lib/wadSlotSummary.mjs";

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function collectWadPaths() {
  const paths = [];
  const catalogDir = path.join(REPO_ROOT, "public/wads");
  if (fs.existsSync(catalogDir)) {
    for (const name of fs.readdirSync(catalogDir).sort()) {
      if (name.toLowerCase().endsWith(".wad")) paths.push(path.join(catalogDir, name));
    }
  }
  for (const extra of (process.env.CODEENSTEIN_EXTRA_WADS ?? "").split(":")) {
    if (extra) paths.push(extra);
  }
  paths.push(...process.argv.slice(2));
  return paths.filter((p, i) => paths.indexOf(p) === i).filter((p) => fs.existsSync(p));
}

function pad(text, width) {
  return String(text).padEnd(width, " ");
}

/**
 * Tries to decode one allowlisted name from `wadPath`'s already-parsed lumps,
 * the same way `loadWad.ts`'s own `resolveCompositeSlot`/`resolveFlatSlot`
 * would — a composite texture for wall/door, a flat for floor. Returns true
 * only if real pixels came back, which is the bar `textureAllowlist.ts` sets.
 */
function probeName(wad, parsed, slot, name) {
  const { view, lumps, palette, defs, pnames } = parsed;
  try {
    if (slot === "floor") {
      const lump = wad.findFlat(lumps, name);
      return lump ? wad.parseFlat(view, lump, palette).rgba.length > 0 : false;
    }
    const def = defs?.get(name);
    if (!def) return false;
    return wad.compositeTexture(def, pnames, (n) => wad.findLump(lumps, n), view, palette).rgba.length > 0;
  } catch {
    return false;
  }
}

/** Header/directory/palette/texture-defs for one WAD, or null if it can't be
 * parsed far enough to probe anything. */
function parseForProbing(wad, bytes) {
  try {
    const view = new DataView(bytes);
    const header = wad.parseWadHeader(view);
    const lumps = wad.parseLumpDirectory(view, header);
    const playpalLump = wad.findLump(lumps, "PLAYPAL");
    if (!playpalLump) return null;
    const palette = wad.parsePlaypal(view, playpalLump);

    let defs = null;
    let pnames = null;
    const pnamesLump = wad.findLump(lumps, "PNAMES");
    const t1 = wad.findLump(lumps, "TEXTURE1");
    const t2 = wad.findLump(lumps, "TEXTURE2");
    if (pnamesLump && (t1 || t2)) {
      pnames = wad.parsePnames(view, pnamesLump);
      defs = new Map();
      if (t1) for (const [n, d] of wad.parseTextureLump(view, t1)) defs.set(n, d);
      if (t2) for (const [n, d] of wad.parseTextureLump(view, t2)) defs.set(n, d);
    }
    return { view, lumps, palette, defs, pnames };
  } catch {
    return null;
  }
}

async function main() {
  const wadPaths = collectWadPaths();
  if (wadPaths.length === 0) {
    console.log("No WADs found. Run `npm run fetch:online-wads`, or pass paths as arguments.");
    console.log("(Optional: set CODEENSTEIN_EXTRA_WADS=/path/to/doom.wad:/path/to/other.wad)");
    return;
  }

  const wad = await loadWadModule();
  const allowlists = wad.STYLE_WAD_ALLOWLISTS;

  /** styleset -> in how many WADs it resolved a wall it actually owns. */
  const ownWallHits = new Map(STYLE_SET_IDS.map((id) => [id, 0]));
  /** "styleset.slot:NAME" -> in how many WADs that name decodes at all. */
  const decodeHits = new Map();

  for (const wadPath of wadPaths) {
    const bytes = toArrayBuffer(fs.readFileSync(wadPath));
    const result = wad.loadWadTextures(bytes);
    console.log(`\n=== ${path.relative(REPO_ROOT, wadPath)} ===`);
    if (!result.ok) {
      console.log(`  [FAIL] ${result.error}`);
      continue;
    }

    const summary = summarizeWadSlots(result);
    console.log(`  ${summary.matched}/${summary.total} slots resolved`);
    console.log(`  ${pad("styleset", 10)} ${STRUCTURAL_SLOTS.map((s) => pad(s, 10)).join(" ")}`);
    for (const id of STYLE_SET_IDS) {
      const cells = STRUCTURAL_SLOTS.map((slot) => pad(summary.styles[id][slot] ?? "—", 10));
      console.log(`  ${pad(id, 10)} ${cells.join(" ")}`);
      const wallName = summary.styles[id].wall;
      if (wallName && allowlists[id].wall.includes(wallName)) ownWallHits.set(id, ownWallHits.get(id) + 1);
    }
    console.log(`  signals: ${SIGNAL_SLOTS.map((s) => `${s}=${summary.signals[s] ?? "—"}`).join(", ")}`);

    const distinctWalls = new Set(STYLE_SET_IDS.map((id) => summary.styles[id].wall).filter(Boolean));
    const distinctFloors = new Set(STYLE_SET_IDS.map((id) => summary.styles[id].floor).filter(Boolean));
    console.log(
      `  distinct across stylesets: ${distinctWalls.size}/${STYLE_SET_IDS.length} walls, ` +
        `${distinctFloors.size}/${STYLE_SET_IDS.length} floors`,
    );

    const parsed = parseForProbing(wad, bytes);
    if (!parsed) continue;
    for (const id of STYLE_SET_IDS) {
      for (const slot of STRUCTURAL_SLOTS) {
        for (const name of allowlists[id][slot]) {
          if (probeName(wad, parsed, slot, name)) {
            const key = `${id}.${slot}:${name}`;
            decodeHits.set(key, (decodeHits.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }

  console.log("\n=== styleset variety (own wall, not borrowed from a sibling) ===");
  for (const id of STYLE_SET_IDS) {
    console.log(`  ${pad(id, 10)} ${ownWallHits.get(id)}/${wadPaths.length} WAD(s)`);
  }

  console.log("\n=== per-candidate decode probe (does this name decode at all?) ===");
  const never = [];
  for (const id of STYLE_SET_IDS) {
    for (const slot of STRUCTURAL_SLOTS) {
      const cells = allowlists[id][slot].map((name) => `${name}:${decodeHits.get(`${id}.${slot}:${name}`) ?? 0}`);
      console.log(`  ${pad(`${id}.${slot}`, 16)} ${cells.join("  ")}`);
      for (const name of allowlists[id][slot]) {
        if (!decodeHits.has(`${id}.${slot}:${name}`)) never.push(`${id}.${slot}:${name}`);
      }
    }
  }
  console.log(`\n  Names decoding in ZERO of the ${wadPaths.length} WAD(s) — real dead weight:`);
  console.log(never.length === 0 ? "    (none)" : never.map((d) => `    ${d}`).join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
