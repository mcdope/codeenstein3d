// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Curated catalog of free, redistributable WADs fetched at build time
 * (`scripts/fetch-online-wads.mjs`) into `public/wads/`, served same-origin
 * at runtime. This sidesteps CORS entirely — every source host was checked
 * directly and none send usable CORS headers, so a runtime `fetch()` against
 * the original source can't work in a browser.
 *
 * `sourceUrl`/`zipEntryPath` are build-time-only (read by the fetch script,
 * never bundled into the browser build). `servedPath` is the runtime-only
 * field, relative to `public/`. `zipEntryPath` is omitted when `sourceUrl`
 * already points at the raw `.wad` file directly (no archive to extract from).
 *
 * Every entry here has been round-tripped through this project's own
 * `loadWadTextures` and must resolve most/all of the 10 texture slots in
 * `textureAllowlist.ts` — a WAD from a different game engine (Heretic/Hexen)
 * or a texture-only resource patch with its own non-classic lump names
 * doesn't belong here even if its license is fine, since it wouldn't
 * actually change anything a player sees. See git history for two rejected
 * candidates (Blasphemer: Heretic-engine, 0/10 matched; OTEX: no lump-name
 * compatibility beyond a handful of walls/doors, 4/10 matched even after a
 * donor-palette splice) if reconsidering either in the future.
 *
 * HACX is the one entry that is not AGPL-compatible in the general sense —
 * its license is non-commercial-use-only. It's included because this
 * specific deployment is non-commercial; see the README's "Online WAD
 * catalog" section for the full license text and a takedown-request notice.
 * A commercial fork of this project would need to drop this entry.
 */
export interface OnlineWadEntry {
  readonly id: string;
  readonly name: string;
  readonly license: string;
  readonly credits: string;
  readonly link: string;
  readonly sourceUrl: string;
  readonly zipEntryPath?: string;
  readonly servedPath: string;
}

export const ONLINE_WAD_CATALOG: readonly OnlineWadEntry[] = [
  {
    id: "freedoom-phase1",
    name: "Freedoom: Phase 1",
    license: "BSD-3-Clause",
    credits: "The Freedoom Project",
    link: "https://freedoom.github.io/",
    sourceUrl: "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip",
    zipEntryPath: "freedoom-0.13.0/freedoom1.wad",
    servedPath: "wads/freedoom1.wad",
  },
  {
    id: "freedoom-phase2",
    name: "Freedoom: Phase 2",
    license: "BSD-3-Clause",
    credits: "The Freedoom Project",
    link: "https://freedoom.github.io/",
    sourceUrl: "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip",
    zipEntryPath: "freedoom-0.13.0/freedoom2.wad",
    servedPath: "wads/freedoom2.wad",
  },
  {
    id: "freedm",
    name: "FreeDM",
    license: "BSD-3-Clause",
    credits: "The Freedoom Project",
    link: "https://freedoom.github.io/",
    sourceUrl: "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedm-0.13.0.zip",
    zipEntryPath: "freedm-0.13.0/freedm.wad",
    servedPath: "wads/freedm.wad",
  },
  {
    id: "doom1-shareware",
    name: "DOOM (Shareware)",
    license: "id Software Shareware License — free redistribution, no fee for the WAD",
    credits: "id Software",
    link: "https://doomwiki.org/wiki/DOOM",
    sourceUrl: "https://raw.githubusercontent.com/Doom-Utils/shareware-collection/master/Doom%201.0/doom1.wad",
    servedPath: "wads/doom1.wad",
  },
  {
    id: "hacx",
    name: "HACX 1.2",
    license: "Freeware (Banjo Software / id Software) — non-commercial use only",
    credits: "Banjo Software, Inc.",
    link: "https://doomwiki.org/wiki/HACX",
    sourceUrl: "https://youfailit.net/pub/idgames/themes/hacx/hacx12.zip",
    zipEntryPath: "HACX.WAD",
    servedPath: "wads/hacx.wad",
  },
];
