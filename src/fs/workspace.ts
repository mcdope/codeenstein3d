// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Workspace access via the File System Access API.
 *
 * Local-first by design: every read goes directly against the raw local file
 * system through user-granted `FileSystemHandle`s. There is no virtual device,
 * no in-memory mock, and no network layer anywhere in this module.
 */

/** A node in the workspace file tree. */
export interface TreeNode {
  name: string;
  /** Path relative to the workspace root, using "/" separators. */
  path: string;
  kind: "file" | "directory";
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  /** Populated for directories; undefined for files. */
  children?: TreeNode[];
}

/**
 * Directory names skipped while walking the tree. These are almost never
 * "source" for our purposes and can contain tens of thousands of entries,
 * which would make the picker unusable on a real project.
 */
const IGNORED_DIRECTORIES = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".idea",
  ".vscode",
  "vendor",
  "__pycache__",
]);

/** True when this browser exposes the File System Access API we rely on. */
export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/**
 * Prompt the user to pick a local directory. Resolves to the granted handle,
 * or `null` if the user cancels the picker. `id` lets the browser remember a
 * separate "last used" starting location per picker purpose (workspace vs.
 * BGM folder — see `pickWorkspace`/main.ts's BGM folder button — so picking
 * one doesn't reset the other's starting directory).
 */
export async function pickDirectory(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) {
    throw new Error(
      "The File System Access API is not available in this browser. " +
        "Use a Chromium-based browser (Chrome, Edge, Brave) over HTTPS or localhost.",
    );
  }

  try {
    return await window.showDirectoryPicker({ id, mode: "read" });
  } catch (err) {
    // The user dismissing the picker surfaces as an AbortError — treat as a
    // non-error cancellation rather than propagating.
    if (err instanceof DOMException && err.name === "AbortError") {
      return null;
    }
    throw err;
  }
}

/** Prompt the user to pick their source workspace — see `pickDirectory`. */
export async function pickWorkspace(): Promise<FileSystemDirectoryHandle | null> {
  return pickDirectory("codeenstein-workspace");
}

/**
 * Recursively walk a directory handle into a `TreeNode`. Entries are sorted
 * directories-first, then alphabetically (case-insensitive).
 */
export async function readDirectoryTree(
  handle: FileSystemDirectoryHandle,
  parentPath = "",
): Promise<TreeNode> {
  const path = parentPath ? `${parentPath}/${handle.name}` : handle.name;
  const children: TreeNode[] = [];

  for await (const entry of handle.values()) {
    if (entry.kind === "directory") {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      children.push(await readDirectoryTree(entry, path));
    } else {
      children.push({
        name: entry.name,
        path: `${path}/${entry.name}`,
        kind: "file",
        handle: entry,
      });
    }
  }

  children.sort(compareNodes);

  return { name: handle.name, path, kind: "directory", handle, children };
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Read a file handle's contents as UTF-8 text. */
export async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}
