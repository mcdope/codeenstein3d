// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import "./style.css";
import {
  isFileSystemAccessSupported,
  pickDirectory,
  pickWorkspace,
  readDirectoryTree,
  readFileText,
  type TreeNode,
} from "./fs/workspace";
import { fetchGithubTree, parseGithubRepoInput } from "./fs/github";
import { DEMO_CAMPAIGN_NAME, loadDemoCampaignTree } from "./fs/demoCampaign";
import { renderFileTree } from "./ui/fileTree";
import { initConsoleSidebar } from "./ui/consoleSidebar";
import { extensionOf, isParsable, parseFile } from "./parser/registry";
import { MapGenerator } from "./map/mapGenerator";
import type { GameMap } from "./map/types";
import { renderExportMap } from "./map/exportView";
import { RaycasterEngine } from "./engine/engine";
import { audio } from "./engine/audio";
import { bgm } from "./engine/bgm";
import { textures, type WadLoadSummary } from "./engine/textures";
import { ONLINE_WAD_CATALOG, type OnlineWadEntry } from "./wad/onlineWadCatalog";
import { hashRun, loadHighscoresForDisplay, recordHighscore, type HighscoreEntry } from "./engine/highscores";
import { renderHighscoreTable } from "./ui/highscorePanel";
import { GameHud, type StatsScreenInfo } from "./ui/gameHud";
import type { ScoreBreakdown } from "./engine/scoring";
import type { PlayerFacingStats } from "./engine/playerStats";

/** Builds a `StatsScreenInfo` from an `EngineStats` pair, or `undefined` if
 * telemetry wasn't recorded this run (`PLAYER_STATS_ENABLED` off and no
 * `?testHooks=1` — see `playerStats.ts`'s doc comment) — `GameHud`'s
 * overlays already know how to show themselves with no stats rows at all in
 * that case. */
export function statsScreenInfo(
  scoreBreakdown: ScoreBreakdown | undefined,
  playerStats: PlayerFacingStats | undefined,
): StatsScreenInfo | undefined {
  if (!scoreBreakdown) return undefined;
  // `playerStats` is always populated together with `scoreBreakdown` — see
  // `buildStats()`'s doc comment, both fields are set or omitted as a
  // matched pair — so this is unreachable in practice, just satisfying the
  // type checker for two independently-optional parameters.
  /* v8 ignore next */
  if (!playerStats) return undefined;
  return { scoreBreakdown, playerStats };
}
import { buildControlsLegend } from "./ui/controlsLegend";
import { downloadBlob } from "./ui/download";
import { RESPONSIVE_CANVAS_SCALING_ENABLED, watchCanvasSizing } from "./ui/canvasFit";
import { DEFAULT_GORE_LEVEL, type GoreLevel } from "./engine/effects";
import {
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  TOOLCHAIN_MIN_LEVEL,
  TOOLCHAIN_WEAPON_INDEX,
  UNLOCKABLE_WEAPONS,
} from "./engine/weapons";
import { DEFAULT_DIFFICULTY, type DifficultyLevel } from "./difficulty";
import { randomSeed } from "./prng";
import { CampaignReplayRecorder, ReplayPlaybackInput, type ReplayLevelSegment } from "./engine/replay";
import type { ParsedFile } from "./parser/types";
import type { EngineCarryover, EngineStats, PlayerId, RosterSnapshotEntry } from "./engine/engine";
import { createSession, fetchSession, fetchSessionAsHost, postAnswer, updateSession } from "./multiplayer/signalingClient";
import { fetchLobbyEntries } from "./multiplayer/lobby";
import { createGuestAnswer, createHostOffer, waitForChannelsOpen } from "./multiplayer/webrtcConnection";
import { SignalingError, type ConnectionState, type HostGuestLink, type LobbyEntry, type MultiplayerConnection } from "./multiplayer/types";
import { runMultiplayerSessionAsHost, type FindNextLevel, type MultiplayerSessionHandle } from "./multiplayer/multiplayerSessionHost";
import { runMultiplayerSessionAsGuest } from "./multiplayer/multiplayerSessionGuest";
import type { SessionEndReason } from "./multiplayer/sessionEngine";
import { buildHostSessionSetupResult, runHostSessionSetup, type HostSessionSetupOptions } from "./multiplayer/sessionSetupHost";
import { runGuestSessionSetup } from "./multiplayer/sessionSetupGuest";
import { guestPlayerId, HOST_PLAYER_ID } from "./multiplayer/sessionSetupTypes";

// Stamps the build timestamp + git ref onto the tab title (index.html's
// static <title> is just the plain fallback for the instant before this
// module runs) — mainly so a stale cached bundle after a deploy is obvious
// from the tab itself instead of silently serving old code. See
// vite.config.ts's `define` for where `__BUILD_TIME__`/`__BUILD_REF__` come
// from — the latter is HEAD's tag if it's exactly tagged, otherwise its
// short commit hash.
document.title = `🔫 Codeenstein 3D (Build: ${__BUILD_TIME__} @ ${__BUILD_REF__})`;

/** Internal render resolution; CSS scales it up for a chunky retro look. */
const SCENE_WIDTH = 640;
const SCENE_HEIGHT = 400;

/** Extensions treated as a "bonus" restock-arena level (see `launchLevel`) —
 * just the C header today, the only header-file extension this app parses. */
const BONUS_LEVEL_EXTENSIONS = new Set(["h"]);

/** localStorage key for the standing gore-level preference (see `loadGoreLevel`
 * below) — declared up here, not next to `loadGoreLevel`/`saveGoreLevel`
 * themselves, because `currentGoreLevel`'s module-level initializer calls
 * `loadGoreLevel()` immediately; a `const` declared later in the file would
 * still be in its temporal dead zone at that point and throw. */
const GORE_KEY = "codeenstein-gore-level";
/** localStorage key for the standing difficulty preference — same "declared
 * up here, not next to load/save" reasoning as `GORE_KEY` above. */
const DIFFICULTY_KEY = "codeenstein-difficulty";
/** localStorage keys for the three standing volume preferences — same
 * "declared up here" reasoning as `GORE_KEY`/`DIFFICULTY_KEY` above. */
const MASTER_VOLUME_KEY = "codeenstein-master-volume";
const SFX_VOLUME_KEY = "codeenstein-sfx-volume";
const BGM_VOLUME_KEY = "codeenstein-bgm-volume";
/** localStorage key for the campaign save (see `loadCampaignSave` below) —
 * same "declared up here" reasoning as `GORE_KEY` above: the "Continue Run"
 * button's visibility is set by a `loadCampaignSave()` call right after
 * module setup, so a `const` declared down next to `loadCampaignSave` itself
 * would still be in its temporal dead zone at that point and throw. */
const SAVE_KEY = "codeenstein-campaign-save";

const tabLocal = requireElement<HTMLButtonElement>("#tab-local");
const tabContinue = requireElement<HTMLButtonElement>("#tab-continue");
const tabGithub = requireElement<HTMLButtonElement>("#tab-github");
const tabDemo = requireElement<HTMLButtonElement>("#tab-demo");
const tabMultiplayer = requireElement<HTMLButtonElement>("#tab-multiplayer");
const tabPanelLocal = requireElement<HTMLElement>("#tab-panel-local");
const tabPanelContinue = requireElement<HTMLElement>("#tab-panel-continue");
const tabPanelGithub = requireElement<HTMLElement>("#tab-panel-github");
const tabPanelDemo = requireElement<HTMLElement>("#tab-panel-demo");
const tabPanelMultiplayer = requireElement<HTMLElement>("#tab-panel-multiplayer");
const selectButton = requireElement<HTMLButtonElement>("#select-workspace");
const continueButton = requireElement<HTMLButtonElement>("#continue-run");
const githubRepoInput = requireElement<HTMLInputElement>("#github-repo-input");
const loadGithubRepoButton = requireElement<HTMLButtonElement>("#load-github-repo");
const githubStatus = requireElement<HTMLParagraphElement>("#github-status");
const githubSuggestionButtons = document.querySelectorAll<HTMLButtonElement>(".suggestion-btn");
const launchDemoCampaignButton = requireElement<HTMLButtonElement>("#launch-demo-campaign");
const workspaceName = requireElement<HTMLParagraphElement>("#workspace-name");
const fileTree = requireElement<HTMLElement>("#file-tree");
const viewport = requireElement<HTMLElement>("#viewport");
const loadingScreen = requireElement<HTMLElement>("#loading-screen");
const loadingStatus = requireElement<HTMLParagraphElement>("#loading-status");
const goreSelect = requireElement<HTMLSelectElement>("#gore-select");
const difficultySelect = requireElement<HTMLSelectElement>("#difficulty-select");
const masterVolumeInput = requireElement<HTMLInputElement>("#master-vol");
const sfxVolumeInput = requireElement<HTMLInputElement>("#sfx-vol");
const bgmVolumeInput = requireElement<HTMLInputElement>("#bgm-vol");
const selectBgmFolderButton = requireElement<HTMLButtonElement>("#select-bgm-folder");
const bgmStatus = requireElement<HTMLParagraphElement>("#bgm-status");
const loadWadTexturesButton = requireElement<HTMLButtonElement>("#load-wad-textures");
const wadFileInput = requireElement<HTMLInputElement>("#wad-file-input");
const wadStatus = requireElement<HTMLParagraphElement>("#wad-status");
const wadTabLocalButton = requireElement<HTMLButtonElement>("#wad-tab-local");
const wadTabOnlineButton = requireElement<HTMLButtonElement>("#wad-tab-online");
const wadTabPanelLocal = requireElement<HTMLElement>("#wad-tab-panel-local");
const wadTabPanelOnline = requireElement<HTMLElement>("#wad-tab-panel-online");
const onlineWadList = requireElement<HTMLUListElement>("#online-wad-list");
const viewHighscoresButton = requireElement<HTMLButtonElement>("#view-highscores");
const highscoreDialog = requireElement<HTMLDialogElement>("#highscore-dialog");
const highscoreList = requireElement<HTMLElement>("#highscore-list");
const closeHighscoresButton = requireElement<HTMLButtonElement>("#close-highscores");
const multiplayerSubtabHost = requireElement<HTMLButtonElement>("#multiplayer-subtab-host");
const multiplayerSubtabJoin = requireElement<HTMLButtonElement>("#multiplayer-subtab-join");
const multiplayerSubtabPanelHost = requireElement<HTMLElement>("#multiplayer-subtab-panel-host");
const multiplayerSubtabPanelJoin = requireElement<HTMLElement>("#multiplayer-subtab-panel-join");
const multiplayerDisplayNameInput = requireElement<HTMLInputElement>("#multiplayer-display-name-input");
const multiplayerPublicCheckbox = requireElement<HTMLInputElement>("#multiplayer-public-checkbox");
const multiplayerMaxPlayersSelect = requireElement<HTMLSelectElement>("#multiplayer-max-players");
const multiplayerHostCreateButton = requireElement<HTMLButtonElement>("#multiplayer-host-create");
const multiplayerHostCancelButton = requireElement<HTMLButtonElement>("#multiplayer-host-cancel");
const multiplayerHostCode = requireElement<HTMLParagraphElement>("#multiplayer-host-code");
const multiplayerGuestCount = requireElement<HTMLParagraphElement>("#multiplayer-guest-count");
const multiplayerStartSessionButton = requireElement<HTMLButtonElement>("#multiplayer-start-session");
const multiplayerJoinCodeInput = requireElement<HTMLInputElement>("#multiplayer-join-code-input");
const multiplayerJoinConnectButton = requireElement<HTMLButtonElement>("#multiplayer-join-connect");
const multiplayerBrowseLobbyButton = requireElement<HTMLButtonElement>("#multiplayer-browse-lobby");
const multiplayerStatus = requireElement<HTMLParagraphElement>("#multiplayer-status");
const multiplayerLobbyDialog = requireElement<HTMLDialogElement>("#multiplayer-lobby-dialog");
const multiplayerLobbyList = requireElement<HTMLUListElement>("#multiplayer-lobby-list");
const closeMultiplayerLobbyButton = requireElement<HTMLButtonElement>("#close-multiplayer-lobby");
// --- Launch method tabs (Local / Continue / GitHub / Demo level) -----------
// Select Workspace, Continue Run, Load from GitHub, and the bundled demo
// campaign are four different ways to start the same game loop; grouped into
// tabs so only one is shown at a time instead of stacking all four
// permanently in the sidebar.
type LaunchTab = "local" | "continue" | "github" | "demo" | "multiplayer";

const launchTabs: Record<LaunchTab, { button: HTMLButtonElement; panel: HTMLElement }> = {
  local: { button: tabLocal, panel: tabPanelLocal },
  continue: { button: tabContinue, panel: tabPanelContinue },
  github: { button: tabGithub, panel: tabPanelGithub },
  demo: { button: tabDemo, panel: tabPanelDemo },
  multiplayer: { button: tabMultiplayer, panel: tabPanelMultiplayer },
};

function activateLaunchTab(tab: LaunchTab): void {
  for (const name of Object.keys(launchTabs) as LaunchTab[]) {
    const active = name === tab;
    launchTabs[name].button.setAttribute("aria-selected", String(active));
    launchTabs[name].panel.hidden = !active;
  }
}

(Object.keys(launchTabs) as LaunchTab[]).forEach((tab) =>
  launchTabs[tab].button.addEventListener("click", () => activateLaunchTab(tab)),
);

// --- Audio settings (Master/SFX/BGM volume, standing preferences) ----------

masterVolumeInput.value = String(Math.round(loadVolume(MASTER_VOLUME_KEY, 0.5) * 100));
sfxVolumeInput.value = String(Math.round(loadVolume(SFX_VOLUME_KEY, 1) * 100));
bgmVolumeInput.value = String(Math.round(loadVolume(BGM_VOLUME_KEY, 0.5) * 100));
audio.setMasterVolume(Number(masterVolumeInput.value) / 100);
audio.setSfxVolume(Number(sfxVolumeInput.value) / 100);
audio.setBgmVolume(Number(bgmVolumeInput.value) / 100);

masterVolumeInput.addEventListener("input", () => {
  const v = Number(masterVolumeInput.value) / 100;
  audio.setMasterVolume(v);
  saveVolume(MASTER_VOLUME_KEY, v);
});
sfxVolumeInput.addEventListener("input", () => {
  const v = Number(sfxVolumeInput.value) / 100;
  audio.setSfxVolume(v);
  saveVolume(SFX_VOLUME_KEY, v);
});
bgmVolumeInput.addEventListener("input", () => {
  const v = Number(bgmVolumeInput.value) / 100;
  audio.setBgmVolume(v);
  saveVolume(BGM_VOLUME_KEY, v);
});

selectBgmFolderButton.addEventListener("click", async () => {
  try {
    const handle = await pickDirectory("codeenstein-bgm-folder");
    if (!handle) return; // user cancelled the picker
    bgmStatus.textContent = "Loading…";
    const count = await bgm.loadFolder(handle);
    bgmStatus.textContent =
      count > 0 ? `Playing ${count} track(s) from "${handle.name}"` : `No .mp3/.ogg/.wav files found in "${handle.name}"`;
  } catch (err) {
    console.error("[bgm] Failed to load BGM folder:", err);
    bgmStatus.textContent = err instanceof Error ? err.message : "Failed to load BGM folder.";
  }
});

// --- WAD texture pack --------------------------------------------------------
// Optional: source real wall/door/floor textures from a DOOM WAD instead of
// the built-in procedural defaults (see `TextureManager` in engine/textures.ts
// for the auto-selection/fallback rules). A single file, not a folder, so a
// plain `<input type="file">` is used instead of the File System Access API
// picker the other launch/BGM flows use — simpler, and works in every
// Canvas2D-capable browser, not just Chromium.

function describeWadStatus(result: WadLoadSummary, fileName: string): string {
  if (!result.ok) return `Failed to load ${fileName}: ${result.error}`;

  const matched: string[] = [];
  if (result.wallName) matched.push(`walls (${result.wallName})`);
  if (result.bonusWallName) matched.push(`bonus walls (${result.bonusWallName})`);
  if (result.doorName) matched.push(`doors (${result.doorName})`);
  if (result.floorName) matched.push(`floors (${result.floorName})`);
  if (result.bonusFloorName) matched.push(`bonus floors (${result.bonusFloorName})`);
  if (result.loreWallName) matched.push(`lore terminals (${result.loreWallName})`);
  if (result.hazardFloorName) matched.push(`hazard floors (${result.hazardFloorName})`);
  if (result.teleporterFloorName) matched.push(`teleporter floors (${result.teleporterFloorName})`);
  if (result.spikeSafeFloorName) matched.push(`spike traps, safe (${result.spikeSafeFloorName})`);
  if (result.spikeActiveFloorName) matched.push(`spike traps, active (${result.spikeActiveFloorName})`);

  const TOTAL_SLOTS = 10;
  if (matched.length === 0) return `No matching textures found in ${fileName} — using built-in defaults`;
  const missing = matched.length < TOTAL_SLOTS ? " — remaining slots using defaults" : "";
  return `Using WAD textures: ${matched.join(", ")}${missing}`;
}

loadWadTexturesButton.addEventListener("click", () => wadFileInput.click());
wadFileInput.addEventListener("change", async () => {
  const file = wadFileInput.files?.[0];
  wadFileInput.value = ""; // allow re-selecting the same file to re-fire "change"
  if (!file) return;
  wadStatus.textContent = "Loading…";
  try {
    const bytes = await file.arrayBuffer();
    const result = textures.loadFromWad(bytes);
    wadStatus.textContent = describeWadStatus(result, file.name);
  } catch (err) {
    console.error("[wad] Failed to load WAD file:", err);
    wadStatus.textContent = err instanceof Error ? err.message : "Failed to load WAD file.";
  }
});

// --- Online WAD/texture-pack catalog ----------------------------------------
// A curated, license-checked list of free WADs/texture packs (see
// `onlineWadCatalog.ts`'s doc comment), fetched and extracted at build time
// (`scripts/fetch-online-wads.mjs`) into `public/wads/` and served
// same-origin — a direct browser fetch of the original sources isn't
// possible (none of them send usable CORS headers).

