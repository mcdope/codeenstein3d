// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loads the real `src/parser/registry.ts` + `src/map/mapGenerator.ts` modules
 * in plain Node, for headless verification scripts that need the actual
 * parser/map-generation pipeline without a browser.
 *
 * Every language adapter imports its grammar wasm via Vite's `?url` syntax
 * (`import fooWasmUrl from "tree-sitter-foo/tree-sitter-foo.wasm?url"`), which
 * only means something to Vite's bundler. `urlImportAsPathPlugin` rewrites
 * each of those into a plain absolute filesystem path instead — exactly the
 * shape `web-tree-sitter`'s `Language.load()`/`Parser.init({ locateFile })`
 * already accept when running under Node (confirmed against
 * `web-tree-sitter`'s own Node code path, which resolves `readBinary` to
 * `fs.readFileSync` given a plain path). No DOM/browser shim is needed here —
 * that's only required by `vite.config.ts`'s browser-target build.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

/** Esbuild plugin: turns any `?url`-suffixed import into a plain absolute
 * path string, resolved the same way esbuild would resolve the import
 * without the suffix. */
function urlImportAsPathPlugin() {
  return {
    name: "url-import-as-path",
    setup(buildApi) {
      buildApi.onResolve({ filter: /\?url$/ }, async (args) => {
        const bareSpecifier = args.path.slice(0, -"?url".length);
        const resolved = await buildApi.resolve(bareSpecifier, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        return { path: resolved.path, namespace: "url-as-path" };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "url-as-path" }, (args) => ({
        contents: `export default ${JSON.stringify(args.path)};`,
        loader: "js",
      }));
    },
  };
}

/**
 * Bundles the real parser registry + map generator for plain Node and
 * imports the result. Returns `{ parseFile, extensionOf, MapGenerator,
 * UNLOCKABLE_WEAPONS, packBoardForStorage, unpackBoardFromStorage,
 * isBinaryBoard }`.
 *
 * The replay codec is bundled here for the same reason as
 * `UNLOCKABLE_WEAPONS`: `generate-default-highscore.mjs` has to read the
 * board the browser just wrote to `localStorage` and write the shipped
 * `defaultHighscore.ts` in the same format the game reads back. Hand-porting
 * a binary frame codec into plain `.mjs` would be a second implementation
 * that silently disagrees with the first the moment either changes — the
 * exact failure mode documented for the bot's weapon/tile mirrors in
 * `doc/dev/balancing-telemetry.md`. `CompressionStream` is available in Node
 * 18+, so the real module runs unmodified here.
 *
 * `UNLOCKABLE_WEAPONS` comes from the real `src/engine/weapons.ts` rather
 * than being mirrored as a literal the way `scripts/lib/combatPolicy.mjs`
 * has to mirror the weapon *stats*: three verification/telemetry scripts
 * need it only to build a `missingWeaponIndices` list for the map generator,
 * and all three used to hardcode `[3, 4, 5]`. That silently stopped being
 * the right answer the moment a fourth unlockable weapon was added — the new
 * weapon would simply never appear in a secret room in any of them. The
 * mirror in `combatPolicy.mjs` exists because that module is deliberately
 * kept liftable into `src/engine/`; this one had no such excuse, and
 * `weapons.ts` is pure data with no imports, so bundling it costs nothing.
 */
export async function loadEngineModules() {
  const registryPath = path.join(REPO_ROOT, "src/parser/registry.ts");
  const mapGeneratorPath = path.join(REPO_ROOT, "src/map/mapGenerator.ts");
  const weaponsPath = path.join(REPO_ROOT, "src/engine/weapons.ts");
  const replayCodecPath = path.join(REPO_ROOT, "src/engine/replayCodec.ts");

  const entryContents = [
    `export { parseFile, extensionOf } from ${JSON.stringify(registryPath)};`,
    `export { MapGenerator } from ${JSON.stringify(mapGeneratorPath)};`,
    `export { UNLOCKABLE_WEAPONS } from ${JSON.stringify(weaponsPath)};`,
    `export { packBoardForStorage, unpackBoardFromStorage, isBinaryBoard } from ${JSON.stringify(replayCodecPath)};`,
  ].join("\n");

  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: REPO_ROOT,
      loader: "ts",
      sourcefile: "demo-campaign-verifier-entry.ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node18",
    plugins: [urlImportAsPathPlugin()],
  });

  const outFile = path.join(os.tmpdir(), `codeenstein-engine-bundle-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(outFile, result.outputFiles[0].text);
  try {
    return await import(`file://${outFile}`);
  } finally {
    fs.unlinkSync(outFile);
  }
}
