// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import "./style.css";
import {
  isFileSystemAccessSupported,
  pickWorkspace,
  readDirectoryTree,
  readFileText,
  type TreeNode,
} from "./fs/workspace";
import { renderFileTree } from "./ui/fileTree";
import { isParsable, parseFile } from "./parser/registry";
import { MapGenerator } from "./map/mapGenerator";
import { RaycasterEngine } from "./engine/engine";
import { audio } from "./engine/audio";
import { GameHud } from "./ui/gameHud";
import type { ParsedFile } from "./parser/types";
import type { EngineCarryover, EngineStats } from "./engine/engine";

/** Internal render resolution; CSS scales it up for a chunky retro look. */
const SCENE_WIDTH = 640;
const SCENE_HEIGHT = 400;

const selectButton = requireElement<HTMLButtonElement>("#select-workspace");
const continueButton = requireElement<HTMLButtonElement>("#continue-run");
const workspaceName = requireElement<HTMLParagraphElement>("#workspace-name");
const fileTree = requireElement<HTMLElement>("#file-tree");
const viewport = requireElement<HTMLElement>("#viewport");

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
/** Name of the picked workspace root, for the campaign name and the save file.
 * The File System Access API only grants a handle to the picked directory
 * itself — there's no way to walk up to its parent — so the "or parent
 * directory if named 'src'" case from the spec isn't reachable in a browser
 * sandbox; a root literally named "src" just uses "src" as-is. */
let workspaceRootName: string | null = null;
/** Most recent stats reported by the running engine, used for the throttled
 * autosave and the `beforeunload` flush. */
let lastStats: EngineStats | null = null;
let lastSaveAt = 0;

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
    workspaceName.textContent = handle.name;

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
    workspaceName.textContent = handle.name;
    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });

    const match = flattenParsableFiles(tree).find((f) => f.path === save.filePath);
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
      console.log(`%c[continue] resuming at ${match.path}`, "color:#8effa0;font-weight:bold");
      launchLevel(match.path, parsed, { health: save.health, ammo: save.ammo, weaponIndex: save.weaponIndex });
    }
  } catch (err) {
    console.error("[continue] Failed to resume campaign:", err);
    workspaceName.textContent = err instanceof Error ? err.message : "Failed to resume campaign.";
    workspaceName.classList.add("error");
  }
});

window.addEventListener("beforeunload", () => {
  if (activeEngine && lastStats) persistProgress(lastStats);
});

/**
 * On file click: parse supported languages into normalized JSON and log that;
 * for everything else fall back to logging raw text.
 */