async function loadOnlineWad(entry: OnlineWadEntry): Promise<void> {
  wadStatus.textContent = `Loading ${entry.name}…`;
  try {
    const res = await fetch(`/${entry.servedPath}`);
    if (!res.ok) throw new Error(`Failed to fetch ${entry.name}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const result = textures.loadFromWad(bytes);
    wadStatus.textContent = describeWadStatus(result, entry.name);
  } catch (err) {
    console.error("[wad] Failed to load online WAD:", err);
    wadStatus.textContent = err instanceof Error ? err.message : "Failed to load online WAD.";
  }
}

function renderOnlineWadCatalog(): void {
  for (const entry of ONLINE_WAD_CATALOG) {
    const li = document.createElement("li");
    li.className = "online-wad-entry";
    li.dataset.wadId = entry.id;

    const row = document.createElement("div");
    row.className = "online-wad-row";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "online-wad-select-btn";
    selectButton.textContent = entry.name;
    selectButton.addEventListener("click", () => void loadOnlineWad(entry));
    row.appendChild(selectButton);

    const link = document.createElement("a");
    link.className = "online-wad-link";
    link.href = entry.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "info ↗";
    row.appendChild(link);

    li.appendChild(row);

    const licenseLine = document.createElement("p");
    licenseLine.className = "online-wad-meta";
    if (entry.license.toLowerCase().includes("non-commercial")) licenseLine.classList.add("online-wad-meta--restricted");
    licenseLine.textContent = `License: ${entry.license}`;
    li.appendChild(licenseLine);

    const creditsLine = document.createElement("p");
    creditsLine.className = "online-wad-meta";
    creditsLine.textContent = `Credits: ${entry.credits}`;
    li.appendChild(creditsLine);

    onlineWadList.appendChild(li);
  }
}

renderOnlineWadCatalog();

// --- WAD source sub-tabs (Local File / Online) ------------------------------
// A small secondary tab pair, same interaction pattern as the top-level
// launch tabs (`activateLaunchTab`) but scoped to just this one section —
// splitting the local-file picker from the online catalog list keeps the
// sidebar from reading as one long, undifferentiated wall of controls.
type WadTab = "local" | "online";

const wadTabs: Record<WadTab, { button: HTMLButtonElement; panel: HTMLElement }> = {
  local: { button: wadTabLocalButton, panel: wadTabPanelLocal },
  online: { button: wadTabOnlineButton, panel: wadTabPanelOnline },
};

function activateWadTab(tab: WadTab): void {
  for (const name of Object.keys(wadTabs) as WadTab[]) {
    const active = name === tab;
    wadTabs[name].button.setAttribute("aria-selected", String(active));
    wadTabs[name].panel.hidden = !active;
  }
}

(Object.keys(wadTabs) as WadTab[]).forEach((tab) => wadTabs[tab].button.addEventListener("click", () => activateWadTab(tab)));

// --- Highscores dialog -------------------------------------------------------

/** Re-reads the current board (never cached — a "Watch Replay" viewing that
 * just ended may have nothing new to show, but the button itself doesn't
 * know that) and opens the dialog. Shared by the button below and by
 * `startReplay`'s own `returnToHighscores`, so finishing a replay lands the
 * viewer back where they launched it from instead of the plain file-tree
 * placeholder. */
async function openHighscoreDialog(): Promise<void> {
  renderHighscoreTable(highscoreList, await loadHighscoresForDisplay(), {
    onWatchReplay: (entry) => {
      highscoreDialog.close();
      void startReplay(entry);
    },
    onExportReplay: (entry) => {
      highscoreDialog.close();
      void startReplay(entry, { autoRecord: true });
    },
  });
  highscoreDialog.showModal();
}

viewHighscoresButton.addEventListener("click", () => void openHighscoreDialog());
closeHighscoresButton.addEventListener("click", () => highscoreDialog.close());
// Whether closed via the button above, Escape, or a backdrop click, hand
// keyboard focus back to the canvas so a running level's WASD doesn't go
// silently nowhere afterward — same reasoning as `canvas.focus()` elsewhere.
highscoreDialog.addEventListener("close", () => {
  if (activeEngine) canvas.focus();
});

/**
 * The one and only game canvas — created once, attached to `#viewport` once,
 * and never removed again for the rest of the session. This is what F
 * fullscreens (see `InputController`). Never detached: fullscreening an
 * element that gets disconnected from the document — even briefly, e.g. via
 * a naive `replaceChildren` call that happens to include it in both the old
 * and new child list — makes the browser auto-exit fullscreen, which is
 * exactly what made fullscreen drop on every level transition. `launchLevel`
 * only ever touches the *other* children of `#viewport` (the hint caption,
 * the HUD overlay); this canvas is simply left alone.
 *
 * Wrapped in `canvasArea`, a flex-grow box that fills whatever vertical
 * space `#viewport`'s other children (the hint caption, controls legend,
 * replay transport bar) don't need — `watchCanvasSizing` (see
 * `./ui/canvasFit.ts`) then sizes the canvas to the largest 640:400 box
 * that fits inside whatever `canvasArea` ends up with, instead of the fixed
 * max-width the layout used to be capped at, when
 * `RESPONSIVE_CANVAS_SCALING_ENABLED` is on. Shown/hidden via
 * `canvasArea.hidden`, not `canvas.hidden` directly —
 * hiding an *ancestor* of the fullscreen element ends fullscreen exactly the
 * same way hiding the element itself does, so this preserves the same
 * "leaving the game ends fullscreen, a level transition doesn't" behavior
 * the doc comment above used to describe for `canvas.hidden`.
 */
const canvas = document.createElement("canvas");
canvas.width = SCENE_WIDTH;
canvas.height = SCENE_HEIGHT;
canvas.className = "scene-canvas";
canvas.tabIndex = 0; // focusable so it can grab keyboard input on click
const canvasArea = document.createElement("div");
canvasArea.className = "canvas-area";
canvasArea.hidden = true; // not shown until a level is actually running
canvasArea.appendChild(canvas);
viewport.appendChild(canvasArea);

if (RESPONSIVE_CANVAS_SCALING_ENABLED) watchCanvasSizing(canvas, canvasArea, SCENE_WIDTH, SCENE_HEIGHT);

const consoleSidebar = initConsoleSidebar(
  canvas,
  requireElement<HTMLElement>("#console-sidebar"),
  requireElement<HTMLElement>("#console-log"),
);

const mapGenerator = new MapGenerator();

/** The engine currently running in the viewport, if any. */
let activeEngine: RaycasterEngine | null = null;
/** The end-of-run overlay for the level currently running, if any. */
let activeHud: GameHud | null = null;
/** The loaded workspace's file tree, kept around so a "return" tile can find
 * the next parsable file for multi-level progression. */
let workspaceTree: TreeNode | null = null;
/** Path of the level currently running (or last launched), for the same. */
let currentLevelPath: string | null = null;
/** Parsed AST of the level currently running (or last launched) — kept
 * alongside `currentLevelPath` so `advanceToNextLevel`'s "campaign finished"
 * branch can still hash the last-cleared level for a highscore entry, even
 * though it isn't nested in `launchLevel`'s closure the way `onGameOver`/
 * `onWin` are. */
let currentParsedFile: ParsedFile | null = null;
/** Records this *run's* input, across every level it spans, for the replay
 * system — `null` when replaying (a replay never re-records itself). A new
 * one is created only at the start of a genuinely fresh run (see
 * `launchLevel`); auto-advancing to the next level via `advanceToNextLevel`
 * reuses the same instance, appending that level's recording to it. Kept at
 * module scope for the same reason as `currentParsedFile`: `advanceToNextLevel`'s
 * "campaign finished" branch needs it, even though it isn't nested in
 * `launchLevel`'s closure the way `onGameOver` is. */
let currentReplayRecorder: CampaignReplayRecorder | null = null;
/** True while `startReplay` is driving a "Watch Replay" viewing rather than a
 * real playthrough — guards `beforeunload` against persisting a replay's
 * transient state as if it were real campaign progress. */
let isReplaying = false;
/** Tears down whatever replay is currently playing, if any — set by
 * `startReplay`, cleared once it stops. `launchLevel` and `startReplay` both
 * call this before starting anything new, so a replay that's still running
 * (its own `requestAnimationFrame` loop, independent of `activeEngine`) can
 * never end up orphaned, driving a stale engine after the canvas has moved on
 * to a real level or a different replay. */
let stopActiveReplay: (() => void) | null = null;
/** Name of the picked workspace root, for the campaign name and the save file.
 * The File System Access API only grants a handle to the picked directory
 * itself — there's no way to walk up to its parent — so the "or parent
 * directory if named 'src'" case from the spec isn't reachable in a browser
 * sandbox; a root literally named "src" just uses "src" as-is. */
let workspaceRootName: string | null = null;
/** True once the active workspace came from `fetchGithubTree` rather than a
 * local `FileSystemDirectoryHandle` pick. Campaign autosave is skipped
 * entirely in that case — `persistProgress`'s saved state is only ever
 * resumable via "Continue Run", which re-picks a *local* folder through
 * `pickWorkspace()` and has no way to re-fetch a remote repo, so saving would
 * just leave a dead "Continue Run" button pointing nowhere. */
let workspaceIsRemote = false;
/** True once the active workspace is the bundled demo campaign rather than a
 * real GitHub repo — `workspaceIsRemote` is also set alongside this (a
 * bundled tree can't be re-picked locally either, so autosave/"Continue Run"
 * stay disabled the same way), but a highscore recorded here needs its own
 * `source: "demo"` rather than being misattributed to GitHub — see
 * `recordRunHighscore` and `startReplay`. */
let workspaceIsDemo = false;
/** True once any Doom-style cheat code (IDDQD/IDKFA/IDCLIP) has been entered
 * during the active campaign — set by the engine's `onCheatActivated`
 * handler, cleared only at the same reset points `workspaceIsRemote` resets
 * (fresh local pick, GitHub load, demo load, Continue Run), never
 * mid-campaign. Gates `recordRunHighscore` so a cheated run can never claim a
 * leaderboard entry (or attach its replay). */
let cheatsUsed = false;
/** Most recent stats reported by the running engine, used for the throttled
 * autosave and the `beforeunload` flush. */
let lastStats: EngineStats | null = null;
let lastSaveAt = 0;
/** 1-based position in the current campaign's level sequence — level 1 is
 * the first file entered after a fresh workspace pick (or "Continue Run"'s
 * saved level). Incremented only by `advanceToNextLevel`'s auto-chaining, so
 * a manual sidebar pick doesn't count as "campaign progression" — drives
 * `applyForcedUnlocks`'s level-4/8/12 safety net. */
let campaignLevelIndex = 1;
/** In-flight (or already-resolved) whole-codebase stats for the currently
 * loaded workspace — every parsable file in `workspaceTree`, not just the
 * files this run's levels actually visit. Kicked off by
 * `kickOffCodebaseStats` right after a fresh pick/GitHub load/Continue Run
 * re-read, consumed with a bounded wait by `recordRunHighscore`. `null`
 * before any workspace has ever loaded. Never reset by `resetToFileTree` —
 * the same workspace's totals stay valid for every run played against it,
 * not just the one that triggered the computation. */
let codebaseStatsPromise: Promise<CodebaseStats> | null = null;
/** Bumped at the start of every workspace load (local pick, GitHub fetch,
 * demo campaign, Continue Run, Watch Replay) so a slower load already in
 * flight can tell it's been superseded and bail out — without this, a
 * GitHub fetch still in flight when the user fires off a second load (a
 * different repo, a local folder, the demo campaign) would eventually
 * resolve and clobber whatever that second load already committed to
 * `workspaceTree`/the file tree UI. See `beginWorkspaceLoad`. */
let workspaceLoadGeneration = 0;
/** The `AbortController` behind whichever GitHub tree fetch is currently in
 * flight, if any — a GitHub fetch is the only workspace-loading step slow
 * enough to still be running when it gets superseded, so it's the only one
 * that needs an actual network-level abort rather than just losing the
 * generation check in `beginWorkspaceLoad`. */
let activeGithubLoadAbort: AbortController | null = null;

/** Call at the very start of every workspace-loading entry point (before any
 * `await`). Aborts a still-in-flight GitHub fetch from a previous load and
 * returns this load's generation token — stash it locally and compare
 * against `workspaceLoadGeneration` after every subsequent `await` (in both
 * the success path and any `catch`) before touching shared state or the DOM;
 * a mismatch means a newer load has since started and this one should bail
 * out silently. */
function beginWorkspaceLoad(): number {
  activeGithubLoadAbort?.abort();
  activeGithubLoadAbort = null;
  return ++workspaceLoadGeneration;
}
/** Standing gore-level preference — not campaign progress, so it's kept
 * entirely separate from `CampaignSave`/`SAVE_KEY` (see `loadGoreLevel`). */
let currentGoreLevel: GoreLevel = loadGoreLevel();

goreSelect.value = currentGoreLevel;
goreSelect.addEventListener("change", () => {
  currentGoreLevel = goreSelect.value as GoreLevel;
  saveGoreLevel(currentGoreLevel);
});

/** Standing difficulty preference — same "independent standing preference,
 * not campaign progress" shape as `currentGoreLevel`. */
let currentDifficulty: DifficultyLevel = loadDifficulty();

difficultySelect.value = currentDifficulty;
difficultySelect.addEventListener("change", () => {
  currentDifficulty = difficultySelect.value as DifficultyLevel;
  saveDifficulty(currentDifficulty);
});

if (!isFileSystemAccessSupported()) {
  selectButton.disabled = true;
  continueButton.disabled = true;
  workspaceName.textContent =
    "This browser does not support the File System Access API. Use Chrome, Edge, or Brave.";
  workspaceName.classList.add("error");
}

if (loadCampaignSave()) tabContinue.style.display = "";

selectButton.addEventListener("click", async () => {
  const gen = beginWorkspaceLoad();
  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker
    if (gen !== workspaceLoadGeneration) return; // superseded while the picker was open

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");
    showLoadingScreen(`Reading "${handle.name}"…`);

    const tree = await readDirectoryTree(handle);
    if (gen !== workspaceLoadGeneration) return; // superseded while reading the workspace
    workspaceTree = tree;
    workspaceRootName = handle.name;
    workspaceIsRemote = false;
    workspaceIsDemo = false;
    cheatsUsed = false;
    workspaceName.textContent = handle.name;
    campaignLevelIndex = 1; // a fresh pick always starts a new campaign
    updateMultiplayerTabEnabled();
    kickOffCodebaseStats(tree);

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[workspace] Loaded "${handle.name}"`, tree);
    await autoLaunchInitialLevel(tree);
  } catch (err) {
    if (gen !== workspaceLoadGeneration) return; // a newer load's own error handling owns the screen now
    console.error("[workspace] Failed to read workspace:", err);
    workspaceName.textContent =
      err instanceof Error ? err.message : "Failed to read workspace.";
    workspaceName.classList.add("error");
    showFileTreePlaceholder();
  }
});

/** Fetches and launches whatever repo reference is currently in
 * `githubRepoInput`, shared by the "Load from GitHub" button and the
 * "Suggested repos" quick-pick buttons below it. Both callers guarantee a
 * parseable value before this ever runs: the button is disabled whenever
 * `githubRepoInput` doesn't parse (`updateLoadGithubRepoButtonEnabled`), and
 * every suggestion button's `data-repo` is a hardcoded valid "owner/repo". */
async function loadGithubRepoFromInput(): Promise<void> {
  const ref = parseGithubRepoInput(githubRepoInput.value)!;

  const gen = beginWorkspaceLoad();
  const controller = new AbortController();
  activeGithubLoadAbort = controller;

  try {
    loadGithubRepoButton.disabled = true;
    githubSuggestionButtons.forEach((btn) => (btn.disabled = true));
    githubStatus.classList.remove("error");
    githubStatus.textContent = `Fetching "${ref.owner}/${ref.repo}"…`;
    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");
    showLoadingScreen(`Fetching "${ref.owner}/${ref.repo}" from GitHub…`);

    const tree = await fetchGithubTree(
      ref,
      (bytesReceived) => {
        setLoadingStatus(`Fetching "${ref.owner}/${ref.repo}" from GitHub… (${formatByteCount(bytesReceived)} received)`);
      },
      controller.signal,
    );
    if (gen !== workspaceLoadGeneration) return; // superseded while fetching — already aborted above
    workspaceTree = tree;
    workspaceRootName = `${ref.owner}/${ref.repo}`;
    workspaceIsRemote = true;
    workspaceIsDemo = false;
    cheatsUsed = false;
    workspaceName.textContent = workspaceRootName;
    campaignLevelIndex = 1; // a fresh load always starts a new campaign
    updateMultiplayerTabEnabled();
    kickOffCodebaseStats(tree);
    clearCampaignSave(); // a stale local-workspace save shouldn't dangle a "Continue Run" button while a remote repo is loaded

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[github] Loaded "${workspaceRootName}"`, tree);
    githubStatus.textContent = "";
    await autoLaunchInitialLevel(tree);
  } catch (err) {
    // A superseding load aborts this fetch itself (see `beginWorkspaceLoad`),
    // which surfaces here as an `AbortError` — that newer load already owns
    // the screen, so this stale failure has nothing useful to report.
    if (gen !== workspaceLoadGeneration) return;
    console.error("[github] Failed to load repository:", err);
    const message = err instanceof Error ? err.message : "Failed to load repository.";
    githubStatus.textContent = message;
    githubStatus.classList.add("error");
    workspaceName.textContent = message;
    workspaceName.classList.add("error");
    showFileTreePlaceholder();
  } finally {
    if (activeGithubLoadAbort === controller) activeGithubLoadAbort = null;
    updateLoadGithubRepoButtonEnabled();
    githubSuggestionButtons.forEach((btn) => (btn.disabled = false));
  }
}

loadGithubRepoButton.addEventListener("click", () => {
  void loadGithubRepoFromInput();
});

// Disabled until the input actually parses as a loadable "owner/repo" or
// github.com URL (see `parseGithubRepoInput`) — `loadGithubRepoFromInput`
// relies on this as its only validation. A `title` tooltip explains the
// disabled state, since a greyed-out button alone doesn't say why.
const LOAD_GITHUB_REPO_DISABLED_TITLE = 'Enter a repo as "owner/repo" or a github.com URL first';
function updateLoadGithubRepoButtonEnabled(): void {
  const disabled = parseGithubRepoInput(githubRepoInput.value) === null;
  loadGithubRepoButton.disabled = disabled;
  loadGithubRepoButton.title = disabled ? LOAD_GITHUB_REPO_DISABLED_TITLE : "";
}
updateLoadGithubRepoButtonEnabled();
githubRepoInput.addEventListener("input", updateLoadGithubRepoButtonEnabled);

// "Suggested repos" quick-picks: same load path as typing a repo in by hand,
// just pre-filling the input first so the status/error messaging stays in
// one place instead of duplicating the fetch-and-launch flow per button.
githubSuggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const repo = button.dataset.repo;
    if (!repo) return;
    githubRepoInput.value = repo;
    void loadGithubRepoFromInput();
  });
});

/** Launches the bundled `demo-campaign/` showcase — same shape as
 * `loadGithubRepoFromInput`, but the tree is built synchronously from the
 * app's own bundle (`loadDemoCampaignTree`) instead of a network fetch, so
 * there's no progress callback and nothing to await before it's ready. */
