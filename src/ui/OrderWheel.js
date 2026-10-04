// =====================================================================
//  OrderWheel — 7단계 명령 휠 (J 누르고 있기). 명령 15개를 다섯 묶음(이동·자세·대형·사격 통제·기타)으로 둥글게 놓는다.
//   · 마우스로 고름 — 휠이 열려 있는 동안 시점은 돌지 않는다 (마우스 이동량이 휠 커서로). 끌어서 보기 환경은 화면 커서 위치.
//   · 좌클릭 = 수신호 (소리 없음 — 나를 볼 수 있는 분대원만), 우클릭 = 외치기 (모두 — 적도 들음). Game 이 실행하고 휠을 닫음
//     (수신호 팔 동작이 보이게 — 다음 명령은 J 를 다시 누름).
//   · 게임 시간은 멈추지 않는다 (걷기·총알 그대로). 숫자·받은 사람 수는 보여 주지 않는다 (누가 봤는지는 분대원이 움직이는 걸로).
// =====================================================================
import { ORDER_LABELS } from '../ai/FriendSquad.js';

export const ORDER_GROUPS = [
  { label: '이동', keys: ['follow', 'halt', 'moveTo', 'retreat'] },
  { label: '자세', keys: ['prone', 'hold'] },
  { label: '대형', keys: ['file', 'wedge', 'spread'] },
  { label: '사격 통제', keys: ['holdFire', 'freeFire', 'onMyShot', 'suppress'] },
  { label: '기타', keys: ['medic', 'ammo'] },
];
export const ORDER_KEYS = ORDER_GROUPS.flatMap((g) => g.keys);
// 시선 지점이 필요한 명령 (휠을 열 때 보던 곳)
const NEEDS_POINT = { moveTo: '보던 곳으로', retreat: '보던 방향으로', suppress: '보던 곳에' };

const N = ORDER_KEYS.length;
const STEP = 360 / N;
const R_IN = 58, R_OUT = 152, R_GROUP = 176, DEAD = 34, CUR_MAX = 170;
const DEG = Math.PI / 180;

/** 화면 각 (도, 0 = 위, 시계 방향) → 칸 번호 */
export function wheelIndex(dx, dy) {
  if (Math.hypot(dx, dy) < DEAD) return -1;
  let a = Math.atan2(dx, -dy) / DEG;   // 0 = 위, 오른쪽 +
  if (a < 0) a += 360;
  return Math.round(a / STEP) % N;
}

