// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Minimal ambient types for buildTestWad.mjs, so src/wad/*.test.ts (the only
 * src/ files importing this plain-JS fixture builder) can typecheck against
 * it without pulling `allowJs` into the whole project's tsconfig. */

export interface BuildTestWadOptions {
  includePlaypal?: boolean;
  includeTextures?: boolean;
  includeFlats?: boolean;
  textureName?: string;
  doorTextureName?: string | null;
  loreWallTextureName?: string | null;
  flatName?: string;
  bonusFloorName?: string | null;
  hazardFloorName?: string | null;
  teleporterFloorName?: string | null;
  spikeSafeFloorName?: string | null;
  spikeActiveFloorName?: string | null;
  texture2Name?: string | null;
  magic?: string;
  truncate?: boolean;
}

export const PALETTE_ENTRIES: {
  patchA: [number, number, number];
  patchB: [number, number, number];
  flat: [number, number, number];
};

export function buildTestWad(opts?: BuildTestWadOptions): ArrayBuffer;