async function loadDemoCampaign(): Promise<void> {
  const gen = beginWorkspaceLoad();
  try {
    launchDemoCampaignButton.disabled = true;
    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");
    showLoadingScreen(`Reading "${DEMO_CAMPAIGN_NAME}"…`);

    const tree = loadDemoCampaignTree();
    workspaceTree = tree;
    workspaceRootName = DEMO_CAMPAIGN_NAME;
    workspaceIsRemote = true;
    workspaceIsDemo = true;
    cheatsUsed = false;
    workspaceName.textContent = workspaceRootName;
    campaignLevelIndex = 1; // a fresh load always starts a new campaign
    updateMultiplayerTabEnabled();
    kickOffCodebaseStats(tree);
    clearCampaignSave(); // a stale local-workspace save shouldn't dangle a "Continue Run" button while the demo campaign is loaded

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[demo] Loaded "${workspaceRootName}"`, tree);
    await autoLaunchInitialLevel(tree);
  } catch (err) {
    // Unlike the other three loaders (local pick, GitHub, Continue Run),
    // this supersession check is unreachable: every read along
    // autoLaunchInitialLevel's path (findEntrypoint's byName match,
    // isParsableNode's scan, the inner try/catch around the final
    // read/parse/launch) already swallows its own errors internally and
    // never rethrows — so the only way this catch fires at all is
    // loadDemoCampaignTree() throwing synchronously, on the very first
    // tick, before any await has run and thus before `gen` could possibly
    // have changed. Kept for symmetry with the other three loaders and as
    // a safety net if that internal error-swallowing ever changes.
    /* v8 ignore next */
    if (gen !== workspaceLoadGeneration) return;
    console.error("[demo] Failed to load demo campaign:", err);
    const message = err instanceof Error ? err.message : "Failed to load demo campaign.";
    workspaceName.textContent = message;
    workspaceName.classList.add("error");
    showFileTreePlaceholder();
  } finally {
    launchDemoCampaignButton.disabled = false;
  }
}

launchDemoCampaignButton.addEventListener("click", () => {
  void loadDemoCampaign();
});

continueButton.addEventListener("click", async () => {
  const save = loadCampaignSave();
  if (!save) return; // button should already be hidden in this case

  const gen = beginWorkspaceLoad();
  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker
    if (gen !== workspaceLoadGeneration) return; // superseded while the picker was open

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");
    showLoadingScreen(`Reading "${handle.name}"…`);

    const tree = await readDirectoryTree(handle);
    if (gen !== workspaceLoadGeneration) return; // superseded while reading the workspace
    workspaceTree = tree;
    workspaceRootName = handle.name;
    workspaceIsRemote = false;
    workspaceIsDemo = false;
    cheatsUsed = false;
    workspaceName.textContent = handle.name;
    updateMultiplayerTabEnabled();
    kickOffCodebaseStats(tree);
    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });

    setLoadingStatus("Locating saved level…");
    const match = (await flattenParsableFiles(tree)).find((f) => f.path === save.filePath);
    if (!match) {
      console.warn(
        `[continue] Saved file "${save.filePath}" not found in "${handle.name}" — starting a fresh run instead.`,
      );
      clearCampaignSave();
      await autoLaunchInitialLevel(tree);
      return;
    }

    setLoadingStatus(`Parsing ${match.name}…`);
    const text = await readFileText(match.handle as FileSystemFileHandle);
    const parsed = await parseFile(match.name, text);
    if (gen !== workspaceLoadGeneration) return; // superseded while parsing the saved level
    if (parsed) {
      campaignLevelIndex = save.levelIndex;
      console.log(`%c[continue] resuming at ${match.path}`, "color:#8effa0;font-weight:bold");
      setLoadingStatus("Generating world…");
      await yieldToMainThread(); // let the status above paint before the synchronous map generation below
      launchLevel(match.path, parsed, {
        health: save.health,
        swap: save.swap,
        bullets: save.bullets,
        rockets: save.rockets,
        smg: save.smg,
        gas: save.gas,
        priorScore: save.score,
        weaponIndex: save.weaponIndex,
        ownedWeapons: save.ownedWeapons,
      });
    } else {
      showFileTreePlaceholder();
    }
  } catch (err) {
    if (gen !== workspaceLoadGeneration) return;
    console.error("[continue] Failed to resume campaign:", err);
    workspaceName.textContent = err instanceof Error ? err.message : "Failed to resume campaign.";
    workspaceName.classList.add("error");
    showFileTreePlaceholder();
  }
});

// --- Multiplayer: connect flow (Host/Join UI, signaling, WebRTC) -----------
// Step 2 of multiplayer-research.md's implementation plan: gets two browsers
// to hold an open RTCDataChannel via a short code. Deliberately no
// session-setup payload, no map transfer, no gameplay yet — see
// doc/dev/multiplayer-netcode-spec.md and doc/dev/multiplayer-server-spec.md
// for what later steps build on top of this.

/** Multiplayer hosting/joining is only available for a GitHub-loaded repo or
 * the Demos campaign — never a locally-picked workspace (see
 * multiplayer-research.md's "Privacy: resolved"). `workspaceIsDemo` always
 * implies `workspaceIsRemote` in every load path today, but this checks both
 * explicitly rather than depending on that implication silently holding
 * forever (see multiplayer-game-state-spec.md §1). */
function isMultiplayerEligibleWorkspace(): boolean {
  return workspaceIsRemote || workspaceIsDemo;
}

const MULTIPLAYER_TAB_DISABLED_TITLE = "Multiplayer requires a GitHub-loaded repo or the Demos campaign";
/** Called from every workspace-loading entry point right after
 * `workspaceIsRemote`/`workspaceIsDemo` are set — same "call at every
 * assignment site" discipline as `updateLoadGithubRepoButtonEnabled`. Bounces
 * back to the Local tab if Multiplayer was active and just became
 * ineligible, so the UI never leaves a disabled tab showing as selected. */
function updateMultiplayerTabEnabled(): void {
  const eligible = isMultiplayerEligibleWorkspace();
  tabMultiplayer.disabled = !eligible;
  tabMultiplayer.title = eligible ? "" : MULTIPLAYER_TAB_DISABLED_TITLE;
  if (!eligible && tabMultiplayer.getAttribute("aria-selected") === "true") activateLaunchTab("local");
}
updateMultiplayerTabEnabled();

// Host/Join sub-tabs — same nested-tab pattern as the WAD source sub-tabs
// (`activateWadTab` above).
type MultiplayerSubtab = "host" | "join";
const multiplayerSubtabs: Record<MultiplayerSubtab, { button: HTMLButtonElement; panel: HTMLElement }> = {
  host: { button: multiplayerSubtabHost, panel: multiplayerSubtabPanelHost },
  join: { button: multiplayerSubtabJoin, panel: multiplayerSubtabPanelJoin },
};
function activateMultiplayerSubtab(tab: MultiplayerSubtab): void {
  for (const name of Object.keys(multiplayerSubtabs) as MultiplayerSubtab[]) {
    const active = name === tab;
    multiplayerSubtabs[name].button.setAttribute("aria-selected", String(active));
    multiplayerSubtabs[name].panel.hidden = !active;
  }
}
(Object.keys(multiplayerSubtabs) as MultiplayerSubtab[]).forEach((tab) =>
  multiplayerSubtabs[tab].button.addEventListener("click", () => activateMultiplayerSubtab(tab)),
);

const MULTIPLAYER_ICE_GATHERING_TIMEOUT_MS = 10_000;
const MULTIPLAYER_CHANNELS_OPEN_TIMEOUT_MS = 15_000;
const MULTIPLAYER_HOST_POLL_INTERVAL_MS = 1_500;

let multiplayerConnectionState: ConnectionState = "idle";
/** The live connection once "connected" — later steps (netcode core) will
 * consume this; step 2 only proves it reaches "connected" with both
 * channels open. */
let activeMultiplayerConnection: MultiplayerConnection | null = null;
/** The live session once gameplay has actually started (session setup
 * resolved and `runMultiplayerSessionAsHost`/`Guest` is driving ticks) — set
 * once `activeMultiplayerConnection` reaches `"connected"` and either the
 * host clicks Start or the guest's own setup resolves; cleared once the
 * shared simulation ends (see `onMultiplayerSessionEnded`). */
let activeMultiplayerSession: MultiplayerSessionHandle | null = null;
/** Bumped at the start of every connect attempt (Host create, Join) — same
 * "supersede a stale in-flight attempt by generation check" discipline as
 * `workspaceLoadGeneration`/`beginWorkspaceLoad` above. */
let multiplayerConnectionGeneration = 0;
let activeMultiplayerAbort: AbortController | null = null;
let hostAnswerPollTimer: ReturnType<typeof setTimeout> | null = null;

function beginMultiplayerConnect(): { generation: number; signal: AbortSignal } {
  activeMultiplayerAbort?.abort();
  if (hostAnswerPollTimer !== null) {
    clearTimeout(hostAnswerPollTimer);
    hostAnswerPollTimer = null;
  }
  const controller = new AbortController();
  activeMultiplayerAbort = controller;
  return { generation: ++multiplayerConnectionGeneration, signal: controller.signal };
}

function setMultiplayerStatus(message: string, isError: boolean): void {
  multiplayerStatus.textContent = message;
  multiplayerStatus.classList.toggle("error", isError);
}

function describeMultiplayerError(err: unknown): string {
  if (err instanceof SignalingError) {
    if (err.code === "rate_limited") return "Rate-limited by the multiplayer server — try again shortly.";
    if (err.code === "session_not_found") return "No session found for that code — it may have expired.";
    if (err.code === "already_answered") return "Someone else already joined that session.";
    return `Multiplayer server error: ${err.code}`;
  }
  return err instanceof Error ? err.message : "Multiplayer connection failed.";
}

// --- Host flow -----------------------------------------------------------

/** Polls `GET /session/<code>` (with the host token, exempt from the
 * guess-sensitive rate budget) until an answer appears. Resolves to `null`
 * if superseded or cancelled first — always in lockstep with
 * `multiplayerConnectionGeneration` also changing (`beginMultiplayerConnect`
 * and the Cancel handler both bump it in the same breath they abort), so a
 * caller that's already checked `generation !== multiplayerConnectionGeneration`
 * and found it unchanged can treat a non-null result as guaranteed — see
 * `createMultiplayerSession`'s own use of this. Rejects only on
 * `session_not_found` (the session expired mid-wait, no point continuing);
 * any other failure (a transient network blip, one rate-limited tick) is
 * retried rather than surfaced as a hard error. */
function pollForHostAnswer(
  code: string,
  hostToken: string,
  generation: number,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      // `beginMultiplayerConnect()` and the Cancel handler both clear
      // `hostAnswerPollTimer` in the same synchronous breath they bump the
      // generation/abort the signal, so a scheduled retry can never actually
      // fire with a stale generation — and there's no `await` between this
      // function's own capture of `generation` and its first (non-retry)
      // call either. Kept as a guard against a future call site changing
      // that, not because it's reachable today.
      /* v8 ignore next */
      if (generation !== multiplayerConnectionGeneration || signal.aborted) return resolve(null);
      try {
        const result = await fetchSessionAsHost(code, hostToken, signal);
        if (generation !== multiplayerConnectionGeneration || signal.aborted) return resolve(null);
        if (result.answer) return resolve(result.answer);
        hostAnswerPollTimer = setTimeout(poll, MULTIPLAYER_HOST_POLL_INTERVAL_MS);
      } catch (err) {
        if (generation !== multiplayerConnectionGeneration || signal.aborted) return resolve(null);
        if (err instanceof SignalingError && err.code === "session_not_found") return reject(err);
        console.warn("[multiplayer] host poll failed, retrying:", err);
        hostAnswerPollTimer = setTimeout(poll, MULTIPLAYER_HOST_POLL_INTERVAL_MS);
      }
    };
    void poll();
  });
}

/** Live "N/maxPlayers connected" readout, shown only while hosting. Reads
 * straight off `activeMultiplayerConnection.links` — the single source of
 * truth for who's joined so far — rather than tracking a separate counter
 * that could drift from it. */
function updateMultiplayerGuestCountDisplay(): void {
  if (!activeMultiplayerConnection || activeMultiplayerConnection.role !== "host") {
    multiplayerGuestCount.hidden = true;
    return;
  }
  const { links, maxPlayers } = activeMultiplayerConnection;
  multiplayerGuestCount.hidden = false;
  multiplayerGuestCount.textContent = `${links.size + 1}/${maxPlayers} players connected`;
}

/** Arms the next open guest slot (if any) by publishing a fresh offer under
 * the *same* code — `multiplayer-server-spec.md` §2's documented "a lobby
 * with more than two players is supported by the host publishing a fresh
 * offer under the same code" mechanism, already implemented server-side and
 * exposed via `signalingClient.updateSession()`, just never called from here
 * before step 10. Runs automatically after every successful join (including
 * the very first, from `createMultiplayerSession` below) — no manual "ready
 * for next joiner" action needed, since the signaling layer's "sequential,
 * not concurrent" constraint is about one offer being pending at a time, not
 * about waiting on the host to say so.
 *
 * `generation`/`signal` are the *same* ones `createMultiplayerSession`
 * captured for the first guest — reused across every subsequent slot rather
 * than starting a fresh one, so Cancel (before "connected") and
 * `startMultiplayerSessionAsHost`'s own generation bump (once the roster is
 * finalized) both cleanly stop this recursion the same way they already stop
 * everything else keyed to a generation. */
async function armNextGuestSlot(generation: number, signal: AbortSignal): Promise<void> {
  // Both guards below are genuinely unreachable via this function's only two
  // call sites (immediately after a successful join, both still within the
  // same generation/connection that was just established) — every real
  // cancellation race this recursion needs to survive is instead covered
  // inside the `await`-separated checks further down (see the "stale
  // generation" tests covering mid-ICE/mid-updateSession/mid-poll/
  // mid-channel-open cancellation). Kept as a defensive entry guard, not
  // dead code: a future call site added here without the same invariant
  // would still be safe.
  /* v8 ignore next 2 */
  if (generation !== multiplayerConnectionGeneration || signal.aborted) return;
  if (!activeMultiplayerConnection || activeMultiplayerConnection.role !== "host") return;
  const { code, hostToken, maxPlayers, links } = activeMultiplayerConnection;
  if (links.size + 1 >= maxPlayers) return; // every slot already filled

  let guestPeerConnection: RTCPeerConnection | null = null;
  try {
    const { peerConnection, channels, offerSdp } = await createHostOffer(MULTIPLAYER_ICE_GATHERING_TIMEOUT_MS);
    guestPeerConnection = peerConnection;
    if (generation !== multiplayerConnectionGeneration || signal.aborted) {
      peerConnection.close();
      return;
    }

    await updateSession(
      code,
      hostToken,
      {
        offer: offerSdp,
        public: multiplayerPublicCheckbox.checked,
        displayName: multiplayerDisplayNameInput.value.trim() || undefined,
        playerCount: links.size + 1,
        /* v8 ignore next */
        campaignName: workspaceRootName ?? "unknown",
      },
      signal,
    );
    if (generation !== multiplayerConnectionGeneration || signal.aborted) {
      peerConnection.close();
      return;
    }

    setMultiplayerStatus(`Waiting for another guest to join with code ${code}…`, false);
    const answer = await pollForHostAnswer(code, hostToken, generation, signal);
    if (generation !== multiplayerConnectionGeneration || signal.aborted || answer === null) {
      peerConnection.close();
      return;
    }

    await peerConnection.setRemoteDescription({ type: "answer", sdp: answer });
    await waitForChannelsOpen(channels, MULTIPLAYER_CHANNELS_OPEN_TIMEOUT_MS);
    if (generation !== multiplayerConnectionGeneration || signal.aborted) {
      peerConnection.close();
      return;
    }

    links.set(guestPlayerId(links.size + 1), { peerConnection, channels });
    updateMultiplayerGuestCountDisplay();
    setMultiplayerStatus(`Connected — ${links.size + 1}/${maxPlayers} players.`, false);

    void armNextGuestSlot(generation, signal); // arm the next slot, if any remain
  } catch (err) {
    guestPeerConnection?.close();
    // Non-fatal: the host can still Start Session with however many guests
    // already joined — a failed re-arm just means no further guest can join
    // this session.
    console.warn("[multiplayer] failed to arm the next guest slot:", err);
  }
}

async function createMultiplayerSession(): Promise<void> {
  const { generation, signal } = beginMultiplayerConnect();
  multiplayerConnectionState = "creating-session";
  multiplayerHostCreateButton.disabled = true;
  multiplayerMaxPlayersSelect.disabled = true;
  multiplayerHostCancelButton.hidden = false;
  multiplayerHostCode.hidden = true;
  setMultiplayerStatus("Creating session…", false);

  // Hoisted so `finally` below can close a peer connection that was
  // successfully created but never reached "connected" — including every
  // silent `if (generation !== ...) return` bail-out, not just a thrown
  // error; a superseded/cancelled attempt shouldn't leave its own
  // `RTCPeerConnection` sitting open with nothing left driving it forward.
  let hostPeerConnection: RTCPeerConnection | null = null;
  let connected = false;

  try {
    const { peerConnection, channels, offerSdp } = await createHostOffer(MULTIPLAYER_ICE_GATHERING_TIMEOUT_MS);
    hostPeerConnection = peerConnection;
    if (generation !== multiplayerConnectionGeneration) return;

    const maxPlayers = Number(multiplayerMaxPlayersSelect.value);
    const displayName = multiplayerDisplayNameInput.value.trim();
    const session = await createSession(
      {
        offer: offerSdp,
        public: multiplayerPublicCheckbox.checked,
        displayName: displayName || undefined,
        playerCount: 1,
        // The Multiplayer tab is only ever enabled once `workspaceRootName`
        // is already a real string (see `isMultiplayerEligibleWorkspace`'s
        // doc comment) — the fallback is defensive against that gating ever
        // changing, not a reachable case today.
        /* v8 ignore next */
        campaignName: workspaceRootName ?? "unknown",
      },
      signal,
    );
    if (generation !== multiplayerConnectionGeneration) return;

    multiplayerHostCode.textContent = session.code;
    multiplayerHostCode.hidden = false;
    multiplayerConnectionState = "awaiting-answer";
    setMultiplayerStatus(`Waiting for a guest to join with code ${session.code}…`, false);

    const answer = await pollForHostAnswer(session.code, session.hostToken, generation, signal);
    if (generation !== multiplayerConnectionGeneration) return;
    // `answer` is guaranteed non-null here — see `pollForHostAnswer`'s doc
    // comment for why a null result always accompanies a generation change,
    // which the check above already caught.

    multiplayerConnectionState = "connecting";
    setMultiplayerStatus("Guest found — establishing connection…", false);
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answer! });
    await waitForChannelsOpen(channels, MULTIPLAYER_CHANNELS_OPEN_TIMEOUT_MS);
    if (generation !== multiplayerConnectionGeneration) return;

    const links: Map<PlayerId, HostGuestLink> = new Map([[guestPlayerId(1), { peerConnection, channels }]]);
    activeMultiplayerConnection = { role: "host", code: session.code, hostToken: session.hostToken, maxPlayers, links };
    multiplayerConnectionState = "connected";
    setMultiplayerStatus("Connected.", false);
    multiplayerStartSessionButton.hidden = false;
    updateMultiplayerGuestCountDisplay();
    connected = true;

    void armNextGuestSlot(generation, signal); // start looking for guest 2, if maxPlayers allows it
  } catch (err) {
    if (generation === multiplayerConnectionGeneration) {
      multiplayerConnectionState = "error";
      setMultiplayerStatus(describeMultiplayerError(err), true);
    }
  } finally {
    if (!connected) hostPeerConnection?.close();
    if (generation === multiplayerConnectionGeneration) {
      multiplayerHostCreateButton.disabled = false;
      multiplayerMaxPlayersSelect.disabled = false;
      multiplayerHostCancelButton.hidden = true;
    }
  }
}

multiplayerHostCreateButton.addEventListener("click", () => void createMultiplayerSession());
multiplayerHostCancelButton.addEventListener("click", () => {
  activeMultiplayerAbort?.abort();
  activeMultiplayerAbort = null;
  multiplayerConnectionGeneration++; // invalidates the in-flight attempt without starting a new one
  if (hostAnswerPollTimer !== null) {
    clearTimeout(hostAnswerPollTimer);
    hostAnswerPollTimer = null;
  }
  activeMultiplayerConnection = null;
  multiplayerConnectionState = "idle";
  multiplayerHostCreateButton.disabled = false;
  multiplayerMaxPlayersSelect.disabled = false;
  multiplayerHostCancelButton.hidden = true;
  multiplayerHostCode.hidden = true;
  multiplayerStartSessionButton.hidden = true;
  updateMultiplayerGuestCountDisplay();
  setMultiplayerStatus("Cancelled.", false);
});

// --- Join flow -------------------------------------------------------------

async function joinMultiplayerSession(code: string): Promise<void> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return;
  const { generation, signal } = beginMultiplayerConnect();
  multiplayerConnectionState = "fetching-session";
  multiplayerJoinConnectButton.disabled = true;
  setMultiplayerStatus(`Fetching session ${trimmed}…`, false);

  // Hoisted so `finally` below can tear down a connection that was
  // successfully created but never made it to "connected" — including every
  // silent `if (generation !== ...) return` bail-out, not just a thrown
  // error. `channelsPromise` in particular (see `createGuestAnswer`'s doc
  // comment): if execution bails out after it exists but before `await
  // channelsPromise` below ever runs, that promise is otherwise abandoned —
  // nothing left awaiting it — and its own internal timeout rejecting later
  // becomes a genuine unhandled rejection.
  let guestPeerConnection: RTCPeerConnection | null = null;
  let guestChannelsPromise: Promise<unknown> | null = null;
  let connected = false;

  try {
    const session = await fetchSession(trimmed, signal);
    if (generation !== multiplayerConnectionGeneration) return;

    multiplayerConnectionState = "connecting";
    setMultiplayerStatus("Establishing connection…", false);
    const { peerConnection, channelsPromise, answerSdp } = await createGuestAnswer(
      session.offer,
      MULTIPLAYER_ICE_GATHERING_TIMEOUT_MS,
      MULTIPLAYER_CHANNELS_OPEN_TIMEOUT_MS,
    );
    guestPeerConnection = peerConnection;
    guestChannelsPromise = channelsPromise;
    if (generation !== multiplayerConnectionGeneration) return;

    // Submit the answer *before* awaiting `channelsPromise` — the host can
    // only apply this answer (and the channels only actually open) once it's
    // arrived; see `createGuestAnswer`'s doc comment.
    await postAnswer(trimmed, answerSdp, signal);
    if (generation !== multiplayerConnectionGeneration) return;

    const channels = await channelsPromise;
    if (generation !== multiplayerConnectionGeneration) return;

    await waitForChannelsOpen(channels, MULTIPLAYER_CHANNELS_OPEN_TIMEOUT_MS);
    if (generation !== multiplayerConnectionGeneration) return;

    activeMultiplayerConnection = { role: "guest", code: trimmed, peerConnection, channels };
    multiplayerConnectionState = "connected";
    setMultiplayerStatus("Connected.", false);
    connected = true;
    void startMultiplayerSessionAsGuest();
  } catch (err) {
    if (generation === multiplayerConnectionGeneration) {
      multiplayerConnectionState = "error";
      setMultiplayerStatus(describeMultiplayerError(err), true);
    }
  } finally {
    if (!connected) {
      guestPeerConnection?.close();
      guestChannelsPromise?.catch(() => {});
    }
    if (generation === multiplayerConnectionGeneration) multiplayerJoinConnectButton.disabled = false;
  }
}

multiplayerJoinConnectButton.addEventListener("click", () => void joinMultiplayerSession(multiplayerJoinCodeInput.value));

// --- Starting a multiplayer level (session setup + netcode, step 6c) -------
// Picks up exactly where the connect flow above leaves off: every connected
// peer holding an open `RTCDataChannel` pair toward the host. Coop supports
// 2-4 players (step 10: host + up to 3 guests, chosen via the host's own
// `maxPlayers` select) — `playerCount` is always the roster's real length,
// never hardcoded.

/** Shared DOM setup for a multiplayer level, mirroring `launchLevel`'s own
 * sequence minus everything single-player-only (briefing gate, replay
 * recorder, campaign-progression carryover) — those are explicitly out of
 * scope for this step (see `multiplayer-netcode-spec.md` §8). */
function beginMultiplayerLevel(): void {
  stopActiveReplay?.();
  activeEngine?.stop();
  for (const child of [...viewport.children]) {
    if (child !== canvasArea) child.remove();
  }
  viewport.append(buildControlsLegend());
  canvasArea.hidden = false;
  canvas.focus();
}

/** Title/theme color for the end-of-run comparison screen, one per
 * `SessionEndReason` — mirrors `GameHud.showKernelPanic`/`showBuildSuccessful`'s
 * own red/green theming, plus a distinct amber for the guest-only provisional
 * `"host-disconnected"` ending. */
const MULTIPLAYER_RESULT_THEME: Record<SessionEndReason, { title: string; color: string }> = {
  "team-eliminated": { title: "MULTIPLAYER: TEAM ELIMINATED", color: "#ff4d4d" },
  "host-disconnected": { title: "MULTIPLAYER: HOST DISCONNECTED", color: "#f2c14e" },
  "campaign-complete": { title: "MULTIPLAYER: CAMPAIGN COMPLETE", color: "#37d24a" },
};

/** Builds the comparison table's rows from `RaycasterEngine.rosterSnapshot()`
 * — one row per roster player, `breakdown.total` (the cumulative *run* score,
 * see `rosterSnapshot()`'s own doc comment) plus kills, labeled with the
 * roster id capitalized (`"host"` -> "Host", `"guest-1"` -> "Guest-1", etc. —
 * see `sessionSetupTypes.ts`'s `HOST_PLAYER_ID`/`guestPlayerId()`) and
 * suffixed `" (disconnected)"` per `multiplayer-netcode-spec.md` §5's "score
 * preserved, not erased, labeled disconnected" rule. */
export function multiplayerResultRows(comparison: ReadonlyMap<PlayerId, RosterSnapshotEntry>): [string, string][] {
  return [...comparison].map(([id, entry]) => {
    const label = id.charAt(0).toUpperCase() + id.slice(1);
    const disconnectedSuffix = entry.status === "disconnected" ? " (disconnected)" : "";
    return [label, `${entry.breakdown.total} pts · ${entry.kills} kills${disconnectedSuffix}`];
  });
}

/** Fired once the shared simulation reaches game-over/win — deterministically
 * the same tick on both peers, except for `"host-disconnected"` (guest-only,
 * fired from the guest's own local grace-timer expiry, never simultaneous
 * with the host, and sourced from this peer's own local, provisional state —
 * see `sessionEngine.ts`'s own doc comment). Shows the end-of-run comparison
 * table (multiplayer step 9) built from `comparison` before returning to the
 * file tree — `resetToFileTree()` now fires from the overlay's own dismiss,
 * not immediately. */
function onMultiplayerSessionEnded(
  _stats: EngineStats,
  reason: SessionEndReason,
  comparison: ReadonlyMap<PlayerId, RosterSnapshotEntry>,
): void {
  activeMultiplayerSession = null;
  const message: Record<SessionEndReason, string> = {
    "team-eliminated": "Multiplayer session ended — every player was eliminated.",
    "host-disconnected": "Multiplayer session ended — the host disconnected.",
    "campaign-complete": "Multiplayer session ended — campaign complete!",
  };
  setMultiplayerStatus(message[reason], false);
  const { title, color } = MULTIPLAYER_RESULT_THEME[reason];
  const hud = new GameHud(canvas);
  activeHud = hud;
  hud.showMultiplayerResults(title, color, multiplayerResultRows(comparison), resetToFileTree);
}

async function startMultiplayerSessionAsHost(): Promise<void> {
  if (!activeMultiplayerConnection || activeMultiplayerConnection.role !== "host") return;
  if (!currentParsedFile || !currentLevelPath) {
    // Reachable: `isMultiplayerEligibleWorkspace()` only checks
    // `workspaceIsRemote`/`workspaceIsDemo` (was a real repo/the Demos
    // campaign loaded at all), not whether a level ever actually
    // auto-launched from it — a GitHub repo with no recognized entrypoint
    // stays multiplayer-eligible (the tab enables) but never sets
    // `currentParsedFile`/`currentLevelPath`.
    setMultiplayerStatus("No workspace loaded to host a level from.", true);
    return;
  }
  const { links } = activeMultiplayerConnection;
  const initialLevelPath = currentLevelPath;
  multiplayerStartSessionButton.disabled = true;
  setMultiplayerStatus("Starting session…", false);
  // Finalizes the roster at whatever's actually connected right now — stops
  // `armNextGuestSlot`'s own recursion from adding a guest after this point
  // (its generation check catches this the same way Cancel already does; see
  // that function's own doc comment). A guest that connects moments after
  // this simply never gets a `session-init` and the connection just sits
  // unused — no different in effect from Cancel superseding an in-flight
  // attempt.
  multiplayerConnectionGeneration++;
  try {
    const roster = [HOST_PLAYER_ID, ...links.keys()].sort();
    const bonusLevel = BONUS_LEVEL_EXTENSIONS.has(extensionOf(currentLevelPath));
    // A fresh multiplayer session always starts with no carryover — same
    // "no owned weapons yet, level 1" shape `launchLevel` uses for a genuinely
    // new run.
    const missingWeaponIndices = computeMissingWeaponIndices([], 1);
    const map = mapGenerator.generate(currentParsedFile, bonusLevel, false, missingWeaponIndices, roster.length);
    const setupOptions: HostSessionSetupOptions = { map, difficulty: currentDifficulty, roster, gameplaySeed: randomSeed() };
    // Every guest's own handshake+map-transfer is an independent chunked
    // transfer with its own backpressure wait — fanned out concurrently, not
    // sequentially, for the same reason `multiplayerSessionHost.ts`'s own
    // level-transition broadcast is (see that module's doc comment).
    await Promise.all([...links.entries()].map(([guestId, link]) => runHostSessionSetup(link.channels, guestId, setupOptions)));
    const result = buildHostSessionSetupResult(setupOptions);
    beginMultiplayerLevel();
    const worker = new Worker(new URL("./multiplayer/tickClockWorker.ts", import.meta.url), { type: "module" });
    activeMultiplayerSession = runMultiplayerSessionAsHost(
      links,
      canvas,
      result,
      worker,
      onMultiplayerSessionEnded,
      findNextMultiplayerLevel(initialLevelPath),
    );
    // Only sent now that `runMultiplayerSessionAsHost` (synchronous — see its
    // own doc comment) has already assigned `worker.onmessage`, the real
    // tick-receiving handler — `tickClockWorker.ts` doesn't start its
    // interval until it receives this, making the "worker message arrives
    // before any listener is attached" race structurally impossible instead
    // of just unlikely.
    worker.postMessage({ type: "start" });
  } catch (err) {
    console.error("[multiplayer] Failed to start session:", err);
    setMultiplayerStatus(err instanceof Error ? err.message : "Failed to start the multiplayer session.", true);
    multiplayerStartSessionButton.disabled = false;
  }
}

/**
 * Builds the host-side `FindNextLevel` callback `runMultiplayerSessionAsHost`
 * calls on every win — mirrors `advanceToNextLevel`'s own file-tree
 * traversal (`findNextParsableFile`/`readFileText`/`parseFile`, skipping a
 * candidate that fails to read/parse in favor of the next one) closely
 * enough to share its own shape, but returns the new map/seed instead of
 * driving UI directly — the session driver owns broadcasting/applying it,
 * and `null` (workspace exhausted) routes to the `"campaign-complete"` end
 * state instead of a phantom transition. `afterPath` is tracked in a local
 * closure variable, updated after each successful transition, so a second
 * win later in the same session resumes the search from where the last one
 * left off — never re-derived from `currentLevelPath` (which this same
 * closure also keeps in sync, for anything else that reads it, but doesn't
 * itself depend on for its own traversal position).
 */
function findNextMultiplayerLevel(initialLevelPath: string): FindNextLevel {
  let afterPath = initialLevelPath;
  return async ({ carryovers }) => {
    // `workspaceTree` is set once at every workspace-load entry point and
    // never reset to null afterward — this closure is only ever reachable
    // via a win inside a session `startMultiplayerSessionAsHost` already
    // required a loaded workspace (and therefore a non-null `workspaceTree`)
    // to start, so the null case can't actually happen here.
    /* v8 ignore next */
    if (!workspaceTree) return null;
    while (true) {
      const next = await findNextParsableFile(workspaceTree, afterPath);
      if (!next) return null;

      try {
        const text = await readFileText(next.handle as FileSystemFileHandle);
        const parsed = await parseFile(next.name, text);
        if (parsed) {
          audio.playLevelComplete();
          campaignLevelIndex += 1;
          console.log(`%c[multiplayer] ${afterPath} cleared — advancing to ${next.path}`, "color:#37d24a;font-weight:bold");
          // A weapon counts as "still missing" (eligible for a secret room
          // or an Elite's bonus drop) only once *every* connected player
          // lacks it — the same spirit `computeMissingWeaponIndices`'s own
          // single-player `owned` param already uses, generalized from one
          // player's inventory to the whole team's.
          const rosterIds = Object.keys(carryovers);
          // Every roster id is always present in `carryovers` with a real,
          // fully-populated `EngineCarryover` (`onWinFromEngine` builds one
          // per `currentResult.roster` entry before calling this) and the
          // roster itself is never empty (`startMultiplayerSessionAsHost`
          // always includes the host itself, plus 0-3 guests) — the
          // `?.`/`?? []` fallback and the empty-roster branch below only
          // satisfy the index signature's and `Array.prototype.reduce`'s own
          // conservative typing, neither is reachable in practice.
          /* v8 ignore next 2 */
          const perPlayerOwned: number[][] = rosterIds.map((id) => carryovers[id]?.ownedWeapons ?? []);
          const ownedByEveryone = perPlayerOwned.length === 0 ? [] : perPlayerOwned.reduce((acc, owned) => acc.filter((w) => owned.includes(w)));
          const missingWeaponIndices = computeMissingWeaponIndices(ownedByEveryone, campaignLevelIndex);
          const bonusLevel = BONUS_LEVEL_EXTENSIONS.has(extensionOf(next.path));
          const nextMap = mapGenerator.generate(parsed, bonusLevel, false, missingWeaponIndices, rosterIds.length);
          afterPath = next.path;
          currentLevelPath = next.path;
          currentParsedFile = parsed;
          return { map: nextMap, gameplaySeed: randomSeed() };
        }
      } catch (err) {
        console.error(`[multiplayer] Failed to load "${next.path}", skipping to the next file:`, err);
      }
      afterPath = next.path;
    }
  };
}

async function startMultiplayerSessionAsGuest(): Promise<void> {
  // Unlike the host's button-triggered call above, this has exactly one call
  // site — right after `activeMultiplayerConnection` is set to a guest
  // connection, synchronously, with no intervening `await` — so the
  // precondition always holds and there's nothing to guard against; the
  // `role` check below exists purely to narrow the discriminated
  // `MultiplayerConnection` union for the compiler, not because the
  // `"host"` branch is actually reachable here.
  /* v8 ignore next */
  if (!activeMultiplayerConnection || activeMultiplayerConnection.role !== "guest") return;
  const { channels, peerConnection } = activeMultiplayerConnection;
  try {
    const result = await runGuestSessionSetup(channels);
    beginMultiplayerLevel();
    activeMultiplayerSession = runMultiplayerSessionAsGuest(channels, canvas, result, onMultiplayerSessionEnded, peerConnection);
  } catch (err) {
    console.error("[multiplayer] Session setup failed:", err);
    setMultiplayerStatus(err instanceof Error ? err.message : "Multiplayer session setup failed.", true);
  }
}

multiplayerStartSessionButton.addEventListener("click", () => void startMultiplayerSessionAsHost());

// --- Lobby browser dialog ---------------------------------------------------

function renderMultiplayerLobbyList(entries: LobbyEntry[]): void {
  multiplayerLobbyList.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "No public sessions right now.";
    multiplayerLobbyList.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "multiplayer-lobby-entry";
    const playerLabel = entry.playerCount === 1 ? "player" : "players";
    button.textContent = `${entry.displayName ?? "(unnamed)"} — ${entry.campaignName} (${entry.playerCount} ${playerLabel})`;
    button.addEventListener("click", () => {
      multiplayerLobbyDialog.close();
      multiplayerJoinCodeInput.value = entry.code;
      void joinMultiplayerSession(entry.code);
    });
    li.appendChild(button);
    multiplayerLobbyList.appendChild(li);
  }
}

