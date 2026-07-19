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

/** Collects chunks (in whatever order they arrive) keyed by their original
 * index, and reassembles + parses them once every expected chunk has
 * arrived. */
export class ChunkReassembler {
  private readonly chunks = new Map<number, string>();

  push(chunk: string, index: number): void {
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
