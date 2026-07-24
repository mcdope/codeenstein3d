// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Splits a JSON-serializable payload into fixed-size string chunks for
 * transfer over an `RTCDataChannel`, and reassembles them back into the
 * original value on the receiving end. An `RTCDataChannel` message has a
 * practical cross-browser size floor around 64 KiB — a large payload (e.g.
 * the session-setup `GameMap` transfer) needs to be sent as several smaller
 * messages rather than one, with an index the receiver can use to
 * reassemble it in the right order regardless of arrival order.
 */

/** Splits `JSON.stringify(payload)` into `chunkSize`-character pieces, in
 * order. The final chunk is whatever remains (may be shorter than
 * `chunkSize`) — no padding. */
export function chunkJson(payload: unknown, chunkSize: number): string[] {
  const json = JSON.stringify(payload);
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Hard ceiling on how many chunks a single `ChunkReassembler` may ever
 * buffer. `isComplete()`'s own `chunks.size !== totalChunks` check already
 * stops a bare inflated `totalChunks` claim with no matching data from
 * spinning forever — this instead guards the real remaining risk: a peer
 * that actually sends a sustained flood of legitimate-looking chunks, which
 * would otherwise grow this reassembler's internal `Map` unboundedly.
 * `netcodeConstants.ts` is where every other transfer-related constant
 * (`MAP_CHUNK_SIZE_BYTES`, the backpressure watermarks) actually lives, but
 * this fix's file scope is `chunkedTransfer.ts` alone, so the cap stays
 * local here rather than there. Sized well above any realistic `GameMap`
 * transfer — `sessionSetupHost.ts`/`multiplayerSessionHost.ts` chunk at 16
 * KiB (`MAP_CHUNK_SIZE_BYTES`), so even a many-megabyte map needs only a few
 * hundred chunks — while still bounding a single reassembly's worst-case
 * memory footprint to a fixed, small multiple of that. */
export const MAX_TOTAL_CHUNKS = 20_000;

/** Hard ceiling on cumulative buffered `chunk.length` (UTF-16 code units,
 * matching `chunkJson`'s own approximation of "bytes" — see
 * `sessionSetupHost.ts`'s comment on that same imprecision) across every
 * chunk a single `ChunkReassembler` has buffered so far. Belt-and-suspenders
 * alongside `MAX_TOTAL_CHUNKS`: a peer could otherwise stay under the chunk
 * *count* cap while still ballooning memory by sending unexpectedly large
 * individual chunks. 64 MiB is comfortably above any real `GameMap` transfer
 * this project produces. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Collects chunks (in whatever order they arrive) keyed by their original
 * index, and reassembles + parses them once every expected chunk has
 * arrived. */
export class ChunkReassembler {
  private readonly chunks = new Map<number, string>();
  private bufferedBytes = 0;

  /** Throws once buffering `chunk` at `index` would exceed `MAX_TOTAL_CHUNKS`
   * or `MAX_TOTAL_BYTES` — before storing it, never after, so a rejected
   * chunk never gets counted. Re-pushing an already-seen `index` (not
   * expected in this project's own protocol, which never retransmits, but
   * not assumed impossible either) adjusts the byte tally by the delta
   * rather than double-counting, so replaying the same index repeatedly
   * can't be used to inflate the tracked total past what's actually held in
   * `chunks`.
   *
   * `chunk`/`index` arrive straight off a peer's `JSON.parse`d message and are
   * validated here before any arithmetic — the reason this throws on a
   * non-string `chunk` or a non-integer/negative `index` rather than trusting
   * the declared types. Without it, a single `chunk: 0` (or `false`, or a
   * missing field) makes `chunk.length` `undefined`, so `bufferedBytes`
   * becomes `NaN` — and every `NaN > MAX_TOTAL_BYTES` comparison thereafter is
   * `false`, permanently disabling the byte cap for this reassembler's whole
   * life. A peer could then flood arbitrarily large chunks (up to the chunk-
   * *count* cap) and exhaust the receiver's memory. A single chunk larger than
   * the cumulative byte cap is likewise refused outright. */
  push(chunk: string, index: number): void {
    if (typeof chunk !== "string") {
      throw new Error(`ChunkReassembler: refusing a non-string chunk (got ${typeof chunk}).`);
    }
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`ChunkReassembler: refusing a chunk with a non-integer or negative index (${String(index)}).`);
    }
    if (chunk.length > MAX_TOTAL_BYTES) {
      throw new Error(`ChunkReassembler: refusing a single chunk larger than ${MAX_TOTAL_BYTES} bytes.`);
    }
    const previous = this.chunks.get(index);
    if (previous === undefined && this.chunks.size + 1 > MAX_TOTAL_CHUNKS) {
      throw new Error(`ChunkReassembler: refusing to buffer more than ${MAX_TOTAL_CHUNKS} chunks.`);
    }
    const nextBufferedBytes = this.bufferedBytes + chunk.length - (previous?.length ?? 0);
    if (nextBufferedBytes > MAX_TOTAL_BYTES) {
      throw new Error(`ChunkReassembler: refusing to buffer more than ${MAX_TOTAL_BYTES} bytes across all chunks.`);
    }
    this.bufferedBytes = nextBufferedBytes;
    this.chunks.set(index, chunk);
  }

  /** True once every chunk `0..totalChunks-1` has been pushed, regardless of
   * arrival order. */
  isComplete(totalChunks: number): boolean {
    if (this.chunks.size !== totalChunks) return false;
    for (let i = 0; i < totalChunks; i++) {
      if (!this.chunks.has(i)) return false;
    }
    return true;
  }

  /** Concatenates every collected chunk in index order and parses the
   * result. Caller is expected to have already checked `isComplete()`. */
  finish<T>(): T {
    const indices = [...this.chunks.keys()].sort((a, b) => a - b);
    const json = indices.map((i) => this.chunks.get(i)).join("");
    return JSON.parse(json) as T;
  }
}

/** Guards a reassembled `GameMap`'s own `width`/`height` before a caller
 * allocates a `visited` grid from them (`Array.from({length: height}, () =>
 * new Array(width)...)`) — the byte/chunk-count caps above bound wire size,
 * not declared dimensions, so a tiny well-formed payload like
 * `{"width":1e9,"height":1e9}` passes both and still triggers a
 * multi-gigabyte allocation. Shared by `sessionSetupGuest.ts` (initial
 * handshake) and `multiplayerSessionGuest.ts` (level transitions) — the same
 * validation applies identically to both map-transfer sites. */
export function isValidMapDimensions(width: unknown, height: unknown, maxDimension: number): boolean {
  return (
    typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    width <= maxDimension &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0 &&
    height <= maxDimension
  );
}
