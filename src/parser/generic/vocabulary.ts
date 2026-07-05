// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Cross-language Tree-sitter node-type vocabulary, shared by every
 * `GenericParserAdapter` instance (see `genericParser.ts`).
 *
 * Every grammar we bundle names its nodes slightly differently, but the same
 * handful of concepts (a function-like declaration, a class-like container, a
 * branch, a loop, a goto/label pair) recur across almost all of them. Rather
 * than writing bespoke imperative extraction code per language (as the C and
 * PHP adapters do, where the grammar's quirks genuinely require it — see
 * `cParser.ts`/`phpParser.ts`), this module is one flat, merged table of node
 * type name -> meaning, verified against each bundled grammar's real
 * `node-types.json`. `Node.descendantsOfType()` on a type name that doesn't
 * exist in a given grammar simply returns nothing, so one shared table can be
 * run against any language's tree with no per-language branching in the
 * traversal code itself.
 *
 * Precision note: this is a best-effort mapping (per Task 23's "generalized
 * ... wherever possible"), not a 1:1 replacement for a hand-tuned adapter.
 * Some constructs (e.g. Go's `type Foo struct{}`, C-style buried function
 * declarators) are intentionally not captured — see inline notes below.
 */
import type { Node } from "web-tree-sitter";
import type { CodeEntity, EntityKind, GotoLink } from "../types";
import { resolveGotos, type RawGotoRef } from "../astUtils";

/**
 * Node types that define a function/method/class-like entity, mapped to their
 * normalized kind. Merged from `node-types.json` of every bundled grammar
 * (bash, cpp, c-sharp, go, java, javascript, objc, python, ruby, rust, scala,
 * typescript, tsx). Deliberately excludes generic container/root node types
 * (e.g. Python's and Ruby's root node happens to be literally typed
 * `"module"` in different grammars — `GenericParserAdapter` also guards
 * against matching the tree's own root node, but the surest fix is not to put
 * anything that ambiguous in this table at all).
 */
export const ENTITY_NODE_TYPES: Record<string, EntityKind> = {
  // --- function-like ---
  function_definition: "function", // C++, Python, Bash, ObjC, Scala
  function_declaration: "function", // JS, TS, Go, Scala
  generator_function_declaration: "function", // JS, TS
  function_item: "function", // Rust (refined to "method" inside `impl`/`trait` blocks)
  function_signature: "function", // TS/Scala ambient/abstract signature (no body)
  function_signature_item: "function", // Rust trait method declaration (no body)
  local_function_statement: "function", // C# local function

  // --- method-like ---
  method_definition: "method", // JS, TS, ObjC
  method_declaration: "method", // Java, Go, C#
  constructor_declaration: "method", // Java, C#
  method: "method", // Ruby `def`
  singleton_method: "method", // Ruby `def self.foo`

  // --- class-like ---
  class_declaration: "class", // JS, TS, C#, Java
  class: "class", // JS/TS anonymous class expression
  class_specifier: "class", // C++
  class_definition: "class", // Python, Scala
  abstract_class_declaration: "class", // TS
  class_interface: "class", // ObjC @interface
  class_implementation: "class", // ObjC @implementation
  struct_specifier: "class", // C++, ObjC
  struct_declaration: "class", // C#
  struct_item: "class", // Rust
  enum_declaration: "class", // C#, Java, TS
  enum_specifier: "class", // C++, ObjC
  enum_item: "class", // Rust
  enum_definition: "class", // Scala
  record_declaration: "class", // Java, C#

  // --- interface-like ---
  interface_declaration: "interface", // Java, C#, TS
  protocol_declaration: "interface", // ObjC @protocol

  // --- trait-like ---
  trait_item: "trait", // Rust
  trait_definition: "trait", // Scala
};

/**
 * Control-flow node types that each add one decision point (cyclomatic
 * complexity = 1 + count). Deliberately excludes pure block-delimiter nodes
 * that don't represent a branch (e.g. Ruby's `do`/`do_block`, which is just
 * iterator-block syntax, not a decision).
 */
export const DECISION_NODE_TYPES: readonly string[] = [
  // if / elif / unless
  "if_statement",
  "if_expression",
  "if_clause",
  "elif_clause",
  "elsif",
  "if",
  "unless",
  "if_guard",
  "unless_guard",
  "if_modifier",
  "unless_modifier",
  "guard",
  // for / while
  "for_statement",
  "for_expression",
  "for_in_statement",
  "for_in_clause",
  "for_clause",
  "c_style_for_statement",
  "enhanced_for_statement",
  "for_range_loop",
  "while_statement",
  "while_expression",
  "while_modifier",
  "for",
  "while",
  // do-while
  "do_statement",
  "do_while_expression",
  "do_group",
  // switch / match / case
  "switch_statement",
  "switch_expression",
  "switch_case",
  "switch_expression_arm",
  "switch_section",
  "case_statement",
  "case_item",
  "case_clause",
  "case_pattern",
  "case_class_pattern",
  "expression_case",
  "type_case",
  "communication_case",
  "default_case",
  "match_arm",
  "match_expression",
  "match_statement",
  "case_match",
  "case",
  "when",
  "when_clause",
  // exceptions
  "catch_clause",
  "except_clause",
  "rescue",
  "rescue_modifier",
  // ternary / conditional
  "conditional_expression",
  "ternary_expression",
  "conditional_type",
  "conditional",
];

/** Short-circuiting logical operators counted as decision points, merged
 * across every bundled grammar's `binary_expression`-style operator text. */
export const LOGICAL_OPERATORS = new Set([
  "&&",
  "||",
  "and",
  "or",
  "xor",
  "??",
]);

/**
 * Block statement types that each deepen nesting depth. Narrower than
 * `DECISION_NODE_TYPES` — only "real" control-flow containers that can hold
 * further nested statements, not single-line modifiers/guards.
 */
export const NESTING_NODE_TYPES = new Set([
  "if_statement",
  "if_expression",
  "elif_clause",
  "elsif",
  "if",
  "unless",
  "for_statement",
  "for_expression",
  "for_in_statement",
  "for_in_clause",
  "c_style_for_statement",
  "enhanced_for_statement",
  "for_range_loop",
  "for",
  "while_statement",
  "while_expression",
  "while",
  "do_statement",
  "do_while_expression",
  "do_group",
  "switch_statement",
  "switch_expression",
  "match_expression",
  "match_statement",
  "case_match",
  "case",
]);

/** `goto`/label node types, merged across the C-family + Go bundled grammars
 * (the only ones in our set with a `goto`). */
export const GOTO_NODE_TYPE = "goto_statement";
export const LABEL_NODE_TYPE = "labeled_statement";

/** Node type suffixes/names treated as "this holds a plain identifier". */
const IDENTIFIER_LIKE = /(^|_)(identifier|name|constant|label_name)$/;

/**
 * Best-effort name for any declaration-shaped node: prefer the grammar's own
 * `name` field (present on the majority of the table above); otherwise fall
 * back to the first identifier-like child found in a shallow breadth-first
 * scan (handles grammars — e.g. ObjC's `function_definition` — that bury the
 * name a level or two down with no dedicated field).
 */
export function entityName(node: Node, maxDepth = 3): string {
  const viaField = node.childForFieldName("name")?.text;
  if (viaField) return viaField;

  let frontier: Node[] = [node];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const n of frontier) {
      for (const child of n.namedChildren) {
        if (IDENTIFIER_LIKE.test(child.type)) return child.text;
        next.push(child);
      }
    }
    frontier = next;
  }
  return "<anonymous>";
}

