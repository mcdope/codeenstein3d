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
import { renderFileTree } from "./ui/fileTree";
import { initConsoleSidebar } from "./ui/consoleSidebar";
import { extensionOf, isParsable, parseFile } from "./parser/registry";
import { MapGenerator } from "./map/mapGenerator";
import { RaycasterEngine } from "./engine/engine";
import { audio } from "./engine/audio";
import { bgm } from "./engine/bgm";
import { hashRun, loadHighscores, recordHighscore, type HighscoreEntry } from "./engine/highscores";
import { renderHighscoreTable } from "./ui/highscorePanel";
import { GameHud } from "./ui/gameHud";
import { DEFAULT_GORE_LEVEL, EXTREME_GORE_ENABLED, type GoreLevel } from "./engine/effects";
import { GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX } from "./engine/weapons";
import { DEFAULT_DIFFICULTY, type DifficultyLevel } from "./difficulty";
import { randomSeed } from "./prng";
import { CampaignReplayRecorder, ReplayPlaybackInput, type ReplayLevelSegment } from "./engine/replay";
import type { ParsedFile } from "./parser/types";
import type { EngineCarryover, EngineStats } from "./engine/engine";

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

const selectButton = requireElement<HTMLButtonElement>("#select-workspace");
const continueButton = requireElement<HTMLButtonElement>("#continue-run");
const githubRepoInput = requireElement<HTMLInputElement>("#github-repo-input");
const loadGithubRepoButton = requireElement<HTMLButtonElement>("#load-github-repo");
const githubStatus = requireElement<HTMLParagraphElement>("#github-status");
const workspaceName = requireElement<HTMLParagraphElement>("#workspace-name");
const fileTree = requireElement<HTMLElement>("#file-tree");
const viewport = requireElement<HTMLElement>("#viewport");
const goreSelect = requireElement<HTMLSelectElement>("#gore-select");
const difficultySelect = requireElement<HTMLSelectElement>("#difficulty-select");
const masterVolumeInput = requireElement<HTMLInputElement>("#master-vol");
const sfxVolumeInput = requireElement<HTMLInputElement>("#sfx-vol");
const bgmVolumeInput = requireElement<HTMLInputElement>("#bgm-vol");
const selectBgmFolderButton = requireElement<HTMLButtonElement>("#select-bgm-folder");
const bgmStatus = requireElement<HTMLParagraphElement>("#bgm-status");
const viewHighscoresButton = requireElement<HTMLButtonElement>("#view-highscores");
const highscoreDialog = requireElement<HTMLDialogElement>("#highscore-dialog");
const highscoreList = requireElement<HTMLElement>("#highscore-list");
const closeHighscoresButton = requireElement<HTMLButtonElement>("#close-highscores");
// "Extreme" reads as over-the-top per playtest feedback — hidden from the
// dropdown for now (see EXTREME_GORE_ENABLED's doc comment); the <option>
// stays in index.html so re-enabling is just flipping that flag back.
if (!EXTREME_GORE_ENABLED) goreSelect.querySelector('option[value="extreme"]')?.remove();

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

// --- Highscores dialog -------------------------------------------------------

viewHighscoresButton.addEventListener("click", async () => {
  renderHighscoreTable(highscoreList, await loadHighscores(), {
    onWatchReplay: (entry) => {
      highscoreDialog.close();
      void startReplay(entry);
    },
  });
  highscoreDialog.showModal();
});
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
 * fullscreens (see `InputController`). It's only ever shown/hidden via
 * `canvas.hidden`, never detached: fullscreening an element that gets
 * disconnected from the document — even briefly, e.g. via a naive
 * `replaceChildren` call that happens to include it in both the old and new
 * child list — makes the browser auto-exit fullscreen, which is exactly what
 * made fullscreen drop on every level transition. `launchLevel` only ever
 * touches the *other* children of `#viewport` (the hint caption, the HUD
 * overlay); this canvas is simply left alone.
 */
