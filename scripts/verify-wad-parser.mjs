// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Pure-logic verification of `src/wad/` — no browser, no DOM, no real IWAD
 * (copyright reasons; synthetic fixtures only, see `fixtures/buildTestWad.mjs`).
 * Bundles the real `src/wad/` modules for plain Node via `loadWadModule.mjs`
 * and exercises both the low-level parse functions directly and the
 * top-level `loadWadTextures` orchestrator's allowlist/fallback behavior.
 */
import { loadWadModule } from "./lib/loadWadModule.mjs";
import { buildTestWad, PALETTE_ENTRIES } from "./fixtures/buildTestWad.mjs";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function pixelAt(pixels, width, x, y) {
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

async function main() {
  const wad = await loadWadModule();

  // --- Direct low-level round-trip + compositing/transparency ---
  console.log("Round-trip + patch compositing/transparency:");
  {
    const bytes = buildTestWad();
    const view = new DataView(bytes);
    const header = wad.parseWadHeader(view);
    check("header magic recognized as IWAD", header.isPwad === false);
    const lumps = wad.parseLumpDirectory(view, header);
    check("lump directory has the expected lump count", lumps.length === 9, `got ${lumps.length}`);

    const playpalLump = wad.findLump(lumps, "PLAYPAL");
    const palette = wad.parsePlaypal(view, playpalLump);
    check(
      "palette index 1 decodes to patchA color",
      palette[1][0] === PALETTE_ENTRIES.patchA[0] &&
        palette[1][1] === PALETTE_ENTRIES.patchA[1] &&
        palette[1][2] === PALETTE_ENTRIES.patchA[2],
    );

    const pnames = wad.parsePnames(view, wad.findLump(lumps, "PNAMES"));
    check("PNAMES lists both patches in order", pnames[0] === "PATCH1" && pnames[1] === "PATCH2");

    const defs = wad.parseTextureLump(view, wad.findLump(lumps, "TEXTURE1"));
    const def = defs.get("STARTAN3");
    check("TEXTURE1 defines STARTAN3 at 6x4", !!def && def.width === 6 && def.height === 4);

    const composited = wad.compositeTexture(def, pnames, (name) => wad.findLump(lumps, name), view, palette);
    const [ax, ay] = [1, 2]; // arbitrary row within patch1's exclusive column
    check(
      "column 0 shows patch2's color (painted after patch1)",
      JSON.stringify(pixelAt(composited.rgba, 6, 0, 0)) === JSON.stringify([...PALETTE_ENTRIES.patchB, 255]),
    );
    check(
      "column 1 shows patch1's color through patch2's hole",
      JSON.stringify(pixelAt(composited.rgba, 6, 1, ay)) === JSON.stringify([...PALETTE_ENTRIES.patchA, 255]),
    );
    check(
      "column 2-3 (patch1-only) show patch1's color",
      JSON.stringify(pixelAt(composited.rgba, 6, ax, ay)) === JSON.stringify([...PALETTE_ENTRIES.patchA, 255]),
    );
    check(
      "columns 4-5 (never covered) are fully transparent",
      pixelAt(composited.rgba, 6, 4, 0)[3] === 0 && pixelAt(composited.rgba, 6, 5, 3)[3] === 0,
    );

    const flatLump = wad.findFlat(lumps, "FLOOR4_8");
    check("flat lump found inside F_START/F_END", !!flatLump);
    const flat = wad.parseFlat(view, flatLump, palette);
    check(
      "flat decodes every texel to its palette color, fully opaque",
      JSON.stringify(pixelAt(flat.rgba, 64, 0, 0)) === JSON.stringify([...PALETTE_ENTRIES.flat, 255]) &&
        JSON.stringify(pixelAt(flat.rgba, 64, 63, 63)) === JSON.stringify([...PALETTE_ENTRIES.flat, 255]),
    );
    check("wrong-sized lump inside the flat block is skipped", wad.findFlat(lumps, "NOTAFLAT") === null);
  }

  // --- loadWadTextures: full match ---
  console.log("\nloadWadTextures — full match (allowlisted names):");
  {
    const result = wad.loadWadTextures(buildTestWad());
    check("ok", result.ok === true);
    check("wallName resolved", result.wallName === "STARTAN3");
    check("wallTexture non-null", result.wallTexture !== null);
    check("floorName resolved", result.floorName === "FLOOR4_8");
    check("floorTexture non-null", result.floorTexture !== null);
    check("bonusWallName not matched (not in fixture)", result.bonusWallName === null);
    check("doorName resolved", result.doorName === "BIGDOOR2");
    check("doorTexture non-null", result.doorTexture !== null);
    check("bonusFloorName not matched (not in fixture)", result.bonusFloorName === null);
  }

  // --- loadWadTextures: allowlist miss ---
  console.log("\nloadWadTextures — allowlist miss (unlisted names):");
  {
    const result = wad.loadWadTextures(
      buildTestWad({ textureName: "RANDOMTEX", doorTextureName: "RANDOMDOOR", flatName: "RANDOMFLAT" }),
    );
    check("ok (clean fallback, not an error)", result.ok === true);
    check("wallName null", result.wallName === null);
    check("wallTexture null", result.wallTexture === null);
    check("doorName null", result.doorName === null);
    check("doorTexture null", result.doorTexture === null);
    check("floorName null", result.floorName === null);
    check("floorTexture null", result.floorTexture === null);
  }

  // --- loadWadTextures: no PLAYPAL ---
  console.log("\nloadWadTextures — missing PLAYPAL:");
  {
    const result = wad.loadWadTextures(buildTestWad({ includePlaypal: false }));
    check("ok (clean fallback)", result.ok === true);
    check("every slot null", [result.wallTexture, result.doorTexture, result.floorTexture].every((t) => t === null));
  }

  // --- loadWadTextures: no flat block, textures still resolve ---
  console.log("\nloadWadTextures — missing flat block, textures unaffected:");
  {
    const result = wad.loadWadTextures(buildTestWad({ includeFlats: false }));
    check("ok", result.ok === true);
    check("wallTexture still resolves", result.wallTexture !== null);
    check("floorTexture null (no F_START/F_END)", result.floorTexture === null);
  }

  // --- loadWadTextures: malformed input never throws ---
  console.log("\nloadWadTextures — malformed input:");
  {
    let threw = false;
    let result;
    try {
      result = wad.loadWadTextures(buildTestWad({ magic: "XXXX" }));
    } catch {
      threw = true;
    }
    check("bad magic never throws", threw === false);
    check("bad magic reports ok:false with an error", result && result.ok === false && !!result.error);
  }
  {
    let threw = false;
    let result;
    try {
      result = wad.loadWadTextures(buildTestWad({ truncate: true }));
    } catch {
      threw = true;
    }
    check("truncated/out-of-range buffer never throws", threw === false);
    check("truncated buffer reports ok:false with an error", result && result.ok === false && !!result.error);
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
