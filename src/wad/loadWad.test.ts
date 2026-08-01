// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import { buildTestWad } from "../../scripts/fixtures/buildTestWad.mjs";
import { STYLE_SET_IDS } from "../map/types";
import { loadWadTextures } from "./loadWad";
import * as wadFileModule from "./wadFile";
import { findLump, parseLumpDirectory, parseWadHeader } from "./wadFile";

/** Renames a lump in the directory (e.g. "TEXTURE1" -> a name `findLump`
 * never looks for) so it's effectively absent, without disturbing any other
 * lump's data or offsets — used to reach the pnamesLump-present-but-no-
 * texture-lump branch, which `buildTestWad`'s options can't express (PNAMES
 * and TEXTURE1 are always created together). */
function renameLump(bytes: ArrayBuffer, lumpName: string, newName: string): ArrayBuffer {
  const copy = bytes.slice(0);
  const view = new DataView(copy);
  const header = parseWadHeader(view);
  const lumps = parseLumpDirectory(view, header);
  const index = lumps.findIndex((l) => l.name === lumpName);
  if (index === -1) throw new Error(`fixture has no lump named ${lumpName}`);
  const nameOffset = header.infoTableOfs + index * 16 + 8;
  for (let i = 0; i < 8; i++) view.setUint8(nameOffset + i, i < newName.length ? newName.charCodeAt(i) : 0);
  return copy;
}

/** Overwrites a lump's directory `filepos` field so reading its data runs off
 * the end of the buffer — used to force a `RangeError` deep inside a single
 * composite/flat candidate, to prove `resolveCompositeSlot`/`resolveFlatSlot`
 * isolate that one candidate's failure instead of the whole parse. */
function corruptLumpFilePos(bytes: ArrayBuffer, lumpName: string): ArrayBuffer {
  const copy = bytes.slice(0);
  const view = new DataView(copy);
  const header = parseWadHeader(view);
  const lumps = parseLumpDirectory(view, header);
  const index = lumps.findIndex((l) => l.name === lumpName);
  if (index === -1) throw new Error(`fixture has no lump named ${lumpName}`);
  const slotOffset = header.infoTableOfs + index * 16;
  view.setInt32(slotOffset, copy.byteLength - 1, true);
  return copy;
}

