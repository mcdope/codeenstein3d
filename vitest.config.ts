// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { defineConfig, type Plugin } from "vitest/config";

const URL_AS_PATH_QUERY = "?url-as-path";

/**
 * Vitest runs source through Vite's own resolver (vite-node), where a
 * `?url` import is normally intercepted by Vite's built-in `vite:asset`
 * plugin and turned into a browser-shaped dev-server/asset URL — meaningless
 * under plain Node. This is the Vite-plugin-hook (`resolveId`/`load`)
 * equivalent of `scripts/lib/loadEngineModules.mjs`'s `urlImportAsPathPlugin`
 * (which does the same thing via esbuild's `onResolve`/`onLoad` for the
 * verify scripts): it rewrites any `?url`-suffixed import into a plain
 * absolute filesystem path, exactly the shape `web-tree-sitter`'s
 * `Parser.init({ locateFile })`/`Language.load()` expect when running under
 * Node (they call `fs.readFileSync` on it directly). Registered with
 * `enforce: "pre"` so its `resolveId` wins the race against `vite:asset`'s.
 */
function wasmUrlAsPathPlugin(): Plugin {
  return {
    name: "wasm-url-as-path",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.endsWith("?url")) return null;
      const bareSpecifier = source.slice(0, -"?url".length);
      const resolved = await this.resolve(bareSpecifier, importer, { skipSelf: true });
      if (!resolved) return null;
      return resolved.id + URL_AS_PATH_QUERY;
    },
    load(id) {
      if (!id.endsWith(URL_AS_PATH_QUERY)) return null;
      const absolutePath = id.slice(0, -URL_AS_PATH_QUERY.length);
      return `export default ${JSON.stringify(absolutePath)};`;
    },
  };
}

export default defineConfig({
  plugins: [wasmUrlAsPathPlugin()],
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // src/engine/defaultHighscore.ts is a 115k-line generated data literal
      // (baked by scripts/generate-default-highscore.mjs) with no logic to
      // test — excluded from the coverage denominator entirely, not tested.
      exclude: [
        "src/engine/defaultHighscore.ts",
        "src/empty-node-shim.ts",
        "src/vite-env.d.ts",
        "dist/**",
        "demo-campaign/**",
        "scripts/**",
        "*.config.ts",
        "test/**",
      ],
      // Thresholds are intentionally unset during the rollout (see
      // PROGRESS-testing.md) so intermediate runs don't hard-fail mid-project
      // — flipped to 100% across the board once every phase is complete.
    },
  },
});