/** Same fallback used to name a `goto`/label pair or a heuristic global. */
function labelRef(node: Node): string | null {
  const viaField = node.childForFieldName("label")?.text;
  if (viaField) return viaField;
  for (const child of node.namedChildren) {
    if (IDENTIFIER_LIKE.test(child.type)) return child.text;
  }
  return null;
}

/** Resolve `goto`/label pairs found anywhere under `root`, using the shared
 * `GOTO_NODE_TYPE`/`LABEL_NODE_TYPE` names. Returns `[]` for grammars with no
 * such nodes (the vast majority — only the C-family and Go have `goto`). */
export function extractGotos(root: Node): GotoLink[] {
  const gotos: RawGotoRef[] = [];
  for (const node of root.descendantsOfType(GOTO_NODE_TYPE)) {
    const label = labelRef(node);
    if (label) gotos.push({ label, line: node.startPosition.row + 1 });
  }
  const labels: RawGotoRef[] = [];
  for (const node of root.descendantsOfType(LABEL_NODE_TYPE)) {
    const label = labelRef(node);
    if (label) labels.push({ label, line: node.startPosition.row + 1 });
  }
  return resolveGotos(gotos, labels);
}

/** Top-level declaration/assignment-shaped node types treated as a possible
 * global variable, once already-captured entity types and import/preprocessor
 * noise are excluded. */
