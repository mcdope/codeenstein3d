// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-memory File System Access API test double, covering exactly the surface
 * `src/fs/workspace.ts` calls: `handle.name`, `handle.kind`, a directory's
 * async-iterable `values()`, and a file's `getFile()` returning a
 * `{ text() }`-shaped object. Not backed by a real OPFS directory (unlike the
 * Playwright scripts' `showDirectoryPicker` stub) — there's no real browser
 * page here to inject into, so a plain nested-object tree stands in directly.
 */

export interface FakeFileTree {
  [name: string]: string | FakeFileTree;
}

export class FakeFileSystemFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    private readonly content: string,
  ) {}

  async getFile(): Promise<{ text(): Promise<string> }> {
    const content = this.content;
    return { text: async () => content };
  }
}

export class FakeFileSystemDirectoryHandle {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    private readonly tree: FakeFileTree,
  ) {}

  async *values(): AsyncGenerator<FakeFileSystemFileHandle | FakeFileSystemDirectoryHandle> {
    for (const [entryName, entry] of Object.entries(this.tree)) {
      yield typeof entry === "string"
        ? new FakeFileSystemFileHandle(entryName, entry)
        : new FakeFileSystemDirectoryHandle(entryName, entry);
    }
  }
}

/** Builds a fake root directory handle from a plain nested-object tree, e.g.
 * `{ "src": { "main.c": "int main() {}" } }`. */
export function fakeDirectoryHandle(name: string, tree: FakeFileTree): FakeFileSystemDirectoryHandle {
  return new FakeFileSystemDirectoryHandle(name, tree);
}
