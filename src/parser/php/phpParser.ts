// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * PHP implementation of `CodeParserAdapter`, backed by `tree-sitter-php`.
 *
 * All Tree-sitter usage is contained here; callers receive only `ParsedFile`
 * JSON. The grammar WASM is loaded lazily on first parse and reused after that.
 */
import { Language, Parser, type Node } from "web-tree-sitter";
import phpWasmUrl from "tree-sitter-php/tree-sitter-php.wasm?url";
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
  findEmptyCatchBlocks,
  findExceptionZones,
  findMagicNumberBlobs,
  maxNestingDepth,
  resolveGotos,
  summarizeSwitchBranches,
  type RawGotoRef,
} from "../astUtils";
import type {
  CodeEntity,
  CodeParserAdapter,
  EntityKind,
  ParsedFile,
  Visibility,
} from "../types";

/** Block node whose direct children are a flat statement list — used to find
 * unreachable code after a `return` (see `findDeadCodeAfterReturn`). */
const BLOCK_NODE_TYPES = new Set(["compound_statement"]);
const RETURN_NODE_TYPES = new Set(["return_statement"]);

/** Catch-clause node type — used to find swallowed-exception empty catch
 * blocks (see `findEmptyCatchBlocks`). */
const CATCH_NODE_TYPES = ["catch_clause"];
/** Comment + PHP 8 attribute nodes, and string literals (PHPDoc `@deprecated`
 * lives in a comment; `#[Deprecated]` in an attribute list) — used to find
 * deprecation markers (see `findDeprecationMarkers`). */
const DEPRECATION_MARKER_NODE_TYPES = ["comment", "attribute_list", "string", "encapsed_string"];
/** String-literal node types — used to find magic-blob strings (see
 * `findMagicNumberBlobs`). */
const STRING_LITERAL_NODE_TYPES = ["string", "encapsed_string"];
/** Integer-literal node type — used to find hex magic numbers (see
 * `findMagicNumberBlobs`). */
const NUMBER_LITERAL_NODE_TYPES = ["integer"];

/** Node types that define an entity, mapped to their normalized kind. */
const ENTITY_NODE_TYPES: Record<string, EntityKind> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
};

/**
 * Control-flow node types that each add one decision point (a new branch) for
 * cyclomatic complexity. Note: `else_clause` and `default_statement` are
 * intentionally excluded — they do not introduce a new independent path.
 */
const DECISION_NODE_TYPES = [
  "if_statement",
  "else_if_clause", // elseif
  "for_statement",
  "foreach_statement",
  "while_statement",
  "do_statement",
  "case_statement", // one per switch case (default excluded)
  "catch_clause",
  "conditional_expression", // ternary ?:
];

/** Short-circuiting operators that each add a decision point. */
const LOGICAL_OPERATORS = new Set(["&&", "||", "and", "or", "xor"]);

/** Block statements that each deepen the nesting level. */
const NESTING_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "foreach_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
]);

/** A function/method's own parameter list — see `countParameters`'s "first
 * match wins" heuristic for why this doesn't need to worry about nested
 * closures. */
const PARAMETER_LIST_NODE_TYPES = ["formal_parameters"];

/** Switch and `match` branches. Unlike C, PHP's grammar gives the catch-all its
 * own node type in both forms, so no keyword/wildcard text check is needed. */
const CASE_BRANCH_NODE_TYPES = ["case_statement", "default_statement", "match_conditional_expression", "match_default_expression"];
const DEFAULT_BRANCH_NODE_TYPES = new Set(["default_statement", "match_default_expression"]);
const NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES = new Set<string>();

/** `try`/`catch`/`finally` — source for Exception Handling Zones. */
const TRY_NODE_TYPES = ["try_statement"];
const CATCH_NODE_TYPE_SET = new Set(CATCH_NODE_TYPES);
const FINALLY_NODE_TYPES = new Set(["finally_clause"]);

/** `use Foo\Bar;` is a declaration; `include`/`require` (and their `_once`
 * variants) are expressions wrapped in an `expression_statement` — which is
 * exactly why `countTopLevelImports` defines "top-level" as "not inside a body
 * block" rather than by nesting depth. */
const IMPORT_NODE_TYPES = [
  "namespace_use_declaration",
  "include_expression",
  "include_once_expression",
  "require_expression",
  "require_once_expression",
];
const CALL_SHAPED_IMPORT_NODE_TYPES: string[] = [];
const CALL_IMPORT_PATTERN = /^$/;

/** `new Foo()` is PHP's only allocation construct — no `malloc`, no fixed-size
 * array declarators. */
const ALLOCATION_NODE_TYPES = ["object_creation_expression"];
const CALL_NODE_TYPES: string[] = [];
const ALLOCATOR_NAME_PATTERN = /^$/;
const ARRAY_DECLARATOR_NODE_TYPES: string[] = [];
const LARGE_ARRAY_MIN_SIZE = 1024;

export class PhpParserAdapter implements CodeParserAdapter {
  readonly language = "php";
  readonly extensions = ["php", "php3", "php4", "php5", "phtml"] as const;

  private parser: Parser | null = null;