const canvas = document.createElement("canvas");
canvas.width = SCENE_WIDTH;
canvas.height = SCENE_HEIGHT;
canvas.className = "scene-canvas";
canvas.tabIndex = 0; // focusable so it can grab keyboard input on click
canvas.hidden = true; // not shown until a level is actually running
viewport.appendChild(canvas);

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
/** True once any Doom-style cheat code (IDDQD/IDKFA/IDCLIP) has been entered
 * during the active campaign — set by the engine's `onCheatActivated`
 * handler, cleared only at the same 3 points `workspaceIsRemote` resets
 * (fresh local pick, GitHub load, Continue Run), never mid-campaign. Gates
 * `recordRunHighscore` so a cheated run can never claim a leaderboard entry
 * (or attach its replay). */
let cheatsUsed = false;
/** Most recent stats reported by the running engine, used for the throttled
 * autosave and the `beforeunload` flush. */
let lastStats: EngineStats | null = null;
let lastSaveAt = 0;
/** 1-based position in the current campaign's level sequence — level 1 is
 * the first file entered after a fresh workspace pick (or "Continue Run"'s
 * saved level). Incremented only by `advanceToNextLevel`'s auto-chaining, so
 * a manual sidebar pick doesn't count as "campaign progression" — drives
 * `applyForcedUnlocks`'s level-4/8 safety net. */
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

if (loadCampaignSave()) continueButton.style.display = "";

selectButton.addEventListener("click", async () => {
  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");

    const tree = await readDirectoryTree(handle);
    workspaceTree = tree;
    workspaceRootName = handle.name;
    workspaceIsRemote = false;
    cheatsUsed = false;
    workspaceName.textContent = handle.name;
    campaignLevelIndex = 1; // a fresh pick always starts a new campaign
    kickOffCodebaseStats(tree);

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[workspace] Loaded "${handle.name}"`, tree);
    await autoLaunchInitialLevel(tree);
  } catch (err) {
    console.error("[workspace] Failed to read workspace:", err);
    workspaceName.textContent =
      err instanceof Error ? err.message : "Failed to read workspace.";
    workspaceName.classList.add("error");
  }
});

loadGithubRepoButton.addEventListener("click", async () => {
  const ref = parseGithubRepoInput(githubRepoInput.value);
  if (!ref) {
    githubStatus.textContent = 'Enter a repo as "owner/repo" or a github.com URL.';
    githubStatus.classList.add("error");
    return;
  }

  try {
    loadGithubRepoButton.disabled = true;
    githubStatus.classList.remove("error");
    githubStatus.textContent = `Fetching "${ref.owner}/${ref.repo}"…`;
    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");

    const tree = await fetchGithubTree(ref);
    workspaceTree = tree;
    workspaceRootName = `${ref.owner}/${ref.repo}`;
    workspaceIsRemote = true;
    cheatsUsed = false;
    workspaceName.textContent = workspaceRootName;
    campaignLevelIndex = 1; // a fresh load always starts a new campaign
    kickOffCodebaseStats(tree);
    clearCampaignSave(); // a stale local-workspace save shouldn't dangle a "Continue Run" button while a remote repo is loaded

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[github] Loaded "${workspaceRootName}"`, tree);
    githubStatus.textContent = "";
    await autoLaunchInitialLevel(tree);
  } catch (err) {
    console.error("[github] Failed to load repository:", err);
    const message = err instanceof Error ? err.message : "Failed to load repository.";
    githubStatus.textContent = message;
    githubStatus.classList.add("error");
    workspaceName.textContent = message;
    workspaceName.classList.add("error");
  } finally {
    loadGithubRepoButton.disabled = false;
  }
});

