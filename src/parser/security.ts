// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Defense-in-depth checks run before any file text reaches a Tree-sitter
 * parser. The extension whitelist in `registry.ts` (`isParsable`) is the
 * primary gate — only extensions a registered `CodeParserAdapter` claims are
 * ever handed to `parseFile()` at all. This module catches the remaining
 * case: a binary/media file that happens to be misnamed with a source
 * extension (e.g. a renamed image), which would otherwise waste time feeding
 * garbage bytes into a WASM parser or, worse, make it choke on a huge file.
 *
 * Nothing in this file — or anywhere else in `src/parser/` — ever evaluates,
 * compiles, or executes the text it inspects. Source text is only ever
 * handed to `Parser.parse()` (builds an AST) or plain string/regex scans.
 */

/** Reject anything larger than this before it reaches a parser. Real source
 * files are essentially never this big; a match is almost certainly a
 * mis-extensioned binary or a pathological input. */
export const MAX_PARSE_BYTES = 4 * 1024 * 1024; // 4 MiB

/** How many leading characters to sample when sniffing for binary content. */
const SNIFF_WINDOW = 8192;
/** Above this fraction of non-printable bytes in the sample, treat as binary. */
const NON_PRINTABLE_RATIO_LIMIT = 0.15;

export interface ParseSafetyResult {
  ok: boolean;
  /** Human-readable reason, present when `ok` is false. */
  reason?: string;
}

/**
 * Heuristically sniff whether `text` looks like real source rather than a
 * binary blob that happened to decode into a JS string. A single NUL byte is
 * a hard reject (never appears in real UTF-8/ASCII source); otherwise a
 * sampled ratio of non-printable/control characters is used, since a fully
 * binary file decoded as UTF-8 tends to produce a lot of the replacement
 * character and other control bytes.
 */
function looksLikeBinary(text: string): boolean {
  const sample = text.slice(0, SNIFF_WINDOW);
  if (sample.length === 0) return false;
  if (sample.includes("\0")) return true;

  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow common whitespace (tab, LF, CR) but count other control chars
    // and the Unicode replacement character (0xFFFD, a decode-failure marker).
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    const isControl = code < 32 && !isAllowedWhitespace;
    if (isControl || code === 0xfffd) nonPrintable++;
  }
  return nonPrintable / sample.length > NON_PRINTABLE_RATIO_LIMIT;
}

/**
 * Whether `sourceText` is safe to hand to a `CodeParserAdapter`. Checks size
 * and binary-content heuristics; the extension whitelist itself is enforced
 * separately by `isParsable()` before this is ever called.
 */
export function isSafeToParse(sourceText: string): ParseSafetyResult {
  if (sourceText.length > MAX_PARSE_BYTES) {
    return { ok: false, reason: `file exceeds ${MAX_PARSE_BYTES} byte parse limit (${sourceText.length} bytes)` };
  }
  if (looksLikeBinary(sourceText)) {
    return { ok: false, reason: "file content looks binary, not source text" };
  }
  return { ok: true };
}
