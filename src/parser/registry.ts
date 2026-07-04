// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Parser registry: maps file extensions to language adapters.
 *
 * The engine calls `getParserForFilename()` / `parseFile()` and only ever sees
 * `ParsedFile` JSON. Adding a language means implementing `CodeParserAdapter`
 * and registering it here — no other part of the app changes.
 */
import { PhpParserAdapter } from "./php/phpParser";
import type { CodeParserAdapter, ParsedFile } from "./types";

const ADAPTERS: CodeParserAdapter[] = [new PhpParserAdapter()];

// extension (lower-case, no dot) -> adapter
const BY_EXTENSION = new Map<string, CodeParserAdapter>();
for (const adapter of ADAPTERS) {
  for (const ext of adapter.extensions) {
    BY_EXTENSION.set(ext.toLowerCase(), adapter);
  }
}

/** Lower-case extension without the dot, or "" if the name has none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** The adapter that handles this filename, or `null` if unsupported. */
export function getParserForFilename(filename: string): CodeParserAdapter | null {
  return BY_EXTENSION.get(extensionOf(filename)) ?? null;
}

/** True when some adapter can parse this filename. */
export function isParsable(filename: string): boolean {
  return BY_EXTENSION.has(extensionOf(filename));
}

/**
 * Parse a file's text with the adapter for its name. Returns `null` when no
 * adapter handles the extension.
 */
export async function parseFile(
  filename: string,
  sourceText: string,
): Promise<ParsedFile | null> {
  const adapter = getParserForFilename(filename);
  return adapter ? adapter.parse(sourceText) : null;
}
