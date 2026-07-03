/**
 * Keyboard + mouse input for the engine.
 *
 * Tracks held keys (polled each frame by the game loop) and accumulates
 * relative mouse motion while the canvas holds a pointer lock. Clicking the
 * canvas requests the lock; Esc releases it (handled by the browser).
 */
const MOVEMENT_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD"]);

export class InputController {
  private readonly keys = new Set<string>();
  /** Accumulated horizontal mouse delta since the last poll. */
  private mouseDX = 0;
  private attached = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("click", this.onCanvasClick);
    document.addEventListener("mousemove", this.onMouseMove);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("click", this.onCanvasClick);
    document.removeEventListener("mousemove", this.onMouseMove);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.keys.clear();
    this.mouseDX = 0;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Return accumulated mouse-x since last call and reset it. */
  consumeMouseDX(): number {
    const dx = this.mouseDX;
    this.mouseDX = 0;
    return dx;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (MOVEMENT_KEYS.has(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  // Dropping focus (alt-tab, etc.) should release all keys to avoid "stuck" input.
  private readonly onBlur = (): void => {
    this.keys.clear();
  };

  private readonly onCanvasClick = (): void => {
    if (document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock();
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === this.canvas) {
      this.mouseDX += e.movementX;
    }
  };
}
