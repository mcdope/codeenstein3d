// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * HTML HUD for a running level: a doom/terminal-style status bar (bottom 20%)
 * plus full-screen end-of-run overlays ("Kernel Panic" / "Build Successful").
 *
 * The engine reports numbers via `update()`; this module only touches the DOM
 * (and only when a value actually changed, to avoid layout churn).
 */
import type { EngineStats } from "../engine/engine";

export class GameHud {
  /** Bottom status bar. */
  readonly bar: HTMLElement;
  /** Full-cover end-of-run overlay (hidden until shown). */
  readonly overlay: HTMLElement;

  private readonly healthFill: HTMLElement;
  private readonly healthVal: HTMLElement;
  private readonly ammoVal: HTMLElement;
  private readonly weaponVal: HTMLElement;
  private readonly keysVal: HTMLElement;
  private readonly enemiesVal: HTMLElement;
  private readonly targetVal: HTMLElement;

  private readonly overlayTitle: HTMLElement;
  private readonly overlayMsg: HTMLElement;
  private readonly overlayBtn: HTMLButtonElement;
  private onReturn: (() => void) | null = null;

  private last: Partial<EngineStats> = {};

  constructor() {
    this.bar = el("div", "hud");
    this.bar.innerHTML = `
      <div class="hud-stat hud-stat--health">
        <span class="hud-label">System Stability</span>
        <div class="hud-bar"><div class="hud-bar-fill"></div></div>
        <span class="hud-value hud-health-val">100%</span>
      </div>
      <div class="hud-stat">
        <span class="hud-label">Heap / RAM</span>
        <span class="hud-value hud-value--big hud-ammo">0</span>
      </div>
      <div class="hud-stat">
        <span class="hud-label">Weapon <span class="hud-weapon-keys">[1/2]</span></span>
        <span class="hud-value hud-weapon">—</span>
      </div>
      <div class="hud-stat">
        <span class="hud-label">Keys 🔑</span>
        <span class="hud-value hud-value--big hud-keys">0</span>
      </div>
      <div class="hud-stat">
        <span class="hud-label">Processes</span>
        <span class="hud-value hud-value--big hud-enemies">0</span>
      </div>
      <div class="hud-stat hud-stat--target">
        <span class="hud-label">Target</span>
        <span class="hud-value hud-target">—</span>
      </div>`;

    this.healthFill = must(this.bar.querySelector(".hud-bar-fill"));
    this.healthVal = must(this.bar.querySelector(".hud-health-val"));
    this.ammoVal = must(this.bar.querySelector(".hud-ammo"));
    this.weaponVal = must(this.bar.querySelector(".hud-weapon"));
    this.keysVal = must(this.bar.querySelector(".hud-keys"));
    this.enemiesVal = must(this.bar.querySelector(".hud-enemies"));
    this.targetVal = must(this.bar.querySelector(".hud-target"));

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

  /** Update the status bar from the latest engine stats. */
  update(stats: EngineStats): void {
    if (stats.health !== this.last.health) {
      const pct = Math.max(0, Math.min(100, (stats.health / stats.maxHealth) * 100));
      this.healthFill.style.width = `${pct}%`;
      this.healthFill.classList.toggle("hud-bar-fill--low", pct <= 30);
      this.healthVal.textContent = `${stats.health}%`;
    }
    if (stats.ammo !== this.last.ammo) {
      this.ammoVal.textContent = String(stats.ammo);
      this.ammoVal.classList.toggle("hud-value--empty", stats.ammo <= 0);
    }
    if (stats.weapon !== this.last.weapon) {
      this.weaponVal.textContent = stats.weapon;
    }
    if (stats.keysHeld !== this.last.keysHeld || stats.keysTotal !== this.last.keysTotal) {
      this.keysVal.textContent = `${stats.keysHeld}/${stats.keysTotal}`;
    }
    if (stats.enemiesRemaining !== this.last.enemiesRemaining) {
      this.enemiesVal.textContent = `${stats.enemiesRemaining}/${stats.totalEnemies}`;
    }
    if (stats.target !== this.last.target) {
      this.targetVal.textContent = stats.target ? `${stats.target}()` : "—";
      this.targetVal.classList.toggle("hud-target--active", stats.target !== null);
    }
    this.last = stats;
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