async function openMultiplayerLobbyDialog(): Promise<void> {
  multiplayerLobbyList.innerHTML = "";
  const loading = document.createElement("li");
  loading.className = "muted";
  loading.textContent = "Loading…";
  multiplayerLobbyList.appendChild(loading);
  multiplayerLobbyDialog.showModal();
  try {
    const entries = await fetchLobbyEntries(new AbortController().signal);
    renderMultiplayerLobbyList(entries);
  } catch (err) {
    multiplayerLobbyList.innerHTML = "";
    const errorItem = document.createElement("li");
    errorItem.className = "error";
    errorItem.textContent = describeMultiplayerError(err);
    multiplayerLobbyList.appendChild(errorItem);
  }
}

multiplayerBrowseLobbyButton.addEventListener("click", () => void openMultiplayerLobbyDialog());
closeMultiplayerLobbyButton.addEventListener("click", () => multiplayerLobbyDialog.close());
multiplayerLobbyDialog.addEventListener("close", () => {
  if (activeEngine) canvas.focus();
});

// --- Test-only introspection (?testHooks=1) ---------------------------------
// Gated the same way as `RaycasterEngine`'s own `window.__codeensteinTestHooks`
// (`src/engine/engine.ts`) — `?testHooks=1` on the page URL — rather than a
// visible debug UI element: `scripts/verify-multiplayer-connect.mjs` reads
// this instead of polling the DOM. Deliberately a **separate** global,
// `__codeensteinMultiplayerTestHooks`, not folded into
// `__codeensteinTestHooks` itself: this project's whole test suite uses
// `!!testHooks()` (reading `__codeensteinTestHooks`) as a proxy for "an
// engine has been constructed" — installed here at *module import* time,
// this object would make that check trivially true before any engine exists,
// racing every `waitUntil(() => !!testHooks())` in `main.test.ts` that
// expects it to mean exactly that.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("testHooks") === "1") {
  (
    window as unknown as {
      __codeensteinMultiplayerTestHooks?: {
        getConnectionState: () => unknown;
        getSimTick: () => number | null;
        getPlayerPosition: (id: string) => { x: number; y: number } | null;
        getPlayerFacing: (id: string) => { dirX: number; dirY: number } | null;
        getRngState: () => number | null;
        injectDesync: (injection: { kind: "position"; deltaTiles: number } | { kind: "extraRngDraw" }) => void;
        hasActiveRenderOffset: (id: string) => boolean;
        getLastReconciliationRngState: () => number | null;
        getPlayerStatus: (id: string) => string | null;
        getLootDrops: () => readonly unknown[];
        getMapExit: () => { x: number; y: number } | null;
        getMapGrid: () => readonly (readonly number[])[] | null;
        getExitCountdownRemaining: () => number | null;
        getMap: () => unknown | null;
        getEnemiesSnapshot: () => { x: number; y: number; alive: boolean; aggroed: boolean; elite: boolean; edgeCase: boolean; hp: number; maxHp: number }[];
        getMinesSnapshot: () => { x: number; y: number; alive: boolean; visible: boolean }[];
        getDropsSnapshot: () => { x: number; y: number; kind: string }[];
        getKeysSnapshot: () => { x: number; y: number }[];
        getBotPlayerState: (id: string) => {
          x: number;
          y: number;
          dirX: number;
          dirY: number;
          health: number;
          healthFraction: number;
          swap: number;
          state: "playing" | "over";
          ammo: { bullets: number; rockets: number; smg: number; gas: number };
          weaponIndex: number;
          meleeWouldHit: boolean;
          wouldMineHit: boolean;
          ownedWeapons: number[];
          levelTime: number;
          distanceTraveled: number;
        } | null;
        // Step 11 Phase 2b — real network/netcode-quality telemetry, see
        // `MultiplayerSessionHandle`'s own doc comments on each.
        getConnectionStats: (id: string) => Promise<{ rttMs: number | null } | null>;
        getMissedTickStats: () => { totalTicks: number; missedTicksByPlayer: Record<string, number> };
        getReconciliationCorrections: () => Record<string, { count: number; totalMagnitudeTiles: number }>;
        // Step 11 Phase 2a — see `RaycasterEngine.getMultiplayerTelemetrySnapshot`'s
        // own doc comment; used by scripts/run-balancing-telemetry-multiplayer.mjs.
        getMultiplayerTelemetrySnapshot: (id: string) => ReturnType<RaycasterEngine["getMultiplayerTelemetrySnapshot"]>;
      };
    }
  ).__codeensteinMultiplayerTestHooks = {
    getConnectionState: () => {
      if (!activeMultiplayerConnection) return { state: multiplayerConnectionState, channels: null };
      if (activeMultiplayerConnection.role === "guest") {
        return {
          state: multiplayerConnectionState,
          channels: {
            input: activeMultiplayerConnection.channels.input.readyState,
            reconciliation: activeMultiplayerConnection.channels.reconciliation.readyState,
          },
        };
      }
      const { links, maxPlayers } = activeMultiplayerConnection;
      // Always at least 1 entry for a host-role connection — `links` is only
      // ever constructed already holding guest-1 (`createMultiplayerSession`)
      // and only ever grows from there (`armNextGuestSlot`), never shrinks
      // (a disconnected guest is marked disconnected at the engine level,
      // never removed from this Map) — the `null` fallback below only
      // satisfies `Map.values().next().value`'s own conservative typing.
      const firstLink = links.values().next().value;
      return {
        state: multiplayerConnectionState,
        // Backward-compatible for the existing single-guest verify scripts
        // (connect/netcode/reconciliation/disconnect/transition): reflects
        // guest-1's own channel pair specifically, same shape they've always
        // read here — none of them needed to change for step 10.
        /* v8 ignore next 3 */
        channels: firstLink
          ? { input: firstLink.channels.input.readyState, reconciliation: firstLink.channels.reconciliation.readyState }
          : null,
        // Step 10 (N-player): per-guest breakdown for the new multi-guest
        // verify script — `channels` above only ever reflects one guest.
        links: [...links.entries()].map(([id, link]) => ({
          id,
          input: link.channels.input.readyState,
          reconciliation: link.channels.reconciliation.readyState,
        })),
        connectedGuestCount: links.size,
        maxPlayers,
      };
    },
    // Both added in step 6c — a live session's tick/position, for the
    // end-to-end verify script's lockstep-correctness assertions.
    getSimTick: () => activeMultiplayerSession?.getLastAppliedTick() ?? null,
    getPlayerPosition: (id) => activeMultiplayerSession?.getPlayerPosition(id) ?? null,
    getPlayerFacing: (id) => activeMultiplayerSession?.getPlayerFacing(id) ?? null,
    // Both added in step 7 (reconciliation) — `getRngState` is read-only
    // introspection, same spirit as the two above. `injectDesync` is
    // different in kind, not just in name: every hook above (and
    // `consumeCheat()`'s permanent no-op) is either read-only or inert —
    // this one genuinely *mutates* live simulation state, deliberately
    // desyncing this peer from its counterpart so
    // `scripts/verify-multiplayer-reconciliation.mjs` can prove the
    // correction mechanism converges it back without waiting on organic
    // cross-engine float drift (which doesn't reliably appear within a
    // short end-to-end run — see `RaycasterEngine.debugInjectDesync`'s own
    // doc comment). Never called from real gameplay code.
    getRngState: () => activeMultiplayerSession?.getRngState() ?? null,
    injectDesync: (injection) => activeMultiplayerSession?.debugInjectDesync(injection),
    hasActiveRenderOffset: (id) => activeMultiplayerSession?.hasActiveRenderOffset(id) ?? false,
    // A *frozen* value, unlike getRngState() above — see
    // MultiplayerSessionHandle.getLastReconciliationRngState's own doc
    // comment for why comparing this instead of live state is what makes
    // the verify script's PRNG-resync check robust against real, ongoing
    // per-tick drift from the demo campaign's own roaming enemies.
    getLastReconciliationRngState: () => activeMultiplayerSession?.getLastReconciliationRngState() ?? null,
    // Both added in step 8 (session lifecycle) — read-only introspection for
    // `scripts/verify-multiplayer-disconnect.mjs` to observe a peer's status
    // flipping to `"disconnected"` and its inventory converting to loot.
    getPlayerStatus: (id) => activeMultiplayerSession?.getPlayerStatus(id) ?? null,
    getLootDrops: () => activeMultiplayerSession?.getLootDrops() ?? [],
    // Both added in step 8 (level transitions) — read-only introspection for
    // `scripts/verify-multiplayer-transition.mjs` to compute its own real,
    // walls-aware route to the exit on the actual generated level, rather
    // than needing a fake/simplified map the way the unit-test-only
    // `main.test.ts` transition tests do.
    getMapExit: () => activeMultiplayerSession?.getMapExit() ?? null,
    getMapGrid: () => activeMultiplayerSession?.getMapGrid() ?? null,
    getExitCountdownRemaining: () => activeMultiplayerSession?.getExitCountdownRemaining() ?? null,
    // Added for `scripts/lib/multiplayerBot.mjs` — see
    // `RaycasterEngine.getMap`/`getEnemiesSnapshot`/`getMinesSnapshot`/
    // `getBotPlayerState`'s own doc comments.
    getMap: () => activeMultiplayerSession?.getMap() ?? null,
    getEnemiesSnapshot: () => activeMultiplayerSession?.getEnemiesSnapshot() ?? [],
    getMinesSnapshot: () => activeMultiplayerSession?.getMinesSnapshot() ?? [],
    getDropsSnapshot: () => activeMultiplayerSession?.getDropsSnapshot() ?? [],
    getKeysSnapshot: () => activeMultiplayerSession?.getKeysSnapshot() ?? [],
    getBotPlayerState: (id) => activeMultiplayerSession?.getBotPlayerState(id) ?? null,
    // Added in step 11 Phase 2b, for scripts/run-balancing-telemetry-multiplayer.mjs's
    // netcodeHealth report section.
    getConnectionStats: (id) => activeMultiplayerSession?.getConnectionStats(id) ?? Promise.resolve(null),
    getMissedTickStats: () => activeMultiplayerSession?.getMissedTickStats() ?? { totalTicks: 0, missedTicksByPlayer: {} },
    getReconciliationCorrections: () => activeMultiplayerSession?.getReconciliationCorrections() ?? {},
    // Added in step 11 Phase 2a, for scripts/run-balancing-telemetry-multiplayer.mjs's
    // gameplayHealth report section.
    getMultiplayerTelemetrySnapshot: (id) => activeMultiplayerSession?.getMultiplayerTelemetrySnapshot(id) ?? null,
  };
}

