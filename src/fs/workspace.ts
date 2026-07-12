// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Workspace access via the File System Access API.
 *
 * Local-first by design: every read goes directly against the raw local file
 * system through user-granted `FileSystemHandle`s. There is no virtual device,
 * no in-memory mock, and no network layer anywhere in this module.
 */

/**
 * Structural subset of `FileSystemFileHandle` that `readFileText` actually
 * needs — just enough for a non-local source (see `src/fs/github.ts`) to
 * stand in for a real handle without satisfying the full browser API surface
 * (`kind`, `name`, `isSameEntry`, `createWritable`, …), which a fetched-over-
 * the-network file has no real backing for.
 */
export interface RemoteFileHandle {
  getFile(): Promise<{ text(): Promise<string> }>;
}

/** A node in the workspace file tree. */
export interface TreeNode {
  name: string;
  /** Path relative to the workspace root, using "/" separators. */
  path: string;
  kind: "file" | "directory";
  handle: FileSystemFileHandle | FileSystemDirectoryHandle | RemoteFileHandle;
  /** Populated for directories; undefined for files. */
  children?: TreeNode[];
}

/**
 * Directory names (matched case-insensitively) skipped while walking the
 * tree. These are almost never "source" for our purposes and can contain
 * tens of thousands of entries, which would make the picker unusable on a
 * real project. Exported so `src/fs/github.ts` applies the exact same
 * skip-list when building a tree from a remote repo instead of a local
 * directory.
 */
export const IGNORED_DIRECTORIES = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".idea",
  ".vscode",
  "vendor",
  "__pycache__",
  "test",
  "tests",
  "__tests__",
]);

/** True when `name` matches an `IGNORED_DIRECTORIES` entry, regardless of case. */
export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name.toLowerCase());
}

/**
 * Matches individual test files that sit next to real source rather than
 * inside one of the `IGNORED_DIRECTORIES` (this very repo's own
 * `workspace.test.ts` is exactly this shape): `foo.test.ts`/`foo.spec.js`
 * (JS/TS/etc.), `test_foo.py`/`foo_test.go` (Python/Go), `foo_spec.rb`
 * (Ruby/RSpec). Case-insensitive — these separator-delimited conventions
 * don't collide with real words.
 */
const TEST_FILE_PATTERN_CI = /(?:^test[_-].+|.+[_.](?:tests?|specs?))\.[^.]+$/i;

/**
 * Matches `FooTest.java`/`FooTests.cs`-style suffixes (Java/C#/Scala).
 * Deliberately case-sensitive on the capital "Test" so real words like
 * "Contest.java" or "Latest.php" aren't caught.
 */
const TEST_FILE_PATTERN_CS = /.+Tests?\.[^.]+$/;

/** True when `name` looks like a colocated test file rather than real source. */
export function isIgnoredFileName(name: string): boolean {
  return TEST_FILE_PATTERN_CI.test(name) || TEST_FILE_PATTERN_CS.test(name);
}

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
      if (isIgnoredDirectoryName(entry.name)) continue;
      children.push(await readDirectoryTree(entry, path));
    } else {
      if (isIgnoredFileName(entry.name)) continue;
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

/** Directories-first, then alphabetical (case-insensitive) — shared with
 * `src/fs/github.ts` so a remote tree sorts identically to a local one. */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Read a file handle's contents as UTF-8 text. */
export async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}
