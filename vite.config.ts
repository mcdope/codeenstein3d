// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const emptyNodeShim = fileURLToPath(new URL("./src/empty-node-shim.ts", import.meta.url));

/** `YYYY-MM-DD HH:MM`, local to the machine running `vite build`/`vite dev` —
 * baked into the bundle as `__BUILD_TIME__` (see `vite-env.d.ts`) so the page
 * title can show which build is actually loaded, e.g. to catch a stale cached
 * bundle after a deploy. For `vite dev` this is just "when the dev server
 * started", not a live-updating clock — computed once when the config loads. */
function buildTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** `HEAD`'s exact tag (e.g. a release build) if it has one, otherwise its
 * short commit hash — baked into the bundle as `__BUILD_REF__` alongside
 * `__BUILD_TIME__` so the page title also pins down *which* commit is
 * actually loaded, not just when it was built. Falls back to "unknown" if
 * git isn't available at all (e.g. building from a source tarball with no
 * `.git` directory) rather than failing the whole build over a title detail. */
function buildRef(): string {
  const run = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    return run("git describe --tags --exact-match");
  } catch {
    try {
      return run("git rev-parse --short HEAD");
    } catch {
      return "unknown";
    }
  }
}

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(buildTimestamp()),
    __BUILD_REF__: JSON.stringify(buildRef()),
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
