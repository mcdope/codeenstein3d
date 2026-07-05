// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Full-screen DOM overlays for a running level: the pre-level briefing, the
 * post-level commit summary, and the end-of-run screens ("Kernel Panic" /
 * "Build Successful"). The live status bar (stability, heap, keys, …) is
 * drawn natively on the canvas by the engine (see src/engine/hud.ts); this
 * module only owns overlays that pause the whole game until dismissed.
 */

/** AST/level stats shown on the pre-level briefing. */
export interface LevelStartInfo {
  campaign: string;
  levelName: string;
  roomCount: number;
  enemyCount: number;
}

/** Stats shown on the post-level commit summary. */
export interface CommitSummaryInfo {
  linesRefactored: number;
  bugsSquashed: number;
}

export class GameHud {
  /** Full-cover overlay (hidden until shown). Reused for every variant below. */
  readonly overlay: HTMLElement;

  private readonly overlayTitle: HTMLElement;
  private readonly overlayBody: HTMLElement;
  private readonly overlayBtn: HTMLButtonElement;
  private onAck: (() => void) | null = null;

  constructor() {
    this.overlay = el("div", "game-overlay hidden");
    this.overlay.innerHTML = `
      <div class="overlay-box">
        <h1 class="overlay-title"></h1>
        <div class="overlay-body"></div>
        <button type="button" class="overlay-btn"></button>
      </div>`;
    this.overlayTitle = must(this.overlay.querySelector(".overlay-title"));
    this.overlayBody = must(this.overlay.querySelector(".overlay-body"));
    this.overlayBtn = must(this.overlay.querySelector(".overlay-btn"));
    this.overlayBtn.addEventListener("click", () => this.dismiss());
  }

  showKernelPanic(onReturn: () => void): void {
    this.show(
      "kernel-panic",
      "KERNEL PANIC",
      [msgNode("System stability reached 0%. The process was terminated.")],
      "Return to file tree",
      onReturn,
    );
  }

  showBuildSuccessful(onReturn: () => void): void {
    this.show(
      "build-ok",
      "BUILD SUCCESSFUL",
      [msgNode("return statement reached. Exit code 0 — the module compiled clean.")],
      "Return to file tree",
      onReturn,
    );
  }

  /** Pre-level briefing: campaign/level identity and AST stats. Blocks play
   * until acknowledged — the engine isn't started until `onAck` fires. */
  showLevelStart(info: LevelStartInfo, onAck: () => void): void {
    this.show(
      "level-start",
      info.campaign,
      [
        msgNode(`Compiling ${info.levelName}…`),
        statList([
          ["Rooms", String(info.roomCount)],
          ["Enemies", String(info.enemyCount)],
        ]),
      ],
      "Start",
      onAck,
    );
  }

  /** Post-level commit summary, shown after reaching the exit and before the
   * next level (or the final Build Successful screen) loads. */
  showCommitSummary(info: CommitSummaryInfo, onAck: () => void): void {
    this.show(
      "commit-summary",
      "COMMIT SUMMARY",
      [
        statList([
          ["Lines refactored", String(info.linesRefactored)],
          ["Bugs squashed", String(info.bugsSquashed)],
        ]),
      ],
      "Continue",
      onAck,
    );
  }

  private show(
    variant: string,
    title: string,
    body: Node[],
    btnLabel: string,
    onAck: () => void,
  ): void {
    this.onAck = onAck;
    this.overlayTitle.textContent = title;
    this.overlayBody.replaceChildren(...body);
    this.overlayBtn.textContent = btnLabel;
    this.overlay.classList.remove("hidden", "kernel-panic", "build-ok", "level-start", "commit-summary");
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
    const cb = this.onAck;
    this.onAck = null;
    cb?.();
  }
}

/** A single `<p class="overlay-msg">` built via `textContent` — safe for
 * filesystem-derived strings (campaign/level names), never `innerHTML`. */
function msgNode(text: string): HTMLElement {
  const p = el("p", "overlay-msg");
  p.textContent = text;
  return p;
}

/** A `<dl class="overlay-stats">` of label/value rows, built via `textContent`
 * per cell — same injection-safety reasoning as `msgNode`. */
function statList(rows: [string, string][]): HTMLElement {
  const dl = el("dl", "overlay-stats");
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
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
