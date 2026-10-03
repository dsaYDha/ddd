// 키보드·마우스 입력 + 포인터 잠금
import { EventEmitter } from './EventEmitter.js';

const PREVENT = new Set(['Space', 'F3', 'F6', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']);

export class Input extends EventEmitter {
  constructor(element) {
    super();
    this.element = element;
    this.down = new Set();
    this.pressedQueue = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;

    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code) || (this.locked && e.code !== 'Escape')) e.preventDefault();
      if (!e.repeat) this.pressedQueue.add(e.code);
      this.down.add(e.code);
      this.emit('keydown', e);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // 일부 브라우저의 포인터 잠금 직후 튀는 값 무시
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.down.clear();
      this.emit('lockchange', this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.emit('lockerror'));
  }

  requestLock() {
    try {
      const p = this.element.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.element.requestPointerLock());
    } catch {
      this.element.requestPointerLock();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(codes) {
    if (Array.isArray(codes)) return codes.some((c) => this.down.has(c));
    return this.down.has(codes);
  }

  /** 이번 프레임에 눌렸는지 (한 번만 true) */
  pressed(codes) {
    const list = Array.isArray(codes) ? codes : [codes];
    let hit = false;
    for (const c of list) if (this.pressedQueue.has(c)) hit = true;
    return hit;
  }

  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = this.mouseDY = 0;
    return d;
  }

  endFrame() {
    this.pressedQueue.clear();
  }
}
