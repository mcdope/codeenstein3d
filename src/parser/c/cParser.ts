// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * C implementation of `CodeParserAdapter`, backed by `tree-sitter-c`.
 *
 * Mirrors the PHP adapter: all Tree-sitter usage stays here and callers only
 * ever see normalized `ParsedFile` JSON. Functions (`function_definition`)
 * become entities (and therefore enemies); struct/union/enum *definitions* map
 * to the `class` kind (rooms, no enemy). Bare `declaration` nodes — function
 * prototypes and globals — are intentionally not entities: prototypes would
 * duplicate their definitions, and globals are a future "hazard" feature.
 */
import { Language, Parser, type Node } from "web-tree-sitter";
import cWasmUrl from "tree-sitter-c/tree-sitter-c.wasm?url";
import { initTreeSitter } from "../runtime";
import {
  codeSmellBonus,
  countAllocations,
  countDecisionPoints,
  countLines,
  countParameters,
  countTopLevelImports,
  extractLargeCommentsFromNodes,
  findCommentedOutCodeBlocksFromNodes,
  findDeadCodeAfterReturn,
  findDeprecationMarkers,
  findExceptionZones,
  findMagicNumberBlobs,
  maxNestingDepth,
  resolveGotos,
  summarizeSwitchBranches,
  type RawGotoRef,
} from "../astUtils";
import type { CodeEntity, CodeParserAdapter, EntityKind, ParsedFile } from "../types";

/** Block node whose direct children are a flat statement list — used to find
 * unreachable code after a `return` (see `findDeadCodeAfterReturn`). */
const BLOCK_NODE_TYPES = new Set(["compound_statement"]);
const RETURN_NODE_TYPES = new Set(["return_statement"]);

/** C has no exceptions/catch construct at all, so empty-catch detection is
 * skipped entirely for this adapter (see `findEmptyCatchBlocks`'s no-op empty
 * input case). Deprecation markers only scan comments — C has no bundled
 * decorator/attribute/annotation node type in this grammar. */
const DEPRECATION_MARKER_NODE_TYPES = ["comment"];
/** String-literal node types — used to find magic-blob strings (see
 * `findMagicNumberBlobs`). */
const STRING_LITERAL_NODE_TYPES = ["string_literal", "concatenated_string"];
/** Number-literal node type — used to find hex magic numbers (see
 * `findMagicNumberBlobs`). */
const NUMBER_LITERAL_NODE_TYPES = ["number_literal"];

/** Node types that define an entity, mapped to their normalized kind. */
const ENTITY_NODE_TYPES: Record<string, EntityKind> = {
  function_definition: "function",
  struct_specifier: "class",
  union_specifier: "class",
  enum_specifier: "class",
};

/**
 * Control-flow node types that each add a decision point. C has no dedicated
 * `else if` node — an `else if` nests an `if_statement` inside an `else_clause`,
 * so counting `if_statement` already covers it. `case_statement` also matches a
 * `default:` label (which isn't a real branch); that's a harmless +1 per switch.
 */
const DECISION_NODE_TYPES = [
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "case_statement",
  "conditional_expression", // ternary ?:
];

/** Short-circuiting operators that each add a decision point. */
const LOGICAL_OPERATORS = new Set(["&&", "||"]);

/** Block statements that each deepen the nesting level. */
const NESTING_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
]);

/** A function's own parameter list — see `countParameters`'s "first match
 * wins" heuristic for why this doesn't need to worry about nested closures. */
const PARAMETER_LIST_NODE_TYPES = ["parameter_list"];

/** C spells every switch branch — `default:` included — as `case_statement`,
 * so the catch-all is told apart by its leading keyword rather than by node
 * type (see `isDefaultBranch` in `astUtils.ts`). */
const CASE_BRANCH_NODE_TYPES = ["case_statement"];
const DEFAULT_BRANCH_NODE_TYPES = new Set<string>();
const NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES = new Set<string>();

