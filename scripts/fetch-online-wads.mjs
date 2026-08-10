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
 *
 * **Nothing here is load-bearing, so a failure must not be fatal by
 * default.** The game ships procedural default textures and a missing pack
 * already degrades cleanly at runtime (the sidebar's online-pack list is
 * simply shorter), whereas exiting non-zero from a `predev`/`prebuild` hook
 * means a clone with no network — or one dead catalog URL — can neither
 * start the dev server nor build at all. So a download/extract/parse failure
 * warns, the run continues with whatever it managed to fetch, and the exit
 * code stays 0. Pass `--strict` (or set `CODEENSTEIN_WADS_STRICT=1`) to get
 * the old fail-hard behaviour — that is what CI uses, since CI *should*
 * notice a catalog entry that has gone 404 rather than silently shipping a
 * shorter list.
 */
import fs from "node:fs";
import path from "node:path";
import { loadOnlineWadCatalogModule, REPO_ROOT } from "./lib/loadOnlineWadCatalogModule.mjs";
import { loadWadModule } from "./lib/loadWadModule.mjs";
import { extractFileFromZip } from "./lib/zipReader.mjs";
import { summarizeWadSlots } from "./lib/wadSlotSummary.mjs";

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

/** `--strict` restores the fail-hard behaviour this script used to have
 * unconditionally; the env var exists so a CI step can turn it on without
 * having to route flags through an npm lifecycle hook. */
const STRICT =
  process.argv.slice(2).includes("--strict") ||
  ["1", "true", "yes"].includes((process.env.CODEENSTEIN_WADS_STRICT ?? "").toLowerCase());

function fail(failures, message) {
  failures.push(message);
  console.log(`  [${STRICT ? "FAIL" : "WARN"}] ${message}`);
}

async function main() {
  const { ONLINE_WAD_CATALOG } = await loadOnlineWadCatalogModule();
  const wad = await loadWadModule();

  const downloadCache = new Map();
  /** Source URLs whose download already failed once — every later entry
   * sharing that URL is skipped rather than re-attempting a host that is
   * plainly unreachable, which is what makes an offline run fast instead of
   * one timeout per catalog entry. */
  const deadSources = new Set();
  const failures = [];

  for (const entry of ONLINE_WAD_CATALOG) {
    console.log(`\n${entry.name} (${entry.id})`);
    const destPath = path.join(REPO_ROOT, "public", entry.servedPath);

    if (fs.existsSync(destPath)) {
      console.log(`  Already present at public/${entry.servedPath} — skipping.`);
      continue;
    }

    if (deadSources.has(entry.sourceUrl)) {
      fail(failures, `${entry.id}: skipped, ${entry.sourceUrl} already failed above`);
      continue;
    }

    let rawBuf = downloadCache.get(entry.sourceUrl);
    if (!rawBuf) {
      try {
        rawBuf = await downloadFile(entry.sourceUrl);
      } catch (err) {
        deadSources.add(entry.sourceUrl);
        fail(failures, `${entry.id}: download failed — ${err instanceof Error ? err.message : err}`);
        continue;
      }
      downloadCache.set(entry.sourceUrl, rawBuf);
    } else {
      console.log(`  Reusing already-downloaded ${entry.sourceUrl}`);
    }

    let wadBytes;
    if (entry.zipEntryPath) {
      try {
        wadBytes = extractFileFromZip(rawBuf, entry.zipEntryPath);
      } catch (err) {
        fail(failures, `${entry.id}: extract "${entry.zipEntryPath}" — ${err instanceof Error ? err.message : err}`);
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
      // Leaving the unparseable file on disk would make the failure
      // *permanent*: the skip-if-present check at the top of the loop would
      // never re-fetch it, and the game would serve a broken pack forever.
      // Removing it is what lets the next run with a working network heal.
      fs.rmSync(destPath, { force: true });
      fail(failures, `${entry.id}: loadWadTextures reported an error — ${result.error}`);
      continue;
    }
    // Per-styleset detail lives in `report-wad-styleset-coverage.mjs`; this
    // step only needs the headline "does this entry actually skin the game".
    const summary = summarizeWadSlots(result);
    console.log(`  [OK] ${summary.matched}/${summary.total} texture slots matched`);
  }

  if (failures.length === 0) {
    console.log("\nAll entries fetched and verified.");
    process.exit(0);
  }

  console.log(`\n${failures.length} entrie(s) FAILED:`);
  for (const message of failures) console.log(`  - ${message}`);
  if (STRICT) process.exit(1);
  console.log(
    "\nContinuing anyway — online texture packs are optional (the game ships procedural\n" +
      "default textures, and public/wads/ is gitignored). The sidebar's online-pack list\n" +
      "will be short until a later run with working network fills it in. Run with\n" +
      "--strict to treat this as an error instead.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  // Same reasoning as a per-entry failure: an unexpected crash in an
  // optional-asset fetcher must not be what stops `npm run dev` from
  // starting. `--strict` (CI) still reports it.
  process.exit(STRICT ? 1 : 0);
});
