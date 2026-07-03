/// <reference types="vite/client" />

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
