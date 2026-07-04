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
import { GameHud } from "./ui/gameHud";
import type { ParsedFile } from "./parser/types";

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
    workspaceName.textContent = handle.name;

    renderFileTree(fileTree, tree, { onSelectFile: handleFileSelected });
    console.info(`[workspace] Loaded "${handle.name}"`, tree);
  } catch (err) {
    console.error("[workspace] Failed to read workspace:", err);
    workspaceName.textContent =
      err instanceof Error ? err.message : "Failed to read workspace.";
    workspaceName.classList.add("error");
  }
});

/**
 * On file click: parse supported languages (currently PHP) into normalized
 * JSON and log that; for everything else fall back to logging raw text.
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

/** Generate a level from parsed JSON and start the raycaster in the viewport. */
function launchLevel(path: string, parsed: ParsedFile): void {
  const map = mapGenerator.generate(parsed);
  console.group(`[map] ${path}`);
  console.log(
    `${map.width}×${map.height} grid, ${map.rooms.length} room(s), ` +
      `${map.enemies.length} enemies, exit @(${map.exit.x},${map.exit.y})`,
    map,
  );
  console.groupEnd();

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
    `Click to capture mouse · W/S move · A/D or mouse turn · ` +
    `Click / Space to fire · 1 pistol / 2 shotgun · avoid the acid · Esc releases mouse`;

  const hud = new GameHud();

  viewport.replaceChildren(canvas, hint, hud.bar, hud.overlay);

  activeEngine = new RaycasterEngine(canvas, map, {
    onStats: (stats) => hud.update(stats),
    onGameOver: () => hud.showKernelPanic(resetToFileTree),
    onWin: () => hud.showBuildSuccessful(resetToFileTree),
  });
  activeEngine.start();
}

/** Stop any running level and return the viewport to its initial state. */
function resetToFileTree(): void {
  activeEngine?.stop();
  activeEngine = null;

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