/**
 * Standard C has no exception construct at all — `seh_try_statement` and its
 * clauses exist in this grammar only for MSVC's `__try`/`__except`/`__finally`
 * extension, so in practice a C file yields zero Exception Handling Zones.
 * Listed rather than omitted so the one file that does use SEH still works,
 * and for the same reason `findEmptyCatchBlocks` is skipped above: the absence
 * is a property of the language, not an oversight.
 */
const TRY_NODE_TYPES = ["seh_try_statement"];
const CATCH_NODE_TYPES = new Set(["seh_except_clause"]);
const FINALLY_NODE_TYPES = new Set(["seh_finally_clause"]);

/** `#include` is C's only import construct. */
const IMPORT_NODE_TYPES = ["preproc_include"];
const CALL_SHAPED_IMPORT_NODE_TYPES: string[] = [];
const CALL_IMPORT_PATTERN = /^$/;

/** C has no `new`; every allocation is a call (`malloc`/`calloc`/…) or a large
 * fixed-size array declarator. */
const ALLOCATION_NODE_TYPES: string[] = [];
const CALL_NODE_TYPES = ["call_expression"];
const ALLOCATOR_NAME_PATTERN = /^((m|c|re|z|v|x)?alloc\w*|strn?dup|memalign|aligned_alloc|reallocarray)$/;
const ARRAY_DECLARATOR_NODE_TYPES = ["array_declarator"];
/** Element count at which a fixed-size array reads as a real allocation rather
 * than an incidental local buffer — mirrors the generic vocabulary's value. */
const LARGE_ARRAY_MIN_SIZE = 1024;

export class CParserAdapter implements CodeParserAdapter {
  readonly language = "c";
  readonly extensions = ["c", "h"] as const;

  private parser: Parser | null = null;

  private async getParser(): Promise<Parser> {
    if (this.parser) return this.parser;
    await initTreeSitter();
    const language = await Language.load(cWasmUrl);
    const parser = new Parser();
    parser.setLanguage(language);
    this.parser = parser;
    return parser;
  }

