// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A compact binary encoding for recorded replay frames, so a highscore board
 * fits comfortably inside a browser's `localStorage` quota.
 *
 * **Why this exists.** A replay is one `ReplayFrame` per simulated step, and
 * `JSON.stringify` writes every field of `InputSnapshot` out in full on every
 * frame — 18 keys, mostly `false`/`0`/`null`, about **334 bytes per frame**:
 *
 * ```json
 * {"dt":0.05,"input":{"keys":[],"mouseDX":0,"fireQueued":false,...,"gpTurn":0}}
 * ```
 *
 * gzip papers over most of that repetition, but not over `dt`. Measured on
 * the shipped board: 213,740 frames carried **14,425 distinct `dt` values**,
 * all rAF jitter in the twelfth decimal (`0.01666666666662786` and friends).
 * Every one serializes to its own ~20-character string, so gzip's dictionary
 * can't fold them together, and that single field dominated the compressed
 * payload.
 *
 * Encoding a frame as a fixed bitfield plus the raw `dt` bits sidesteps both
 * problems at once. Measured end-to-end on the same board, as `localStorage`
 * quota (which is billed in UTF-16 code units — a base64 character costs
 * *two* bytes of quota, not one):
 *
 * | | quota |
 * |---|---|
 * | `JSON.stringify` → gzip → base64 (the old scheme) | 1.48 MB |
 * | this codec → gzip → base64 | **0.42 MB** |
 *
 * **It is exactly lossless, and that is not incidental.** `dt` is stored as
 * its raw IEEE-754 float64 bits, never quantized and never narrowed to
 * float32 — float32 cannot represent *any* of the 213,740 recorded `dt`
 * values exactly (checked, not assumed), and a replay is a deterministic
 * input stream, so a rounded `dt` would drift the simulation away from the
 * score that was actually recorded. That is precisely the silent-divergence
 * class `balanceHash.ts` exists to catch, and it would sail straight past it
 * because the balance fingerprint would still match.
 *
 * Two cheaper-looking ideas were measured and rejected: XOR-delta-encoding
 * `dt` against the previous frame (Gorilla-style) came out *larger* than the
 * raw bits once gzip had run, and quantizing `dt` to whole microseconds is
 * ~2x smaller again but only safe if the live game loop quantizes too —
 * otherwise playback and the recorded score disagree.
 */

import type { HighscoreEntry } from "./highscores";
import { RECORDED_KEYS, type InputSnapshot } from "./input";
import type { ReplayFrame } from "./replay";
import { base64ToBytes, bytesToBase64, gunzip, gzip } from "./storageCompression";

/** Prefix marking a stored board as "binary frame blocks, gzipped, base64".
 * Sits alongside `storageCompression.ts`'s `gz1:` rather than replacing it:
 * a board written by an older build still loads, and this module falls back
 * to that reader for anything not carrying this prefix. */
const BINARY_PREFIX = "bin1:";

/** Every `InputSnapshot` boolean except `fireQueued`-adjacent ordering
 * concerns — packed one per bit, in this fixed order. Adding a field means
 * appending to this list (never inserting), and bumping `BINARY_PREFIX`, or
 * previously stored boards decode with shifted flags. */
const PACKED_BOOLS = [
  "fireQueued",
  "fireHeld",
  "mapToggle",
  "interact",
  "melee",
  "meleeHeld",
  "fpsToggle",
  "escape",
  "blur",
  "pointerUnlock",
  "click",
  // Appended, never inserted — see this list's doc comment. Appending is
  // backward compatible: the writer already emits two boolean bytes whenever
  // any flag is set (11 bits of 16 used before this one), so a board recorded
  // before reloading existed still decodes, with `reload` false throughout.
  // That is why `BINARY_PREFIX` does *not* need bumping here, and why the
  // shipped `defaultHighscore.ts` board still reads.
  "reload",
  // Appended for the same reason, and with the same arithmetic still holding:
  // this is bit 12 of the 16 the two boolean bytes carry, so a board recorded
  // before the coop help ping existed decodes with `helpPing` false and
  // `BINARY_PREFIX` again stays put.
  "helpPing",
] as const satisfies readonly (keyof InputSnapshot)[];

/** Sentinel for `weaponRequest: null` in the one byte it occupies — a real
 * request is a number-key slot index, never anywhere near 255. */
const NO_WEAPON_REQUEST = 0xff;