continueButton.addEventListener("click", async () => {
  const save = loadCampaignSave();
  if (!save) return; // button should already be hidden in this case

  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");

    const tree = await readDirectoryTree(handle);
    workspaceTree = tree;
    workspaceRootName = handle.name;
    workspaceIsRemote = false;
    cheatsUsed = false;
    workspaceName.textContent = handle.name;
    kickOffCodebaseStats(tree);
    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });

    const match = (await flattenParsableFiles(tree)).find((f) => f.path === save.filePath);
    if (!match) {
      console.warn(
        `[continue] Saved file "${save.filePath}" not found in "${handle.name}" — starting a fresh run instead.`,
      );
      clearCampaignSave();
      await autoLaunchInitialLevel(tree);
      return;
    }

    const text = await readFileText(match.handle as FileSystemFileHandle);
    const parsed = await parseFile(match.name, text);
    if (parsed) {
      campaignLevelIndex = save.levelIndex;
      console.log(`%c[continue] resuming at ${match.path}`, "color:#8effa0;font-weight:bold");
      launchLevel(match.path, parsed, {
        health: save.health,
        armor: save.armor,
        bullets: save.bullets,
        rockets: save.rockets,
        weaponIndex: save.weaponIndex,
        ownedWeapons: save.ownedWeapons,
      });
    }
  } catch (err) {
    console.error("[continue] Failed to resume campaign:", err);
    workspaceName.textContent = err instanceof Error ? err.message : "Failed to resume campaign.";
    workspaceName.classList.add("error");
  }
});

window.addEventListener("beforeunload", () => {
  if (activeEngine && lastStats && !isReplaying) persistProgress(lastStats);
});

/**
 * On file click: parse supported languages into normalized JSON and log that;
 * for everything else fall back to logging raw text.
 */
