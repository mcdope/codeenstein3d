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
            <button id="tab-multiplayer" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-multiplayer" disabled title="Multiplayer requires a GitHub-loaded repo or the Demos campaign">Multiplayer</button>
          </div>
          <div id="tab-panel-local" class="tab-panel" role="tabpanel">
            <button id="select-workspace" type="button">📁 Select Workspace</button>
          </div>
          <div id="tab-panel-continue" class="tab-panel" role="tabpanel" hidden>
            <button id="continue-run" type="button">📁 Continue Run</button>
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
          <div id="tab-panel-multiplayer" class="tab-panel" role="tabpanel" hidden>
            <div id="multiplayer-subtabs" role="tablist">
              <button id="multiplayer-subtab-host" class="tab-btn" type="button" role="tab" aria-selected="true" aria-controls="multiplayer-subtab-panel-host">Host</button>
              <button id="multiplayer-subtab-join" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="multiplayer-subtab-panel-join">Join</button>
            </div>
            <div id="multiplayer-subtab-panel-host" class="tab-panel" role="tabpanel">
              <input id="multiplayer-display-name-input" type="text" maxlength="100" />
              <label id="multiplayer-public-label" class="checkbox-label">
                <input id="multiplayer-public-checkbox" type="checkbox" />
                List in public lobby
              </label>
              <label id="multiplayer-max-players-label" for="multiplayer-max-players">Max players</label>
              <select id="multiplayer-max-players">
                <option value="2">2 (you + 1 guest)</option>
                <option value="3">3 (you + 2 guests)</option>
                <option value="4">4 (you + 3 guests)</option>
              </select>
              <button id="multiplayer-host-create" class="settings-btn" type="button">Create Session</button>
              <button id="multiplayer-host-cancel" class="settings-btn" type="button" hidden>Cancel</button>
              <p id="multiplayer-host-code" class="multiplayer-code" hidden></p>
              <p id="multiplayer-guest-count" class="muted" hidden></p>
              <button id="multiplayer-start-session" class="settings-btn" type="button" hidden>Start Session</button>
            </div>
            <div id="multiplayer-subtab-panel-join" class="tab-panel" role="tabpanel" hidden>
              <input id="multiplayer-join-code-input" type="text" />
              <button id="multiplayer-join-connect" class="settings-btn" type="button">Join</button>
              <button id="multiplayer-browse-lobby" class="settings-btn" type="button">Browse Lobby</button>
            </div>
            <p id="multiplayer-status" class="muted"></p>
          </div>
          <p id="workspace-name" class="muted">No workspace selected</p>
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
          <label id="master-vol-label" for="master-vol">Master Volume</label>
          <input id="master-vol" class="volume-slider" type="range" min="0" max="100" value="50" />
          <label id="sfx-vol-label" for="sfx-vol">SFX Volume</label>
          <input id="sfx-vol" class="volume-slider" type="range" min="0" max="100" value="100" />
          <label id="bgm-vol-label" for="bgm-vol">Music Volume</label>
          <input id="bgm-vol" class="volume-slider" type="range" min="0" max="100" value="50" />
          <button id="select-bgm-folder" class="settings-btn" type="button">📁 Select BGM Folder</button>
          <p id="bgm-status" class="muted">No custom music loaded</p>
          <div id="wad-tabs" role="tablist">
            <button id="wad-tab-local" class="tab-btn" type="button" role="tab" aria-selected="true" aria-controls="wad-tab-panel-local">Local File</button>
            <button id="wad-tab-online" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="wad-tab-panel-online">Online</button>
          </div>
          <div id="wad-tab-panel-local" class="tab-panel" role="tabpanel">
            <button id="load-wad-textures" class="settings-btn" type="button">📄 Load WAD Texture Pack</button>
            <input id="wad-file-input" type="file" accept=".wad" hidden />
          </div>
          <div id="wad-tab-panel-online" class="tab-panel" role="tabpanel" hidden>
            <ul id="online-wad-list" class="online-wad-list"></ul>
          </div>
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
    <dialog id="multiplayer-lobby-dialog">
      <ul id="multiplayer-lobby-list"></ul>
      <button id="close-multiplayer-lobby" class="settings-btn" type="button">Close</button>
    </dialog>
  `;
}

/** jsdom has no `ResizeObserver` implementation at all. `main.ts` observes
 * exactly one element (`canvasArea`) with it — the returned `fire()` lets a
 * test manually invoke whatever callback `main.ts` registered, e.g. to
 * exercise `fitCanvasToArea`'s recompute path (which a real browser would
 * trigger on layout/size changes ResizeObserver can't see coming under
 * jsdom's non-rendering DOM). */
export function stubResizeObserver(): { fire: () => void } {
  let callback: ResizeObserverCallback | null = null;
  class StubResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
  return {
    fire: () => callback?.([] as unknown as ResizeObserverEntry[], null as unknown as ResizeObserver),
  };
}

/** jsdom (this project's pinned 26.1.0) doesn't implement `<dialog>`'s
 * `showModal()`/`close()` at all — calling either throws
 * "is not a function". `main.ts`'s `#highscore-dialog` needs both (plus the
 * `open` property and a `close` event on `close()`, which `HTMLDialogElement`
 * spec-wise fires synchronously) for the Highscores button/dialog flow. */
export function stubDialogElement(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, "open", { value: false, writable: true, configurable: true });
  dialog.showModal = function (this: HTMLDialogElement): void {
    (this as unknown as { open: boolean }).open = true;
  };
  dialog.close = function (this: HTMLDialogElement): void {
    if (!this.open) return;
    (this as unknown as { open: boolean }).open = false;
    this.dispatchEvent(new Event("close"));
  };
}
