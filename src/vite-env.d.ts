// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/// <reference types="vite/client" />

/** Build timestamp (`YYYY-MM-DD HH:MM`, local to the machine that ran the
 * build), injected via `vite.config.ts`'s `define` — see `document.title`'s
 * assignment in `main.ts`. */
declare const __BUILD_TIME__: string;

/** `HEAD`'s exact git tag if it has one, otherwise its short commit hash
 * (or "unknown" with no git available) — injected via `vite.config.ts`'s
 * `define`, see `document.title`'s assignment in `main.ts`. */
declare const __BUILD_REF__: string;

// Minimal ambient declarations for the File System Access API.
//
// The core handle interfaces (FileSystemDirectoryHandle, FileSystemFileHandle,
// FileSystemHandle) already ship in TypeScript's lib.dom.d.ts. The entry-point
// `showDirectoryPicker()` is not yet in the standard lib, so we declare just
// that here rather than pulling in an extra @types dependency.
//
// See: https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker

interface DirectoryPickerOptions {
  /** Suggested starting location, e.g. "documents" or a well-known dir id. */
  id?: string;
  startIn?: FileSystemHandle | string;
  /** "read" (default) or "readwrite". We only ever read. */
  mode?: "read" | "readwrite";
}

interface Window {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions,
  ) => Promise<FileSystemDirectoryHandle>;
}

// The async-iterable accessors on FileSystemDirectoryHandle are not present in
// every TypeScript DOM lib version, so declare them here.
type FileSystemHandleUnion = FileSystemDirectoryHandle | FileSystemFileHandle;

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandleUnion>;
  keys(): AsyncIterableIterator<string>;
  entries(): AsyncIterableIterator<[string, FileSystemHandleUnion]>;
}
