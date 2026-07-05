// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Full-screen end-of-run overlays ("Kernel Panic" / "Build Successful") for a
 * running level. The live status bar (stability, heap, keys, …) is now drawn
 * natively on the canvas by the engine (see src/engine/hud.ts); this module
 * only owns the DOM overlay shown when a run ends.
 */
export class GameHud {
  /** Full-cover end-of-run overlay (hidden until shown). */
  readonly overlay: HTMLElement;

  private readonly overlayTitle: HTMLElement;
  private readonly overlayMsg: HTMLElement;
  private readonly overlayBtn: HTMLButtonElement;
  private onReturn: (() => void) | null = null;

  constructor() {
    this.overlay = el("div", "game-overlay hidden");
    this.overlay.innerHTML = `
      <div class="overlay-box">
        <h1 class="overlay-title">KERNEL PANIC</h1>
        <p class="overlay-msg"></p>
        <button type="button" class="overlay-btn">Return to file tree</button>
      </div>`;
    this.overlayTitle = must(this.overlay.querySelector(".overlay-title"));
    this.overlayMsg = must(this.overlay.querySelector(".overlay-msg"));
    this.overlayBtn = must(this.overlay.querySelector(".overlay-btn"));
    this.overlayBtn.addEventListener("click", () => this.dismiss());
  }

  showKernelPanic(onReturn: () => void): void {
    this.showOverlay(
      "kernel-panic",
      "KERNEL PANIC",
      "System stability reached 0%. The process was terminated.",
      onReturn,
    );
  }

  showBuildSuccessful(onReturn: () => void): void {
    this.showOverlay(
      "build-ok",
      "BUILD SUCCESSFUL",
      "return statement reached. Exit code 0 — the module compiled clean.",
      onReturn,
    );
  }

  private showOverlay(
    variant: string,
    title: string,
    msg: string,
    onReturn: () => void,
  ): void {
    this.onReturn = onReturn;
    this.overlayTitle.textContent = title;
    this.overlayMsg.textContent = msg;
    this.overlay.classList.remove("hidden", "kernel-panic", "build-ok");
    this.overlay.classList.add(variant);
    this.overlayBtn.focus();
    document.addEventListener("keydown", this.onOverlayKey);
  }

  private readonly onOverlayKey = (e: KeyboardEvent): void => {
    if (e.code === "Enter" || e.code === "Space" || e.code === "Escape") {
      e.preventDefault();
      this.dismiss();
    }
  };

  private dismiss(): void {
    document.removeEventListener("keydown", this.onOverlayKey);
    this.overlay.classList.add("hidden");
    const cb = this.onReturn;
    this.onReturn = null;
    cb?.();
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function must<T extends Element>(node: T | null): T {
  if (!node) throw new Error("GameHud: missing element");
  return node;
}
