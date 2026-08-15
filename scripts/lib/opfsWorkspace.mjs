// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * OPFS-backed workspace picker stub for Playwright drivers: pre-writes the
 * given files into an OPFS directory and replaces `window.showDirectoryPicker`
 * with a resolver returning that handle, so clicking "📁 Select Workspace"
 * loads a local workspace without a native dialog (which Playwright cannot
 * answer).
 *
 * Same trick as `verify-campaign-playthrough.mjs`'s `installTestStubs`, but
 * WITHOUT that script's virtual clock: the perf benchmark measures on the
 * real clock, and monkeypatching `performance.now`/`rAF` would destroy the
 * very pacing it measures. Needs no `?testHooks=1` either — the picker path
 * (`src/fs/workspace.ts`) has no test-hook dependency — so a run through this
 * stub is measurement-neutral.
 *
 * `files` is a flat `{ name: content }` map written into one directory; a
 * single-file workspace auto-launches straight into that file's level
 * (`autoLaunchInitialLevel`, src/main.ts).
 */
export async function installOpfsWorkspace(page, { dirName, files }) {
  await page.addInitScript(
    ({ files, dirName }) => {
      window.__opfsReady = (async () => {
        const root = await navigator.storage.getDirectory();
        // A stale dir from a previous run in the same profile would add
        // levels; contexts are fresh per run, but remove defensively.
        await root.removeEntry(dirName, { recursive: true }).catch(() => {});
        const dir = await root.getDirectoryHandle(dirName, { create: true });
        for (const [name, content] of Object.entries(files)) {
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        }
        return dir;
      })();
      window.showDirectoryPicker = async () => window.__opfsReady;
    },
    { files, dirName },
  );
}
