// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loads the real `src/wad/onlineWadCatalog.ts` in plain Node, for
 * `scripts/fetch-online-wads.mjs` — same esbuild-bundle-and-import pattern as
 * `loadWadModule.mjs`, kept separate since this catalog module has nothing
 * to do with WAD byte parsing itself.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export async function loadOnlineWadCatalogModule() {
  const catalogFile = path.join(REPO_ROOT, "src/wad/onlineWadCatalog.ts");

  const result = await build({
    entryPoints: [catalogFile],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node18",
  });

  const outFile = path.join(os.tmpdir(), `codeenstein-online-wad-catalog-bundle-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  try {
    return await import(`file://${outFile}`);
  } finally {
    fs.unlinkSync(outFile);
  }
}