async function handleFileSelected(node: TreeNode): Promise<void> {
  if (node.kind !== "file") return;
  try {
    const text = await readFileText(node.handle as FileSystemFileHandle);

    if (isParsable(node.name)) {
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
 * entrypoint, checked in order across the whole tree — first match wins. C-
 * family languages don't get a reliable filename convention, so they also
 * fall back to a content-based check (`findEntrypointByMainFunction`) when no
 * name here matches anything in the workspace.
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

/** Extensions worth a content-based `main`-function scan (see
 * `findEntrypointByMainFunction`) — the C family, where the entrypoint can
 * live in any arbitrarily-named file. */
const MAIN_FUNCTION_EXTENSIONS = /\.(c|h|cpp|cc|cxx|hpp|hh|hxx|m|mm)$/i;

/** First parsable file anywhere in the tree whose name matches a standard
 * project-entrypoint convention, or `null` if none does. */
export function findEntrypointByName(tree: TreeNode): TreeNode | null {
  const files = flattenParsableFiles(tree);
  for (const candidate of ENTRYPOINT_FILENAMES) {
    const match = files.find((f) => f.name.toLowerCase() === candidate);
    if (match) return match;
  }
  return null;
}

/**
 * Fallback for the C family: no filename convention reliably marks the
 * entrypoint, so parse each C/C++/Objective-C file in tree order and return
 * the first one that actually defines a `main` function. A file that fails to
 * read or parse is just skipped, same as everywhere else in this app.
 */
export async function findEntrypointByMainFunction(tree: TreeNode): Promise<TreeNode | null> {
  const candidates = flattenParsableFiles(tree).filter((f) => MAIN_FUNCTION_EXTENSIONS.test(f.name));
  for (const file of candidates) {
    try {
      const text = await readFileText(file.handle as FileSystemFileHandle);
      const parsed = await parseFile(file.name, text);
      const hasMain = parsed?.entities.some(
        (e) => e.name === "main" && (e.kind === "function" || e.kind === "method"),
      );
      if (hasMain) return file;
    } catch (err) {
      console.error(`[entrypoint] Failed to scan "${file.path}" for main():`, err);
    }
  }
  return null;
}

/** The workspace's logical entrypoint, if any — see the two finder functions
 * above for the search order (filename convention, then a C-family main()
 * content scan). */
export async function findEntrypoint(tree: TreeNode): Promise<TreeNode | null> {
  return findEntrypointByName(tree) ?? (await findEntrypointByMainFunction(tree));
}

/**
 * Auto-start the very first level right after a workspace loads: prefer a
 * detected project entrypoint (see `findEntrypoint`) over just resolving the
 * first parsable file alphabetically/by tree order, though that remains the
 * fallback when no entrypoint is found. Does nothing if the workspace has no
 * parsable file at all — the sidebar is left for a manual pick as before.
 */
async function autoLaunchInitialLevel(tree: TreeNode): Promise<void> {
  const entry = await findEntrypoint(tree);
  const target = entry ?? flattenParsableFiles(tree)[0] ?? null;
  if (!target) return;

  try {
    const text = await readFileText(target.handle as FileSystemFileHandle);
    const parsed = await parseFile(target.name, text);
    if (parsed) {
      const how = entry ? "detected entrypoint" : "first file in tree order";
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
  const map = mapGenerator.generate(parsed);
  console.group(`[map] ${path}`);
  console.log(
    `${map.width}×${map.height} grid, ${map.rooms.length} room(s), ` +
      `${map.enemies.length} enemies, ${map.teleporters.length / 2} teleporter pair(s), ` +
      `exit @(${map.exit.x},${map.exit.y})`,
    map,
  );
  console.groupEnd();

  currentLevelPath = path;

  // Tear down any level already running before starting the new one.
  activeEngine?.stop();

  const canvas = document.createElement("canvas");
  canvas.width = SCENE_WIDTH;
  canvas.height = SCENE_HEIGHT;
  canvas.className = "scene-canvas";
  canvas.tabIndex = 0; // focusable so it can grab keyboard input on click

  const hint = document.createElement("p");
  hint.className = "map-caption";
  hint.textContent =
    `${path} — reach the green "return" tile to build · ` +
    `Click to capture mouse · W/S move, A/D strafe · Q/E or mouse turn · ` +
    `Shift to sprint · Click / Space to fire · 1 pistol / 2 shotgun · ` +
    `grab keys to open blue doors · step on a glowing pad to warp (goto) · ` +
    `avoid the acid and timed spikes · shoot spotted mines to disarm them from range · ` +
    `Tab for map · F for fullscreen · Esc to pause`;

  const hud = new GameHud();
  activeHud = hud;

  // The status bar is drawn natively on the canvas; only the end-of-run
  // overlay remains in the DOM.
  viewport.replaceChildren(canvas, hint, hud.overlay);
  // Grab keyboard focus immediately — without this, the very first WASD press
  // after a level (re)load is silently swallowed until the player clicks the
  // canvas themselves, which reads as "controls don't work" on every level
  // change (multi-level advance, retry after death, or a fresh manual pick).
  canvas.focus();

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
      onGameOver: () => {
        clearCampaignSave();
        hud.showKernelPanic(resetToFileTree);
      },
      onWin: (stats) => {
        hud.showCommitSummary(
          { linesRefactored: parsed.linesOfCode, bugsSquashed: stats.kills },
          () => void advanceToNextLevel(stats),
        );
      },
    },
    carryover,
  );

  const levelName = path.split("/").pop() ?? path;
  hud.showLevelStart(
    {
      campaign: campaignName(),
      levelName,
      roomCount: map.rooms.length,
      enemyCount: map.enemies.length,
    },
    () => activeEngine?.start(),
  );
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
    const next = findNextParsableFile(workspaceTree, afterPath);
    if (!next) break;

    try {
      const text = await readFileText(next.handle as FileSystemFileHandle);
      const parsed = await parseFile(next.name, text);
      if (parsed) {
        audio.playLevelComplete();
        console.log(`%c[level] ${currentLevelPath} cleared — advancing to ${next.path}`, "color:#37d24a;font-weight:bold");
        const carryover: EngineCarryover = { health: stats.health, ammo: stats.ammo, weaponIndex: stats.weaponIndex };
        // Persist immediately at the transition (not just the throttled
        // in-play autosave) so a tab closed right after advancing still
        // resumes at the new file rather than the one just cleared.
        saveCampaign({
          workspaceName: workspaceRootName ?? "",
          filePath: next.path,
          health: carryover.health,
          ammo: carryover.ammo,
          score: stats.score,
          weaponIndex: stats.weaponIndex,
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
  // resume point no longer means anything.
  clearCampaignSave();
  activeHud?.showBuildSuccessful(resetToFileTree);
}

/** Files parsable by a registered adapter, in the same depth-first,
 * directories-first order the sidebar renders them in. */
export function flattenParsableFiles(node: TreeNode): TreeNode[] {
  if (node.kind === "file") return isParsable(node.name) ? [node] : [];
  const out: TreeNode[] = [];
  for (const child of node.children ?? []) out.push(...flattenParsableFiles(child));
  return out;
}

/** The parsable file immediately after `afterPath` in tree order, or `null`
 * when `afterPath` is the last one (or wasn't found). */
function findNextParsableFile(tree: TreeNode, afterPath: string): TreeNode | null {
  const files = flattenParsableFiles(tree);
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

  const placeholder = document.createElement("p");
  placeholder.className = "muted";
  placeholder.innerHTML =
    'Select a file from the tree to build and enter its level.<br />' +
    "Reach the green <code>return</code> tile to win.";
  viewport.replaceChildren(placeholder);
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
  ammo: number;
  score: number;
  weaponIndex: number;
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
      typeof save.ammo !== "number" ||
      typeof save.score !== "number" ||
      typeof save.weaponIndex !== "number"
    ) {
      return null;
    }
    return save as CampaignSave;
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
  if (!workspaceRootName || !currentLevelPath) return;
  saveCampaign({
    workspaceName: workspaceRootName,
    filePath: currentLevelPath,
    health: stats.health,
    ammo: stats.ammo,
    score: stats.score,
    weaponIndex: stats.weaponIndex,
  });
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
