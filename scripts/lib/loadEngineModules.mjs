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
 * imports the result. Returns `{ parseFile, extensionOf, MapGenerator }`.
 */
export async function loadEngineModules() {
  const registryPath = path.join(REPO_ROOT, "src/parser/registry.ts");
  const mapGeneratorPath = path.join(REPO_ROOT, "src/map/mapGenerator.ts");

  const entryContents = [
    `export { parseFile, extensionOf } from ${JSON.stringify(registryPath)};`,
    `export { MapGenerator } from ${JSON.stringify(mapGeneratorPath)};`,
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
