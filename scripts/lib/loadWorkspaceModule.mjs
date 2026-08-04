// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loads the real `src/fs/workspace.ts` in plain Node — same
 * esbuild-bundle-and-import pattern as `loadWadModule.mjs` and
 * `loadOnlineWadCatalogModule.mjs`, kept separate from `loadEngineModules.mjs`
 * for the same reason those are: a caller that only needs to know which files
 * become levels should not pay for the parser registry's tree-sitter wasm
 * bundle.
 *
 * **Why bundle it rather than reimplement the walk.** Which files become
 * levels, and in what order, is a real behavioural contract — it decides which
 * source file is level 1 and therefore what every per-level budget number in
 * `report-level-budget.mjs` is *about*. `IGNORED_DIRECTORIES`,
 * `isIgnoredFileName` and `compareNodes` already encode it, and a second copy
 * would silently disagree the first time one of them changed. That is the same
 * argument `loadEngineModules.mjs` makes for the balance constants, and the
 * `ROCKET_TRAVEL_SPEED` drift is what it looks like when the argument is
 * ignored.
 *
 * `workspace.ts` touches `window.showDirectoryPicker` only inside functions
 * this caller never invokes, so it bundles and imports for Node unchanged.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export async function loadWorkspaceModule() {
  const result = await build({
    entryPoints: [path.join(REPO_ROOT, "src/fs/workspace.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node18",
  });

  const outFile = path.join(os.tmpdir(), `codeenstein-workspace-bundle-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  try {
    return await import(`file://${outFile}`);
  } finally {
    fs.unlinkSync(outFile);
  }
}
