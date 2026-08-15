// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A deliberately shallow syntax highlighter, written for the boss screen
 * (`./bossScreen.ts`) and nothing else.
 *
 * **Why not the real parser.** `src/parser/` already runs tree-sitter over
 * every level's source, but it is firewalled by design ("nothing outside
 * `src/parser/` should import `web-tree-sitter`" — `src/parser/types.ts`) and
 * `ParsedFile` deliberately carries line numbers only: no columns, no byte
 * offsets, no node types. Getting real token spans out of it would mean
 * widening that contract for a feature whose entire job is to *look*
 * plausible from across a room. So this scans the text directly and never
 * touches the parser layer.
 *
 * What it therefore is: comments, string literals, numbers and a shared
 * keyword list, per line, with one bit of carried state for block comments.
 * It will mis-colour a regex literal containing a quote, a nested template
 * expression, and Python's triple-quoted strings. That is an accepted cost —
 * every one of those degrades to "some code is the wrong colour", which is
 * exactly as convincing as the right colour at a glance.
 *
 * Output is always tokens rendered as `textContent`, never markup — same
 * hygiene as `./consoleSidebar.ts`, and the reason arbitrary source text can
 * be displayed here without an escaping pass.
 */

/** What a token gets coloured as. `plain` covers everything unclaimed —
 * identifiers, operators, punctuation, whitespace. */
export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";

export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

/** The comment/string rules of one language family. */
interface Syntax {
  readonly lineComment: readonly string[];
  /** `null` for languages in this project's set that have no block form. */
  readonly block: { readonly open: string; readonly close: string } | null;
  readonly quotes: readonly string[];
}

const C_FAMILY: Syntax = { lineComment: ["//"], block: { open: "/*", close: "*/" }, quotes: ['"', "'", "`"] };
const HASH_FAMILY: Syntax = { lineComment: ["#"], block: null, quotes: ['"', "'"] };
/** PHP accepts all three comment forms; treated as its own entry rather than
 * bent into `C_FAMILY`, since `#` comments are common in real PHP. */
const PHP: Syntax = { lineComment: ["//", "#"], block: { open: "/*", close: "*/" }, quotes: ['"', "'"] };

/**
 * Extension → syntax family. Covers exactly the extensions this project's
 * parsers accept (`src/parser/registry.ts`), plus the handful a repo may hold
 * that never becomes a level but can still be shown here.
 */
const BY_EXTENSION: Readonly<Record<string, Syntax>> = {
  c: C_FAMILY,
  h: C_FAMILY,
  cpp: C_FAMILY,
  hpp: C_FAMILY,
  cc: C_FAMILY,
  cs: C_FAMILY,
  java: C_FAMILY,
  js: C_FAMILY,
  jsx: C_FAMILY,
  ts: C_FAMILY,
  tsx: C_FAMILY,
  go: C_FAMILY,
  rs: C_FAMILY,
  scala: C_FAMILY,
  swift: C_FAMILY,
  kt: C_FAMILY,
  m: C_FAMILY,
  mm: C_FAMILY,
  php: PHP,
  py: HASH_FAMILY,
  rb: HASH_FAMILY,
  sh: HASH_FAMILY,
  bash: HASH_FAMILY,
  pl: HASH_FAMILY,
  yml: HASH_FAMILY,
  yaml: HASH_FAMILY,
};

/**
 * One union of keywords across every language above, rather than a set per
 * language. A word that is a keyword in Go and an identifier in Ruby gets
 * coloured in both — at a glance that reads as "syntax highlighting is on",
 * which is the whole requirement. Per-language sets would be more correct and
 * buy nothing this feature can use.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract", "and", "as", "async", "await", "begin", "bool", "boolean", "break", "case", "catch", "char", "class",
  "const", "constexpr", "continue", "def", "default", "defer", "delete", "do", "double", "echo", "elif", "else",
  "elseif", "end", "enum", "except", "export", "extends", "extern", "false", "final", "finally", "float", "fn",
  "for", "foreach", "from", "func", "function", "go", "goto", "if", "impl", "implements", "import", "in", "include",
  "int", "interface", "is", "lambda", "let", "local", "long", "loop", "match", "mod", "module", "mut", "namespace",
  "new", "nil", "none", "not", "null", "object", "or", "override", "package", "pass", "print", "private",
  "protected", "pub", "public", "raise", "readonly", "require", "return", "self", "short", "sizeof", "static",
  "std", "string", "struct", "super", "switch", "template", "this", "throw", "trait", "true", "try", "type",
  "typedef", "typeof", "union", "unsafe", "use", "using", "var", "virtual", "void", "when", "while", "with", "yield",
]);

/** Carried between lines so a `/* … *\/` block spanning several of them stays
 * one comment. The only state this highlighter has. */
export interface ScanState {
  inBlockComment: boolean;
}

export function initialScanState(): ScanState {
  return { inBlockComment: false };
}

