// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-rolled `MediaRecorder`/`HTMLCanvasElement.captureStream()`/download
 * test doubles — none of `MediaRecorder`, `captureStream`, or
 * `URL.createObjectURL` exist in this project's pinned jsdom (confirmed:
 * `typeof URL.createObjectURL === "undefined"`), and a real
 * `HTMLAnchorElement.prototype.click()` on a `download` anchor still queues
 * a deferred "Not implemented: navigation" jsdom error (`download` doesn't
 * suppress it there) — all four need stubbing together for
 * `startReplay`'s recording feature to run under test at all. Not an npm
 * package, same dependency-minimalism reasoning as `canvas.ts`'s mock
 * context: the code under test only ever touches a handful of methods
 * (`new MediaRecorder(stream, opts)`, `.start()`, `.stop()`,
 * `ondataavailable`/`onstop`, the static `isTypeSupported`), not real
 * encoding/streaming.
 */
import { vi } from "vitest";

export class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  /** Every instance ever constructed this test run, oldest first — lets a
   * test inspect the most recently created recorder without `startReplay`
   * having to expose one. */
  static instances: FakeMediaRecorder[] = [];

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly start = vi.fn();
  /** Synchronous, unlike a real `MediaRecorder` (which fires
   * `ondataavailable`/`onstop` asynchronously) — this suite's other fakes
   * (e.g. `stubDialogElement`'s `close` event) take the same shortcut where
   * the async-vs-sync distinction doesn't matter to what's under test. */
  readonly stop = vi.fn(() => {
    this.ondataavailable?.({ data: new Blob(["frame"]) });
    this.onstop?.();
  });

  constructor(
    readonly stream: unknown,
    readonly options?: { mimeType?: string },
  ) {
    FakeMediaRecorder.instances.push(this);
  }
}

/** Installs everything `startReplay`'s recording feature (both the
 * transport bar's Record button and the Highscores dialog's auto-record
 * "Export" button) needs to run end-to-end under test: `MediaRecorder` as
 * a global, `captureStream` on the canvas prototype, and a download path
 * (`URL.createObjectURL`/`revokeObjectURL`, plus a stubbed anchor click so
 * jsdom doesn't log a spurious navigation error) that doesn't touch real
 * browser APIs. `MediaRecorder`/`URL.createObjectURL`/`revokeObjectURL` are
 * cleaned up by the suite's own `vi.unstubAllGlobals()` in the shared
 * `afterEach`; `captureStream` and the anchor click are prototype patches
 * that need the returned `restore()` called explicitly. */
export function installRecordingSupport(): { restore: () => void } {
  FakeMediaRecorder.instances.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });

  const canvasProto = HTMLCanvasElement.prototype as unknown as { captureStream?: unknown };
  const originalCaptureStream = canvasProto.captureStream;
  canvasProto.captureStream = vi.fn(() => ({}));

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = vi.fn();

  return {
    restore: () => {
      canvasProto.captureStream = originalCaptureStream;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    },
  };
}
