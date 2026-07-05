// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One `CodeParserAdapter` implementation, parameterized by a `LanguageConfig`,
 * used for every bundled language that doesn't need the bespoke treatment C
 * and PHP get (see `cParser.ts`/`phpParser.ts` for why those two stay
 * hand-written). All Tree-sitter usage stays behind this module; callers only
 * ever see normalized `ParsedFile` JSON — see `src/parser/types.ts`.
 */
import { Language, Parser } from "web-tree-sitter";
import { initTreeSitter } from "../runtime";
import { countDecisionPoints, countLines, maxNestingDepth } from "../astUtils";
import {
  DECISION_NODE_TYPES,
  ENTITY_NODE_TYPES,
  LOGICAL_OPERATORS,
  NESTING_NODE_TYPES,
  entityName,
  extractGotos,
  genericGlobals,
} from "./vocabulary";
import type { CodeEntity, CodeParserAdapter, ParsedFile } from "../types";

/** Static description of one generically-parsed language. */
export interface LanguageConfig {
  /** Stable language id, e.g. "python". */
  readonly id: string;
  /** Lower-case file extensions (no dot) this language covers. */
  readonly extensions: readonly string[];
  /** Grammar wasm asset URL (a Vite `?url` import — see call sites). */
  readonly wasmUrl: string;
}

const ENTITY_TYPE_NAMES = Object.keys(ENTITY_NODE_TYPES);

export class GenericParserAdapter implements CodeParserAdapter {
  readonly language: string;
  readonly extensions: readonly string[];

  private parser: Parser | null = null;

  constructor(private readonly config: LanguageConfig) {
    this.language = config.id;
    this.extensions = config.extensions;
  }

  private async getParser(): Promise<Parser> {
    if (this.parser) return this.parser;
    await initTreeSitter();
    const language = await Language.load(this.config.wasmUrl);
    const parser = new Parser();
    parser.setLanguage(language);
    this.parser = parser;
    return parser;
  }

  async parse(sourceText: string): Promise<ParsedFile> {
    const parser = await this.getParser();
    const tree = parser.parse(sourceText);
    if (!tree) throw new Error(`${this.language} parser returned no syntax tree`);

    try {
      const root = tree.rootNode;
      const entities: CodeEntity[] = [];

      for (const node of root.descendantsOfType(ENTITY_TYPE_NAMES)) {
        // `descendantsOfType` also matches anonymous keyword tokens whose
        // type string happens to equal one of our names (e.g. a bare `class`
        // token inside `template<class T>`) — only named nodes are real
        // declarations. Also defensively skip the tree's own root, in case a
        // grammar's root node type ever collides with a table entry.
        if (!node.isNamed || node === root) continue;
        const kind = ENTITY_NODE_TYPES[node.type];
        entities.push({
          name: entityName(node),
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: 1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS),
          nestingDepth: maxNestingDepth(node, NESTING_NODE_TYPES),
        });
      }

      entities.push(...genericGlobals(root));
      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      return {
        language: this.language,
        linesOfCode: countLines(sourceText),
        entities,
        gotos: extractGotos(root),
      };
    } finally {
      tree.delete();
    }
  }
}