const GLOBAL_CONTAINER = /(declaration|assignment|_item)$/;
const GLOBAL_EXCLUDE = /^(import|using|package|preproc|include|export)/;

/** Position key used to recognize "this exact node was already captured as a
 * real entity" — see `genericGlobals`'s `consumed` parameter. */
export function positionKey(node: Node): string {
  return `${node.startIndex}:${node.endIndex}`;
}

/**
 * Heuristic global-variable detection: direct children of the file's root
 * node that look like a variable declaration/assignment and aren't already
 * one of `ENTITY_NODE_TYPES` (so a top-level `const Foo = class {}` isn't
 * double-counted as both a class and a global, for example). Best-effort —
 * languages whose top-level variable syntax doesn't match the shared pattern
 * simply yield no globals, which just means no acid-hazard rooms for that
 * file rather than a crash or incorrect data.
 *
 * `consumed`/`entityTypeNames` guard against a subtler duplication: some
 * languages wrap an already-captured entity one level deeper than the
 * top-level child itself — Go's `type Foo struct{}` is a `type_spec` nested
 * inside a `type_declaration`, JS's `const foo = () => {}` is a
 * `variable_declarator` nested inside a `lexical_declaration` (see
 * `refinements.ts`'s `extraEntityTypes`). If the top-level container's
 * subtree already contains a node that was captured as a real entity, it's
 * skipped here rather than counted a second time as a global.
 */
export function genericGlobals(
  root: Node,
  consumed: ReadonlySet<string>,
  entityTypeNames: readonly string[],
): CodeEntity[] {
  const out: CodeEntity[] = [];
  for (const child of root.namedChildren) {
    if (child === root) continue;
    let target = child;
    if (child.type === "expression_statement" && child.namedChildCount === 1) {
      const inner = child.namedChild(0);
      if (inner) target = inner;
    }
    if (ENTITY_NODE_TYPES[target.type] || ENTITY_NODE_TYPES[child.type]) continue;
    if (!GLOBAL_CONTAINER.test(target.type) || GLOBAL_EXCLUDE.test(target.type)) continue;
    if (containsConsumedEntity(target, entityTypeNames, consumed)) continue;

    const name = labelRef(target) ?? entityNameQuiet(target);
    if (!name) continue;
    out.push({
      name,
      kind: "global",
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      complexityScore: 1,
      nestingDepth: 0,
    });
  }
  return out;
}

function containsConsumedEntity(
  node: Node,
  entityTypeNames: readonly string[],
  consumed: ReadonlySet<string>,
): boolean {
  for (const match of node.descendantsOfType([...entityTypeNames])) {
    if (match.isNamed && consumed.has(positionKey(match))) return true;
  }
  return false;
}

/** Like `entityName`, but returns `null` instead of "<anonymous>" so callers
 * can skip globals they can't confidently name rather than inventing rooms
 * called "<anonymous>". */
function entityNameQuiet(node: Node): string | null {
  const name = entityName(node);
  return name === "<anonymous>" ? null : name;
}
