// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Rebuilds the exact DOM structure `index.html` provides, minus styling —
 * `src/main.ts` calls `requireElement` for every id referenced here at
 * *module load time* (not inside any function), so importing it against an
 * empty jsdom document throws immediately. Kept in sync with `index.html` by
 * hand (there's no automated cross-check) — if `requireElement` throws
 * "Missing required element" in a `main.test.ts` run, `index.html` gained a
 * new required id this fixture needs too.
 *
 * Every `main.test.ts`-family test must call this in a `beforeEach`, before
 * `vi.resetModules()` + `await import("../main")` — module-level state
 * (the `let activeEngine`/`workspaceTree`/etc. closures) persists for the
 * life of one imported module instance, so a fresh DOM *and* a fresh module
 * import are both required per test to avoid cross-test bleed.
 */
export function buildIndexDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <aside id="sidebar">
        <header id="sidebar-header">
          <h1>Codeenstein 3D</h1>
          <div id="launch-tabs" role="tablist">
            <button id="tab-local" class="tab-btn" type="button" role="tab" aria-selected="true" aria-controls="tab-panel-local">Local</button>
            <button id="tab-continue" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-continue" style="display: none">Continue</button>
            <button id="tab-github" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-github">GitHub</button>
            <button id="tab-demo" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-demo">Demos</button>
          </div>
          <div id="tab-panel-local" class="tab-panel" role="tabpanel">
            <button id="select-workspace" type="button">Select Workspace</button>
          </div>
          <div id="tab-panel-continue" class="tab-panel" role="tabpanel" hidden>
            <button id="continue-run" type="button">Continue Run</button>
          </div>
          <div id="tab-panel-github" class="tab-panel" role="tabpanel" hidden>
            <input id="github-repo-input" type="text" />
            <button id="load-github-repo" type="button">Load from GitHub</button>
            <p id="github-status" class="muted"></p>
            <div id="github-suggestions" class="github-suggestions">
              <button type="button" class="suggestion-btn" data-repo="EnterpriseQualityCoding/FizzBuzzEnterpriseEdition" title="EnterpriseQualityCoding/FizzBuzzEnterpriseEdition">Easy</button>
              <button type="button" class="suggestion-btn" data-repo="id-Software/DOOM" title="id-Software/DOOM">Medium</button>
            </div>
          </div>
          <div id="tab-panel-demo" class="tab-panel" role="tabpanel" hidden>
            <button id="launch-demo-campaign" type="button">Launch Demo Campaign</button>
          </div>
          <label id="gore-label" for="gore-select">Gore</label>
          <select id="gore-select">
            <option value="none">None</option>
            <option value="normal" selected>Normal</option>
            <option value="more">More</option>
            <option value="extreme">Extreme</option>
          </select>
          <label id="difficulty-label" for="difficulty-select">Difficulty</label>
          <select id="difficulty-select">
            <option value="easy">Easy</option>
            <option value="normal" selected>Normal</option>
            <option value="hard">Hard</option>
          </select>
          <p id="workspace-name" class="muted">No workspace selected</p>
          <label id="master-vol-label" for="master-vol">Master Volume</label>
          <input id="master-vol" class="volume-slider" type="range" min="0" max="100" value="50" />
          <label id="sfx-vol-label" for="sfx-vol">SFX Volume</label>
          <input id="sfx-vol" class="volume-slider" type="range" min="0" max="100" value="100" />
          <label id="bgm-vol-label" for="bgm-vol">Music Volume</label>
          <input id="bgm-vol" class="volume-slider" type="range" min="0" max="100" value="50" />
          <button id="select-bgm-folder" class="settings-btn" type="button">Select BGM Folder</button>
          <p id="bgm-status" class="muted">No custom music loaded</p>
          <button id="load-wad-textures" class="settings-btn" type="button">Load WAD Texture Pack</button>
          <input id="wad-file-input" type="file" accept=".wad" hidden />
          <p id="wad-status" class="muted">Using built-in default textures</p>
          <button id="view-highscores" class="settings-btn" type="button">Highscores</button>
          <a id="player-guide-link" class="settings-btn" href="#" target="_blank" rel="noopener noreferrer">Player Guide</a>
        </header>
        <nav id="file-tree" aria-label="File tree"></nav>
        <footer id="sidebar-footer"></footer>
      </aside>
      <main id="viewport">
        <div id="intro-screen"></div>
        <div id="loading-screen" class="loading-screen" hidden>
          <div class="loading-spinner" aria-hidden="true"></div>
          <p id="loading-status" class="loading-status">Loading…</p>
        </div>
      </main>
      <aside id="console-sidebar" class="console-sidebar">
        <div id="console-log"></div>
      </aside>
    </div>
    <dialog id="highscore-dialog">
      <div id="highscore-list"></div>
      <button id="close-highscores" class="settings-btn" type="button">Close</button>
    </dialog>
  `;
}

/** jsdom has no `ResizeObserver` implementation at all — `main.ts` only ever
 * calls `.observe()` on `canvasArea` and never reads back a callback
 * synchronously in any code path this suite exercises, so a no-op stub is
 * enough (unlike `installRaf`, there's no need to manually fire callbacks). */
export function stubResizeObserver(): void {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;
}
