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

/** Interpreter basename (from a `#!` shebang line) -> the registered
 * extension whose adapter should parse it. Only maps interpreters onto
 * extensions some adapter above already claims — this never grows the set of
 * parsable languages, it just lets an existing one match a file that has no
 * extension of its own (a common shape for shebang scripts). */
const SHEBANG_INTERPRETERS: Record<string, string> = {
  sh: "sh", bash: "sh", dash: "sh", zsh: "sh", ksh: "sh",
  python: "py", python2: "py", python3: "py",
  ruby: "rb",
  php: "php",
  node: "js", nodejs: "js",
};

/** Best-effort interpreter -> extension guess from a leading `#!` line, e.g.
 * `#!/usr/bin/env python3` or `#!/bin/bash`. `null` when the text has no
 * shebang or names an interpreter nothing here recognizes. */
function shebangExtension(sourceText: string): string | null {
  const newline = sourceText.indexOf("\n");
  const firstLine = (newline === -1 ? sourceText : sourceText.slice(0, newline)).trimEnd();
  if (!firstLine.startsWith("#!")) return null;

  const tokens = firstLine.slice(2).trim().split(/\s+/);
  // `#!/usr/bin/env python3` names the real interpreter as the second token;
  // every other form (`#!/bin/bash`) names it directly as the path itself.
  // `?? ""` below is unreachable defensive code, not a real fallback:
  // `String.prototype.split()` always returns at least one element, even for
  // an empty string, so `tokens[0]` can never actually be `undefined`.
  /* v8 ignore next */
  const interpreterPath = /(^|\/)env$/.test(tokens[0] ?? "") ? tokens[1] : tokens[0];
  if (!interpreterPath) return null;

  // Same reasoning as above: `interpreterPath` is already known non-empty
  // (guarded above), so `.split("/")` always yields >=1 element and `.pop()`
  // can never be `undefined` — `?? ""` is unreachable.
  /* v8 ignore next */
  const basename = interpreterPath.split("/").pop() ?? "";
  // Strip a trailing version suffix so "python3.11" / "bash5" still match.
  const name = basename.toLowerCase().replace(/[\d.]+$/, "");
  return SHEBANG_INTERPRETERS[basename.toLowerCase()] ?? SHEBANG_INTERPRETERS[name] ?? null;
}

/**
 * The adapter that handles this filename, or `null` if unsupported. When the
 * filename has no extension and `sourceText` is given, falls back to sniffing
 * a `#!` shebang line (see `shebangExtension`) — the only way an extensionless
 * script (`myscript` starting `#!/usr/bin/env python3`) is ever recognized.
 */
export function getParserForFilename(filename: string, sourceText?: string): CodeParserAdapter | null {
  const ext = extensionOf(filename);
  if (ext) return BY_EXTENSION.get(ext) ?? null;
  if (sourceText === undefined) return null;

  const shebangExt = shebangExtension(sourceText);
  if (!shebangExt) return null;
  // Every `SHEBANG_INTERPRETERS` value names an extension some adapter above
  // already registers (see the object's own doc comment) — `?? null` is
  // unreachable defensive code guarding that invariant, not a real fallback.
  /* v8 ignore next */
  return BY_EXTENSION.get(shebangExt) ?? null;
}

/** True when some adapter can parse this filename (see
 * `getParserForFilename` for the extension/shebang lookup rules). */
export function isParsable(filename: string, sourceText?: string): boolean {
  return getParserForFilename(filename, sourceText) !== null;
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
  const adapter = getParserForFilename(filename, sourceText);
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
