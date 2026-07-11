// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loads the real `src/wad/` module in plain Node, for `verify-wad-parser.mjs`.
 * Unlike `loadEngineModules.mjs`, `src/wad/` has no `?url`/wasm imports and no
 * DOM dependency at all — it's pure byte-array-in/byte-array-out — so a plain
 * esbuild bundle is enough, no plugin needed.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

/** Bundles the real `src/wad/loadWad.ts` (and the individual lower-level
 * modules it re-exports here for direct unit testing) for plain Node. */
export async function loadWadModule() {
  const wadDir = path.join(REPO_ROOT, "src/wad");
  const entryContents = [
    `export * from ${JSON.stringify(path.join(wadDir, "loadWad.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "wadFile.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "playpal.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "pnames.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "textureLump.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "patch.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "compositeTexture.ts"))};`,
    `export * from ${JSON.stringify(path.join(wadDir, "flatLump.ts"))};`,
  ].join("\n");

  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: REPO_ROOT,
      loader: "ts",
      sourcefile: "wad-verifier-entry.ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node18",
  });

  const outFile = path.join(os.tmpdir(), `codeenstein-wad-bundle-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  try {
    return await import(`file://${outFile}`);
  } finally {
    fs.unlinkSync(outFile);
  }
}
