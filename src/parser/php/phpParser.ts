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
import type { CodeEntity, CodeParserAdapter, EntityKind, ParsedFile } from "../types";

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
        entities.push({
          name: node.childForFieldName("name")?.text ?? "<anonymous>",
          kind: ENTITY_NODE_TYPES[node.type],
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: computeComplexity(node),
        });
      }
      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      return {
        language: this.language,
        linesOfCode: countLines(sourceText),
        entities,
      };
    } finally {
      // Free the WASM-side syntax tree; the Parser itself is kept for reuse.
      tree.delete();
    }
  }
}

/** 1 (base path) + number of decision points within the entity's subtree. */
function computeComplexity(entity: Node): number {
  let score = 1;
  score += entity.descendantsOfType(DECISION_NODE_TYPES).length;
  for (const binary of entity.descendantsOfType("binary_expression")) {
    const operator = binary.childForFieldName("operator")?.text;
    if (operator && LOGICAL_OPERATORS.has(operator)) score += 1;
  }
  return score;
}

/** Total line count; a single trailing newline is not counted as a new line. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}