async function handleFileSelected(node: TreeNode): Promise<void> {
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

/** Files processed between yields in `findEntrypointByScanning` — same
 * reasoning as `CODEBASE_STATS_CHUNK_SIZE`, kept as its own constant so the
 * two independent background scans can be tuned separately. */
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
 * `computeCodebaseStats`.
 */
async function findEntrypointByScanning(files: TreeNode[]): Promise<EntrypointMatch | null> {
  let bestWithMain: EntrypointMatch | null = null;
  let bestWithMainComplexity = -1;
  let bestOverall: EntrypointMatch | null = null;
  let bestOverallComplexity = -1;

  for (let i = 0; i < files.length; i++) {
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

/** The workspace's logical entrypoint, if any. Partitions every parsable file
 * into "real" project source and test/spec fixtures (see
 * `partitionEntrypointCandidates`), then tries, in order: a filename-
 * convention match in real source, the same in test/spec fixtures, a scored
 * main()-scan in real source, and finally a scored main()-scan in test/spec
 * fixtures. Each stage falls through to the next only when it finds nothing
 * *usable* — not merely when a bucket is empty — so a workspace whose real
 * source is present but entirely unparsable still correctly falls back to
 * whatever test fixtures do parse, rather than giving up early; likewise a
 * filename match that turns out to fail parsing (a broken/binary file that
 * happens to have a conventional name) falls through to the scoring stage
 * rather than dead-ending detection. */
export async function findEntrypoint(tree: TreeNode): Promise<EntrypointMatch | null> {
  const { primary, secondary } = partitionEntrypointCandidates(await flattenParsableFiles(tree));

  const byName = findEntrypointByName(primary) ?? findEntrypointByName(secondary);
  if (byName) {
    try {
      const text = await readFileText(byName.handle as FileSystemFileHandle);
      const parsed = await parseFile(byName.name, text);
      if (parsed) return { file: byName, parsed };
    } catch (err) {
      console.error(`[entrypoint] Matched "${byName.path}" by name but failed to parse it:`, err);
    }
  }

  return (await findEntrypointByScanning(primary)) ?? (await findEntrypointByScanning(secondary));
}

/** Caps how long `findEntrypoint`'s detection scan may run before
 * `autoLaunchInitialLevel` gives up and falls back to the first parsable file
 * in tree order — tighter than `CODEBASE_STATS_WAIT_MS` (8s) since this
 * blocks the very first level launch rather than running silently in the
 * background after a run has already ended. */
const ENTRYPOINT_DETECTION_TIMEOUT_MS = 4000;

/**
 * Auto-start the very first level right after a workspace loads: prefer a
 * detected project entrypoint (see `findEntrypoint`) over just resolving the
 * first parsable file alphabetically/by tree order, though that remains the
 * fallback both when no entrypoint is found and when detection itself times
 * out (see `ENTRYPOINT_DETECTION_TIMEOUT_MS`). Does nothing if the workspace
 * has no parsable file at all — the sidebar is left for a manual pick as
 * before.
 */
async function autoLaunchInitialLevel(tree: TreeNode): Promise<void> {
  const previousWorkspaceName = workspaceName.textContent;
  workspaceName.textContent = "Scanning for entrypoint…";
  const match = await withTimeout(findEntrypoint(tree), ENTRYPOINT_DETECTION_TIMEOUT_MS);
  workspaceName.textContent = previousWorkspaceName;

  let target: TreeNode | null;
  let parsed: ParsedFile | null;
  const how = match ? "detected entrypoint" : "first file in tree order";

  if (match) {
    target = match.file;
    parsed = match.parsed;
  } else {
    target = (await flattenParsableFiles(tree))[0] ?? null;
    parsed = null;
  }
  if (!target) return;

  try {
    if (!parsed) {
      const text = await readFileText(target.handle as FileSystemFileHandle);
      parsed = await parseFile(target.name, text);
    }
    if (parsed) {
      console.log(`%c[entrypoint] auto-starting at ${target.path} (${how})`, "color:#8effa0;font-weight:bold");
      launchLevel(target.path, parsed);
    }
  } catch (err) {
    console.error(`[entrypoint] Failed to auto-launch "${target.path}":`, err);
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
  const map = mapGenerator.generate(parsed, bonusLevel);
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
    `Click to capture mouse · W/S move, A/D strafe · Q/E or mouse turn · ` +
    `Shift to sprint · Click / Space to fire · 1 pistol / 2 shotgun · mousewheel cycles weapons · ` +
    `Left-Ctrl quick-melee knife (never runs dry) · elite kills unlock gdb or ghidra · ` +
    `grab keys to open blue doors · step on a glowing pad to warp (goto) · ` +
    `avoid the acid and timed spikes · shoot spotted mines to disarm them from range · ` +
    `R to read a glowing lore terminal or open a suspicious wall · ` +
    `Tab for map · F for fullscreen · Esc to pause · Right-Ctrl for FPS · ` +
    `gamepad: left stick move, right stick turn, RT fire, bumpers cycle weapons, R3/B melee`;

  const hud = new GameHud(canvas);
  activeHud = hud;

  // The status bar and every blocking overlay (briefing, commit summary,
  // end-of-run) are all drawn natively on the canvas now — nothing but the
  // hint caption is DOM. Only the canvas's *siblings* are replaced — the
  // canvas itself is never removed from #viewport (see its doc comment).
  for (const child of [...viewport.children]) {
    if (child !== canvas) child.remove();
  }
  viewport.append(hint);
  canvas.hidden = false;
  // Grab keyboard focus immediately — without this, the very first WASD press
  // after a level (re)load is silently swallowed until the player clicks the
  // canvas themselves, which reads as "controls don't work" on every level
  // change (multi-level advance, retry after death, or a fresh manual pick).
  canvas.focus();

  // Campaign-progression safety net: gdb/ghidra are force-added to
  // ownedWeapons once the player reaches level 4/8, regardless of whether an
  // Elite ever dropped them — never removes anything, so a weapon already
  // earned by looting is unaffected.
  const effectiveCarryover: EngineCarryover | undefined = carryover
    ? { ...carryover, ownedWeapons: applyForcedUnlocks(carryover.ownedWeapons ?? [], campaignLevelIndex) }
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
        hud.showKernelPanic(resetToFileTree);
      },
      onWin: (stats) => {
        hud.showCommitSummary(
          { linesRefactored: parsed.linesOfCode, bugsSquashed: stats.kills },
          () => void advanceToNextLevel(stats),
        );
      },
      onCheatActivated: () => {
        cheatsUsed = true;
      },
    },
    effectiveCarryover,
    currentGoreLevel,
    currentDifficulty,
    gameplaySeed,
    undefined,
    currentReplayRecorder,
  );

  const levelName = path.split("/").pop() ?? path;
  hud.showLevelStart(
    {
      campaign: campaignName(),
      levelName,
      roomCount: map.rooms.length,
      enemyCount: map.enemies.length,
    },
    () => {
      activeEngine?.start();
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
 * progression safety net so a long, loot-unlucky run doesn't leave gdb/ghidra
 * permanently unreachable. */
const FORCED_UNLOCK_LEVELS: { level: number; weaponIndex: number; name: string }[] = [
  { level: 4, weaponIndex: GDB_WEAPON_INDEX, name: "gdb" },
  { level: 8, weaponIndex: GHIDRA_WEAPON_INDEX, name: "ghidra" },
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

/** The workspace root's name, or a placeholder if none is loaded yet. See the
 * `workspaceRootName` doc comment for why the "parent dir named src" case
 * from the spec can't be implemented in a browser sandbox. */
function campaignName(): string {
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
          armor: stats.armor,
          bullets: stats.bullets,
          rockets: stats.rockets,
          weaponIndex: stats.weaponIndex,
          ownedWeapons: stats.ownedWeapons,
        };
        // Persist immediately at the transition (not just the throttled
        // in-play autosave) so a tab closed right after advancing still
        // resumes at the new file rather than the one just cleared.
        saveCampaign({
          workspaceName: workspaceRootName ?? "",
          filePath: next.path,
          health: carryover.health,
          armor: carryover.armor,
          bullets: carryover.bullets,
          rockets: carryover.rockets,
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
  activeHud?.showBuildSuccessful(resetToFileTree);
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

/** Files parsable by a registered adapter, in the same depth-first,
 * directories-first order the sidebar renders them in. */
export async function flattenParsableFiles(node: TreeNode): Promise<TreeNode[]> {
  if (node.kind === "file") return (await isParsableNode(node)) ? [node] : [];
  const out: TreeNode[] = [];
  for (const child of node.children ?? []) out.push(...(await flattenParsableFiles(child)));
  return out;
}

interface CodebaseStats {
  linesOfCode: number;
  complexity: number;
}

/** Files processed between yields in `computeCodebaseStats` — small enough
 * that a slow file (a GitHub raw fetch) doesn't stall input/rendering for
 * more than a beat, large enough that a big local codebase doesn't spend all
 * its time on `setTimeout` overhead. */
const CODEBASE_STATS_CHUNK_SIZE = 20;

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
 * this run's levels actually reach. Reuses the exact same
 * `readFileText`/`parseFile` pair every level launch already goes through; a
 * file that fails to read or parse is skipped rather than aborting the whole
 * aggregation. Yields back to the event loop every
 * `CODEBASE_STATS_CHUNK_SIZE` files so this background pass never starves
 * the level the player is actively in.
 */
async function computeCodebaseStats(tree: TreeNode): Promise<CodebaseStats> {
  const files = await flattenParsableFiles(tree);
  let linesOfCode = 0;
  let complexity = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const text = await readFileText(file.handle as FileSystemFileHandle);
      const parsed = await parseFile(file.name, text);
      if (parsed) {
        linesOfCode += parsed.linesOfCode;
        for (const entity of parsed.entities) complexity += entity.complexityScore;
      }
    } catch (err) {
      console.warn(`[codebase-stats] Failed to parse "${file.path}", skipping:`, err);
    }

    if (i % CODEBASE_STATS_CHUNK_SIZE === CODEBASE_STATS_CHUNK_SIZE - 1) {
      await yieldToMainThread();
    }
  }

  return { linesOfCode, complexity };
}

/** (Re)starts the whole-codebase background aggregation for a just-loaded
 * workspace — fire-and-forget, so it never delays `autoLaunchInitialLevel`.
 * A failed aggregation resolves to zeroed totals rather than a rejected
 * promise, so `withTimeout` only ever has to special-case "still running",
 * not "errored". */
function kickOffCodebaseStats(tree: TreeNode): void {
  codebaseStatsPromise = computeCodebaseStats(tree).catch((err) => {
    console.warn("[codebase-stats] Aggregation failed:", err);
    return { linesOfCode: 0, complexity: 0 };
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
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
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

/** Stop any running level and return the viewport to its initial state. */
function resetToFileTree(): void {
  activeEngine?.stop();
  activeEngine = null;
  activeHud = null;
  currentLevelPath = null;
  currentParsedFile = null;
  consoleSidebar.setHintsActive(false);

  // Hide (never remove) the canvas — see its doc comment. A display:none
  // element can't stay the fullscreen target, so this is also the one point
  // where leaving the game naturally ends fullscreen, rather than it dropping
  // mid-run on every level transition.
  canvas.hidden = true;
  for (const child of [...viewport.children]) {
    if (child !== canvas) child.remove();
  }

  const placeholder = document.createElement("p");
  placeholder.className = "muted";
  placeholder.innerHTML =
    'Select a file from the tree to build and enter its level.<br />' +
    "Reach the green <code>return</code> tile to win.";
  viewport.appendChild(placeholder);
}

// --- Campaign persistence (Continue Run) -----------------------------------

const SAVE_KEY = "codeenstein-campaign-save";
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
  armor: number;
  bullets: number;
  rockets: number;
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
    const save = JSON.parse(raw) as Partial<CampaignSave>;
    if (
      typeof save.workspaceName !== "string" ||
      typeof save.filePath !== "string" ||
      typeof save.health !== "number" ||
      typeof save.armor !== "number" ||
      typeof save.bullets !== "number" ||
      typeof save.rockets !== "number" ||
      typeof save.score !== "number" ||
      typeof save.weaponIndex !== "number" ||
      !Array.isArray(save.ownedWeapons) ||
      !save.ownedWeapons.every((i) => typeof i === "number")
    ) {
      return null;
    }
    return { ...save, levelIndex: typeof save.levelIndex === "number" ? save.levelIndex : 1 } as CampaignSave;
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
  continueButton.style.display = "none";
}

/** Save the current position + stats, if a level is actually running. */
function persistProgress(stats: EngineStats): void {
  if (!workspaceRootName || !currentLevelPath || workspaceIsRemote) return;
  saveCampaign({
    workspaceName: workspaceRootName,
    filePath: currentLevelPath,
    health: stats.health,
    armor: stats.armor,
    bullets: stats.bullets,
    rockets: stats.rockets,
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
 * same "never throw" philosophy as `loadCampaignSave`. A previously-saved
 * "extreme" is downgraded to "more" while `EXTREME_GORE_ENABLED` is off, since
 * that option is no longer in the dropdown for the player to see/change. */
function loadGoreLevel(): GoreLevel {
  try {
    const raw = localStorage.getItem(GORE_KEY);
    if (raw === "extreme" && !EXTREME_GORE_ENABLED) return "more";
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
    const hash = await hashRun(JSON.stringify(parsed), campaignName());
    const levelName = path.split("/").pop() ?? path;
    const codebaseStats = await withTimeout(codebaseStatsPromise, CODEBASE_STATS_WAIT_MS);
    await recordHighscore({
      score: stats.score,
      campaignName: campaignName(),
      levelName,
      levelsCleared,
      hash,
      achievedAt: Date.now(),
      replay: (await recorder?.finish()) ?? undefined,
      source: workspaceIsRemote ? "github" : undefined,
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
async function startReplay(entry: HighscoreEntry): Promise<void> {
  const payload = entry.replay;
  // Defensive, not just type-driven: this value round-tripped through
  // localStorage/JSON, so an entry saved before the replay system became
  // campaign-scoped could still be sitting there with the old single-level
  // shape (no `levels` array) despite what the type claims.
  if (!payload || payload.version !== 2 || !payload.levels?.length) return;

  // End any replay already playing before starting this one — otherwise its
  // own requestAnimationFrame loop keeps running orphaned (see
  // `stopActiveReplay`'s doc comment).
  stopActiveReplay?.();

  try {
    let tree: TreeNode;
    if (entry.source === "github") {
      // This run's workspace was fetched from GitHub, not picked off local
      // disk — re-fetch the same repo instead of prompting a local folder
      // picker, which would never match `entry.campaignName`'s recorded
      // `owner/repo` paths at all.
      const ref = parseGithubRepoInput(entry.campaignName);
      if (!ref) return; // campaign name doesn't parse back to a repo ref — nothing sane to fetch
      tree = await fetchGithubTree(ref);
    } else {
      const handle = await pickWorkspace();
      if (!handle) return; // user cancelled the picker
      tree = await readDirectoryTree(handle);
    }
    const files = await flattenParsableFiles(tree);

    // Tear down whatever's currently running/shown, same as launching any
    // other level — see `launchLevel`'s equivalent block. Done once, up
    // front — each level below just swaps the engine underneath it.
    activeEngine?.stop();
    for (const child of [...viewport.children]) {
      if (child !== canvas) child.remove();
    }
    const hint = document.createElement("p");
    hint.className = "map-caption";
    const controls = buildReplayControls();
    viewport.append(hint, controls.el);
    canvas.hidden = false;
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

    const teardown = (): void => {
      isReplaying = false;
      stopActiveReplay = null;
      cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onStopKey);
      resetToFileTree();
    };

    /** Ends the viewing with an on-screen explanation — every termination
     * path except a natural win/death, which already shows its own overlay
     * (see `buildEngineFor`'s handlers) and can go straight to `teardown`. */
    const endReplay = (reason: string): void => {
      if (!isReplaying) return;
      window.removeEventListener("keydown", onStopKey); // avoid double-handling Escape against the dialog's own listener
      hud.showReplayEnded(reason, teardown);
    };
    stopActiveReplay = teardown;

    const onStopKey = (e: KeyboardEvent): void => {
      if (e.code === "Escape") endReplay("Replay stopped.");
    };
    window.addEventListener("keydown", onStopKey);

    const updateHint = (): void => {
      const segment = currentSegment;
      hint.textContent = segment
        ? `Watching replay: level ${levelIndex}/${payload.levels.length} — ${segment.filePath} — Esc to stop`
        : "";
    };

    /** Builds a fresh engine for `segment`/`parsed`, wired the same way for
     * both a normal level load and an in-place restart (seeking backward). */
    const buildEngineFor = (segment: ReplayLevelSegment, parsed: ParsedFile): void => {
      const map = mapGenerator.generate(parsed, segment.bonusLevel);
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
          onGameOver: () => {
            levelEnded = true;
            hud.showKernelPanic(teardown);
          },
          onWin: () => {
            levelEnded = true;
            if (levelIndex >= payload.levels.length) hud.showBuildSuccessful(teardown);
            else advanceLevel();
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
      if (levelIndex >= payload.levels.length) {
        endReplay("Replay ended — ran out of recorded levels.");
        return;
      }
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

    advanceLevel();
  } catch (err) {
    console.error("[replay] Failed to start replay:", err);
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
  setPaused: (paused: boolean) => void;
  setSpeedLabel: (label: string) => void;
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

  el.append(seekBack, playPause, seekForward, speedDown, speedLabel, speedUp);

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
    setPaused: (paused) => {
      playPause.textContent = paused ? "▶" : "⏸";
    },
    setSpeedLabel: (label) => {
      speedLabel.textContent = label;
    },
  };
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
