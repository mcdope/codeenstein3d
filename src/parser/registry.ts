// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Parser registry: maps file extensions to language adapters.
 *
 * The engine calls `getParserForFilename()` / `parseFile()` and only ever sees
 * `ParsedFile` JSON. Adding a language means implementing `CodeParserAdapter`
 * and registering it here — no other part of the app changes.
 *
 * PHP and C keep bespoke, hand-written adapters (their grammars have quirks —
 * PHP's global-variable-at-`program`-scope detection, C's buried function
 * declarator — that a generic traversal can't capture precisely). Every other
 * bundled language goes through one `GenericParserAdapter`, driven by the
 * shared node-type vocabulary in `generic/vocabulary.ts` — see Task 23.
 */
import { PhpParserAdapter } from "./php/phpParser";
import { CParserAdapter } from "./c/cParser";
import { GENERIC_ADAPTERS } from "./generic/languages";
import { isSafeToParse } from "./security";
import type { CodeParserAdapter, ParsedFile } from "./types";

const ADAPTERS: CodeParserAdapter[] = [
  new PhpParserAdapter(),
  new CParserAdapter(),
  ...GENERIC_ADAPTERS,
];

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
 * Parse a file's text with the adapter for its name. Returns `null` — after
 * logging a `console.warn` — when no adapter handles the extension, the
 * content fails the binary/size safety check, or the adapter itself throws
 * (a malformed file, an unexpected grammar edge case, etc). Callers never
 * need their own try/catch: a file that can't be parsed just doesn't become a
 * level, it never crashes the map generator or the game loop.
 */
export async function parseFile(
  filename: string,
  sourceText: string,
): Promise<ParsedFile | null> {
  const adapter = getParserForFilename(filename);
  if (!adapter) return null;

  const safety = isSafeToParse(sourceText);
  if (!safety.ok) {
    console.warn(`[parser] Skipping "${filename}": ${safety.reason}`);
    return null;
  }

  try {
    return await adapter.parse(sourceText);
  } catch (err) {
    console.warn(`[parser] Skipping "${filename}": parse failed —`, err);
    return null;
  }
}
