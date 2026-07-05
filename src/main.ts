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

if (!isFileSystemAccessSupported()) {
  selectButton.disabled = true;
  workspaceName.textContent =
    "This browser does not support the File System Access API. Use Chrome, Edge, or Brave.";
  workspaceName.classList.add("error");
}

selectButton.addEventListener("click", async () => {
  try {
    const handle = await pickWorkspace();
    if (!handle) return; // user cancelled the picker

    workspaceName.textContent = "Reading workspace…";
    workspaceName.classList.remove("error");

    const tree = await readDirectoryTree(handle);
    workspaceTree = tree;
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
 * Generate a level from parsed JSON and start the raycaster in the viewport.
 * `carryover` (health/ammo from a just-cleared level) is passed when this is
 * a multi-level progression rather than a fresh pick from the file tree.
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
    `Tab for map · Esc releases mouse`;

  const hud = new GameHud();
  activeHud = hud;

  // The status bar is drawn natively on the canvas; only the end-of-run
  // overlay remains in the DOM.
  viewport.replaceChildren(canvas, hint, hud.overlay);

  activeEngine = new RaycasterEngine(
    canvas,
    map,
    {
      onGameOver: () => hud.showKernelPanic(resetToFileTree),
      onWin: (stats) => void advanceToNextLevel(stats),
    },
    carryover,
  );
  activeEngine.start();
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
        launchLevel(next.path, parsed, { health: stats.health, ammo: stats.ammo });
        return;
      }
    } catch (err) {
      console.error(`[level] Failed to load "${next.path}", skipping to the next file:`, err);
    }

    afterPath = next.path;
  }

  // No more files left to try — show the normal end-of-run screen rather than
  // leaving the player stuck on a frozen frame.
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

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing required element: ${selector}`);
  return el;
}