  private async getParser(): Promise<Parser> {
    if (this.parser) return this.parser;
    await initTreeSitter();
    const language = await Language.load(phpWasmUrl);
    const parser = new Parser();
    parser.setLanguage(language);
    this.parser = parser;
    return parser;
  }

  async parse(sourceText: string): Promise<ParsedFile> {
    const parser = await this.getParser();
    const tree = parser.parse(sourceText);
    if (!tree) throw new Error("PHP parser returned no syntax tree");

    try {
      const entities: CodeEntity[] = [];
      for (const node of tree.rootNode.descendantsOfType(Object.keys(ENTITY_NODE_TYPES))) {
        const kind = ENTITY_NODE_TYPES[node.type];
        const nestingDepth = maxNestingDepth(node, NESTING_NODE_TYPES);
        // Code smells (too many parameters, too much nesting) only make
        // sense for callable entities — classes/interfaces/traits have no
        // parameter list of their own.
        const isCallable = kind === "function" || kind === "method";
        const smellBonus = isCallable ? codeSmellBonus(countParameters(node, PARAMETER_LIST_NODE_TYPES), nestingDepth) : 0;

        const switchBranches = summarizeSwitchBranches(node, CASE_BRANCH_NODE_TYPES, DEFAULT_BRANCH_NODE_TYPES, NON_SWITCH_BRANCH_ANCESTOR_NODE_TYPES);
        const allocations = countAllocations(node, ALLOCATION_NODE_TYPES, CALL_NODE_TYPES, ALLOCATOR_NAME_PATTERN, ARRAY_DECLARATOR_NODE_TYPES, LARGE_ARRAY_MIN_SIZE);

        entities.push({
          name: node.childForFieldName("name")?.text ?? "<anonymous>",
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: 1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS) + smellBonus,
          nestingDepth,
          ...(kind === "method" ? { visibility: methodVisibility(node) } : {}),
          // Absent rather than present-and-zero when there's nothing to report
          // — see the same convention in `genericParser.ts`.
          ...(switchBranches ? { switchBranches } : {}),
          ...(allocations > 0 ? { allocations } : {}),
        });
      }

      // Global variables: assignments to a variable at file (program) scope,
      // e.g. `$config = [...];`. Assignments inside functions are locals.
      for (const assign of tree.rootNode.descendantsOfType("assignment_expression")) {
        if (assign.parent?.type !== "expression_statement") continue;
        if (assign.parent.parent?.type !== "program") continue;
        const left = assign.childForFieldName("left");
        if (left?.type !== "variable_name") continue;
        entities.push({
          name: left.text,
          kind: "global",
          startLine: assign.startPosition.row + 1,
          endLine: assign.endPosition.row + 1,
          complexityScore: 1,
          nestingDepth: 0,
        });
      }

      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      // `goto label;` / `label:` pairs become teleporter pads in the map.
      // Neither node type exposes a "label" field in this grammar — the name
      // is just an unnamed-field child of type `name`. That child is a
      // required (non-optional) single child per tree-sitter-php's
      // node-types.json, and error recovery on malformed gotos/labels falls
      // back to generic ERROR nodes rather than emitting a mistyped
      // goto_statement/named_label_statement — confirmed empirically:
      // neither `goto;` nor a bare `: ;` yields a node of either type, so
      // `.find(...)?.text` can never actually see `undefined` here.
      const rawGotos: RawGotoRef[] = [];
      for (const node of tree.rootNode.descendantsOfType("goto_statement")) {
        /* v8 ignore next -- @preserve */
        const label = node.namedChildren.find((c) => c.type === "name")?.text;
        if (label) rawGotos.push({ label, line: node.startPosition.row + 1 });
      }
      const rawLabels: RawGotoRef[] = [];
      for (const node of tree.rootNode.descendantsOfType("named_label_statement")) {
        /* v8 ignore next -- @preserve */
        const label = node.namedChildren.find((c) => c.type === "name")?.text;
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
          ...findEmptyCatchBlocks(tree.rootNode, CATCH_NODE_TYPES, BLOCK_NODE_TYPES, new Set(["comment"])),
          ...findDeprecationMarkers(tree.rootNode, DEPRECATION_MARKER_NODE_TYPES),
          ...findCommentedOutCodeBlocksFromNodes(commentNodes),
          ...findMagicNumberBlobs(tree.rootNode, STRING_LITERAL_NODE_TYPES, NUMBER_LITERAL_NODE_TYPES),
        ],
        exceptionZones: findExceptionZones(tree.rootNode, TRY_NODE_TYPES, CATCH_NODE_TYPE_SET, FINALLY_NODE_TYPES),
        importCount: countTopLevelImports(tree.rootNode, IMPORT_NODE_TYPES, CALL_SHAPED_IMPORT_NODE_TYPES, CALL_IMPORT_PATTERN, BLOCK_NODE_TYPES),
      };
    } finally {
      // Free the WASM-side syntax tree; the Parser itself is kept for reuse.
      tree.delete();
    }
  }
}

/** A method's access modifier from its `visibility_modifier`, defaulting public. */
function methodVisibility(method: Node): Visibility {
  for (const child of method.namedChildren) {
    if (child.type === "visibility_modifier") {
      const text = child.text.toLowerCase();
      if (text === "private" || text === "protected") return text;
      return "public";
    }
  }
  return "public";
}
