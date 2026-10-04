// 키보드·마우스 입력 + 포인터 잠금
//  마우스 버튼은 키와 같은 목록(down / pressedQueue)에 'Mouse0'(왼쪽)·'Mouse1'(가운데)·'Mouse2'(오른쪽)로 들어간다.
//  포인터 잠금 중(또는 끌어서 보기 중)에만 받는다 — 메뉴를 누른 클릭이 사격으로 새지 않게.
import { EventEmitter } from './EventEmitter.js';

// F7 = 일부 브라우저의 '캐럿 탐색' 토글, F3 = 찾기 — 게임 키로 쓰므로 막는다 (3단계: F9 피격 테스트)
const PREVENT = new Set(['Space', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input extends EventEmitter {
  constructor(element) {
    super();
    this.element = element;
    this.down = new Set();
    this.pressedQueue = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.clientX = window.innerWidth / 2;
    this.clientY = window.innerHeight / 2;
    this.locked = false;
    // 포인터 잠금을 쓸 수 없는 환경(일부 임베드 뷰 등): 마우스를 누른 채 끌어서 시점 이동
    //  (왼쪽·오른쪽 버튼 끌기 = 시점, 오른쪽 버튼 = 조준 그대로, 사격은 F)
    this.dragLook = false;
    this._dragging = false;
    element.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.dragLook) return;
      if (this.dragLook && (e.button === 0 || e.button === 2)) this._dragging = true;
      const code = `Mouse${e.button}`;
      if (!this.down.has(code)) this.pressedQueue.add(code);
      this.down.add(code);
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      this.down.delete(`Mouse${e.button}`);
      // 다른 버튼이 아직 눌려 있으면 끌기 유지 (조준한 채 시점 이동)
      if (!this.down.has('Mouse0') && !this.down.has('Mouse2')) this._dragging = false;
    });
    // 우클릭 = 조준 — 브라우저 메뉴가 뜨지 않게 (게임 화면 위에서만)
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => { if (this.locked || this.dragLook) e.preventDefault(); });

    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code) || ((this.locked || this.dragLook) && e.code !== 'Escape')) e.preventDefault();
      if (!e.repeat) this.pressedQueue.add(e.code);
      this.down.add(e.code);
      this.emit('keydown', e);
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => { this.down.clear(); this._dragging = false; });
    document.addEventListener('mousemove', (e) => {
      this.clientX = e.clientX; this.clientY = e.clientY;   // 7단계: 끌어서 보기 환경의 명령 휠·지도 연필 (화면 커서 위치)
      if (!this.locked && !(this.dragLook && this._dragging)) return;
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
