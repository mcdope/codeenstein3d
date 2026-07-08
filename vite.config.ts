// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const emptyNodeShim = fileURLToPath(new URL("./src/empty-node-shim.ts", import.meta.url));

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.jest-setup.ts', './vitest.setup.ts'],
    exclude: ['tests/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['src/main.ts', 'src/empty-node-shim.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  },
  resolve: {
    alias: {
      // web-tree-sitter's single build (web-tree-sitter.js) statically
      // imports `fs/promises` and `module` for its Node.js code path, even
      // though that path never actually runs in a browser (see
      // `src/empty-node-shim.ts`) — Vite's bundler still has to resolve the
      // import at build time, which without this produced "has been
      // externalized for browser compatibility" warnings on every production
      // build. Aliased to an absolute path (not the "/src/..." root-relative
      // form) since esbuild's dev-time dependency pre-bundling resolves that
      // against the OS filesystem root, not the project root, and fails.
      "fs/promises": emptyNodeShim,
      module: emptyNodeShim,
    },
  },
});
