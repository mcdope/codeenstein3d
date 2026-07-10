// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One `CodeParserAdapter` implementation, parameterized by a `LanguageConfig`,
 * used for every bundled language that doesn't need the bespoke treatment C
 * and PHP get (see `cParser.ts`/`phpParser.ts` for why those two stay
 * hand-written). All Tree-sitter usage stays behind this module; callers only
 * ever see normalized `ParsedFile` JSON — see `src/parser/types.ts`.
 */
import type { Node } from "web-tree-sitter";
import { Language, Parser } from "web-tree-sitter";
import { initTreeSitter } from "../runtime";
import {
  codeSmellBonus,
  countDecisionPoints,
  countLines,
  countParameters,
  extractLargeCommentsFromNodes,
  findCommentedOutCodeBlocksFromNodes,
  findDeadCodeAfterReturn,
  findDeprecationMarkers,
  findEmptyCatchBlocks,
  findMagicNumberBlobs,
  maxNestingDepth,
} from "../astUtils";
import {
  ANNOTATION_NODE_TYPES,
  BLOCK_NODE_TYPES,
  CATCH_NODE_TYPES,
  COMMENT_NODE_TYPES,
  DECISION_NODE_TYPES,
  ENTITY_NODE_TYPES,
  LOGICAL_OPERATORS,
  NESTING_NODE_TYPES,
  NUMBER_LITERAL_NODE_TYPES,
  PARAMETER_LIST_NODE_TYPES,
  RETURN_NODE_TYPES,
  STRING_LITERAL_NODE_TYPES,
  entityName,
  extractGotos,
  genericGlobals,
  positionKey,
} from "./vocabulary";
import type { CodeEntity, CodeParserAdapter, EntityKind, ParsedFile } from "../types";

/** Deprecation markers can hide in a comment, an annotation/decorator, or a
 * docstring (a plain string literal in grammars like Python) — see
 * `findDeprecationMarkers` in `astUtils.ts`. */
const DEPRECATION_MARKER_NODE_TYPES: readonly string[] = [
  ...COMMENT_NODE_TYPES,
  ...ANNOTATION_NODE_TYPES,
  ...STRING_LITERAL_NODE_TYPES,
];

/** Content that doesn't disqualify a catch body from counting as "empty" —
 * comments, plus Python's `pass_statement`, since `except: pass` (a no-op
 * required by Python's grammar, which doesn't allow a truly empty block) is
 * that language's idiomatic form of a swallowed exception. Harmless for
 * every other bundled grammar, where this type name never occurs. */
const EMPTY_CATCH_IGNORABLE_NODE_TYPES = new Set([...COMMENT_NODE_TYPES, "pass_statement"]);

/**
 * Static description of one generically-parsed language, plus the hooks a
 * language needs to go beyond the shared defaults. `refinements.ts` has one
 * of these per bundled language — most languages need at least one hook
 * (visibility modifiers, method-vs-function distinction, name assembly for
 * grammars that don't expose a plain `name` field) to score as precisely as
 * the bespoke PHP/C adapters do.
 */
export interface LanguageConfig {
  /** Stable language id, e.g. "python". */
  readonly id: string;
  /** Lower-case file extensions (no dot) this language covers. */
  readonly extensions: readonly string[];
  /** Grammar wasm asset URL (a Vite `?url` import — see call sites). */
  readonly wasmUrl: string;
  /** Extra node type -> kind entries layered on top of the shared
   * `ENTITY_NODE_TYPES` table, scoped to just this language's own parse (e.g.
   * JS/TS's `const foo = () => {}` pattern, Go's `type Foo struct{}`). */
  readonly extraEntityTypes?: Record<string, EntityKind>;
  /** Return `false` to drop an otherwise-matched node entirely — e.g. a
   * `variable_declarator` whose value isn't a function, or an ObjC
   * `method_declaration` prototype that's already covered by its
   * `method_definition` implementation. */
  readonly filter?: (node: Node) => boolean;
  /** Adjust the generically-built entity (name/kind/visibility) using node
   * context the shared traversal doesn't have — e.g. "is this Rust
   * `function_item` inside an `impl` block", "what access modifier applies
   * here". Runs after the generic name/complexity/nesting scoring. */
  readonly refine?: (node: Node, entity: CodeEntity) => CodeEntity;
}

export class GenericParserAdapter implements CodeParserAdapter {
  readonly language: string;
  readonly extensions: readonly string[];

  private readonly entityTypes: Record<string, EntityKind>;
  private readonly entityTypeNames: string[];
  private parser: Parser | null = null;

  constructor(private readonly config: LanguageConfig) {
    this.language = config.id;
    this.extensions = config.extensions;
    this.entityTypes = { ...ENTITY_NODE_TYPES, ...(config.extraEntityTypes ?? {}) };
    this.entityTypeNames = Object.keys(this.entityTypes);
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
      const consumed = new Set<string>();

      for (const node of root.descendantsOfType(this.entityTypeNames)) {
        // `descendantsOfType` also matches anonymous keyword tokens whose
        // type string happens to equal one of our names (e.g. a bare `class`
        // token inside `template<class T>`) — only named nodes are real
        // declarations. Also defensively skip the tree's own root, in case a
        // grammar's root node type ever collides with a table entry.
        if (!node.isNamed || node === root) continue;
        if (this.config.filter && !this.config.filter(node)) continue;

        const kind = this.entityTypes[node.type];
        const nestingDepth = maxNestingDepth(node, NESTING_NODE_TYPES);
        // Code smells (too many parameters, too much nesting) only make
        // sense for callable entities — classes/interfaces/traits have no
        // parameter list of their own.
        const isCallable = kind === "function" || kind === "method";
        const smellBonus = isCallable ? codeSmellBonus(countParameters(node, PARAMETER_LIST_NODE_TYPES), nestingDepth) : 0;

        let entity: CodeEntity = {
          name: entityName(node),
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexityScore: 1 + countDecisionPoints(node, DECISION_NODE_TYPES, LOGICAL_OPERATORS) + smellBonus,
          nestingDepth,
        };
        if (this.config.refine) entity = this.config.refine(node, entity);
        entities.push(entity);
        consumed.add(positionKey(node));
      }

      entities.push(...genericGlobals(root, consumed, this.entityTypeNames));
      entities.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      // `extractLargeComments`/`findCommentedOutCodeBlocks` both want every
      // comment node — collected once here and shared, instead of each doing
      // its own full-tree walk over the same node types.
      const commentNodes = root.descendantsOfType([...COMMENT_NODE_TYPES]);

      return {
        language: this.language,
        linesOfCode: countLines(sourceText),
        entities,
        gotos: extractGotos(root),
        comments: extractLargeCommentsFromNodes(commentNodes),
        secretTriggers: [
          ...findDeadCodeAfterReturn(root, BLOCK_NODE_TYPES, RETURN_NODE_TYPES),
          ...findEmptyCatchBlocks(root, CATCH_NODE_TYPES, BLOCK_NODE_TYPES, EMPTY_CATCH_IGNORABLE_NODE_TYPES),
          ...findDeprecationMarkers(root, DEPRECATION_MARKER_NODE_TYPES),
          ...findCommentedOutCodeBlocksFromNodes(commentNodes),
          ...findMagicNumberBlobs(root, STRING_LITERAL_NODE_TYPES, NUMBER_LITERAL_NODE_TYPES),
        ],
      };
    } finally {
      tree.delete();
    }
  }
}