  async parse(sourceText: string): Promise<ParsedFile> {
    const parser = await this.getParser();
    const tree = parser.parse(sourceText);
    if (!tree) throw new Error("C parser returned no syntax tree");

    try {
      const entities: CodeEntity[] = [];
      for (const node of tree.rootNode.descendantsOfType(Object.keys(ENTITY_NODE_TYPES))) {
        const kind = ENTITY_NODE_TYPES[node.type];

        // Only count struct/union/enum *definitions* (with a body), not uses
        // like `struct Point p;` or a forward `struct Point;`.
        if (kind === "class" && !node.childForFieldName("body")) continue;

        const name = kind === "function" ? functionName(node) : typeName(node);
        if (!name) continue; // skip anonymous structs/enums

        const nestingDepth = maxNestingDepth(node, NESTING_NODE_TYPES);
        // Code smells (too many parameters, too much nesting) only make
        // sense for callable entities — structs/unions/enums have no
        // parameter list of their own.
        const smellBonus =
          kind === "function" ? codeSmellBonus(countParameters(node, PARAMETER_LIST_NODE_TYPES), nestingDepth) : 0;

        const switchBranches = summarizeSwitchBranches(node, CASE_BRANCH_NODE_TYPES, DEFAULT_BRANCH_NODE_TYPES, NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES);
        const allocations = countAllocations(node, ALLOCATION_NODE_TYPES, CALL_NODE_TYPES, ALLOCATOR_NAME_PATTERN, ARRAY_DECLARATOR_NODE_TYPES, LARGE_ARRAY_MIN_SIZE);

        entities.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: 1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS) + smellBonus,
          nestingDepth,
          // Absent rather than present-and-zero when there's nothing to report
          // — see the same convention in `genericParser.ts`.
          ...(switchBranches ? { switchBranches } : {}),
          ...(allocations > 0 ? { allocations } : {}),
        });
      }

      // Global variables: top-level `declaration`s that aren't function
      // prototypes (those contain a function_declarator).
      for (const decl of tree.rootNode.descendantsOfType("declaration")) {
        if (decl.parent?.type !== "translation_unit") continue;
        if (decl.descendantsOfType("function_declarator").length > 0) continue;
        const name = firstIdentifier(decl);
        if (!name) continue;
        entities.push({
          name,
          kind: "global",
          startLine: decl.startPosition.row + 1,
          endLine: decl.endPosition.row + 1,
          complexityScore: 1,
          nestingDepth: 0,
        });
      }

      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      // `goto label;` / `label:` pairs become teleporter pads in the map.
      // tree-sitter-c's grammar marks `label` as a required field on both
      // node types (src/node-types.json), and error recovery on malformed
      // gotos/labels falls back to generic ERROR nodes rather than emitting
      // a mistyped goto_statement/labeled_statement — confirmed empirically:
      // neither `goto;` nor a bare `: ;` yields a node of either type, so
      // `?.text` can never actually see `undefined` here.
      const rawGotos: RawGotoRef[] = [];
      for (const node of tree.rootNode.descendantsOfType("goto_statement")) {
        /* v8 ignore next -- @preserve */
        const label = node.childForFieldName("label")?.text;
        if (label) rawGotos.push({ label, line: node.startPosition.row + 1 });
      }
      const rawLabels: RawGotoRef[] = [];
      for (const node of tree.rootNode.descendantsOfType("labeled_statement")) {
        /* v8 ignore next -- @preserve */
        const label = node.childForFieldName("label")?.text;
        if (label) rawLabels.push({ label, line: node.startPosition.row + 1 });
      }

      // `extractLargeComments`/`findCommentedOutCodeBlocks` both want every
      // "comment" node — collected once here and shared, instead of each
      // doing its own full-tree walk over the same node type.
      const commentNodes = tree.rootNode.descendantsOfType("comment");

      return {
        language: this.language,
        linesOfCode: countLines(sourceText),
        entities,
        gotos: resolveGotos(rawGotos, rawLabels),
        comments: extractLargeCommentsFromNodes(commentNodes),
        secretTriggers: [
          ...findDeadCodeAfterReturn(tree.rootNode, BLOCK_NODE_TYPES, RETURN_NODE_TYPES),
          ...findDeprecationMarkers(tree.rootNode, DEPRECATION_MARKER_NODE_TYPES),
          ...findCommentedOutCodeBlocksFromNodes(commentNodes),
          ...findMagicNumberBlobs(tree.rootNode, STRING_LITERAL_NODE_TYPES, NUMBER_LITERAL_NODE_TYPES),
        ],
        exceptionZones: findExceptionZones(tree.rootNode, TRY_NODE_TYPES, CATCH_NODE_TYPES, FINALLY_NODE_TYPES),
        importCount: countTopLevelImports(tree.rootNode, IMPORT_NODE_TYPES, CALL_SHAPED_IMPORT_NODE_TYPES, CALL_IMPORT_PATTERN, BLOCK_NODE_TYPES),
      };
    } finally {
      tree.delete();
    }
  }
}

/** Name of a struct/union/enum specifier, or null when anonymous. */
function typeName(node: Node): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

/**
 * Extract a function's name from its `function_definition`. The name lives in
 * the innermost declarator, e.g. `int *foo(int x)` →
 * function_definition.declarator (pointer/function_declarator) → … → `foo`.
 */
function functionName(def: Node): string {
  const declarator = def.childForFieldName("declarator");
  const funcDecl =
    declarator?.type === "function_declarator"
      ? declarator
      : (declarator?.descendantsOfType("function_declarator")[0] ?? null);
  const nameDecl = funcDecl?.childForFieldName("declarator") ?? null;
  return firstIdentifier(nameDecl) ?? "<anonymous>";
}

/** First `identifier` found in a declarator subtree (depth-first). */
function firstIdentifier(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  for (const child of node.namedChildren) {
    const found = firstIdentifier(child);
    if (found) return found;
  }
  return null;
}
