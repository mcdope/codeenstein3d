// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Lets a verify script's browser engine be overridden via
 * `CODEENSTEIN_VERIFY_BROWSER` (chromium/firefox/webkit, default chromium —
 * zero behavior change for every existing caller) instead of hardcoding
 * `chromium.launch()`. Playwright already bundles all three engines, so this
 * needs no new dependency — see `doc/dev/testing.md`'s cross-browser section
 * for which scripts use this and why they're safe to run against a
 * non-Chromium engine (neither touches `window.showDirectoryPicker`'s real
 * native picker, the one genuinely Chromium-only surface this app has).
 */
import { chromium, firefox, webkit } from "playwright";

const ENGINES = { chromium, firefox, webkit };

/** The Playwright `BrowserType` selected by `CODEENSTEIN_VERIFY_BROWSER`
 * (default `"chromium"`). Throws on an unrecognized value rather than
 * silently falling back, so a typo'd env var fails loudly instead of quietly
 * re-running the Chromium pass a caller thought they'd overridden away from. */
export function resolveBrowserEngine() {
  const name = process.env.CODEENSTEIN_VERIFY_BROWSER ?? "chromium";
  const engine = ENGINES[name];
  if (!engine) {
    throw new Error(`Unknown CODEENSTEIN_VERIFY_BROWSER "${name}" — expected one of: ${Object.keys(ENGINES).join(", ")}`);
  }
  return { name, engine };
}