window.addEventListener("beforeunload", () => {
  if (activeEngine && lastStats && !isReplaying) persistProgress(lastStats);
});

/**
 * On file click: parse supported languages into normalized JSON and log that;
 * for everything else fall back to logging raw text.
 */
async function handleFileSelected(node: TreeNode): Promise<void> {
  // Unreachable given the single call site: renderFileTree/fileTree.ts only
  // ever wires onSelectFile to file rows, never directory rows.
  /* v8 ignore next */
  if (node.kind !== "file") return;
  try {
    const text = await readFileText(node.handle as FileSystemFileHandle);

    if (isParsable(node.name, text)) {
      const parsed = await parseFile(node.name, text);
      console.group(`[parse] ${node.path}`);
      console.log(parsed);
      console.groupEnd();
      if (parsed) launchLevel(node.path, parsed);
      return;
    }

    console.group(`[file] ${node.path} (${text.length} chars)`);
    console.log(text);
    console.groupEnd();
  } catch (err) {
    console.error(`[file] Failed to read/parse "${node.path}":`, err);
  }
}

/**
 * Filenames (case-insensitive) recognized as a project's likely single
 * entrypoint, checked in order across the whole tree — first match wins.
 * Most languages don't get a reliable filename convention (or none is
 * registered here), so this is tried first against "real" project source and
 * falls back to a scored content scan (`findEntrypointByScanning`) when no
 * name here matches anything — see `findEntrypoint` for the full cascade.
 */
const ENTRYPOINT_FILENAMES = [
  "main.c", "main.cpp", "main.cc", "main.cxx", "main.m", "main.mm",
  "index.php", "main.php",
  "index.js", "main.js", "index.ts", "main.ts", "index.tsx", "main.tsx",
  "main.py", "__main__.py",
  "main.go",
  "main.rs",
  "program.cs",
  "main.scala",
];

/** Path segments (case-insensitive, matched whole, not substring) that mark a
 * file as a test/spec fixture rather than "real" project source for
 * entrypoint-detection purposes only — see `isSecondaryEntrypointCandidate`.
 * Does not affect `flattenParsableFiles`/level progression/replay: a file in
 * one of these directories is still a fully ordinary, fully playable level
 * once the campaign reaches it — this only demotes it from being picked as
 * the very first auto-launched level. Verified against the real
 * `mcdope/pam_usb` repo that this matters in practice: every file under its
 * `tests/unit/c/` is a 100-700+ line hand-rolled test runner with its own
 * `main()`, i.e. *higher* raw complexity than any of its real source files —
 * without this exclusion, a scoring-based scan would pick a test file over
 * the real implementation, a worse result than the bug being fixed. */
const SECONDARY_ENTRYPOINT_PATH_SEGMENTS = new Set(["test", "tests", "spec", "specs", "__tests__"]);

/** True when any path segment of `file` names a conventional test/spec
 * directory — see `SECONDARY_ENTRYPOINT_PATH_SEGMENTS`. */