/** Grows a byte array without committing to a size up front. */
class ByteWriter {
  private bytes: number[] = [];
  private readonly scratch = new DataView(new ArrayBuffer(8));

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  /** LEB128, for lengths — a frame count is usually two bytes, not four. */
  varint(value: number): void {
    let v = value >>> 0;
    while (v > 0x7f) {
      this.u8((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.u8(v);
  }

  /** Raw IEEE-754 bits, big-endian. Lossless by construction — see this
   * module's doc comment for why nothing narrower is acceptable. */
  f64(value: number): void {
    this.scratch.setFloat64(0, value);
    for (let i = 0; i < 8; i++) this.u8(this.scratch.getUint8(i));
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Reads back exactly what `ByteWriter` wrote. */
class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** How many bytes have been consumed so far — lets a caller walk a run of
   * concatenated blocks without the container carrying explicit offsets. */
  get consumed(): number {
    return this.offset;
  }

  u8(): number {
    return this.bytes[this.offset++];
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }

  f64(): number {
    const value = this.view.getFloat64(this.offset);
    this.offset += 8;
    return value;
  }
}

/**
 * Pack one level's frames.
 *
 * Layout per frame: a held-key bitfield byte (indexed by `RECORDED_KEYS`), a
 * flags byte saying which optional groups follow, the two boolean bytes if
 * any boolean is set, the `dt` bits, and — only when something in it is
 * non-default — the "extras" group (`mouseDX`, `weaponRequest`, `wheelSteps`
 * and the three gamepad axes). Measured on the shipped board, the extras
 * group is needed on well under 1% of frames and the boolean bytes on about
 * 4%, so the common frame costs 10 bytes before gzip instead of 334.
 */
export function encodeReplayFrames(frames: readonly ReplayFrame[]): Uint8Array {
  const w = new ByteWriter();
  w.varint(frames.length);
  for (const frame of frames) {
    const input = frame.input;

    let keyBits = 0;
    for (let i = 0; i < RECORDED_KEYS.length; i++) {
      if (input.keys.includes(RECORDED_KEYS[i])) keyBits |= 1 << i;
    }
    let boolBits = 0;
    for (let i = 0; i < PACKED_BOOLS.length; i++) {
      if (input[PACKED_BOOLS[i]]) boolBits |= 1 << i;
    }
    const hasExtras =
      input.mouseDX !== 0 ||
      input.weaponRequest !== null ||
      input.wheelSteps !== 0 ||
      input.gpForward !== 0 ||
      input.gpStrafe !== 0 ||
      input.gpTurn !== 0;

    w.u8(keyBits);
    w.u8((boolBits !== 0 ? 1 : 0) | (hasExtras ? 2 : 0));
    if (boolBits !== 0) {
      w.u8(boolBits & 0xff);
      w.u8((boolBits >> 8) & 0xff);
    }
    w.f64(frame.dt);
    if (hasExtras) {
      w.f64(input.mouseDX);
      w.u8(input.weaponRequest === null ? NO_WEAPON_REQUEST : input.weaponRequest);
      w.f64(input.wheelSteps);
      w.f64(input.gpForward);
      w.f64(input.gpStrafe);
      w.f64(input.gpTurn);
    }
  }
  return w.finish();
}

/** Inverse of `encodeReplayFrames`. */
export function decodeReplayFrames(bytes: Uint8Array): ReplayFrame[] {
  return decodeReplayFramesAt(new ByteReader(bytes));
}

/** The body of `decodeReplayFrames`, reading from a shared cursor so
 * `unpackBoardFromStorage` can walk consecutive blocks in one pass. */
function decodeReplayFramesAt(r: ByteReader): ReplayFrame[] {
  const count = r.varint();
  const frames: ReplayFrame[] = [];
  for (let i = 0; i < count; i++) {
    const keyBits = r.u8();
    const flags = r.u8();
    let boolBits = 0;
    if (flags & 1) boolBits = r.u8() | (r.u8() << 8);
    const dt = r.f64();

    const input: InputSnapshot = {
      keys: [],
      mouseDX: 0,
      fireQueued: false,
      fireHeld: false,
      weaponRequest: null,
      mapToggle: false,
      interact: false,
      reload: false,
      helpPing: false,
      melee: false,
      meleeHeld: false,
      wheelSteps: 0,
      fpsToggle: false,
      escape: false,
      blur: false,
      pointerUnlock: false,
      click: false,
      gpForward: 0,
      gpStrafe: 0,
      gpTurn: 0,
    };
    for (let k = 0; k < RECORDED_KEYS.length; k++) {
      if (keyBits & (1 << k)) input.keys.push(RECORDED_KEYS[k]);
    }
    for (let b = 0; b < PACKED_BOOLS.length; b++) {
      if (boolBits & (1 << b)) input[PACKED_BOOLS[b]] = true;
    }
    if (flags & 2) {
      input.mouseDX = r.f64();
      const requested = r.u8();
      input.weaponRequest = requested === NO_WEAPON_REQUEST ? null : requested;
      input.wheelSteps = r.f64();
      input.gpForward = r.f64();
      input.gpStrafe = r.f64();
      input.gpTurn = r.f64();
    }
    frames.push({ dt, input });
  }
  return frames;
}

/**
 * Every level segment in the board, in a fixed depth-first order, so the
 * encoder and decoder walk the frame blocks in lockstep without the header
 * needing to carry explicit block offsets.
 */
function levelSegmentsOf(entries: readonly HighscoreEntry[]): { frames: ReplayFrame[] }[] {
  const segments: { frames: ReplayFrame[] }[] = [];
  for (const entry of entries) {
    for (const level of entry.replay?.levels ?? []) segments.push(level as { frames: ReplayFrame[] });
  }
  return segments;
}

/**
 * Serialize a highscore board for storage.
 *
 * Container layout, all of it gzipped and base64'd as one blob:
 * `[varint headerByteLength][header JSON][frame block]...`, where the header
 * is the whole board with every `frames` array emptied out, and the blocks
 * follow in `levelSegmentsOf` order.
 *
 * The frame blocks are raw bytes inside the gzip stream rather than base64
 * embedded in the JSON — measured, that difference is worth 1.31x (0.42 MB
 * of quota against 0.55 MB), because base64'ing before gzip hands the
 * compressor a 4/3-inflated alphabet it can only partly win back.
 */
export async function packBoardForStorage(entries: readonly HighscoreEntry[]): Promise<string> {
  const segments = levelSegmentsOf(entries);
  const blocks = segments.map((segment) => encodeReplayFrames(segment.frames));

  const header = JSON.parse(JSON.stringify(entries)) as HighscoreEntry[];
  for (const level of levelSegmentsOf(header)) level.frames = [];
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const lengthPrefix = new ByteWriter();
  lengthPrefix.varint(headerBytes.length);
  const prefixBytes = lengthPrefix.finish();

  const total = prefixBytes.length + headerBytes.length + blocks.reduce((sum, b) => sum + b.length, 0);
  const container = new Uint8Array(total);
  let offset = 0;
  container.set(prefixBytes, offset);
  offset += prefixBytes.length;
  container.set(headerBytes, offset);
  offset += headerBytes.length;
  for (const block of blocks) {
    container.set(block, offset);
    offset += block.length;
  }

  return BINARY_PREFIX + bytesToBase64(await gzip(container));
}

/** Whether `raw` was written by `packBoardForStorage`. Callers that also
 * handle the older `gz1:`/plain-JSON forms use this to pick a reader. */
export function isBinaryBoard(raw: string): boolean {
  return raw.startsWith(BINARY_PREFIX);
}

/** Inverse of `packBoardForStorage`. Only valid for a `bin1:` value — check
 * `isBinaryBoard` first and fall back to `decompressFromStorage` otherwise. */
export async function unpackBoardFromStorage(raw: string): Promise<HighscoreEntry[]> {
  const container = await gunzip(base64ToBytes(raw.slice(BINARY_PREFIX.length)));
  const r = new ByteReader(container);
  const headerLength = r.varint();
  const headerStart = r.consumed;
  const headerBytes = container.subarray(headerStart, headerStart + headerLength);
  const entries = JSON.parse(new TextDecoder().decode(headerBytes)) as HighscoreEntry[];

  // One continuous pass over the concatenated blocks, in the same order
  // `packBoardForStorage` wrote them — `ByteReader` carries the cursor, so
  // no block needs a length header and nothing is decoded twice.
  const blocks = new ByteReader(container.subarray(headerStart + headerLength));
  for (const level of levelSegmentsOf(entries)) level.frames = decodeReplayFramesAt(blocks);
  return entries;
}
