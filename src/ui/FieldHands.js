// =====================================================================
//  FieldHands — 6단계 손 동작 화면 (숫자 없음, 캔버스 그림). 화면 아래쪽에서 손이 올라온다 — 그동안 총은 내려가 있다.
//   · drink: 수통을 들어 입으로 기울여 마심 (꿀꺽마다 살짝 출렁)
//   · refill: 개울물에 수통을 담금 — 물결·공기 방울
//   · probe: 대검 끝으로 발 앞 땅을 비스듬히 찔러 봄 (찌르고 빼기를 반복)
//   · disarm: 왼손으로 철선을 잡고 오른손 칼로 조심스럽게 끊음
//  밤에는 손이 어둡게 (setLight — 장면 빛 수준 + 손전등)
// =====================================================================
const W = 520, H = 360;

export class FieldHands {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `<div id="fieldhands"><canvas width="${W}" height="${H}"></canvas></div>`);
    this.el = root.querySelector('#fieldhands');
    this.ctx = this.el.querySelector('canvas').getContext('2d');
    this.k = 0;
    this.mode = null;
    this.time = 0;
    this._light = -1;
  }

  /** mode: 'drink'|'refill'|'probe'|'disarm'|null, p: 진행 0~1 */
  update(dt, mode, p = 0) {
    this.time += dt;
    if (mode) this.mode = mode;
    const target = mode ? 1 : 0;
    this.k += (target - this.k) * Math.min(1, dt * 6);
    if (this.k < 0.01 && !mode) { if (this.el.style.display !== 'none') this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    this.el.style.transform = `translate(-50%, ${(1 - this.k) * 100}%)`;
    this._draw(this.mode, p);
  }

  hideNow() { this.k = 0; this.mode = null; this.el.style.display = 'none'; }

  /** 장면 빛 (0~1) — 밤엔 손이 거의 안 보임 */
  setLight(v) {
    const b = Math.max(0.08, Math.min(1, v));
    if (Math.abs(b - this._light) < 0.02) return;
    this._light = b;
    this.el.style.filter = `drop-shadow(0 6px 16px rgba(0,0,0,0.55)) brightness(${b.toFixed(2)})`;
  }

  // -----------------------------------------------------------------
  _skin(c, x0, y0, x1, y1) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#9b7556'); g.addColorStop(1, '#6a4b34');
    return g;
  }

  _sleeve(c, x0, y0, x1, y1, w) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const g = c.createLinearGradient(x0 + nx * w * 0.5, y0 + ny * w * 0.5, x0 - nx * w * 0.5, y0 - ny * w * 0.5);
    g.addColorStop(0, '#363c25'); g.addColorStop(0.5, '#4f5734'); g.addColorStop(1, '#2c3120');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x0 + nx * w * 0.55, y0 + ny * w * 0.55); c.lineTo(x1 + nx * w * 0.38, y1 + ny * w * 0.38);
    c.lineTo(x1 - nx * w * 0.38, y1 - ny * w * 0.38); c.lineTo(x0 - nx * w * 0.55, y0 - ny * w * 0.55);
    c.closePath(); c.fill();
    c.strokeStyle = '#272b18'; c.lineWidth = 6;
    c.beginPath(); c.moveTo(x1 + nx * w * 0.4, y1 + ny * w * 0.4); c.lineTo(x1 - nx * w * 0.4, y1 - ny * w * 0.4); c.stroke();
  }

  /** 주먹 쥔 손 (중심 x,y, 회전 a, 크기 s) */
  _fist(c, x, y, a, s = 1) {
    c.save(); c.translate(x, y); c.rotate(a); c.scale(s, s);
    c.fillStyle = this._skin(c, -40, -30, 40, 30);
    c.beginPath(); c.ellipse(0, 0, 38, 30, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(40,25,15,0.35)'; c.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(-14 + i * 12, -24); c.quadraticCurveTo(-10 + i * 12, -8, -14 + i * 12, 6); c.stroke(); }
    c.restore();
  }

  /** 군용 수통 (콩팥 모양 녹색 플라스틱 + 검은 뚜껑) — 중심 x,y, 회전 a, 뚜껑 열림 */
  _canteen(c, x, y, a, open = true) {
    c.save(); c.translate(x, y); c.rotate(a);
    const g = c.createLinearGradient(-60, 0, 60, 0);
    g.addColorStop(0, '#2c3320'); g.addColorStop(0.45, '#56603a'); g.addColorStop(1, '#262c1b');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(-50, -70); c.quadraticCurveTo(-62, 0, -50, 80); c.quadraticCurveTo(0, 96, 50, 80); c.quadraticCurveTo(62, 0, 50, -70);
    c.quadraticCurveTo(0, -84, -50, -70); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 2; c.stroke();
    // 목 + 뚜껑
    c.fillStyle = '#1f2219'; c.fillRect(-16, -100, 32, 26);
    if (!open) { c.fillStyle = '#151612'; c.fillRect(-19, -108, 38, 14); }
    c.restore();
  }

  _draw(mode, p) {
    const c = this.ctx, t = this.time;
    c.clearRect(0, 0, W, H);
    c.lineCap = 'round'; c.lineJoin = 'round';
    const ease = (v) => v * v * (3 - 2 * v);
    if (mode === 'drink') {
      // 들어 올림 (0~0.2) → 기울여 마심 (꿀꺽마다 출렁) → 내림 (0.9~1)
      const up = p < 0.2 ? ease(p / 0.2) : p > 0.9 ? 1 - ease((p - 0.9) / 0.1) : 1;
      const gulp = Math.sin(t * 9) * 0.03 * (p > 0.2 && p < 0.9 ? 1 : 0);
      const x = W * 0.52, y = H * (1.05 - 0.62 * up);
      const a = -0.25 - 1.15 * up + gulp;
      this._sleeve(c, W * 0.95, H + 60, x + 70, y + 90, 80);
      this._canteen(c, x, y, a, true);
      this._fist(c, x + 30, y + 40, a - 0.4, 1.05);
      // 물방울 (입가)
      if (up > 0.8 && Math.sin(t * 5) > 0.6) {
        c.fillStyle = 'rgba(200,215,225,0.7)';
        c.beginPath(); c.ellipse(x - 70, y - 70 + (t * 60) % 40, 2.5, 4, 0, 0, Math.PI * 2); c.fill();
      }
    } else if (mode === 'refill') {
      // 물 (아래쪽 띠, 물결) + 반쯤 잠긴 수통 + 공기 방울
      const x = W * 0.48, y = H * 0.68 + Math.sin(t * 1.7) * 3;
      this._sleeve(c, W * 0.92, H + 60, x + 80, y + 10, 78);
      this._canteen(c, x, y, 0.95, true);
      this._fist(c, x + 50, y - 10, 0.5, 1.05);
      const wy = H * 0.62;
      const wg = c.createLinearGradient(0, wy, 0, H);
      wg.addColorStop(0, 'rgba(60,75,70,0.82)'); wg.addColorStop(1, 'rgba(25,32,28,0.95)');
      c.fillStyle = wg;
      c.beginPath(); c.moveTo(0, wy);
      for (let i = 0; i <= 26; i++) { const xx = (i / 26) * W; c.lineTo(xx, wy + Math.sin(i * 0.9 + t * 3) * 3); }
      c.lineTo(W, H); c.lineTo(0, H); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(190,205,200,0.35)'; c.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) {
        const r = ((t * 40 + k * 30) % 90);
        c.beginPath(); c.ellipse(x - 70, wy + 4, r, r * 0.22, 0, 0, Math.PI * 2); c.stroke();
      }
      c.fillStyle = 'rgba(210,225,220,0.6)';
      for (let k = 0; k < 6; k++) {
        const bt = (t * 1.6 + k * 0.37) % 1;
        c.beginPath(); c.arc(x - 70 + Math.sin(k * 2 + t * 4) * 6, wy + 40 - bt * 40, 2 + (k % 3), 0, Math.PI * 2); c.fill();
      }
    } else if (mode === 'probe') {
      // 땅 (낙엽·흙) + 대검을 비스듬히 찌름
      const gy = H * 0.62;
      const gg = c.createLinearGradient(0, gy, 0, H);
      gg.addColorStop(0, '#3a2c1c'); gg.addColorStop(1, '#1e1610');
      c.fillStyle = gg; c.fillRect(0, gy, W, H - gy);
      c.fillStyle = 'rgba(110,80,40,0.55)';
      for (let i = 0; i < 26; i++) {
        const lx = (i * 97) % W, ly = gy + 8 + ((i * 53) % (H - gy - 10));
        c.beginPath(); c.ellipse(lx, ly, 14, 6, (i * 0.7) % 3, 0, Math.PI * 2); c.fill();
      }
      const poke = Math.max(0, Math.sin(t * Math.PI * 2 / 0.5)) ** 2;
      const x = W * 0.52 - poke * 14, y = H * 0.46 + poke * 22;
      // 칼날 (손에서 아래 왼쪽으로)
      c.save(); c.translate(x, y); c.rotate(2.25);
      const bg = c.createLinearGradient(0, -8, 0, 8);
      bg.addColorStop(0, '#9ea29c'); bg.addColorStop(0.5, '#62665f'); bg.addColorStop(1, '#3a3d39');
      c.fillStyle = bg;
      c.beginPath(); c.moveTo(0, -9); c.lineTo(150, -4); c.lineTo(178, 0); c.lineTo(150, 6); c.lineTo(0, 9); c.closePath(); c.fill();
      c.fillStyle = '#2a2a24'; c.fillRect(-18, -14, 12, 28);
      c.fillStyle = '#3b3326'; c.fillRect(-80, -11, 62, 22);
      c.restore();
      this._sleeve(c, W * 0.98, H + 50, x + 70, y - 10, 76);
      this._fist(c, x + 20, y - 20, 0.6, 1.0);
    } else if (mode === 'disarm') {
      // 철선 (가로) + 왼손이 잡음 + 오른손 칼이 다가가 끊음 (p 가 1 에 가까우면 끊김)
      const wy = H * 0.5;
      const cut = p > 0.93;
      c.strokeStyle = 'rgba(160,165,155,0.9)'; c.lineWidth = 1.6;
      if (!cut) { c.beginPath(); c.moveTo(0, wy + 6); c.lineTo(W, wy - 4); c.stroke(); } else {
        c.beginPath(); c.moveTo(0, wy + 6); c.lineTo(W * 0.5, wy + 20); c.stroke();
        c.beginPath(); c.moveTo(W * 0.55, wy + 24); c.lineTo(W, wy - 4); c.stroke();
      }
      // 왼손 (철선을 잡음)
      this._sleeve(c, -60, H + 60, W * 0.3, wy + 70, 78);
      this._fist(c, W * 0.33, wy + 24, -0.3, 0.95);
      // 오른손 + 칼 (천천히 다가감)
      const k = Math.min(1, p / 0.9), jit = Math.sin(t * 13) * 1.5;
      const x = W * (0.82 - 0.22 * k) + jit, y = wy + 40 - 10 * k;
      c.save(); c.translate(x, y); c.rotate(-2.6);
      c.fillStyle = '#80847e';
      c.beginPath(); c.moveTo(0, -6); c.lineTo(90, -2); c.lineTo(104, 0); c.lineTo(90, 4); c.lineTo(0, 6); c.closePath(); c.fill();
      c.fillStyle = '#3b3326'; c.fillRect(-55, -9, 50, 18);
      c.restore();
      this._sleeve(c, W + 60, H + 60, x + 50, y + 40, 76);
      this._fist(c, x + 30, y + 22, 0.4, 0.95);
    }
    // 아래 가장자리 그늘
    const vg = c.createLinearGradient(0, H * 0.55, 0, H);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    c.fillStyle = vg; c.fillRect(0, H * 0.55, W, H * 0.45);
  }
}