function isSecondaryEntrypointCandidate(file: TreeNode): boolean {
  return file.path.split("/").some((segment) => SECONDARY_ENTRYPOINT_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/** Splits an already-flattened file list into "real" project source
 * (`primary`) and test/spec fixtures (`secondary`) for entrypoint detection —
 * see `isSecondaryEntrypointCandidate`. `findEntrypoint` tries `primary`
 * first at every stage, only falling through to `secondary` if that stage
 * found nothing usable in `primary`. (A workspace whose root folder is
 * itself literally named e.g. "tests" would classify everything as
 * secondary — harmless, since the fallback degrades gracefully to exactly
 * the same result either bucket would have produced.) */
function partitionEntrypointCandidates(files: TreeNode[]): { primary: TreeNode[]; secondary: TreeNode[] } {
  const primary: TreeNode[] = [];
  const secondary: TreeNode[] = [];
  for (const file of files) (isSecondaryEntrypointCandidate(file) ? secondary : primary).push(file);
  return { primary, secondary };
}

/** First file in `files` whose name matches a standard project-entrypoint
 * convention, or `null` if none does. Takes an already-flattened file list
 * (see `partitionEntrypointCandidates`) rather than a tree, and does no I/O
 * of its own — a caller decides which bucket(s) to check and in what order. */
function findEntrypointByName(files: TreeNode[]): TreeNode | null {
  for (const candidate of ENTRYPOINT_FILENAMES) {
    const match = files.find((f) => f.name.toLowerCase() === candidate);
    if (match) return match;
  }
  return null;
}

/** A detected entrypoint file together with its already-parsed AST, so
 * `autoLaunchInitialLevel` never has to parse the winning file a second
 * time. */
interface EntrypointMatch {
  file: TreeNode;
  parsed: ParsedFile;
}

/** Files processed between yields in `findEntrypointByScanning` — this scan
 * runs before the first level launches (nothing is playing yet), unlike
 * `computeCodebaseStats`'s background pass, so a fixed file count is fine
 * here; kept as its own constant so the two independent scans can be tuned
 * separately. */
const ENTRYPOINT_SCAN_CHUNK_SIZE = 20;

/**
 * Fallback when no file matches a standard entrypoint filename: parse every
 * file in `files` and score it by summing `complexityScore` across all its
 * entities — a general, language-agnostic "how much real work does this file
 * do" signal (no longer restricted to the C family, so this also newly
 * covers conventions like C#'s capitalized `Main`). Tracks the
 * highest-complexity file that defines a `main`/`Main` function/method
 * entity, and separately the highest-complexity file overall; returns the
 * former if any file had one, else the latter, else `null` if nothing in
 * `files` parsed successfully at all. A file that fails to read or parse is
 * skipped, same as everywhere else in this app. Yields to the event loop
 * every `ENTRYPOINT_SCAN_CHUNK_SIZE` files, same pattern as
 * `computeCodebaseStats`. `signal`, when given and already aborted by the
 * time a given file is reached, stops the scan right there instead of
 * working through the rest of `files`.
 */
async function findEntrypointByScanning(files: TreeNode[], signal?: AbortSignal): Promise<EntrypointMatch | null> {
  let bestWithMain: EntrypointMatch | null = null;
  let bestWithMainComplexity = -1;
  let bestOverall: EntrypointMatch | null = null;
  let bestOverallComplexity = -1;

  for (let i = 0; i < files.length; i++) {
    // `autoLaunchInitialLevel` has already given up and fallen back to the
    // first parsable file by the time this fires (see its own
    // `ENTRYPOINT_DETECTION_TIMEOUT_MS` race) — without this check the scan
    // would keep fetching and parsing the rest of `files` indefinitely in
    // the true background regardless, one network round-trip per file, for
    // a result nothing will ever read.
    if (signal?.aborted) break;
    const file = files[i];
    try {
      const text = await readFileText(file.handle as FileSystemFileHandle);
      const parsed = await parseFile(file.name, text);
      if (parsed) {
        const complexity = parsed.entities.reduce((sum, e) => sum + e.complexityScore, 0);
        const hasMain = parsed.entities.some(
          (e) => (e.kind === "function" || e.kind === "method") && e.name.toLowerCase() === "main",
        );

        if (complexity > bestOverallComplexity) {
          bestOverall = { file, parsed };
          bestOverallComplexity = complexity;
        }
        if (hasMain && complexity > bestWithMainComplexity) {
          bestWithMain = { file, parsed };
          bestWithMainComplexity = complexity;
        }
      }
    } catch (err) {
      console.error(`[entrypoint] Failed to scan "${file.path}":`, err);
    }

    if (i % ENTRYPOINT_SCAN_CHUNK_SIZE === ENTRYPOINT_SCAN_CHUNK_SIZE - 1) {
      await yieldToMainThread();
    }
  }

  return bestWithMain ?? bestOverall;
}

/** Every file node in `tree`, depth-first in the same directories-first order
 * the sidebar renders and `flattenParsableFiles` walks — a synchronous,
 * in-memory walk with no I/O (unlike `flattenParsableFiles`, which calls
 * `isParsableNode` per file, a real network round-trip for every extensionless
 * file on a remote workspace). `findEntrypoint`'s filename-convention stage
 * only needs to compare names — every `ENTRYPOINT_FILENAMES` entry has a
 * registered extension, so parsability there is never in question — so it
 * uses this instead of paying to sniff every extensionless file in a large
 * remote repo before even checking for a plain `main.c`-style name match. */
function flattenAllFiles(node: TreeNode): TreeNode[] {
  if (node.kind === "file") return [node];
  return (node.children ?? []).flatMap(flattenAllFiles);
}

/** The workspace's logical entrypoint, if any. Tries, in order: a filename-
 * convention match in real source, the same in test/spec fixtures (see
 * `partitionEntrypointCandidates`) — both against the raw tree via
 * `flattenAllFiles`, no I/O — and only if neither hits, *for a local
 * workspace only*, a scored main()-scan (`findEntrypointByScanning`) over
 * real source then test/spec fixtures, which does need
 * `flattenParsableFiles`'s parsability check. Each stage falls through to the
 * next only when it finds nothing *usable* — not merely when a bucket is
 * empty — so a workspace whose real source is present but entirely
 * unparsable still correctly falls back to whatever test fixtures do parse,
 * rather than giving up early; likewise a filename match that turns out to
 * fail parsing (a broken/binary file that happens to have a conventional
 * name) falls through to the scoring stage rather than dead-ending
 * detection. `signal`, when given, is forwarded to the scoring stage — see
 * `findEntrypointByScanning`.
 *
 * The scoring stage is skipped entirely for a remote (GitHub) workspace —
 * confirmed against a real repo (`id-Software/DOOM`, no filename-convention
 * match since its entrypoint is `d_main.c`/`i_main.c`) that this stage alone
 * generates on the order of "as many requests as the repo has files" well
 * within its own timeout, since fetching is fast enough to make real
 * progress through the whole tree before `ENTRYPOINT_DETECTION_TIMEOUT_MS`
 * fires — exactly the "parse files ahead of need" cost this whole cascade is
 * trying to avoid for a network-backed workspace. `autoLaunchInitialLevel`
 * already has a working fallback for "nothing detected" (first parsable file
 * in tree order), so a remote workspace goes straight there instead of
 * paying for a scan that can't be bounded by request count, only by wall
 * clock. `workspaceIsDemo` is excluded from this skip even though it also
 * sets `workspaceIsRemote` — the bundled demo campaign's files are already
 * in memory (see `demoCampaign.ts`), so scoring them costs nothing; it just
 * never actually needs to; its own `main.c` always resolves via the
 * filename-convention stage above. */
export async function findEntrypoint(tree: TreeNode, signal?: AbortSignal): Promise<EntrypointMatch | null> {
  const allFiles = partitionEntrypointCandidates(flattenAllFiles(tree));
  const byName = findEntrypointByName(allFiles.primary) ?? findEntrypointByName(allFiles.secondary);
  if (byName) {
    try {
      const text = await readFileText(byName.handle as FileSystemFileHandle);
      const parsed = await parseFile(byName.name, text);
      if (parsed) return { file: byName, parsed };
    } catch (err) {
      console.error(`[entrypoint] Matched "${byName.path}" by name but failed to parse it:`, err);
    }
  }

  if (workspaceIsRemote && !workspaceIsDemo) return null;
  if (signal?.aborted) return null;
  const { primary, secondary } = partitionEntrypointCandidates(await flattenParsableFiles(tree));
  return (await findEntrypointByScanning(primary, signal)) ?? (await findEntrypointByScanning(secondary, signal));
}

/** Caps how long `findEntrypoint`'s detection scan may run before
 * `autoLaunchInitialLevel` gives up and falls back to the first parsable file
 * in tree order — tighter than `CODEBASE_STATS_WAIT_MS` (8s) since this
 * blocks the very first level launch rather than running silently in the
 * background after a run has already ended. */
const ENTRYPOINT_DETECTION_TIMEOUT_MS = 4000;

/** How often (in files checked) the "Scanning file tree…" readout updates —
 * frequent enough to visibly move, coarse enough that a huge local tree
 * (all-synchronous, no network gaps to naturally space repaints out) isn't
 * paying for a DOM write on literally every file. */
const FILE_TREE_SCAN_PROGRESS_INTERVAL = 25;

/**
 * Shows the loading overlay in place of whatever else is in `#viewport` —
 * the intro screen, the "select a file" placeholder, or a previous run's
 * canvas — while a workspace's tree is fetched, its entrypoint is scanned,
 * or a level's world is generated. A large remote repo (`torvalds/linux` is
 * the standing test case) can spend real seconds in these phases; without
 * this the app just looked frozen the whole time. Also hides the canvas
 * (see its own doc comment for why it's otherwise never touched) so a stale
 * frame from a still-running previous level doesn't show through alongside
 * the spinner if the player picks a new workspace mid-run — `launchLevel`
 * un-hides it again once the new level is actually ready.
 */
function showLoadingScreen(status: string): void {
  canvasArea.hidden = true;
  for (const child of [...viewport.children]) {
    if (child !== canvasArea && child !== loadingScreen) child.remove();
  }
  loadingStatus.textContent = status;
  loadingScreen.hidden = false;
  viewport.appendChild(loadingScreen);
}

/** Updates the loading overlay's status text — only meaningful while it's
 * actually shown (see `showLoadingScreen`). */
function setLoadingStatus(status: string): void {
  loadingStatus.textContent = status;
}

/** Formats a byte count for the GitHub tree-fetch progress readout — just
 * enough precision to see the number climbing (KB while small, one decimal
 * of MB once it's not), not a general-purpose unit formatter. */
function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Auto-start the very first level right after a workspace loads: prefer a
 * detected project entrypoint (see `findEntrypoint`) over just resolving the
 * first parsable file alphabetically/by tree order, though that remains the
 * fallback both when no entrypoint is found and when detection itself times
 * out (see `ENTRYPOINT_DETECTION_TIMEOUT_MS`). Falls back to the "select a
 * file" placeholder (see `showFileTreePlaceholder`) if the workspace has no
 * parsable file at all, or nothing could actually be parsed.
 */
async function autoLaunchInitialLevel(tree: TreeNode): Promise<void> {
  setLoadingStatus("Scanning for entrypoint…");
  // `withTimeout` alone only stops *waiting* on `findEntrypoint` — the scan
  // itself would keep running (and fetching) in the true background
  // afterward. This signal, on the same budget, tells `findEntrypointByScanning`
  // to actually stop making further file reads once that happens.
  const signal = AbortSignal.timeout(ENTRYPOINT_DETECTION_TIMEOUT_MS);
  const match = await withTimeout(findEntrypoint(tree, signal), ENTRYPOINT_DETECTION_TIMEOUT_MS);

  let target: TreeNode | null;
  let parsed: ParsedFile | null;
  const how = match ? "detected entrypoint" : "first file in tree order";

  if (match) {
    target = match.file;
    parsed = match.parsed;
  } else {
    const totalFiles = countTreeFiles(tree);
    let checked = 0;
    setLoadingStatus(`Scanning file tree… (0/${totalFiles})`);
    target =
      (
        await flattenParsableFiles(tree, () => {
          checked++;
          if (checked % FILE_TREE_SCAN_PROGRESS_INTERVAL === 0 || checked === totalFiles) {
            setLoadingStatus(`Scanning file tree… (${checked}/${totalFiles})`);
          }
        })
      )[0] ?? null;
    parsed = null;
  }
  if (!target) {
    showFileTreePlaceholder();
    return;
  }

  try {
    if (!parsed) {
      setLoadingStatus(`Parsing ${target.name}…`);
      const text = await readFileText(target.handle as FileSystemFileHandle);
      parsed = await parseFile(target.name, text);
    }
    if (parsed) {
      console.log(`%c[entrypoint] auto-starting at ${target.path} (${how})`, "color:#8effa0;font-weight:bold");
      setLoadingStatus("Generating world…");
      // Let the status above actually paint before the synchronous (and,
      // for a large/complex file, potentially slow) map generation below
      // blocks the main thread — see `yieldToMainThread`'s doc comment.
      await yieldToMainThread();
      launchLevel(target.path, parsed);
    } else {
      showFileTreePlaceholder();
    }
  } catch (err) {
    console.error(`[entrypoint] Failed to auto-launch "${target.path}":`, err);
    showFileTreePlaceholder();
  }
}

/**
 * Generate a level from parsed JSON and set up the raycaster in the viewport.
 * `carryover` (health/ammo/weapon from a just-cleared level, or a resumed
 * save) is passed when this isn't a fresh pick from the file tree. The engine
 * itself isn't started until the level-start briefing is acknowledged — see
 * `GameHud.showLevelStart`.
 */
function launchLevel(path: string, parsed: ParsedFile, carryover?: EngineCarryover): void {
  // End any replay still playing — its own requestAnimationFrame loop is
  // independent of `activeEngine`/this function, so it would otherwise keep
  // running orphaned once this real level takes over the canvas (see
  // `stopActiveReplay`'s doc comment).
  stopActiveReplay?.();

  // Header (or equivalent) files make small, single-purpose "bonus levels" —
  // a distinct visual theme and a boosted loot rate, treating them as restock
  // arenas rather than normal combat levels (see `MapGenerator.generate`).
  const bonusLevel = BONUS_LEVEL_EXTENSIONS.has(extensionOf(path));
  const hasRocketLauncher = carryover?.ownedWeapons?.includes(GHIDRA_WEAPON_INDEX) ?? false;
  const ownedWeapons = carryover?.ownedWeapons ?? [];
  const missingWeaponIndices = computeMissingWeaponIndices(ownedWeapons, campaignLevelIndex);
  const map = mapGenerator.generate(parsed, bonusLevel, hasRocketLauncher, missingWeaponIndices);
  // Deliberately spoiler-free: no exit/secret-room/lore-terminal coordinates
  // in the printed text, since that string is also what the console sidebar
  // mirrors verbatim (see `src/ui/consoleSidebar.ts`) — a glance at it
  // shouldn't hand over the answer to something the player is meant to find
  // in-world. The full `map` object is still passed through for devtools
  // inspection, which takes a deliberate expand-the-object click rather than
  // a passive read.
  console.group(`[map] ${path}`);
  console.log(
    `${map.width}×${map.height} grid, ${map.rooms.length} room(s), ` +
      `${map.enemies.length} enemies, ${map.teleporters.length / 2} teleporter pair(s), ` +
      `${map.loreTerminals.length} lore terminal(s)${bonusLevel ? " — BONUS restock level" : ""}`,
    map,
  );
  console.groupEnd();

  currentLevelPath = path;
  currentParsedFile = parsed;

  // Tear down any level already running before starting the new one.
  activeEngine?.stop();

  const hint = document.createElement("p");
  hint.className = "map-caption";
  hint.textContent =
    `${path} — reach the green "return" tile to build · ` +
    `elite kills unlock gdb, ghidra, or Friday Hotfix · from level ${TOOLCHAIN_MIN_LEVEL} on, secret rooms and ` +
    `elites can also drop the Toolchain, replacing your knife · grab keys to open blue doors · ` +
    `step on a glowing pad to warp (goto) · avoid the acid and timed spikes · ` +
    `shoot spotted mines to disarm them from range`;

  const hud = new GameHud(canvas);
  activeHud = hud;

  // The status bar and every blocking overlay (briefing, commit summary,
  // end-of-run) are all drawn natively on the canvas now — nothing but the
  // hint caption and controls legend is DOM. Only canvasArea's *siblings*
  // are replaced — the canvas (and its wrapper) is never removed from
  // #viewport (see its doc comment).
  for (const child of [...viewport.children]) {
    if (child !== canvasArea) child.remove();
  }
  viewport.append(hint, buildControlsLegend());
  canvasArea.hidden = false;
  // Grab keyboard focus immediately — without this, the very first WASD press
  // after a level (re)load is silently swallowed until the player clicks the
  // canvas themselves, which reads as "controls don't work" on every level
  // change (multi-level advance, retry after death, or a fresh manual pick).
  canvas.focus();

  // Campaign-progression safety net: gdb/ghidra/Friday Hotfix are
  // force-added to ownedWeapons once the player reaches level 4/8/12,
  // regardless of whether an Elite ever dropped them — never removes
  // anything, so a weapon already earned by looting is unaffected.
  const effectiveCarryover: EngineCarryover | undefined = carryover
    ? {
        ...carryover,
        // `?? []` is unreachable: every real call site that builds a
        // carryover (Continue Run's saved ownedWeapons, an advancing
        // level's stats.ownedWeapons) always populates a real array.
        /* v8 ignore next */
        ownedWeapons: applyForcedUnlocks(carryover.ownedWeapons ?? [], campaignLevelIndex),
        campaignLevelIndex,
      }
    : undefined;

  // A fresh, non-deterministic seed for this level's own randomness (enemy AI
  // timing/roam targets, loot rolls, weapon spread) — recorded (alongside
  // every frame's input) so this exact run can be reproduced later. See
  // `src/prng.ts`'s doc comment for what's seeded vs. left cosmetic.
  const gameplaySeed = randomSeed();

  // A genuinely fresh run — no carryover, or no in-memory recorder left to
  // append to (e.g. right after a page reload, via "Continue Run") — starts a
  // new campaign recording; auto-advancing to this level from the previous
  // one (see `advanceToNextLevel`) reuses the same recorder instead, so one
  // run's replay ends up spanning every level it actually visited.
  if (!carryover || !currentReplayRecorder) {
    currentReplayRecorder = new CampaignReplayRecorder(campaignName());
  }
  currentReplayRecorder.startLevel(
    {
      filePath: path,
      bonusLevel,
      gameplaySeed,
      difficulty: currentDifficulty,
      gore: currentGoreLevel,
      carryover: effectiveCarryover,
    },
    hashRun(JSON.stringify(parsed), campaignName()),
  );

  activeEngine = new RaycasterEngine(
    canvas,
    map,
    {
      onStats: (stats) => {
        lastStats = stats;
        const now = Date.now();
        if (now - lastSaveAt >= AUTOSAVE_INTERVAL_MS) {
          lastSaveAt = now;
          persistProgress(stats);
        }
      },
      onGameOver: (stats) => {
        // Died on the current (not yet cleared) level, so only the levels
        // before it actually count as progress.
        void recordRunHighscore(parsed, path, stats, campaignLevelIndex - 1, currentReplayRecorder);
        clearCampaignSave();
        hud.showKernelPanic(statsScreenInfo(stats.runScoreBreakdown, stats.runPlayerStats), resetToFileTree);
      },
      onWin: (stats) => {
        hud.showCommitSummary(
          {
            linesRefactored: parsed.linesOfCode,
            bugsSquashed: stats.kills,
            stats: statsScreenInfo(stats.levelScoreBreakdown, stats.levelPlayerStats),
          },
          () => void advanceToNextLevel(stats),
        );
        // Inserted *before* hint/the controls legend, not appended after
        // them — #viewport clips overflow rather than scrolling
        // (style.css), so a button appended last risked being the one
        // clipped beneath the (fairly tall) legend, and even when visible
        // it was easy to miss as the last, smallest thing in the stack.
        // Being first (right under the canvas) plus its own prominent
        // styling (see .export-map-btn) fixes both.
        viewport.insertBefore(buildExportMapButton(map, campaignName(), levelName), hint);
      },
      onCheatActivated: () => {
        cheatsUsed = true;
      },
      onFreezeChange: (frozen) => {
        consoleSidebar.setPaused(frozen);
      },
    },
    effectiveCarryover,
    currentGoreLevel,
    currentDifficulty,
    gameplaySeed,
    undefined,
    currentReplayRecorder,
  );

  // `?? path` is unreachable defensive code: String.prototype.split() never
  // returns an empty array, so `.pop()` can never actually be undefined —
  // same reasoning as demoCampaign.ts's identical pattern.
  /* v8 ignore next */
  const levelName = path.split("/").pop() ?? path;
  hud.showLevelStart(
    {
      campaign: campaignName(),
      levelName,
      roomCount: map.rooms.length,
      enemyCount: map.enemies.length,
      secretRoomCount: map.secretRoomCount,
    },
    () => {
      activeEngine?.start();
      consoleSidebar.setPaused(false);
      consoleSidebar.setHintsActive(true);
      // The overlay focuses its own "Start" button (so Enter/Space dismiss
      // it) and never gives focus back — without this, WASD silently does
      // nothing until the player clicks the canvas themselves.
      canvas.focus();
    },
  );
}

/** Weapon indices force-unlocked once the player reaches the given campaign
 * level, regardless of whether an Elite has actually dropped them yet — a
 * progression safety net so a long, loot-unlucky run doesn't leave
 * gdb/ghidra/Friday Hotfix permanently unreachable. */
const FORCED_UNLOCK_LEVELS: { level: number; weaponIndex: number; name: string }[] = [
  { level: 4, weaponIndex: GDB_WEAPON_INDEX, name: "gdb" },
  { level: 8, weaponIndex: GHIDRA_WEAPON_INDEX, name: "ghidra" },
  { level: 12, weaponIndex: FRIDAY_HOTFIX_WEAPON_INDEX, name: "Friday Hotfix" },
];

/** Union `owned` with whichever `FORCED_UNLOCK_LEVELS` entries `levelIndex`
 * has reached — never removes anything, so a weapon already earned by
 * looting is unaffected. Logs only the first time an entry actually adds
 * something (i.e. wasn't already owned), not on every subsequent level. */
export function applyForcedUnlocks(owned: number[], levelIndex: number): number[] {
  const unlocked = new Set(owned);
  for (const { level, weaponIndex, name } of FORCED_UNLOCK_LEVELS) {
    if (levelIndex >= level && !unlocked.has(weaponIndex)) {
      unlocked.add(weaponIndex);
      console.log(`%c[progression] campaign level ${levelIndex}: ${name} unlocked as a safety net`, "color:#e06aff;font-weight:bold");
    }
  }
  return [...unlocked];
}

/** Weapon indices still missing from `owned`, eligible to appear in a secret
 * room (`MapGenerator.generate`'s `missingWeaponIndices` param) or an Elite's
 * bonus drop (`RaycasterEngine.dropEliteLoot`) this level. Almost just
 * `UNLOCKABLE_WEAPONS.filter(...)`, except Toolchain — deliberately excluded
 * from `UNLOCKABLE_WEAPONS` itself (see its doc comment) — is folded in here
 * instead, gated by `TOOLCHAIN_MIN_LEVEL`, since it has no forced-unlock
 * counterpart and isn't reachable via the ordinary per-kill roll. Shared by
 * `launchLevel` (passed `campaignLevelIndex`) and `buildEngineFor`'s replay
 * reconstruction (passed the recorded segment's own
 * `carryover?.campaignLevelIndex`), so a replay recomputes exactly the same
 * candidate list — and thus the same seeded RNG draw — as the live run did. */
function computeMissingWeaponIndices(owned: number[], levelIndex: number): number[] {
  const missing = UNLOCKABLE_WEAPONS.filter((i) => !owned.includes(i));
  if (levelIndex >= TOOLCHAIN_MIN_LEVEL && !owned.includes(TOOLCHAIN_WEAPON_INDEX)) {
    missing.push(TOOLCHAIN_WEAPON_INDEX);
  }
  return missing;
}

/** The workspace root's name, or a placeholder if none is loaded yet. See the
 * `workspaceRootName` doc comment for why the "parent dir named src" case
 * from the spec can't be implemented in a browser sandbox. */
function campaignName(): string {
  // `?? "Untitled Workspace"` is unreachable: every call site is only
  // reached via launchLevel/kickOffCodebaseStats, both only invoked after a
  // workspace load has already set workspaceRootName (which is never reset
  // to null afterward).
  /* v8 ignore next */
  return workspaceRootName ?? "Untitled Workspace";
}

/**
 * Called when the player reaches the exit. If the workspace has another
 * parsable file after the current one (in tree order), silently loads it as
 * the next level, carrying health and ammo across. A candidate file that
 * fails to read or parse (corrupt, unsupported edge case, etc — `parseFile`
 * already logs why) is skipped in favor of the next one after it, rather than
 * ending the run early; only running out of files entirely shows the normal
 * "Build Successful" end-of-run overlay.
 */
async function advanceToNextLevel(stats: EngineStats): Promise<void> {
  let afterPath = currentLevelPath;

  while (workspaceTree && afterPath) {
    const next = await findNextParsableFile(workspaceTree, afterPath);
    if (!next) break;

    try {
      const text = await readFileText(next.handle as FileSystemFileHandle);
      const parsed = await parseFile(next.name, text);
      if (parsed) {
        audio.playLevelComplete();
        campaignLevelIndex += 1;
        console.log(`%c[level] ${currentLevelPath} cleared — advancing to ${next.path}`, "color:#37d24a;font-weight:bold");
        const carryover: EngineCarryover = {
          health: stats.health,
          swap: stats.swap,
          bullets: stats.bullets,
          rockets: stats.rockets,
          smg: stats.smg,
          gas: stats.gas,
          priorScore: stats.score,
          priorScoreBreakdown: stats.runScoreBreakdown,
          priorPlayerStats: stats.runPlayerStats,
          weaponIndex: stats.weaponIndex,
          ownedWeapons: stats.ownedWeapons,
          showFps: stats.showFps,
          godMode: stats.godMode,
          noClip: stats.noClip,
        };
        // Persist immediately at the transition (not just the throttled
        // in-play autosave) so a tab closed right after advancing still
        // resumes at the new file rather than the one just cleared.
        saveCampaign({
          // `?? ""` is unreachable here too — reached only after a level
          // already launched, which requires workspaceRootName to be set.
          /* v8 ignore next */
          workspaceName: workspaceRootName ?? "",
          filePath: next.path,
          health: carryover.health,
          swap: carryover.swap,
          bullets: carryover.bullets,
          rockets: carryover.rockets,
          smg: carryover.smg,
          gas: carryover.gas,
          score: stats.score,
          weaponIndex: stats.weaponIndex,
          ownedWeapons: stats.ownedWeapons,
          levelIndex: campaignLevelIndex,
        });
        launchLevel(next.path, parsed, carryover);
        return;
      }
    } catch (err) {
      console.error(`[level] Failed to load "${next.path}", skipping to the next file:`, err);
    }

    afterPath = next.path;
  }

  // No more files left to try — the campaign is complete, so the saved
  // resume point no longer means anything. The level just cleared (still
  // `currentLevelPath`/`currentParsedFile`/`currentReplayRecorder`, and still
  // counted in `campaignLevelIndex`) is what the highscore entry hashes/
  // reports/replays as the final level.
  if (currentParsedFile && currentLevelPath) {
    void recordRunHighscore(currentParsedFile, currentLevelPath, stats, campaignLevelIndex, currentReplayRecorder);
  }
  clearCampaignSave();
  activeHud?.showBuildSuccessful(statsScreenInfo(stats.runScoreBreakdown, stats.runPlayerStats), resetToFileTree);
}

/**
 * True when `node` is parsable — a plain extension check, except for an
 * extensionless file, where its content is read and sniffed for a `#!`
 * shebang (see `isParsable` in the registry) before giving up on it.
 */
async function isParsableNode(node: TreeNode): Promise<boolean> {
  if (extensionOf(node.name)) return isParsable(node.name);
  try {
    const text = await readFileText(node.handle as FileSystemFileHandle);
    return isParsable(node.name, text);
  } catch {
    return false;
  }
}

/** Caches `flattenParsableFiles`'s result per root tree node — see that
 * function's doc comment. Never explicitly invalidated: `workspaceTree` is
 * replaced wholesale (a fresh root node) on every new load and never mutated
 * in place, so a stale entry simply becomes unreachable and is
 * garbage-collected rather than needing a manual reset. */
const parsableFilesCache = new WeakMap<TreeNode, Promise<TreeNode[]>>();

/** Files parsable by a registered adapter, in the same depth-first,
 * directories-first order the sidebar renders them in. `onFileChecked`, when
 * given, fires once per file node visited (parsable or not) — a remote
 * workspace's extensionless files each cost a real network round-trip (see
 * `isParsableNode`'s shebang sniff), so a big repo can spend real seconds
 * walking this without it, same problem `fetchGithubTree`'s tree download
 * had before it got a progress callback of its own.
 *
 * Memoized (via `parsableFilesCache`) whenever no `onFileChecked` is given —
 * every real caller always passes the workspace root, so this means a full
 * walk (and, for a remote workspace, every not-yet-seen extensionless file's
 * network sniff) happens at most once per workspace load rather than once
 * per level clear, which is what `advanceToNextLevel`'s per-level
 * progression used to cause by re-walking the whole tree on every single
 * level. The one caller that does pass `onFileChecked` (`autoLaunchInitialLevel`'s
 * no-named-entrypoint fallback, for its "Scanning file tree… (N/Total)"
 * readout) always does a fresh walk and never touches the cache — that path
 * is rare (only when nothing matches `ENTRYPOINT_FILENAMES`) and needs a
 * genuine per-file callback on every call, not a cached replay of one. One
 * accepted side effect of caching: a file whose parsability sniff transiently
 * fails (e.g. a network hiccup) no longer gets retried on a later level
 * clear — it stays "not parsable" for the rest of the session, the same as
 * a genuine parse failure already did before this cache existed. */
export function flattenParsableFiles(node: TreeNode, onFileChecked?: () => void): Promise<TreeNode[]> {
  if (!onFileChecked) {
    const cached = parsableFilesCache.get(node);
    if (cached) return cached;
  }
  const promise = flattenParsableFilesUncached(node, onFileChecked);
  if (!onFileChecked) parsableFilesCache.set(node, promise);
  return promise;
}

async function flattenParsableFilesUncached(node: TreeNode, onFileChecked?: () => void): Promise<TreeNode[]> {
  if (node.kind === "file") {
    const ok = await isParsableNode(node);
    onFileChecked?.();
    return ok ? [node] : [];
  }
  const out: TreeNode[] = [];
  for (const child of node.children ?? []) out.push(...(await flattenParsableFilesUncached(child, onFileChecked)));
  return out;
}

/** Total file (non-directory) node count in `tree` — a synchronous, in-
 * memory walk of the already-fetched tree structure, no I/O. Denominator for
 * the "Scanning file tree…" progress readout in `autoLaunchInitialLevel`. */
function countTreeFiles(node: TreeNode): number {
  if (node.kind === "file") return 1;
  // `?? []` is unreachable: every production TreeNode builder (workspace.ts,
  // github.ts, demoCampaign.ts) always sets `children` on a directory node,
  // even to an empty array — never omits it.
  /* v8 ignore next */
  return (node.children ?? []).reduce((sum, child) => sum + countTreeFiles(child), 0);
}

interface CodebaseStats {
  linesOfCode: number;
  complexity: number;
  /** SHA-256 hash (see `hashRun`) of every parsable file's AST in the whole
   * workspace, combined — the highscore board's `HighscoreEntry.hash`. Scoped
   * to the whole workspace rather than just the level a run ended on so that
   * two runs over the identical, unedited codebase always compare equal
   * regardless of which level they happened to end on. */
  hash: string;
}

/** Wall-clock budget (ms) `computeCodebaseStats` processes files for before
 * yielding — comfortably under a 120fps frame's ~8.3ms, so a burst of large
 * or slow-to-parse files (a big real-world file, or several back-to-back
 * GitHub raw fetches) can't stall input/rendering for more than a beat. A
 * fixed file-count chunk would let one burst of unusually large files run for
 * an unbounded amount of wall-clock time; budgeting by elapsed time instead
 * bounds the worst case regardless of what's in any given file. */
const CODEBASE_STATS_TIME_BUDGET_MS = 6;

/** Hands control back to the browser for one macrotask tick. There's no
 * `requestIdleCallback`/worker pool anywhere in this codebase to reuse, and
 * introducing one is more machinery than a background parse loop needs — a
 * plain `setTimeout(0)` is enough to let pending input/render work run
 * between chunks. */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Sums `linesOfCode` and every entity's `complexityScore` across every
 * parsable file in `tree` — the whole codebase, independent of which files
 * this run's levels actually reach — and folds every file's parsed AST into
 * one combined `hash` (path-prefixed and NUL-joined, in the same stable
 * depth-first order `flattenParsableFiles` returns, so the digest only
 * changes when the workspace's actual content does). Reuses the exact same
 * `readFileText`/`parseFile` pair every level launch already goes through; a
 * file that fails to read or parse is skipped rather than aborting the whole
 * aggregation. Yields back to the event loop whenever a chunk has run for
 * `CODEBASE_STATS_TIME_BUDGET_MS`, so this background pass never starves the
 * level the player is actively in.
 */
async function computeCodebaseStats(tree: TreeNode): Promise<CodebaseStats> {
  const files = await flattenParsableFiles(tree);
  let linesOfCode = 0;
  let complexity = 0;
  const astParts: string[] = [];
  let chunkStart = performance.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const text = await readFileText(file.handle as FileSystemFileHandle);
      const parsed = await parseFile(file.name, text);
      if (parsed) {
        linesOfCode += parsed.linesOfCode;
        for (const entity of parsed.entities) complexity += entity.complexityScore;
        astParts.push(`${file.path}\n${JSON.stringify(parsed)}`);
      }
    } catch (err) {
      console.warn(`[codebase-stats] Failed to parse "${file.path}", skipping:`, err);
    }

    if (performance.now() - chunkStart >= CODEBASE_STATS_TIME_BUDGET_MS) {
      await yieldToMainThread();
      chunkStart = performance.now();
    }
  }

  const hash = await hashRun(astParts.join("\0"), campaignName());
  return { linesOfCode, complexity, hash };
}

/** (Re)starts the whole-codebase background aggregation for a just-loaded
 * workspace — fire-and-forget, so it never delays `autoLaunchInitialLevel`.
 * A failed aggregation resolves to zeroed totals rather than a rejected
 * promise, so `withTimeout` only ever has to special-case "still running",
 * not "errored".
 *
 * Skipped outright for *any* remote (GitHub) workspace, regardless of file
 * count — a local workspace has no such gate (disk reads are effectively
 * free), but for a GitHub repo this pass means fetching and parsing every
 * single parsable file's full content over the network, purely for a
 * highscore's whole-codebase hash/stats, long after (and regardless of
 * whether) the player ever reaches most of them. An earlier version of this
 * gate only skipped repos over a 300-file threshold, on the theory that
 * smaller repos were cheap enough to fetch in full — measured against a real
 * repo (`id-Software/DOOM`, ~97 parsable files, comfortably under that
 * threshold) that theory didn't hold: it alone generated ~97 real
 * `raw.githubusercontent.com` requests on top of the tree fetch, immediately
 * on load, well before any level was even reached. `recordRunHighscore`
 * already treats a `null` `codebaseStatsPromise` the same as one that simply
 * didn't finish in time, falling back to hashing just the single ended-on
 * file — no new degradation path needed here. */
function kickOffCodebaseStats(tree: TreeNode): void {
  if (workspaceIsRemote) {
    console.info(
      `[codebase-stats] Skipping whole-codebase aggregation for "${workspaceRootName}" — ` +
        "a remote repo's whole-codebase hash/stats would mean fetching and parsing every " +
        "single file's content over the network purely for a highscore board; playing " +
        "further levels doesn't need it either.",
    );
    codebaseStatsPromise = null;
    return;
  }
  codebaseStatsPromise = computeCodebaseStats(tree).catch(async (err) => {
    console.warn("[codebase-stats] Aggregation failed:", err);
    return { linesOfCode: 0, complexity: 0, hash: await hashRun("", campaignName()) };
  });
}

/** Caps how long `recordRunHighscore` will wait on a still-running
 * `codebaseStatsPromise` before giving up and recording the entry without
 * codebase totals. Aggregation gets a multi-minute head start (it starts the
 * moment the workspace loads, not when the run ends), so in the vast
 * majority of cases it's already resolved by now; this only matters for a
 * pathologically large tree that genuinely hasn't finished. */
const CODEBASE_STATS_WAIT_MS = 8000;

/** Resolves `promise` (or `undefined` immediately if `null`), capped at `ms` —
 * resolves to `undefined` on timeout rather than rejecting, since "no
 * codebase stats attached" is an accepted degraded outcome (see
 * `HighscoreEntry.codebaseLinesOfCode`/`codebaseComplexity`, both optional). */
function withTimeout<T>(promise: Promise<T> | null, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      // Both current call sites (`findEntrypoint`'s promise, and
      // `codebaseStatsPromise`) are structurally guaranteed never to reject
      // — kept for `withTimeout`'s own correctness as a general two-outcome
      // utility, not because a rejection is expected today.
      /* v8 ignore start */
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      /* v8 ignore stop */
    );
  });
}