const pt = (r, deg) => [Math.sin(deg * DEG) * r, -Math.cos(deg * DEG) * r];
function arcPath(r0, r1, a0, a1) {
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  const big = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r1},${r1} 0 ${big} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${r0},${r0} 0 ${big} 0 ${x3.toFixed(1)},${y3.toFixed(1)}Z`;
}

export class OrderWheel {
  constructor(root) {
    const slices = ORDER_KEYS.map((k, i) => {
      const a = i * STEP;
      const [lx, ly] = pt((R_IN + R_OUT) / 2, a);
      return `<path class="ow-slice" data-i="${i}" d="${arcPath(R_IN, R_OUT, a - STEP / 2 + 0.6, a + STEP / 2 - 0.6)}"/>`
        + `<text class="ow-label" data-i="${i}" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${ORDER_LABELS[k]}</text>`;
    }).join('');
    let at = 0;
    const groups = ORDER_GROUPS.map((g, gi) => {
      const a0 = at * STEP - STEP / 2, a1 = (at + g.keys.length) * STEP - STEP / 2;
      at += g.keys.length;
      const [lx, ly] = pt(R_GROUP + 9, (a0 + a1) / 2);
      return `<path class="ow-group g${gi}" d="${arcPath(R_OUT + 4, R_GROUP - 2, a0 + 1, a1 - 1)}"/>`
        + `<text class="ow-glabel" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${g.label}</text>`;
    }).join('');
    root.insertAdjacentHTML('beforeend', `
      <div id="orderwheel">
        <svg viewBox="-200 -200 400 400">${groups}${slices}
          <circle class="ow-hub" r="${R_IN - 6}"/>
          <line class="ow-cursor" x1="0" y1="0" x2="0" y2="0"/>
          <circle class="ow-dot" r="4"/>
        </svg>
        <div class="ow-center"><div class="ow-name"></div><div class="ow-hint"></div></div>
        <div class="ow-foot">좌클릭 <b>수신호</b> (소리 없음 · 나를 보는 분대원만) · 우클릭 <b>외치기</b> (모두 · 적도 들음)</div>
      </div>`);
    this.el = root.querySelector('#orderwheel');
    this.slices = [...this.el.querySelectorAll('.ow-slice')];
    this.labels = [...this.el.querySelectorAll('.ow-label')];
    this.nameEl = this.el.querySelector('.ow-name');
    this.hintEl = this.el.querySelector('.ow-hint');
    this.cursorEl = this.el.querySelector('.ow-cursor');
    this.dotEl = this.el.querySelector('.ow-dot');
    this.open = false;
    this.index = -1;
    this.cx = 0; this.cy = 0;
    this._flash = null;     // { i, method, t }
    this._shown = -2;
  }

  get selected() { return this.index >= 0 ? ORDER_KEYS[this.index] : null; }

  show() {
    if (this.open) return;
    this.open = true;
    this.cx = 0; this.cy = 0; this.index = -1; this._shown = -2;
    this._flash = null;
    this.el.style.display = 'block';
    this._render();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.style.display = 'none';
  }

  /**
   * 커서 움직임: rel = {dx, dy} (잠금 — 마우스 이동량, 화면 px) 또는 abs = {x, y} (끌어서 보기 — 화면 가운데 기준 px)
   */
  move(rel, abs = null) {
    if (!this.open) return;
    const k = this._scale();
    if (abs) { this.cx = abs.x / k; this.cy = abs.y / k; } else if (rel) { this.cx += rel.dx * 0.9; this.cy += rel.dy * 0.9; }
    const l = Math.hypot(this.cx, this.cy);
    if (l > CUR_MAX) { this.cx *= CUR_MAX / l; this.cy *= CUR_MAX / l; }
    this.index = wheelIndex(this.cx, this.cy);
    this._render();
  }

  /** 실행한 명령 잠깐 표시 */
  flash(key, method) {
    const i = ORDER_KEYS.indexOf(key);
    this._flash = { i, method, t: 0.7 };
    this._shown = -2;
    this._render();
  }

  update(dt) {
    if (!this.open || !this._flash) return;
    this._flash.t -= dt;
    if (this._flash.t <= 0) { this._flash = null; this._shown = -2; this._render(); }
  }

  hideNow() { this.hide(); }

  // -----------------------------------------------------------------
  _scale() {
    // SVG 400 단위 = 요소 너비 px
    const w = this.el.clientWidth || 400;
    return w / 400;
  }

  _render() {
    this.cursorEl.setAttribute('x2', this.cx.toFixed(1));
    this.cursorEl.setAttribute('y2', this.cy.toFixed(1));
    this.dotEl.setAttribute('cx', this.cx.toFixed(1));
    this.dotEl.setAttribute('cy', this.cy.toFixed(1));
    const f = this._flash;
    const key = `${this.index}|${f ? f.i + f.method : ''}`;
    if (key === this._shown) return;
    this._shown = key;
    this.slices.forEach((el, i) => {
      el.classList.toggle('sel', i === this.index);
      el.classList.toggle('done', !!f && i === f.i);
    });
    this.labels.forEach((el, i) => el.classList.toggle('sel', i === this.index));
    if (f && f.i >= 0) {
      this.nameEl.textContent = ORDER_LABELS[ORDER_KEYS[f.i]];
      this.hintEl.textContent = f.method === 'signal' ? '수신호' : '외쳤다';
    } else if (this.index >= 0) {
      const k = ORDER_KEYS[this.index];
      this.nameEl.textContent = ORDER_LABELS[k];
      this.hintEl.textContent = NEEDS_POINT[k] ?? '';
    } else {
      this.nameEl.textContent = '명령';
      this.hintEl.textContent = '마우스로 고르기';
    }
  }
}