describe("loadWadTextures", () => {
  it("resolves every signal slot from a well-formed fixture", () => {
    const result = loadWadTextures(buildTestWad());

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.signals.loreWall.name).toBe("COMPUTE2");
    expect(result.signals.hazardFloor.name).toBe("NUKAGE3");
    expect(result.signals.teleporterFloor.name).toBe("GATE1");
    expect(result.signals.spikeSafeFloor.name).toBe("FLOOR7_1");
    expect(result.signals.spikeActiveFloor.name).toBe("BLOOD1");
  });

  it("resolves the structural slots for the styleset that owns the fixture's names", () => {
    const result = loadWadTextures(buildTestWad());
    // The fixture ships STARTAN3/FLOOR4_8, which are `tech`'s own first
    // choices, and BIGDOOR2, which `techCool` owns.
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
    expect(result.styles.tech.wall.texture).not.toBeNull();
    expect(result.styles.tech.floor.name).toBe("FLOOR4_8");
    expect(result.styles.tech.floor.texture).not.toBeNull();
    expect(result.styles.techCool.door.name).toBe("BIGDOOR2");
  });

  it("falls back across stylesets rather than leaving a slot on programmer art", () => {
    const result = loadWadTextures(buildTestWad());
    // None of `stone`'s own names exist in the fixture. Resolving stylesets in
    // isolation would leave this level fully procedural while `tech` levels
    // were fully WAD-textured — the campaign would visibly flip between the
    // two. Instead it borrows the only wall/floor/door the WAD actually has.
    expect(result.styles.stone.wall.name).toBe("STARTAN3");
    expect(result.styles.stone.floor.name).toBe("FLOOR4_8");
    expect(result.styles.stone.door.name).toBe("BIGDOOR2");
    for (const id of STYLE_SET_IDS) {
      expect(result.styles[id].wall.texture).not.toBeNull();
      expect(result.styles[id].floor.texture).not.toBeNull();
      expect(result.styles[id].door.texture).not.toBeNull();
    }
  });

  it("prefers a styleset's own candidate over a sibling's when the WAD has both", () => {
    // COMPBLUE is `techCool`'s first-choice wall; STARTAN3 is `tech`'s. With
    // both present the two stylesets must resolve differently — this is the
    // assertion that per-level WAD variety actually happens, rather than every
    // styleset collapsing onto whichever name the fallback chain reaches first.
    const result = loadWadTextures(buildTestWad({ texture2Name: "COMPBLUE" }));
    expect(result.ok).toBe(true);
    expect(result.styles.techCool.wall.name).toBe("COMPBLUE");
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("re-composites per styleset so no two share a pixel buffer", () => {
    // `bitmapFromWadPixels` (textures.ts) mutates the buffer in place with the
    // styleset's own hole-fill colour, so two stylesets landing on the same
    // name must still get independent buffers or the second fill corrupts the
    // first. Here every styleset resolves to STARTAN3 via the fallback chain.
    const result = loadWadTextures(buildTestWad());
    const buffers = STYLE_SET_IDS.map((id) => result.styles[id].wall.texture?.rgba);
    expect(new Set(buffers).size).toBe(STYLE_SET_IDS.length);
  });

  it("returns an all-null-but-ok result when there is no PLAYPAL lump", () => {
    const result = loadWadTextures(buildTestWad({ includePlaypal: false }));
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.styles.tech.wall.texture).toBeNull();
    expect(result.styles.tech.floor.texture).toBeNull();
  });

  it("reports a fatal error for an invalid magic", () => {
    const result = loadWadTextures(buildTestWad({ magic: "JUNK" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Not a WAD file/);
    expect(result.styles.tech.wall.texture).toBeNull();
  });

  it("reports a fatal error for a truncated/corrupt buffer", () => {
    const result = loadWadTextures(buildTestWad({ truncate: true }));
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("leaves wall/door/loreWall null when there is no PNAMES/TEXTURE1, but still resolves floors", () => {
    const result = loadWadTextures(buildTestWad({ includeTextures: false }));
    expect(result.ok).toBe(true);
    expect(result.styles.tech.wall.name).toBeNull();
    expect(result.styles.tech.door.name).toBeNull();
    expect(result.signals.loreWall.name).toBeNull();
    expect(result.styles.tech.floor.name).toBe("FLOOR4_8");
  });

  it("leaves floor slots null when there are no flat markers, but still resolves wall textures", () => {
    const result = loadWadTextures(buildTestWad({ includeFlats: false }));
    expect(result.ok).toBe(true);
    expect(result.styles.tech.floor.name).toBeNull();
    expect(result.signals.hazardFloor.name).toBeNull();
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("leaves the door slot null for every styleset when the fixture omits a door texture", () => {
    const result = loadWadTextures(buildTestWad({ doorTextureName: null }));
    for (const id of STYLE_SET_IDS) expect(result.styles[id].door.name).toBeNull();
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("leaves just the loreWall slot null when the fixture omits a lore-wall texture", () => {
    const result = loadWadTextures(buildTestWad({ loreWallTextureName: null }));
    expect(result.signals.loreWall.name).toBeNull();
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("leaves just the hazardFloor slot null when the fixture omits a hazard flat", () => {
    const result = loadWadTextures(buildTestWad({ hazardFloorName: null }));
    expect(result.signals.hazardFloor.name).toBeNull();
    expect(result.styles.tech.floor.name).toBe("FLOOR4_8");
  });

  it("leaves just the teleporterFloor slot null when the fixture omits a teleporter flat", () => {
    const result = loadWadTextures(buildTestWad({ teleporterFloorName: null }));
    expect(result.signals.teleporterFloor.name).toBeNull();
  });

  it("leaves just the spikeSafeFloor slot null when the fixture omits it", () => {
    const result = loadWadTextures(buildTestWad({ spikeSafeFloorName: null }));
    expect(result.signals.spikeSafeFloor.name).toBeNull();
  });

  it("leaves just the spikeActiveFloor slot null when the fixture omits it", () => {
    const result = loadWadTextures(buildTestWad({ spikeActiveFloorName: null }));
    expect(result.signals.spikeActiveFloor.name).toBeNull();
  });

  it("isolates a composite-slot candidate whose patch data is corrupt, without failing the whole parse", () => {
    const corrupted = corruptLumpFilePos(buildTestWad(), "PATCH1");
    const result = loadWadTextures(corrupted);

    expect(result.ok).toBe(true);
    // STARTAN3/BIGDOOR2/COMPUTE2 all composite from the now-corrupt PATCH1 —
    // each throws inside compositeTexture, is caught, and no other allowlist
    // name exists in this fixture for any styleset, so every wall and door
    // slot comes back null...
    for (const id of STYLE_SET_IDS) {
      expect(result.styles[id].wall.name).toBeNull();
      expect(result.styles[id].door.name).toBeNull();
    }
    expect(result.signals.loreWall.name).toBeNull();
    // ...but floor parsing is entirely unaffected — proves the failure was
    // isolated to resolveCompositeSlot's own try/catch, not the outer one.
    expect(result.styles.tech.floor.name).toBe("FLOOR4_8");
    expect(result.styles.tech.floor.texture).not.toBeNull();
  });

  it("isolates a flat-slot candidate whose data runs off the buffer, without failing the whole parse", () => {
    const corrupted = corruptLumpFilePos(buildTestWad(), "FLOOR4_8");
    const result = loadWadTextures(corrupted);

    expect(result.ok).toBe(true);
    for (const id of STYLE_SET_IDS) expect(result.styles[id].floor.name).toBeNull();
    // Unrelated flat slots (different lumps) are unaffected.
    expect(result.signals.hazardFloor.name).toBe("NUKAGE3");
    // Unrelated wall texture parsing is unaffected either.
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("merges TEXTURE2 definitions in on top of TEXTURE1's", () => {
    const result = loadWadTextures(buildTestWad({ texture2Name: "TEKWALL4" }));
    expect(result.ok).toBe(true);
    // TEKWALL4 is 2nd in `tech`'s wall list, behind STARTAN3 (present) —
    // proves TEXTURE2's defs were merged in (not ignored), even though
    // STARTAN3 still wins the allowlist race.
    expect(result.styles.tech.wall.name).toBe("STARTAN3");
  });

  it("resolves textures from TEXTURE2 alone when TEXTURE1 has no matching name", () => {
    const result = loadWadTextures(buildTestWad({ texture2Name: "COMPBLUE" }));
    expect(result.ok).toBe(true);
    expect(result.styles.techCool.wall.name).toBe("COMPBLUE");
    expect(result.styles.techCool.wall.texture).not.toBeNull();
  });

  it("resolves textures from TEXTURE2 when the TEXTURE1 lump itself is absent (not just non-matching)", () => {
    // A WAD can legally ship only TEXTURE2 (no TEXTURE1 lump at all) — distinct
    // from the "TEXTURE1 present but no matching name" case above.
    const bytes = renameLump(buildTestWad({ texture2Name: "COMPBLUE" }), "TEXTURE1", "TEXTURE9");
    const result = loadWadTextures(bytes);
    expect(result.ok).toBe(true);
    expect(result.styles.techCool.wall.name).toBe("COMPBLUE");
    expect(result.styles.techCool.wall.texture).not.toBeNull();
    // And every other styleset borrows it rather than dropping to defaults.
    expect(result.styles.stone.wall.name).toBe("COMPBLUE");
  });

  it("leaves wall/door/loreWall null when PNAMES exists but no TEXTURE1/TEXTURE2 lump does", () => {
    const bytes = renameLump(buildTestWad(), "TEXTURE1", "TEXTURE9");
    const result = loadWadTextures(bytes);
    expect(result.ok).toBe(true);
    expect(result.styles.tech.wall.name).toBeNull();
    expect(result.styles.tech.door.name).toBeNull();
    expect(result.signals.loreWall.name).toBeNull();
    // Unaffected — PNAMES/TEXTURE1 absence doesn't touch flat resolution.
    expect(result.styles.tech.floor.name).toBe("FLOOR4_8");
  });

  it("falls back to a generic message when a non-Error value is thrown", () => {
    const spy = vi.spyOn(wadFileModule, "parseWadHeader").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "not an Error instance";
    });
    try {
      const result = loadWadTextures(buildTestWad());
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Failed to parse WAD file.");
    } finally {
      spy.mockRestore();
    }
  });

  it("sanity-checks findLump still works against a real fixture's directory", () => {
    const bytes = buildTestWad();
    const view = new DataView(bytes);
    const lumps = parseLumpDirectory(view, parseWadHeader(view));
    expect(findLump(lumps, "PLAYPAL")).toBeDefined();
    expect(findLump(lumps, "NOPE")).toBeUndefined();
  });
});