/** Lower-case extension without the dot, or `""` if the path has none.
 *
 * Deliberately a local copy of `src/parser/registry.ts`'s identical helper
 * rather than an import: that module pulls in every parser adapter and, with
 * them, `web-tree-sitter`. Six lines is a much smaller cost than dragging the
 * parser layer into a presentation module. */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** The syntax family for a file path, defaulting to the C family — the
 * majority of this project's supported languages, and the least surprising
 * guess for an unknown extension. */
export function syntaxForPath(path: string): Syntax {
  return BY_EXTENSION[extensionOf(path)] ?? C_FAMILY;
}

const isWordStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isWordPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

/**
 * Split one line into coloured tokens, advancing `state` in place.
 *
 * Adjacent `plain` characters are coalesced into a single token so a typical
 * line produces a handful of spans rather than one per character.
 */
export function tokenizeLine(line: string, syntax: Syntax, state: ScanState): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain, kind: "plain" });
      plain = "";
    }
  };

  let i = 0;
  while (i < line.length) {
    // Inside a block comment: everything up to the closing marker, or the
    // whole rest of the line if it doesn't close here.
    if (state.inBlockComment) {
      // Non-null by construction: the only thing that sets this flag is the
      // open branch below, which cannot run for a language with no block
      // comment syntax.
      const block = syntax.block!;
      const close = line.indexOf(block.close, i);
      if (close === -1) {
        tokens.push({ text: line.slice(i), kind: "comment" });
        return tokens;
      }
      const end = close + block.close.length;
      tokens.push({ text: line.slice(i, end), kind: "comment" });
      state.inBlockComment = false;
      i = end;
      continue;
    }

    // The opening marker is part of the comment token, not skipped past —
    // dropping it would silently lose two characters out of the rendered
    // file, which is worse than any mis-colouring this module can produce.
    // The search for the close deliberately starts *after* the marker, so
    // `/*/` opens a block rather than being read as an instant close.
    if (syntax.block && line.startsWith(syntax.block.open, i)) {
      flush();
      const from = i + syntax.block.open.length;
      const close = line.indexOf(syntax.block.close, from);
      if (close === -1) {
        tokens.push({ text: line.slice(i), kind: "comment" });
        state.inBlockComment = true;
        return tokens;
      }
      const end = close + syntax.block.close.length;
      tokens.push({ text: line.slice(i, end), kind: "comment" });
      i = end;
      continue;
    }

    const lineMarker = syntax.lineComment.find((marker) => line.startsWith(marker, i));
    if (lineMarker) {
      flush();
      tokens.push({ text: line.slice(i), kind: "comment" });
      return tokens;
    }

    const quote = syntax.quotes.find((q) => line.startsWith(q, i));
    if (quote) {
      flush();
      let j = i + quote.length;
      // An unterminated quote (a stray apostrophe in prose, a multi-line
      // string) simply runs to end-of-line and stops there — no state is
      // carried, so it can never swallow the rest of the file.
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        j += 1;
      }
      tokens.push({ text: line.slice(i, Math.min(j, line.length)), kind: "string" });
      i = Math.min(j, line.length);
      continue;
    }

    const ch = line[i];
    // A digit only starts a number when it isn't part of an identifier
    // already being read — `utf8Decode` must not colour its `8`.
    if (isDigit(ch) && !(i > 0 && isWordPart(line[i - 1]))) {
      flush();
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB._]/.test(line[j])) j += 1;
      tokens.push({ text: line.slice(i, j), kind: "number" });
      i = j;
      continue;
    }

    if (isWordStart(ch)) {
      let j = i;
      while (j < line.length && isWordPart(line[j])) j += 1;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word.toLowerCase())) {
        flush();
        tokens.push({ text: word, kind: "keyword" });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flush();
  return tokens;
}

/**
 * Beyond this many lines the rest is dropped. A source file can be up to 4
 * MiB (`MAX_PARSE_BYTES`), and the boss screen has one hard requirement —
 * that it appear *instantly* — so it renders a plausible screenful-plus
 * rather than a whole monolith. Nobody reading over your shoulder scrolls to
 * line 2,001.
 */
export const MAX_RENDERED_LINES = 2000;

/**
 * Render `source` into `container` as one row per line: a line-number gutter
 * plus coloured tokens. Replaces whatever was there.
 */
export function renderHighlighted(container: HTMLElement, source: string, path: string): void {
  const syntax = syntaxForPath(path);
  const state = initialScanState();
  const lines = source.split("\n");
  const shown = Math.min(lines.length, MAX_RENDERED_LINES);
  const rows: HTMLElement[] = [];

  for (let n = 0; n < shown; n += 1) {
    const row = document.createElement("div");
    row.className = "boss-line";

    const gutter = document.createElement("span");
    gutter.className = "boss-line-no";
    gutter.textContent = String(n + 1);

    const code = document.createElement("span");
    code.className = "boss-line-code";
    for (const token of tokenizeLine(lines[n], syntax, state)) {
      const span = document.createElement("span");
      span.className = `boss-tok boss-tok--${token.kind}`;
      span.textContent = token.text;
      code.append(span);
    }

    row.append(gutter, code);
    rows.push(row);
  }

  container.replaceChildren(...rows);
}
