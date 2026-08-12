// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Is this page being driven by browser automation?
 *
 * Extracted from `engine/audio.ts`, which has silenced itself this way since
 * long before there was a second caller — one copy rather than two, for the
 * same reason `fnv1a` lives in one place: a duplicated predicate is a thing
 * that can drift.
 *
 * **Why `navigator.webdriver` rather than a URL flag.** Playwright, Puppeteer
 * and Selenium all set it on the browser they control, so it needs no
 * cooperation from the harness. That matters because the harnesses that trip
 * over intrusive UI here are not one script: the whole `verify:*` suite, the
 * balancing bot, and the default-highscore generator all drive real pages, and
 * only some of them pass `?testHooks=1`. A flag would have to be threaded
 * through every one of them and would be forgotten by the next.
 *
 * Used to suppress things that are *for a person* and actively wrong for a
 * robot: audio nobody can hear, and the first-run tour, whose backdrop
 * swallows the very clicks a harness is trying to make.
 */
export function isAutomated(): boolean {
  const nav = (globalThis as unknown as { navigator?: { webdriver?: boolean } }).navigator;
  return nav?.webdriver === true;
}
