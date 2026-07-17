// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Build-time fetch tool for `src/wad/onlineWadCatalog.ts` — downloads each
 * unique source URL (a ZIP to extract from, or a raw `.wad` served
 * directly — see `zipEntryPath`'s doc comment in the catalog), writes the
 * WAD to `public/wads/`, and round-trips it through the real
 * `loadWadTextures` parser to catch a broken download or a stale allowlist
 * before it ships. Idempotent: an entry whose `public/wads/<servedPath>`
 * file already exists on disk is skipped entirely (no re-download, no
 * re-extract) — safe to run on every `npm run dev`/`npm run build` via the
 * `predev`/`prebuild` hooks in `package.json`. `public/wads/` is gitignored
 * — these are real-world game data files fetched fresh per machine/CI run
 * rather than committed to the repo.
 */
import fs from "node:fs";
import path from "node:path";
import { loadOnlineWadCatalogModule, REPO_ROOT } from "./lib/loadOnlineWadCatalogModule.mjs";
import { loadWadModule } from "./lib/loadWadModule.mjs";
import { extractFileFromZip } from "./lib/zipReader.mjs";

const TEXTURE_SLOTS = [
  "wallName",
  "bonusWallName",
  "doorName",
  "floorName",
  "bonusFloorName",
  "loreWallName",
  "hazardFloorName",
  "teleporterFloorName",
  "spikeSafeFloorName",
  "spikeActiveFloorName",
];

async function downloadFile(url) {
  console.log(`  Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`    ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return buf;
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const { ONLINE_WAD_CATALOG } = await loadOnlineWadCatalogModule();
  const wad = await loadWadModule();

  const downloadCache = new Map();
  let failures = 0;

  for (const entry of ONLINE_WAD_CATALOG) {
    console.log(`\n${entry.name} (${entry.id})`);
    const destPath = path.join(REPO_ROOT, "public", entry.servedPath);

    if (fs.existsSync(destPath)) {
      console.log(`  Already present at public/${entry.servedPath} — skipping.`);
      continue;
    }

    let rawBuf = downloadCache.get(entry.sourceUrl);
    if (!rawBuf) {
      rawBuf = await downloadFile(entry.sourceUrl);
      downloadCache.set(entry.sourceUrl, rawBuf);
    } else {
      console.log(`  Reusing already-downloaded ${entry.sourceUrl}`);
    }

    let wadBytes;
    if (entry.zipEntryPath) {
      try {
        wadBytes = extractFileFromZip(rawBuf, entry.zipEntryPath);
      } catch (err) {
        failures += 1;
        console.log(`  [FAIL] extract "${entry.zipEntryPath}": ${err instanceof Error ? err.message : err}`);
        continue;
      }
      console.log(`  Extracted "${entry.zipEntryPath}" (${(wadBytes.length / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      wadBytes = rawBuf; // sourceUrl already served the raw .wad directly
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, wadBytes);
    console.log(`  Wrote public/${entry.servedPath}`);

    const result = wad.loadWadTextures(toArrayBuffer(wadBytes));
    if (!result.ok) {
      failures += 1;
      console.log(`  [FAIL] loadWadTextures reported an error: ${result.error}`);
      continue;
    }
    const matched = TEXTURE_SLOTS.filter((slot) => result[slot] !== null);
    console.log(`  [OK] ${matched.length}/${TEXTURE_SLOTS.length} texture slots matched: ${matched.join(", ") || "(none)"}`);
  }

  console.log(`\n${failures === 0 ? "All entries fetched and verified." : `${failures} entrie(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
