// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Optional gzip compression for values headed into `localStorage`, so a
 * highly repetitive JSON blob (a replay's frame list, in particular — see
 * `HighscoreEntry.replay`'s doc comment) has a much better chance of fitting
 * under a browser's storage quota. Uses the native `CompressionStream`/
 * `DecompressionStream` (gzip) rather than a bundled library, per this
 * project's "keep dependencies minimal" constraint — the same reasoning
 * already applied to using `crypto.subtle.digest` in `highscores.ts`'s
 * `hashRun` instead of a bundled hash library.
 */

/** Prefix marking a stored value as gzip+base64 — anything else (including
 * every value written before this module existed) is assumed to be plain
 * JSON, so old data keeps loading exactly as before. */
const COMPRESSED_PREFIX = "gz1:";

/** Byte chunk size used when turning a large `Uint8Array` into a binary
 * string for `btoa` — spreading a huge typed array directly into
 * `String.fromCharCode(...bytes)` can blow the call stack, so this feeds it
 * in bounded pieces instead. */
const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** A single-chunk stream wrapping `bytes` — used instead of
 * `new Blob([bytes]).stream()` because jsdom's `Blob` shim (unlike every
 * real browser) doesn't implement `.stream()` at all, which left this
 * module's compression path untested: `compressForStorage`'s try/catch
 * silently swallowed the resulting failure and fell back to plain JSON,
 * so no test ever exercised real gzip data until `defaultHighscore.ts`
 * started shipping pre-compressed data directly. `ReadableStream` itself is
 * a plain JS global jsdom doesn't shadow, so this works identically in a
 * real browser and under jsdom. */
function singleChunkStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = singleChunkStream(bytes).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = singleChunkStream(bytes).pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Serialize `value` for `localStorage`, gzip-compressing it when that's
 * supported (`CompressionStream` exists) and actually smaller than the plain
 * JSON — otherwise falls back to plain `JSON.stringify`, so this never makes
 * a value bigger and works unchanged in a browser without the API. */
export async function compressForStorage(value: unknown): Promise<string> {
  const plain = JSON.stringify(value);
  if (typeof CompressionStream === "undefined") return plain;

  try {
    const compressed = COMPRESSED_PREFIX + bytesToBase64(await gzip(new TextEncoder().encode(plain)));
    return compressed.length < plain.length ? compressed : plain;
  } catch {
    return plain;
  }
}

/** Inverse of `compressForStorage`: gunzips+parses a `"gz1:"`-prefixed value,
 * or `JSON.parse`s anything else directly (covers every value stored before
 * this module existed). Throws on corrupt/invalid data, same as a plain
 * `JSON.parse` would — callers already handle that via try/catch. */
export async function decompressFromStorage<T>(raw: string): Promise<T> {
  if (!raw.startsWith(COMPRESSED_PREFIX)) return JSON.parse(raw) as T;
  const bytes = await gunzip(base64ToBytes(raw.slice(COMPRESSED_PREFIX.length)));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
