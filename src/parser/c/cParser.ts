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
import { countDecisionPoints, countLines } from "../astUtils";
import type { CodeEntity, CodeParserAdapter, EntityKind, ParsedFile } from "../types";

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

        entities.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: 1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS),
        });
      }
      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      return {
        language: this.language,
        linesOfCode: countLines(sourceText),
        entities,
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
