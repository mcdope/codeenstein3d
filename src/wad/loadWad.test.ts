// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { buildTestWad } from "../../scripts/fixtures/buildTestWad.mjs";
import { loadWadTextures } from "./loadWad";
import { findLump, parseLumpDirectory, parseWadHeader } from "./wadFile";

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
  it("resolves every slot from a well-formed fixture", () => {
    const result = loadWadTextures(buildTestWad());

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.wallName).toBe("STARTAN3");
    expect(result.wallTexture).not.toBeNull();
    expect(result.doorName).toBe("BIGDOOR2");
    expect(result.loreWallName).toBe("COMPUTE2");
    expect(result.floorName).toBe("FLOOR4_8");
    expect(result.floorTexture).not.toBeNull();
    expect(result.hazardFloorName).toBe("NUKAGE3");
    expect(result.teleporterFloorName).toBe("GATE1");
    expect(result.spikeSafeFloorName).toBe("FLOOR7_1");
    expect(result.spikeActiveFloorName).toBe("BLOOD1");
    // The fixture never creates any BONUS_*_TEXTURE_ALLOWLIST-named lump.
    expect(result.bonusWallName).toBeNull();
    expect(result.bonusFloorName).toBeNull();
  });

  it("returns an all-null-but-ok result when there is no PLAYPAL lump", () => {
    const result = loadWadTextures(buildTestWad({ includePlaypal: false }));
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.wallTexture).toBeNull();
    expect(result.floorTexture).toBeNull();
  });

  it("reports a fatal error for an invalid magic", () => {
    const result = loadWadTextures(buildTestWad({ magic: "JUNK" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Not a WAD file/);
    expect(result.wallTexture).toBeNull();
  });

  it("reports a fatal error for a truncated/corrupt buffer", () => {
    const result = loadWadTextures(buildTestWad({ truncate: true }));
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("leaves wall/door/loreWall null when there is no PNAMES/TEXTURE1, but still resolves floors", () => {
    const result = loadWadTextures(buildTestWad({ includeTextures: false }));
    expect(result.ok).toBe(true);
    expect(result.wallName).toBeNull();
    expect(result.doorName).toBeNull();
    expect(result.loreWallName).toBeNull();
    expect(result.floorName).toBe("FLOOR4_8");
  });

  it("leaves floor slots null when there are no flat markers, but still resolves wall textures", () => {
    const result = loadWadTextures(buildTestWad({ includeFlats: false }));
    expect(result.ok).toBe(true);
    expect(result.floorName).toBeNull();
    expect(result.hazardFloorName).toBeNull();
    expect(result.wallName).toBe("STARTAN3");
  });

  it("leaves just the door slot null when the fixture omits a door texture", () => {
    const result = loadWadTextures(buildTestWad({ doorTextureName: null }));
    expect(result.doorName).toBeNull();
    expect(result.wallName).toBe("STARTAN3");
  });

  it("leaves just the loreWall slot null when the fixture omits a lore-wall texture", () => {
    const result = loadWadTextures(buildTestWad({ loreWallTextureName: null }));
    expect(result.loreWallName).toBeNull();
    expect(result.wallName).toBe("STARTAN3");
  });

  it("leaves just the hazardFloor slot null when the fixture omits a hazard flat", () => {
    const result = loadWadTextures(buildTestWad({ hazardFloorName: null }));
    expect(result.hazardFloorName).toBeNull();
    expect(result.floorName).toBe("FLOOR4_8");
  });

  it("leaves just the teleporterFloor slot null when the fixture omits a teleporter flat", () => {
    const result = loadWadTextures(buildTestWad({ teleporterFloorName: null }));
    expect(result.teleporterFloorName).toBeNull();
  });

  it("leaves just the spikeSafeFloor slot null when the fixture omits it", () => {
    const result = loadWadTextures(buildTestWad({ spikeSafeFloorName: null }));
    expect(result.spikeSafeFloorName).toBeNull();
  });

  it("leaves just the spikeActiveFloor slot null when the fixture omits it", () => {
    const result = loadWadTextures(buildTestWad({ spikeActiveFloorName: null }));
    expect(result.spikeActiveFloorName).toBeNull();
  });

  it("isolates a composite-slot candidate whose patch data is corrupt, without failing the whole parse", () => {
    const corrupted = corruptLumpFilePos(buildTestWad(), "PATCH1");
    const result = loadWadTextures(corrupted);

    expect(result.ok).toBe(true);
    // STARTAN3/BIGDOOR2/COMPUTE2 all composite from the now-corrupt PATCH1 —
    // each throws inside compositeTexture, is caught, and no other allowlist
    // name exists in this fixture, so all three slots come back null...
    expect(result.wallName).toBeNull();
    expect(result.doorName).toBeNull();
    expect(result.loreWallName).toBeNull();
    // ...but floor parsing is entirely unaffected — proves the failure was
    // isolated to resolveCompositeSlot's own try/catch, not the outer one.
    expect(result.floorName).toBe("FLOOR4_8");
    expect(result.floorTexture).not.toBeNull();
  });

  it("isolates a flat-slot candidate whose data runs off the buffer, without failing the whole parse", () => {
    const corrupted = corruptLumpFilePos(buildTestWad(), "FLOOR4_8");
    const result = loadWadTextures(corrupted);

    expect(result.ok).toBe(true);
    expect(result.floorName).toBeNull();
    // Unrelated flat slots (different lumps) are unaffected.
    expect(result.hazardFloorName).toBe("NUKAGE3");
    // Unrelated wall texture parsing is unaffected either.
    expect(result.wallName).toBe("STARTAN3");
  });

  it("sanity-checks findLump still works against a real fixture's directory", () => {
    const bytes = buildTestWad();
    const view = new DataView(bytes);
    const lumps = parseLumpDirectory(view, parseWadHeader(view));
    expect(findLump(lumps, "PLAYPAL")).toBeDefined();
    expect(findLump(lumps, "NOPE")).toBeUndefined();
  });
});
