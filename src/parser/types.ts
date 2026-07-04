// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Language-agnostic parser contract.
 *
 * This module defines the ONLY shape the rest of the engine is allowed to know
 * about. Concrete adapters (PHP, and future languages) hide Tree-sitter — or
 * any other parsing technology — entirely behind `CodeParserAdapter.parse()`,
 * which returns plain, serializable `ParsedFile` JSON.
 *
 * Nothing outside `src/parser/` should import `web-tree-sitter`.
 */

/** Kind of source entity we surface to the map generator. */
export type EntityKind = "function" | "method" | "class" | "interface" | "trait";

/** A single function/method/class/... discovered in a source file. */
export interface CodeEntity {
  /** Declared name, or "<anonymous>" when the grammar has none. */
  name: string;
  kind: EntityKind;
  /** 1-based, inclusive line where the entity starts. */
  startLine: number;
  /** 1-based, inclusive line where the entity ends. */
  endLine: number;
  /**
   * Approximate cyclomatic complexity: 1 + the number of decision points
   * (if/elseif, loops, switch cases, catch, ternary, logical && / ||) found
   * within the entity's body. Higher = harder "boss".
   */
  complexityScore: number;
}

/** Normalized, engine-facing result of parsing one source file. */
export interface ParsedFile {
  /** Language id of the adapter that produced this, e.g. "php". */
  language: string;
  /** Total number of lines in the file. */
  linesOfCode: number;
  /** Entities discovered, ordered by `startLine`. */
  entities: CodeEntity[];
}

/**
 * A parser for one language. Implementations must be safe to reuse across many
 * `parse()` calls (initialize expensive resources like WASM lazily and once).
 */
export interface CodeParserAdapter {
  /** Stable language id, e.g. "php". */
  readonly language: string;
  /** Lower-case file extensions (no dot) this adapter handles. */
  readonly extensions: readonly string[];
  /** Parse raw file text into normalized JSON. */
  parse(sourceText: string): Promise<ParsedFile>;
}
