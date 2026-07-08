import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputController } from './input';

describe('InputController', () => {
  let canvas: HTMLCanvasElement;
  let controller: InputController;

  beforeEach(() => {
    document.exitPointerLock = vi.fn();
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    controller = new InputController(canvas);
    controller.attach();
  });

  afterEach(() => {
    controller.detach();
    document.body.removeChild(canvas);
    vi.restoreAllMocks();
  });

  it('handles attach and detach gracefully', () => {
    controller.attach();
    controller.detach();
    controller.detach();
  });

  it('records key presses via isDown() and captureSnapshot()', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'KeyW' });
    window.dispatchEvent(eventDown);
    expect(controller.isDown('KeyW')).toBe(true);

    const snapshot = controller.captureSnapshot();
    expect(snapshot.keys).toContain('KeyW');

    const eventUp = new KeyboardEvent('keyup', { code: 'KeyW' });
    window.dispatchEvent(eventUp);
    expect(controller.isDown('KeyW')).toBe(false);
  });

  it('handles Space bar for fire Queued', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Space' });
    const preventSpy = vi.spyOn(eventDown, 'preventDefault');
    window.dispatchEvent(eventDown);
    expect(preventSpy).toHaveBeenCalled();
    expect(controller.consumeFire()).toBe(true);
    expect(controller.consumeFire()).toBe(false);
  });
  
  it('ignores Space bar auto-repeat for fire Queued', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Space', repeat: true });
    window.dispatchEvent(eventDown);
    expect(controller.consumeFire()).toBe(false); 
  });

  it('isFireHeld reflects Space or mouse state', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Space' });
    window.dispatchEvent(eventDown);
    expect(controller.isFireHeld()).toBe(true);
    
    const eventUp = new KeyboardEvent('keyup', { code: 'Space' });
    window.dispatchEvent(eventUp);
    expect(controller.isFireHeld()).toBe(false);
  });

  it('handles weapon request with digit and numpad keys', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Digit3' });
    window.dispatchEvent(eventDown);
    expect(controller.consumeWeaponRequest()).toBe(2);
    
    const eventDown2 = new KeyboardEvent('keydown', { code: 'Numpad4' });
    window.dispatchEvent(eventDown2);
    expect(controller.consumeWeaponRequest()).toBe(3);
    
    const eventDown3 = new KeyboardEvent('keydown', { code: 'KeyW' });
    window.dispatchEvent(eventDown3);
    expect(controller.consumeWeaponRequest()).toBe(null);
  });

  it('handles Tab for map toggle', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Tab' });
    const preventSpy = vi.spyOn(eventDown, 'preventDefault');
    window.dispatchEvent(eventDown);
    
    expect(preventSpy).toHaveBeenCalled();
    expect(controller.consumeMapToggle()).toBe(true);
    expect(controller.consumeMapToggle()).toBe(false);
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'Tab', repeat: true });
    window.dispatchEvent(eventRepeat);
    expect(controller.consumeMapToggle()).toBe(false);
  });

  it('handles KeyR for interact', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'KeyR' });
    window.dispatchEvent(eventDown);
    expect(controller.consumeInteract()).toBe(true);
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'KeyR', repeat: true });
    window.dispatchEvent(eventRepeat);
    expect(controller.consumeInteract()).toBe(false);
  });

  it('handles ControlLeft for melee', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'ControlLeft' });
    window.dispatchEvent(eventDown);
    expect(controller.consumeMelee()).toBe(true);
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'ControlLeft', repeat: true });
    window.dispatchEvent(eventRepeat);
    expect(controller.consumeMelee()).toBe(false);
  });

  it('handles ControlRight for fps toggle', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'ControlRight' });
    window.dispatchEvent(eventDown);
    expect(controller.consumeFpsToggle()).toBe(true);
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'ControlRight', repeat: true });
    window.dispatchEvent(eventRepeat);
    expect(controller.consumeFpsToggle()).toBe(false);
  });

  it('handles Escape for pause/escape queue', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'Escape' });
    window.dispatchEvent(eventDown);
    expect(controller.consumeEscape()).toBe(true);
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'Escape', repeat: true });
    window.dispatchEvent(eventRepeat);
    expect(controller.consumeEscape()).toBe(false);
  });

  it('handles KeyF for fullscreen', () => {
    canvas.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.exitFullscreen = vi.fn().mockResolvedValue(undefined);
    
    const eventDown = new KeyboardEvent('keydown', { code: 'KeyF' });
    const preventSpy = vi.spyOn(eventDown, 'preventDefault');
    window.dispatchEvent(eventDown);
    
    expect(preventSpy).toHaveBeenCalled();
    expect(canvas.requestFullscreen).toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => canvas,
    });

    const eventDown2 = new KeyboardEvent('keydown', { code: 'KeyF' });
    window.dispatchEvent(eventDown2);
    expect(document.exitFullscreen).toHaveBeenCalled();
    
    const eventRepeat = new KeyboardEvent('keydown', { code: 'KeyF', repeat: true });
    window.dispatchEvent(eventRepeat);
    
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
  });
  
  it('prevents default for movement keys', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'KeyW' });
    const preventSpy = vi.spyOn(eventDown, 'preventDefault');
    window.dispatchEvent(eventDown);
    expect(preventSpy).toHaveBeenCalled();
  });

  it('handles blur event', () => {
    const eventDown = new KeyboardEvent('keydown', { code: 'KeyW' });
    window.dispatchEvent(eventDown);
    expect(controller.isDown('KeyW')).toBe(true);
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    expect(controller.isFireHeld()).toBe(true);
    
    const blurEvent = new FocusEvent('blur');
    window.dispatchEvent(blurEvent);
    
    expect(controller.isDown('KeyW')).toBe(false);
    expect(controller.consumeBlur()).toBe(true);
    expect(controller.isFireHeld()).toBe(false);
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
  });

  it('handles canvas click to request pointer lock', () => {
    canvas.requestPointerLock = vi.fn();
    const clickEvent = new MouseEvent('click');
    canvas.dispatchEvent(clickEvent);
    
    expect(controller.consumeClick()).toBe(true);
    expect(canvas.requestPointerLock).toHaveBeenCalled();
  });

  it('does not request pointer lock if already locked', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    canvas.requestPointerLock = vi.fn();
    
    const clickEvent = new MouseEvent('click');
    canvas.dispatchEvent(clickEvent);
    
    expect(controller.consumeClick()).toBe(true);
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
  });

  it('handles mousedown for fire if pointer locked', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    
    const mousedownEvent = new MouseEvent('mousedown');
    canvas.dispatchEvent(mousedownEvent);
    
    expect(controller.consumeFire()).toBe(true);
    expect(controller.isFireHeld()).toBe(true);
    
    const mouseupEvent = new MouseEvent('mouseup');
    window.dispatchEvent(mouseupEvent);
    expect(controller.isFireHeld()).toBe(false);
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
  });

  it('ignores mousedown/mousemove if pointer is not locked', () => {
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    
    const event1 = new MouseEvent('mousemove');
    Object.defineProperty(event1, 'movementX', { value: 5 });
    document.dispatchEvent(event1);
    
    expect(controller.consumeFire()).toBe(false);
    expect(controller.isFireHeld()).toBe(false);
    expect(controller.consumeMouseDX()).toBe(0);
  });

  it('handles mousemove for DX if pointer locked', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    
    const event1 = new MouseEvent('mousemove');
    Object.defineProperty(event1, 'movementX', { value: 15 });
    document.dispatchEvent(event1);
    
    expect(controller.consumeMouseDX()).toBe(15);
    expect(controller.consumeMouseDX()).toBe(0);
    
    const event2 = new MouseEvent('mousemove');
    Object.defineProperty(event2, 'movementX', { value: -5 });
    document.dispatchEvent(event2);
    
    expect(controller.consumeMouseDX()).toBe(-5);
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
  });

  it('handles wheel events using sign interpolation', () => {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
    
    expect(controller.consumeWheelSteps()).toBe(0);
    
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 50 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 50 }));
    
    expect(controller.consumeWheelSteps()).toBe(2);
  });

  it('handles cheat codes sequence matching', () => {
    const typeCheat = (str: string) => {
      for (const char of str) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: char }));
      }
    };
    
    typeCheat('IDDQD');
    expect(controller.consumeCheat()).toBe('IDDQD');
    expect(controller.consumeCheat()).toBe(null);
    
    typeCheat('XYIDKFA');
    expect(controller.consumeCheat()).toBe('IDKFA');
    
    typeCheat('IDCL');
    typeCheat('123'); 
    typeCheat('IP');
    expect(controller.consumeCheat()).toBe('IDCLIP');
  });

  it('polls gamepad safely when Gamepad API is missing', () => {
    const originalGetGamepads = navigator.getGamepads;
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: undefined,
    });
    
    controller.pollGamepad();
    
    expect(controller.gamepadForward()).toBe(-0);
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadTurn()).toBe(0);
    expect(controller.isFireHeld()).toBe(false);
    
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: originalGetGamepads,
    });
  });

  it('polls gamepad safely with no gamepads connected', () => {
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [null, null],
    });
    
    controller.pollGamepad();
    
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadForward()).toBe(-0);
    expect(controller.gamepadTurn()).toBe(0);
  });

  it('polls gamepad with a connected gamepad interpreting axes and buttons', () => {
    const mockGamepad = {
      axes: [0.5, -0.8, 0.2],
      buttons: [
        { pressed: false },
        { pressed: true },  // 1: B (Melee)
        { pressed: false },
        { pressed: false },
        { pressed: true },  // 4: LB (Previous Weapon)
        { pressed: false }, // 5: RB
        { pressed: false },
        { pressed: true },  // 7: RT (Fire)
      ]
    } as any;
    
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [mockGamepad],
    });
    
    controller.pollGamepad();
    
    expect(controller.gamepadStrafe()).toBe(0.5);
    expect(controller.gamepadForward()).toBe(0.8);
    expect(controller.gamepadTurn()).toBe(0.2);
    
    expect(controller.consumeFire()).toBe(true);
    expect(controller.isFireHeld()).toBe(true);
    
    expect(controller.consumeWheelSteps()).toBe(-1);
    expect(controller.consumeMelee()).toBe(true);
    
    controller.pollGamepad();
    expect(controller.consumeFire()).toBe(false);
    expect(controller.isFireHeld()).toBe(true);
    expect(controller.consumeWheelSteps()).toBe(0);
    expect(controller.consumeMelee()).toBe(false);
  });

  it('polls gamepad applying deadzone', () => {
    const mockGamepad = {
      axes: [0.1, -0.1, 0.17],
      buttons: []
    } as any;
    
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [mockGamepad],
    });
    
    controller.pollGamepad();
    expect(controller.gamepadStrafe()).toBe(0);
    expect(controller.gamepadForward()).toBe(-0);
    expect(controller.gamepadTurn()).toBe(0);
  });

  it('polls gamepad buttons right bumper (next weapon) and R3 (melee)', () => {
    const mockGamepad = {
      axes: [],
      buttons: Array(15).fill({ pressed: false })
    } as any;
    mockGamepad.buttons[5] = { pressed: true };
    mockGamepad.buttons[11] = { pressed: true };
    
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [mockGamepad],
    });
    
    controller.pollGamepad();
    expect(controller.consumeWheelSteps()).toBe(1);
    expect(controller.consumeMelee()).toBe(true);
  });
  
  it('captureSnapshot captures accurate one-shot engine snapshot', () => {
    const snapshot = controller.captureSnapshot();
    expect(snapshot).toEqual({
      keys: [],
      mouseDX: 0,
      fireQueued: false,
      fireHeld: false,
      weaponRequest: null,
      mapToggle: false,
      interact: false,
      melee: false,
      wheelSteps: 0,
      fpsToggle: false,
      escape: false,
      blur: false,
      click: false,
      gpForward: -0,
      gpStrafe: 0,
      gpTurn: 0,
    });
  });

  it('detaching removes pointer lock if held', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => canvas,
    });
    
    document.exitPointerLock = vi.fn();
    controller.detach();
    expect(document.exitPointerLock).toHaveBeenCalled();
    
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });
  });
});
