// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Build-time stand-in for Node's `fs/promises` and `module` core modules —
 * see `vite.config.ts`'s `resolve.alias`. `web-tree-sitter`'s single browser
 * bundle statically references both (dynamically imported, but Rollup still
 * has to resolve them at build time) purely for a Node.js code path gated
 * behind an `ENVIRONMENT_IS_NODE` runtime check that's always false in an
 * actual browser, so nothing here is ever called — an empty module is enough
 * to satisfy the resolver without dragging in a real polyfill.
 */
export {};