/** The parsable file immediately after `afterPath` in tree order, or `null`
 * when `afterPath` is the last one (or wasn't found). */
async function findNextParsableFile(tree: TreeNode, afterPath: string): Promise<TreeNode | null> {
  const files = await flattenParsableFiles(tree);
  const index = files.findIndex((f) => f.path === afterPath);
  if (index === -1 || index + 1 >= files.length) return null;
  return files[index + 1];
}

/**
 * Replaces `#viewport`'s contents with the "select a file" placeholder —
 * shown once a workspace is loaded (tree populated in the sidebar) but no
 * level is running, whether because nothing has been picked yet or because
 * `autoLaunchInitialLevel` finished without finding anything launchable.
 * Also hides (never removes) the canvas — see its doc comment. A
 * `display:none` element can't stay the Fullscreen API's target, so this is
 * also the one point where leaving the game naturally ends fullscreen,
 * rather than it dropping mid-run on every level transition.
 */
function showFileTreePlaceholder(): void {
  loadingScreen.hidden = true;
  canvasArea.hidden = true;
  for (const child of [...viewport.children]) {
    if (child !== canvasArea) child.remove();
  }

  const placeholder = document.createElement("p");
  placeholder.className = "muted";
  placeholder.innerHTML =
    'Select a file from the tree to build and enter its level.<br />' +
    "Reach the green <code>return</code> tile to win.";
  viewport.appendChild(placeholder);
}

/** Stop any running level and return the viewport to its initial state. */
function resetToFileTree(): void {
  activeEngine?.stop();
  activeEngine = null;
  activeHud = null;
  currentLevelPath = null;
  currentParsedFile = null;
  consoleSidebar.setHintsActive(false);
  showFileTreePlaceholder();
}

// --- Campaign persistence (Continue Run) -----------------------------------
// SAVE_KEY itself is declared near the top of the file — see its doc comment
// for why it can't live down here next to the functions that use it.

/** Minimum time between in-play autosaves; level transitions and
 * `beforeunload` always save immediately regardless of this. */
const AUTOSAVE_INTERVAL_MS = 3000;

/** Everything needed to resume a campaign in a later session. `filePath` is
 * matched against the freshly re-picked workspace's tree on "Continue Run" —
 * there's no way to persist the actual file handle across sessions. */
interface CampaignSave {
  workspaceName: string;
  filePath: string;
  health: number;
  swap: number;
  bullets: number;
  rockets: number;
  /** gdb's own ammo pool (see `AmmoType`). Defaulted to 0 for saves written
   * before this field existed (see `loadCampaignSave`) — a resumed run with
   * gdb already unlocked just starts it dry, exactly as if the player had
   * fired off their last round; not a broken state. */
  smg: number;
  /** Friday Hotfix's own ammo pool (see `AmmoType`) — same "defaulted to 0
   * for older saves" shape as `smg` above. */
  gas: number;
  score: number;
  weaponIndex: number;
  ownedWeapons: number[];
  /** 1-based campaign level position, for `applyForcedUnlocks`'s level-4/8
   * safety net. Defaulted to 1 for saves written before this field existed
   * (see `loadCampaignSave`), rather than rejecting the whole save. */
  levelIndex: number;
}

/** Parse and loosely validate a save from `localStorage`; `null` on any
 * missing field, parse error, or if storage is unavailable (e.g. private
 * browsing) — a broken/absent save should never crash the app. */
export function loadCampaignSave(): CampaignSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    // `armor` was renamed to `swap`; saves written before the rename carry
    // the old field name, so fall back to it rather than treating those
    // saves as invalid.
    const save = JSON.parse(raw) as Partial<CampaignSave> & { armor?: number };
    const swap = typeof save.swap === "number" ? save.swap : save.armor;
    if (
      typeof save.workspaceName !== "string" ||
      typeof save.filePath !== "string" ||
      typeof save.health !== "number" ||
      typeof swap !== "number" ||
      typeof save.bullets !== "number" ||
      typeof save.rockets !== "number" ||
      typeof save.score !== "number" ||
      typeof save.weaponIndex !== "number" ||
      !Array.isArray(save.ownedWeapons) ||
      !save.ownedWeapons.every((i) => typeof i === "number")
    ) {
      return null;
    }
    return {
      ...save,
      swap,
      // `smg`/`gas` are fields new to this save schema — see their doc comments above.
      smg: typeof save.smg === "number" ? save.smg : 0,
      gas: typeof save.gas === "number" ? save.gas : 0,
      levelIndex: typeof save.levelIndex === "number" ? save.levelIndex : 1,
    } as CampaignSave;
  } catch {
    return null;
  }
}

export function saveCampaign(save: CampaignSave): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (err) {
    console.warn("[continue] Failed to save campaign progress:", err);
  }
}

export function clearCampaignSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // Nothing sensible to do if storage itself is unavailable.
  }
  tabContinue.style.display = "none";
  // The Continue tab can't stay active once it's hidden — fall back to Local.
  if (tabContinue.getAttribute("aria-selected") === "true") activateLaunchTab("local");
}

/** Save the current position + stats, if a level is actually running. */
function persistProgress(stats: EngineStats): void {
  if (!workspaceRootName || !currentLevelPath || workspaceIsRemote) return;
  saveCampaign({
    workspaceName: workspaceRootName,
    filePath: currentLevelPath,
    health: stats.health,
    swap: stats.swap,
    bullets: stats.bullets,
    rockets: stats.rockets,
    smg: stats.smg,
    gas: stats.gas,
    score: stats.score,
    weaponIndex: stats.weaponIndex,
    ownedWeapons: stats.ownedWeapons,
    levelIndex: campaignLevelIndex,
  });
}

// --- Gore level (standing preference, independent of any campaign save) ----
// GORE_KEY itself is declared near the top of the file — see its doc comment
// for why it can't live down here next to the functions that use it.

/** Read the saved gore level, falling back to `DEFAULT_GORE_LEVEL` on any
 * missing/invalid value or if storage is unavailable (e.g. private browsing) —
 * same "never throw" philosophy as `loadCampaignSave`. */
function loadGoreLevel(): GoreLevel {
  try {
    const raw = localStorage.getItem(GORE_KEY);
    if (raw === "none" || raw === "normal" || raw === "more" || raw === "extreme") return raw;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_GORE_LEVEL;
}

function saveGoreLevel(level: GoreLevel): void {
  try {
    localStorage.setItem(GORE_KEY, level);
  } catch (err) {
    console.warn("[settings] Failed to save gore level:", err);
  }
}

/** Read the saved difficulty, falling back to `DEFAULT_DIFFICULTY` on any
 * missing/invalid value or if storage is unavailable — same shape as
 * `loadGoreLevel`. */
function loadDifficulty(): DifficultyLevel {
  try {
    const raw = localStorage.getItem(DIFFICULTY_KEY);
    if (raw === "easy" || raw === "normal" || raw === "hard") return raw;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_DIFFICULTY;
}

function saveDifficulty(level: DifficultyLevel): void {
  try {
    localStorage.setItem(DIFFICULTY_KEY, level);
  } catch (err) {
    console.warn("[settings] Failed to save difficulty:", err);
  }
}

// --- Volume settings (Master/SFX/BGM, standing preferences) -----------------

/** Read a saved 0-1 volume, falling back to `fallback` on any missing/invalid
 * value or if storage is unavailable — same shape as `loadGoreLevel`. */
function loadVolume(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  } catch {
    // Fall through to the default.
  }
  return fallback;
}

function saveVolume(key: string, volume: number): void {
  try {
    localStorage.setItem(key, String(volume));
  } catch (err) {
    console.warn("[settings] Failed to save volume:", err);
  }
}

// --- Highscores --------------------------------------------------------------

/**
 * Hash the run-ending level's AST + campaign name and record the resulting
 * score on the top-10 board. Called once per run, not per level — on death
 * (`onGameOver`) or on finishing the whole campaign (`advanceToNextLevel`'s
 * "no more files" branch), never on an ordinary mid-campaign level clear.
 * Fire-and-forget — hashing is cheap but async (`crypto.subtle.digest`), and
 * there's no reason to hold up the caller's own overlay on it.
 *
 * `recorder` (this run's `CampaignReplayRecorder`, spanning every level it
 * visited) is finalized and attached to the saved entry if it produced
 * anything (`null` if recording never captured a frame, overflowed a cap, or
 * no recorder was active at all, e.g. during a replay viewing).
 */
async function recordRunHighscore(
  parsed: ParsedFile,
  path: string,
  stats: EngineStats,
  levelsCleared: number,
  recorder: CampaignReplayRecorder | null,
): Promise<void> {
  if (cheatsUsed) {
    console.log(
      "%c[highscores] Cheats were used this run — not recording a leaderboard entry.",
      "color:#e0483a",
    );
    return;
  }
  if (levelsCleared === 0) {
    console.log(
      "%c[highscores] Died on the very first level — not recording a leaderboard entry.",
      "color:#e0483a",
    );
    return;
  }
  try {
    // `?? path` is unreachable defensive code: String.prototype.split() never
    // returns an empty array, so `.pop()` can never actually be undefined —
    // same reasoning as demoCampaign.ts's identical pattern.
    /* v8 ignore next */
    const levelName = path.split("/").pop() ?? path;
    const codebaseStats = await withTimeout(codebaseStatsPromise, CODEBASE_STATS_WAIT_MS);
    // Prefer the whole-workspace hash so two runs over identical, unedited
    // source compare equal regardless of which level they ended on. Only
    // falls back to the single ended-on file's AST if the background
    // aggregation genuinely never finished in time (see `CodebaseStats.hash`).
    const hash = codebaseStats?.hash ?? (await hashRun(JSON.stringify(parsed), campaignName()));
    await recordHighscore({
      score: stats.score,
      campaignName: campaignName(),
      levelName,
      levelsCleared,
      hash,
      achievedAt: Date.now(),
      // `recorder?.` is unreachable: launchLevel always ensures
      // currentReplayRecorder (the only value ever passed as `recorder`
      // here) is non-null before either call site below can run. `??
      // undefined` covers finish() resolving null (no level produced a
      // savable segment — zero recorded frames), also unreachable given
      // every real win/death test drives at least one frame first.
      /* v8 ignore next */
      replay: (await recorder?.finish()) ?? undefined,
      source: workspaceIsDemo ? "demo" : workspaceIsRemote ? "github" : undefined,
      codebaseLinesOfCode: codebaseStats?.linesOfCode,
      codebaseComplexity: codebaseStats?.complexity,
    });
  } catch (err) {
    console.warn("[highscores] Failed to record this level's score:", err);
  }
}

// --- Replay playback ---------------------------------------------------------

/** Playback speeds "Watch Replay" cycles through, in playback-speed order —
 * see the transport control bar `startReplay` builds. Every speed still
 * advances the sim using each frame's own recorded `dt` unchanged (only *how
 * many* frames run per real-time tick changes), so the simulated trajectory
 * itself is never altered by playback speed — only how fast it's watched. */
const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];
/** Frames a single seek button press jumps by — not tied to real seconds
 * (recorded frame `dt`s vary slightly), but close enough at a typical ~60fps
 * recording to read as "about 5 seconds". */
const REPLAY_SEEK_FRAMES = 300;

/** Preferred-to-fallback `MediaRecorder` mime types for a "Watch Replay"
 * video export — vp9 gives the smallest file at equal quality, vp8 is the
 * older, more universally-supported webm codec, and the bare container is
 * the last resort a spec-compliant browser must still accept. */
const RECORDING_MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

/** First of `RECORDING_MIME_CANDIDATES` this browser can actually record,
 * or `undefined` to let `MediaRecorder` pick its own default (still valid —
 * omitting `mimeType` entirely is allowed by the spec). */
function pickSupportedRecordingMimeType(): string | undefined {
  return RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Turns a campaign name (which may be a GitHub `owner/repo` path, or
 * contain spaces/punctuation from a local folder name) into a safe
 * filename component — anything other than alphanumerics/`.`/`_`/`-`
 * becomes a `-`. */
function sanitizeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** Builds the "Export Map as PNG" button shown once a level is won (see
 * `onWin` in `launchLevel`) — inserted into `#viewport`, destroyed
 * automatically the next time its children get cleared (the next
 * `launchLevel` call, or a return to the file tree), same as every other
 * level-scoped DOM addition in this function. No "has this level been
 * won" state needs tracking anywhere — the button's own presence in the
 * DOM already is that state, and it closes over this level's own `map`
 * object directly rather than needing it threaded through anything wider.
 * Uses its own `.export-map-btn` styling, not `.settings-btn` — that
 * class is `width: 100%` and deliberately muted, built for the sidebar's
 * vertical stack of settings, not a below-canvas call-to-action a player
 * needs to actually notice right after winning. */
function buildExportMapButton(map: GameMap, campaign: string, levelName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "export-map-btn";
  button.textContent = "🖼️ Export Map as PNG";
  button.addEventListener("click", () => {
    const mapCanvas = renderExportMap(map, textures.getActiveSet());
    mapCanvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `codeenstein-${sanitizeFilenamePart(campaign)}-${sanitizeFilenamePart(levelName)}-map.png`);
      }
    }, "image/png");
  });
  return button;
}

/**
 * Play back a recorded run from the Highscores dialog, level by level. Only
 * `replay.version === 2` (campaign-scoped) payloads are ever offered a
 * "Watch Replay" button in the first place — see `renderHighscoreTable`'s
 * call site — so this never has to handle the older single-level shape.
 *
 * Re-picks the workspace once (same "file handles can't survive a session,
 * so ask again" pattern as "Continue Run"), then for each recorded level in
 * turn: locates the file by path, verifies its re-parsed AST still hashes to
 * that level's `astHash` before trusting it to regenerate the exact map (a
 * source file edited since the recorded run would hash differently and is
 * refused rather than silently replayed wrong), and drives a fresh engine
 * through that level's recorded frames — carrying over health/ammo/weapons
 * to the next level exactly as recorded, same as a real multi-level run.
 * Ends whatever real level is currently running, the same way picking a new
 * file from the sidebar already does.
 *
 * A DOM transport bar (play/pause, seek back/forward, speed) sits alongside
 * the hint caption, and every way the viewing can end — a natural win/death
 * (which already shows its own Build Successful / Kernel Panic overlay),
 * Escape, a failed file relocation/hash check, or the (shouldn't-happen)
 * frames-exhausted safety net — surfaces a "Replay Ended" overlay explaining
 * why, rather than silently snapping back to the file tree.
 */
