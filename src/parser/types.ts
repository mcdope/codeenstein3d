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

/**
 * Kind of source entity we surface to the map generator. `function`/`method`
 * become enemies; `global` (a global variable) becomes a hazard room; the rest
 * are plain rooms.
 */
export type EntityKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "trait"
  | "global";

/** Access modifier of a method. `public` is the default when unspecified. */
export type Visibility = "public" | "private" | "protected";

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
  /**
   * Maximum nesting depth of control-flow blocks (nested if/for/while/…) inside
   * the entity. 0 = flat body. Drives labyrinth generation: deeply nested code
   * becomes a maze rather than an open room.
   */
  nestingDepth: number;
  /**
   * Access modifier, for methods. `private`/`protected` methods become
   * key-locked rooms. Undefined for non-methods (treated as public).
   */
  visibility?: Visibility;
  /**
   * Summary of every `switch`/`match` construct in this entity's body, or
   * `undefined` when it contains none. Source for "Switchboard" junction rooms
   * (`placeSwitchboards`): the entity's own room becomes the hub, with one
   * small dead-end room carved off its sides per case branch.
   */
  switchBranches?: SwitchBranchSummary;
  /**
   * Number of explicit allocation expressions in this entity's body
   * (`malloc`/`calloc`/`new`/`make`/large fixed-size array declarators — see
   * `countAllocations` in `astUtils.ts`). Absent when zero, and for entity
   * kinds with no body.
   *
   * Deliberately a raw *count*, not a "density" or an "is leaky" flag: the
   * threshold that decides whether this becomes an "Acid Overflow" room is a
   * gameplay-balance number, and lives next to `ELITE_COMPLEXITY_THRESHOLD` in
   * the map layer (`map/generation/acidOverflow.ts`) rather than here. This
   * layer stays purely descriptive.
   */
  allocations?: number;
}

/**
 * Aggregate summary of every `switch`/`match`/`case` construct found inside one
 * entity's body — see `CodeEntity.switchBranches`.
 *
 * Aggregated rather than one entry per switch statement on purpose: a function
 * with three small switches reads, structurally, as just as much of a branching
 * junction as one function with one big switch, and one hub per entity is the
 * only shape the map layer can place anyway — the hub *is* the entity's single
 * already-carved room.
 *
 * Note this counts the whole subtree, so a `class` entity's summary also covers
 * its methods' switches. Harmless: `placeSwitchboards` only ever considers
 * `function`/`method` rooms, exactly like `spawnEnemies`.
 */
export interface SwitchBranchSummary {
  /** Number of non-default case branches (`case`/`when`/`match_arm`/…). */
  caseCount: number;
  /** Whether any of the aggregated switches has a `default`/`else`/`_`/`*`
   * catch-all branch. */
  hasDefault: boolean;
}

/**
 * One `try`/`catch`/`finally` construct (or `begin`/`rescue`/`ensure`, or
 * `try`/`except`/`finally`) found in a source file. The map generator turns
 * each into a sequential 3-part "Exception Handling Zone" hanging off whichever
 * room contains `startLine`: a hazard-heavy `try` gauntlet, a `catch` alcove
 * with guaranteed restoration, then a safe `finally` room with guaranteed loot
 * (see `placeExceptionZones`).
 */
export interface ExceptionZoneTrigger {
  /** 1-based, inclusive line where the `try` starts. */
  startLine: number;
  /** 1-based, inclusive line where the whole construct ends. */
  endLine: number;
  /** How many catch/except/rescue clauses are attached; 0 for try/finally. */
  catchCount: number;
  /** Whether a `finally`/`ensure` clause is present. */
  hasFinally: boolean;
}

/**
 * One resolved `goto label;` → `label:` jump found in a source file. The map
 * generator turns each of these into a bidirectional teleporter pad pair.
 */
export interface GotoLink {
  /** The label name (debug/HUD display only). */
  label: string;
  /** 1-based line of the `goto label;` statement. */
  gotoLine: number;
  /** 1-based line of the `label:` target. */
  labelLine: number;
}

/**
 * A source comment large enough to be worth surfacing as a "lore terminal"
 * (see `placeLoreTerminals` in `mapGenerator.ts`). Raw comment delimiters
 * (`//`, `/* *\/`, `#`, …) are kept as-is rather than stripped, since the
 * in-game overlay is meant to read like an artifact of the real source.
 */
export interface CodeComment {
  text: string;
  /** 1-based, inclusive start line. */
  startLine: number;
  /** 1-based, inclusive end line. */
  endLine: number;
}

/**
 * A code pattern the map generator turns into a hidden "secret room" behind a
 * fake wall (see `placeSecretRooms`): unreachable code after a `return`, an
 * empty/swallowed catch block, a deprecation marker, a commented-out code
 * block, or a magic-number/blob literal.
 */
export type SecretTriggerKind =
  | "deadCode"
  | "emptyCatch"
  | "deprecated"
  | "commentedCode"
  | "magicBlob";

/** One occurrence of a `SecretTriggerKind` pattern found in a source file. */
export interface SecretTrigger {
  kind: SecretTriggerKind;
  /** 1-based, inclusive start line of the triggering span. */
  startLine: number;
  /** 1-based, inclusive end line of the triggering span. */
  endLine: number;
}

/** Normalized, engine-facing result of parsing one source file. */
export interface ParsedFile {
  /** Language id of the adapter that produced this, e.g. "php". */
  language: string;
  /** Total number of lines in the file. */
  linesOfCode: number;
  /** Entities discovered, ordered by `startLine`. */
  entities: CodeEntity[];
  /** `goto`/label jumps resolved within the file; a goto with no matching
   * label anywhere in the file is dropped rather than guessed at. */
  gotos: GotoLink[];
  /** Large comment blocks, source for in-game "lore terminals". */
  comments: CodeComment[];
  /** Code smells/patterns (dead code, empty catches, deprecation markers,
   * commented-out code, magic-number/blob literals), source for secret rooms. */
  secretTriggers: SecretTrigger[];
  /** `try`/`catch`/`finally` constructs, source for Exception Handling Zones.
   * Empty for languages whose grammar has no exception construct at all (Go,
   * Bash, Rust, and plain C — see `findExceptionZones`). */
  exceptionZones: ExceptionZoneTrigger[];
  /**
   * Number of top-level `import`/`#include`/`require`/`use` declarations — how
   * much third-party code this file leans on. Source for the "Vendor Depot"
   * supply alcoves carved off the spawn room.
   *
   * A plain scalar rather than a list: the depots attach to the spawn room,
   * which has nothing to do with *where* in the file an import sits, so line
   * numbers would be dead data.
   */
  importCount: number;
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
