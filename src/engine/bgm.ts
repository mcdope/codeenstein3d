// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Custom background music, loaded from a local folder via the File System
 * Access API. Unlike `audio.ts`'s procedural sound effects, real audio files
 * are actual media — played through a plain `<audio>` element (so a large
 * file streams rather than needing a full up-front decode) routed into
 * `audio.ts`'s BGM bus via a single `MediaElementAudioSourceNode`. Tracks play
 * as a shuffled, looping playlist: the whole folder repeats once every track
 * in it has played, rather than any one file looping on its own.
 */
import { audio } from "./audio";

/** Extensions treated as playable BGM — mirrors the task's ".mp3/.ogg/.wav". */
const BGM_EXTENSIONS = /\.(mp3|ogg|wav)$/i;

export class BgmPlayer {
  private readonly el: HTMLAudioElement;
  /** Wired once, the first time a track actually plays — a second
   * `createMediaElementSource` call on the same element throws. */
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private handles: FileSystemFileHandle[] = [];
  /** Shuffled play order (indices into `handles`); re-shuffled per folder load. */
  private order: number[] = [];
  private cursor = 0;
  /** The currently-playing track's object URL, revoked as soon as it's
   * superseded so a long session doesn't leak one per track played. */
  private currentUrl: string | null = null;

  constructor() {
    this.el = new Audio();
    this.el.addEventListener("ended", () => void this.advance());
  }

  /** Number of BGM-eligible files found in the last loaded folder. */
  get trackCount(): number {
    return this.handles.length;
  }

  /**
   * Scan `dir` for `.mp3`/`.ogg`/`.wav` files (top-level only — a "BGM
   * folder" is meant to be a flat pile of tracks, not a nested workspace) and
   * start playing them, shuffled, as a looping playlist. Resolves to the
   * number of tracks found; 0 means the folder had nothing playable and
   * nothing was started.
   */
  async loadFolder(dir: FileSystemDirectoryHandle): Promise<number> {
    const handles: FileSystemFileHandle[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && BGM_EXTENSIONS.test(entry.name)) {
        handles.push(entry as FileSystemFileHandle);
      }
    }

    this.handles = handles;
    this.order = shuffledIndices(handles.length);
    this.cursor = 0;
    if (handles.length > 0) await this.playCurrent();
    return handles.length;
  }

  /** Stop playback without discarding the loaded playlist. */
  stop(): void {
    this.el.pause();
  }

  private async playCurrent(): Promise<void> {
    // Both callers (loadFolder, advance) already guard against an empty
    // playlist before ever reaching this call — belt-and-suspenders, not a
    // reachable branch.
    /* v8 ignore next */
    if (this.handles.length === 0) return;
    const handle = this.handles[this.order[this.cursor]];

    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = url;
    this.el.src = url;
    await this.wireAndPlay();
  }

  private async wireAndPlay(): Promise<void> {
    // The raw `<audio>` element plays on its own even without a Web Audio
    // graph wired up, so this needs its own check independent of `resume()`.
    if (audio.isSilenced()) return;
    if (!this.sourceNode) {
      const ctx = audio.resume();
      if (ctx) {
        this.sourceNode = ctx.createMediaElementSource(this.el);
        audio.connectBgmSource(this.sourceNode);
      }
    }
    // Autoplay is fine here — loading a folder is itself a user gesture (the
    // click that opened the directory picker), so the browser's autoplay
    // policy doesn't block it. A rejected play() (e.g. the tab lost focus
    // mid-await) just leaves playback paused rather than throwing.
    await this.el.play().catch(() => undefined);
  }

  private async advance(): Promise<void> {
    if (this.handles.length === 0) return;
    this.cursor = (this.cursor + 1) % this.order.length;
    await this.playCurrent();
  }
}

/** A random permutation of `0..n-1` (Fisher-Yates). */
function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Process-wide BGM player singleton, parallel to `audio`'s SFX singleton. */
export const bgm = new BgmPlayer();