async function startReplay(entry: HighscoreEntry, opts: { autoRecord?: boolean } = {}): Promise<void> {
  const payload = entry.replay;
  // Defensive, not just type-driven: this value round-tripped through
  // localStorage/JSON, so an entry saved before the replay system became
  // campaign-scoped could still be sitting there with the old single-level
  // shape (no `levels` array) despite what the type claims. Unreachable
  // TODAY given the two call sites (onWatchReplay's and onExportReplay's
  // click handlers, both only wired by highscorePanel.ts's identical
  // `entry.replay?.version === 2 && entry.replay.levels?.length > 0` gate
  // before either button even renders) — kept as defense-in-depth against
  // a future third call site or a hand-edited localStorage entry.
  /* v8 ignore next */
  if (!payload || payload.version !== 2 || !payload.levels?.length) return;

  // End any replay already playing before starting this one — otherwise its
  // own requestAnimationFrame loop keeps running orphaned (see
  // `stopActiveReplay`'s doc comment).
  stopActiveReplay?.();

  // Same supersession guard as the real workspace loaders below — a replay's
  // GitHub re-fetch is just as capable of still being in flight when the
  // user starts a real workspace load (or another replay) in the meantime,
  // and resolving into `activeEngine?.stop()`-ing whatever that newer action
  // already set up.
  const gen = beginWorkspaceLoad();
  const controller = new AbortController();
  activeGithubLoadAbort = controller;

  try {
    let tree: TreeNode;
    if (entry.source === "github") {
      // This run's workspace was fetched from GitHub, not picked off local
      // disk — re-fetch the same repo instead of prompting a local folder
      // picker, which would never match `entry.campaignName`'s recorded
      // `owner/repo` paths at all.
      const ref = parseGithubRepoInput(entry.campaignName);
      if (!ref) return; // campaign name doesn't parse back to a repo ref — nothing sane to fetch
      showLoadingScreen(`Fetching "${ref.owner}/${ref.repo}" from GitHub…`);
      tree = await fetchGithubTree(
        ref,
        (bytesReceived) => {
          setLoadingStatus(`Fetching "${ref.owner}/${ref.repo}" from GitHub… (${formatByteCount(bytesReceived)} received)`);
        },
        controller.signal,
      );
    } else if (entry.source === "demo") {
      // Bundled demo campaign — rebuild the same synthetic tree from the
      // app's own bundle rather than prompting a local folder picker (there's
      // no real "demo-campaign" directory on disk to pick).
      showLoadingScreen(`Reading "${DEMO_CAMPAIGN_NAME}"…`);
      tree = loadDemoCampaignTree();
    } else {
      const handle = await pickWorkspace();
      if (!handle) return; // user cancelled the picker
      showLoadingScreen(`Reading "${handle.name}"…`);
      tree = await readDirectoryTree(handle);
    }
    if (gen !== workspaceLoadGeneration) return; // superseded while loading this replay's workspace

    setLoadingStatus("Scanning file tree…");
    const totalFiles = countTreeFiles(tree);
    let checked = 0;
    const files = await flattenParsableFiles(tree, () => {
      checked++;
      if (checked % FILE_TREE_SCAN_PROGRESS_INTERVAL === 0 || checked === totalFiles) {
        setLoadingStatus(`Scanning file tree… (${checked}/${totalFiles})`);
      }
    });
    if (gen !== workspaceLoadGeneration) return; // superseded while scanning for parsable files

    // Tear down whatever's currently running/shown, same as launching any
    // other level — see `launchLevel`'s equivalent block. Done once, up
    // front — each level below just swaps the engine underneath it.
    activeEngine?.stop();
    for (const child of [...viewport.children]) {
      if (child !== canvasArea) child.remove();
    }
    const hint = document.createElement("p");
    hint.className = "map-caption";
    const controls = buildReplayControls();
    // Feature-detected once, not assumed: `MediaRecorder`/`captureStream`
    // are widely but not universally supported (and don't exist in jsdom —
    // see the test suite's stubs). Missing either means the Record button
    // just hides itself and `autoRecord` silently falls back to plain
    // Watch behavior, rather than throwing.
    const recordingSupported = typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";
    controls.setRecordAvailable(recordingSupported);
    viewport.append(hint, controls.el);
    canvasArea.hidden = false;
    canvas.focus();

    const hud = new GameHud(canvas);
    activeHud = hud;
    isReplaying = true;

    let levelIndex = 0;
    let replayInput: ReplayPlaybackInput | null = null;
    let frameIndex = 0;
    let rafId = 0;
    let paused = false;
    let speedIndex = REPLAY_SPEEDS.indexOf(1);
    let mediaRecorder: MediaRecorder | null = null;
    let recordedChunks: Blob[] = [];
    /** Fractional frame budget carried between ticks so speeds other than 1x
     * (more or fewer than one frame per real tick) still advance the sim at
     * exactly the recorded rate on average — see `step()`. */
    let speedAccumulator = 0;
    /** True once the active level's engine has already fired onGameOver/
     * onWin this frame (before its resulting dialog has been dismissed) —
     * `step` must stop consuming further frames the instant this flips, or
     * a tick landing before the player dismisses that dialog (or several
     * frames processed in one burst at a high speed) could advance right
     * past the point the level actually ended. */
    let levelEnded = false;
    /** True while `loadLevel`/a restart is (asynchronously or synchronously)
     * setting up a level — `step` must not touch `frameIndex`/`replayInput`/
     * `activeEngine` while this is true, or a frame tick landing mid-
     * transition could act on the level being torn down instead of the one
     * coming up. */
    let transitioning = false;
    /** The currently-loaded level's already-verified parsed AST + segment —
     * kept around so a seek backward can rebuild this same level from
     * scratch without re-reading/re-parsing/re-hashing the file again. */
    let currentParsed: ParsedFile | null = null;
    let currentSegment: ReplayLevelSegment | null = null;

    /** Begins capturing the canvas as a webm video — forces 1x playback
     * speed (a `MediaRecorder` captures in real wall-clock time, so any
     * other speed would produce a sped-up/slowed-down video instead of an
     * accurate recording) and locks the rest of the transport bar for the
     * duration (see `buildReplayControls`'s `lockableButtons`). No-op if
     * unsupported or already recording. */
    const startRecording = (): void => {
      if (!recordingSupported) return;
      // Unreachable via the UI today: `controls.onRecord`'s ternary and the
      // `autoRecord` notice's callback are the only two call sites, and
      // both already guarantee a recording isn't already active before
      // calling this — kept as defense-in-depth against a future third
      // call site double-starting (and leaking) a `MediaRecorder`.
      /* v8 ignore next */
      if (mediaRecorder) return;
      controls.setControlsEnabled(false);
      speedIndex = REPLAY_SPEEDS.indexOf(1);
      controls.setSpeedLabel(`${REPLAY_SPEEDS[speedIndex]}x`);
      const mimeType = pickSupportedRecordingMimeType();
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(canvas.captureStream(), mimeType ? { mimeType } : undefined);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: mimeType ?? "video/webm" });
        recordedChunks = [];
        downloadBlob(blob, `codeenstein-${sanitizeFilenamePart(entry.campaignName)}-replay-${Date.now()}.webm`);
      };
      mediaRecorder.start();
      controls.setRecording(true);
    };

    /** Stops an active recording (a no-op if none is running) — `onstop`
     * above fires synchronously-enough to finish the download before this
     * returns in every browser this was tested against, but isn't awaited
     * either way since there's nothing meaningful to do after. */
    const stopRecording = (): void => {
      if (!mediaRecorder) return;
      mediaRecorder.stop();
      mediaRecorder = null;
      controls.setRecording(false);
      controls.setControlsEnabled(true);
    };

    const teardown = (): void => {
      isReplaying = false;
      stopActiveReplay = null;
      cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onStopKey);
      stopRecording(); // flush + download whatever was captured, if a recording was in progress
      resetToFileTree();
    };

    /** `teardown`, plus reopening the Highscores dialog this viewing was
     * launched from — used only by the three "genuinely done watching"
     * overlays below (natural win/death, Escape, or any load/verify error),
     * never by `stopActiveReplay`'s supersession call sites (`launchLevel`
     * picking a real file, or `startReplay` itself starting a *different*
     * replay) — those are the user explicitly navigating away, not "done",
     * so popping the dialog back open there would fight whatever they just
     * launched. */
    const returnToHighscores = (): void => {
      teardown();
      void openHighscoreDialog();
    };

    /** Ends the viewing with an on-screen explanation — every termination
     * path except a natural win/death, which already shows its own overlay
     * (see `buildEngineFor`'s handlers) and can go straight to
     * `returnToHighscores`. */
    const endReplay = (reason: string): void => {
      if (!isReplaying) return;
      window.removeEventListener("keydown", onStopKey); // avoid double-handling Escape against the dialog's own listener
      hud.showReplayEnded(reason, returnToHighscores);
    };
    stopActiveReplay = teardown;

    const onStopKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") endReplay("Replay stopped.");
    };
    window.addEventListener("keydown", onStopKey);

    const updateHint = (): void => {
      const segment = currentSegment;
      // The only call site (buildEngineFor) always sets currentSegment first.
      // `v8 ignore next` alone only suppressed the assignment's first line —
      // the ternary's own continuation lines still showed up as uncovered;
      // start/stop brackets the whole statement instead.
      /* v8 ignore start */
      hint.textContent = segment
        ? `Watching replay: level ${levelIndex}/${payload.levels.length} — ${segment.filePath} — Esc to stop`
        : "";
      /* v8 ignore stop */
    };

    /** Builds a fresh engine for `segment`/`parsed`, wired the same way for
     * both a normal level load and an in-place restart (seeking backward). */
    const buildEngineFor = (segment: ReplayLevelSegment, parsed: ParsedFile): void => {
      const hasRocketLauncher = segment.carryover?.ownedWeapons?.includes(GHIDRA_WEAPON_INDEX) ?? false;
      const segmentOwnedWeapons = segment.carryover?.ownedWeapons ?? [];
      const missingWeaponIndices = computeMissingWeaponIndices(segmentOwnedWeapons, segment.carryover?.campaignLevelIndex ?? 1);
      const map = mapGenerator.generate(parsed, segment.bonusLevel, hasRocketLauncher, missingWeaponIndices);
      currentParsed = parsed;
      currentSegment = segment;
      replayInput = new ReplayPlaybackInput();
      frameIndex = 0;
      levelEnded = false;
      updateHint();
      activeEngine = new RaycasterEngine(
        canvas,
        map,
        {
          onGameOver: (stats) => {
            levelEnded = true;
            hud.showKernelPanic(statsScreenInfo(stats.runScoreBreakdown, stats.runPlayerStats), returnToHighscores);
          },
          onWin: (stats) => {
            levelEnded = true;
            if (levelIndex >= payload.levels.length) {
              hud.showBuildSuccessful(statsScreenInfo(stats.runScoreBreakdown, stats.runPlayerStats), returnToHighscores);
            } else {
              advanceLevel();
            }
          },
        },
        segment.carryover,
        segment.gore,
        segment.difficulty,
        segment.gameplaySeed,
        replayInput,
        undefined, // never record a replay of a replay
      );
    };

    // Loads `payload.levels[levelIndex]`, advances `levelIndex` past it, and
    // (re)starts the driving loop. Ends the whole replay if the file can't be
    // relocated/re-verified, or once every level has played — same failure-
    // handling shape as a live run's `advanceToNextLevel`, just reporting
    // failure by ending the viewing instead of falling back to the next file.
    const loadLevel = async (): Promise<void> => {
      // Defensive: both callers (startReplay's own kick-off, guarded by its
      // non-empty-levels check; onWin's else-branch, guarded by the same
      // bounds check one line above it) already ensure this can't be true.
      /* v8 ignore start */
      if (levelIndex >= payload.levels.length) {
        endReplay("Replay ended — ran out of recorded levels.");
        return;
      }
      /* v8 ignore stop */
      const segment = payload.levels[levelIndex++];

      const match = files.find((f) => f.path === segment.filePath);
      if (!match) {
        endReplay(`"${segment.filePath}" wasn't found in "${entry.campaignName}" — load the same workspace this run was recorded in.`);
        return;
      }

      const text = await readFileText(match.handle as FileSystemFileHandle);
      const parsed = await parseFile(match.name, text);
      if (!parsed) {
        endReplay(`"${segment.filePath}" could not be parsed.`);
        return;
      }

      const hash = await hashRun(JSON.stringify(parsed), payload.campaignName);
      if (hash !== segment.astHash) {
        endReplay(`"${segment.filePath}" doesn't match the recorded run anymore — the source may have changed since.`);
        return;
      }

      buildEngineFor(segment, parsed);
      if (isReplaying) rafId = requestAnimationFrame(step);
    };

    const advanceLevel = (): void => {
      transitioning = true;
      void loadLevel().finally(() => {
        transitioning = false;
      });
    };

    /** Fast-forwards the *current* level's engine through recorded frames,
     * synchronously and without real-time pacing, until reaching
     * `targetFrameIndex` (or the level ends, or frames run out) — the engine
     * for both seek directions (backward first rebuilds the level from
     * scratch via `restartLevel`, then bursts forward to the target). */
    const burstTo = (targetFrameIndex: number): void => {
      const segment = currentSegment;
      // Unreachable given the single call site (seekBy), which already
      // requires currentSegment non-null and isReplaying true before calling
      // this — activeEngine/replayInput/currentSegment are always set
      // together in buildEngineFor, and nothing clears just one of them
      // while isReplaying stays true.
      /* v8 ignore next */
      if (!activeEngine || !replayInput || !segment) return;
      while (frameIndex < targetFrameIndex && frameIndex < segment.frames.length && !levelEnded) {
        const frame = segment.frames[frameIndex++];
        replayInput.loadFrame(frame.input);
        activeEngine.advance(frame.dt);
      }
    };

    /** Rebuilds the current level's engine from scratch (frame 0) — the only
     * way to go "backward", since simulation isn't reversible. Re-verifying
     * the file isn't needed: `currentParsed`/`currentSegment` are already the
     * verified result of this same level's `loadLevel` call. */
    const restartLevel = (): void => {
      // Unreachable given the single call site (seekBy), which already
      // requires currentSegment non-null — currentParsed/currentSegment are
      // always set together in buildEngineFor.
      /* v8 ignore next */
      if (!currentParsed || !currentSegment) return;
      buildEngineFor(currentSegment, currentParsed);
    };

    const seekBy = (deltaFrames: number): void => {
      if (!isReplaying || transitioning || !currentSegment) return;
      const target = Math.max(0, Math.min(currentSegment.frames.length, frameIndex + deltaFrames));
      if (target < frameIndex) restartLevel();
      burstTo(target);
    };

    const step = (): void => {
      // Unreachable in practice: exactly one step() reschedule is ever
      // outstanding at a time (confirmed via temporary instrumentation —
      // rafId increments 1-2-3-4 with no gaps or duplicates across a whole
      // multi-tick run), and teardown()/endReplay() always cancel that
      // specific id via cancelAnimationFrame before isReplaying flips false.
      // Kept as a safety net against a future change loosening that
      // invariant, not because this fires today.
      /* v8 ignore next */
      if (!isReplaying) return;
      if (transitioning || paused || levelEnded || !activeEngine || !replayInput || !currentSegment) {
        rafId = requestAnimationFrame(step); // keep polling so unpausing (or a transition finishing) resumes on its own
        return;
      }
      speedAccumulator += REPLAY_SPEEDS[speedIndex];
      while (speedAccumulator >= 1) {
        speedAccumulator -= 1;
        if (frameIndex >= currentSegment.frames.length) {
          // A correctly-deterministic replay should already have ended this
          // level via onGameOver/onWin above by the time its frames run
          // out — this is just a safety net for the (shouldn't-happen)
          // alternative, and it's honest about something having gone wrong
          // rather than quietly barreling into whatever's next.
          endReplay("Replay ended — ran out of recorded input before the level concluded.");
          return;
        }
        const frame = currentSegment.frames[frameIndex++];
        replayInput.loadFrame(frame.input);
        activeEngine.advance(frame.dt);
        if (levelEnded) break; // onGameOver/onWin just fired mid-burst — stop consuming this tick
      }
      if (isReplaying && !transitioning) rafId = requestAnimationFrame(step);
    };

    controls.onPlayPause(() => {
      paused = !paused;
      controls.setPaused(paused);
    });
    controls.onSeek((deltaFrames) => seekBy(deltaFrames * REPLAY_SEEK_FRAMES));
    controls.onSpeedChange((direction) => {
      speedIndex = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, speedIndex + direction));
      controls.setSpeedLabel(`${REPLAY_SPEEDS[speedIndex]}x`);
    });
    // Manual click starts capturing immediately — the user is already
    // looking at the replay and clicked a clearly-labeled button, unlike
    // `autoRecord` below, which jumps straight from the Highscores dialog
    // into a recording with no replay UI seen yet and so gets an
    // explanatory notice first.
    controls.onRecord(() => (mediaRecorder ? stopRecording() : startRecording()));

    // The replay's own playback loop only ever starts inside `loadLevel`
    // (`if (isReplaying) rafId = requestAnimationFrame(step)`), which is
    // only ever reached via `advanceLevel` — nothing else schedules the
    // first frame. So gating `advanceLevel` itself behind the notice's
    // acknowledgement (rather than showing the notice as an afterthought
    // once playback has already begun) makes it structurally impossible
    // for the replay to end before the user has seen the notice and
    // recording has started: nothing is playing yet for it to end.
    // `recordingSupported` is also checked here (not just inside
    // `startRecording`'s own no-op guard) — an unsupported browser should
    // fall back to plain Watch behavior, not show a "recording will start"
    // notice for a recording that's never actually going to happen.
    if (opts.autoRecord && recordingSupported) {
      hud.showRecordingNotice(() => {
        startRecording();
        advanceLevel();
      });
    } else {
      advanceLevel();
    }
  } catch (err) {
    if (gen !== workspaceLoadGeneration) return; // a newer load's own error handling owns the screen now
    console.error("[replay] Failed to start replay:", err);
    showFileTreePlaceholder(); // otherwise the loading screen shown above would be left stuck on screen
  } finally {
    if (activeGithubLoadAbort === controller) activeGithubLoadAbort = null;
  }
}

/** The replay transport control bar: play/pause, seek back/forward, and a
 * speed stepper — a plain DOM strip (not a canvas overlay, unlike the rest of
 * this game's HUD) since it needs real click targets and lives alongside the
 * hint caption, not inside the rendered scene. Returned as a small handle
 * rather than raw elements so `startReplay` doesn't have to know its DOM
 * structure — just how to react to each control. */
function buildReplayControls(): {
  el: HTMLElement;
  onPlayPause: (fn: () => void) => void;
  onSeek: (fn: (direction: -1 | 1) => void) => void;
  onSpeedChange: (fn: (direction: -1 | 1) => void) => void;
  onRecord: (fn: () => void) => void;
  setPaused: (paused: boolean) => void;
  setSpeedLabel: (label: string) => void;
  setRecording: (recording: boolean) => void;
  setRecordAvailable: (available: boolean) => void;
  setControlsEnabled: (enabled: boolean) => void;
} {
  const el = document.createElement("div");
  el.className = "replay-controls";

  const seekBack = document.createElement("button");
  seekBack.type = "button";
  seekBack.className = "replay-btn";
  seekBack.textContent = "⏪";
  seekBack.title = "Seek back";

  const playPause = document.createElement("button");
  playPause.type = "button";
  playPause.className = "replay-btn";
  playPause.textContent = "⏸";
  playPause.title = "Play/Pause";

  const seekForward = document.createElement("button");
  seekForward.type = "button";
  seekForward.className = "replay-btn";
  seekForward.textContent = "⏩";
  seekForward.title = "Seek forward";

  const speedDown = document.createElement("button");
  speedDown.type = "button";
  speedDown.className = "replay-btn";
  speedDown.textContent = "−";
  speedDown.title = "Slower";

  const speedLabel = document.createElement("span");
  speedLabel.className = "replay-speed-label";
  speedLabel.textContent = "1x";

  const speedUp = document.createElement("button");
  speedUp.type = "button";
  speedUp.className = "replay-btn";
  speedUp.textContent = "+";
  speedUp.title = "Faster";

  const record = document.createElement("button");
  record.type = "button";
  record.className = "replay-btn";
  record.textContent = "⏺";
  record.title = "Record video";

  el.append(seekBack, playPause, seekForward, speedDown, speedLabel, speedUp, record);

  // Everything except Record/Stop itself — locked for the whole duration a
  // recording is active (see `startReplay`'s `startRecording`), since
  // MediaRecorder captures in real time and a seek/pause/speed change mid-
  // capture would either desync the video from what it's supposed to show
  // or (for seeking) look like an instant jump-cut.
  const lockableButtons = [seekBack, playPause, seekForward, speedDown, speedUp];

  return {
    el,
    onPlayPause: (fn) => playPause.addEventListener("click", fn),
    onSeek: (fn) => {
      seekBack.addEventListener("click", () => fn(-1));
      seekForward.addEventListener("click", () => fn(1));
    },
    onSpeedChange: (fn) => {
      speedDown.addEventListener("click", () => fn(-1));
      speedUp.addEventListener("click", () => fn(1));
    },
    onRecord: (fn) => record.addEventListener("click", fn),
    setPaused: (paused) => {
      playPause.textContent = paused ? "▶" : "⏸";
    },
    setSpeedLabel: (label) => {
      speedLabel.textContent = label;
    },
    setRecording: (recording) => {
      record.textContent = recording ? "⏹" : "⏺";
      record.title = recording ? "Stop recording" : "Record video";
      record.classList.toggle("recording", recording);
    },
    setRecordAvailable: (available) => {
      record.hidden = !available;
    },
    setControlsEnabled: (enabled) => {
      for (const button of lockableButtons) button.disabled = !enabled;
    },
  };
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
