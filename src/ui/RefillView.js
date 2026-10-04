// =====================================================================
//  RefillView — 5단계 탄창 채우기 화면 (숫자 없음). 화면 아래쪽에 두 손과 탄창:
//   왼손이 굽은 강철 탄창을 쥐고, 오른손 엄지가 낱발을 하나씩 탄창 입구에 눌러 넣는다 (AmmoPouch.progress 로 한 발 주기:
//   주머니에서 집기 → 입구에 대기 → 엄지로 누름). 'round' 이벤트마다 탄창이 살짝 내려앉음.
//   채우는 동안 총은 화면에서 내려가 있다 (Game 이 WeaponView 를 숨김).
// =====================================================================
const W = 460, H = 330;

export class RefillView {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `<div id="refillview"><canvas width="${W}" height="${H}"></canvas></div>`);
    this.el = root.querySelector('#refillview');
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.k = 0;            // 올라온 정도 0~1
    this.bump = 0;         // 탄이 들어간 순간 탄창 흔들림
    this.fill = 0;         // 탄창에 보이는 탄 높이 (탄창 실제 양의 비율, 대충)
    this.active = false;
  }

  /** 탄 하나 들어감 (탄창 몇 발 / 용량) */
  round(rounds, capacity) {
    this.bump = 1;
    this.fill = Math.min(1, rounds / Math.max(1, capacity));
  }

  start(rounds, capacity) { this.fill = Math.min(1, rounds / Math.max(1, capacity)); }

  /** active: 채우는 중, progress: 이번 발 0~1 */
  update(dt, active, progress) {
    const target = active ? 1 : 0;
    this.k += (target - this.k) * Math.min(1, dt * 7);
    if (this.k < 0.01 && !active) { if (this.el.style.display !== 'none') this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    this.bump = Math.max(0, this.bump - dt * 6);
    this.el.style.transform = `translate(-50%, ${(1 - this.k) * 100}%)`;
    this._draw(progress);
  }

  hideNow() { this.k = 0; this.el.style.display = 'none'; }

  _draw(p) {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.lineCap = 'round'; c.lineJoin = 'round';
    const ease = (t) => t * t * (3 - 2 * t);
    const mx = W * 0.46, my = H * 0.36 + this.bump * 4;   // 탄창 입구 (멈치)
    const tilt = -0.14;
    // ---- 왼팔 소매 (아래 왼쪽에서) + 손목
    this._sleeve(c, -40, H + 30, mx - 70, my + 175, 74);
    // ---- 탄창 (굽은 강철, 앞으로 휨) — 왼손이 앞쪽을 감싸 쥠
    c.save();
    c.translate(mx, my); c.rotate(tilt);
    const magH = 190;
    const body = new Path2D();
    body.moveTo(-23, 0); body.lineTo(23, 0);
    body.quadraticCurveTo(30, magH * 0.55, 64, magH);
    body.lineTo(12, magH + 8);
    body.quadraticCurveTo(-16, magH * 0.6, -23, 0);
    body.closePath();
    const g = c.createLinearGradient(-30, 0, 40, 0);
    g.addColorStop(0, '#141514'); g.addColorStop(0.35, '#3b3d3b'); g.addColorStop(0.55, '#2a2b2a'); g.addColorStop(1, '#111211');
    c.fillStyle = g; c.fill(body);
    // 보강 홈 (가로 갈비)
    c.strokeStyle = 'rgba(255,255,255,0.07)'; c.lineWidth = 2;
    for (let k = 1; k < 7; k++) { const y = k * magH / 7.5, x0 = -20 + y * 0.06, x1 = 22 + y * 0.18; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y + 2); c.stroke(); }
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.5; c.stroke(body);
    // 입구 멈치 + 맨 위 탄
    c.fillStyle = '#232423'; c.fillRect(-26, -7, 52, 9);
    if (this.fill > 0.02) {
      const bg = c.createLinearGradient(0, -12, 0, -2);
      bg.addColorStop(0, '#e2bd6a'); bg.addColorStop(1, '#8a6526');
      c.fillStyle = bg; c.beginPath(); c.ellipse(-2, -6, 14, 5.5, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#9a5b36'; c.beginPath(); c.moveTo(-15, -8); c.lineTo(-31, -6); c.lineTo(-15, -3); c.closePath(); c.fill();
    }
    c.restore();
    // 왼손: 손바닥(탄창 뒤) + 네 손가락이 앞쪽을 감쌈 + 엄지는 뒤쪽 위
    const skin = (x0, y0, x1, y1) => { const gg = c.createLinearGradient(x0, y0, x1, y1); gg.addColorStop(0, '#9b7556'); gg.addColorStop(1, '#6e4f37'); return gg; };
    c.fillStyle = skin(mx - 80, my + 80, mx, my + 180);
    c.beginPath(); c.ellipse(mx - 34, my + 118, 30, 56, 0.2, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < 4; i++) {
      const fy = my + 70 + i * 23, fx = mx + 8 + i * 4;
      c.strokeStyle = skin(fx - 30, fy, fx + 30, fy); c.lineWidth = 17 - i;
      c.beginPath(); c.moveTo(fx - 26, fy + 8); c.quadraticCurveTo(fx + 16, fy - 6, fx + 30, fy + 10); c.stroke();
      c.strokeStyle = 'rgba(40,25,15,0.35)'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(fx + 4, fy - 2); c.lineTo(fx + 6, fy + 6); c.stroke();
    }
    c.strokeStyle = skin(mx - 60, my + 40, mx - 20, my + 90); c.lineWidth = 18;
    c.beginPath(); c.moveTo(mx - 52, my + 110); c.quadraticCurveTo(mx - 46, my + 60, mx - 26, my + 42); c.stroke();
    // ---- 오른손: 주머니(오른쪽 아래)에서 탄을 집어 와 엄지로 눌러 넣음
    //  p 0~0.45 집으러 갔다 옴, 0.45~0.75 입구에 댐, 0.75~1 엄지로 누름
    let hx, hy, press = 0;
    const home = { x: W * 0.95, y: H * 1.02 }, at = { x: mx + 4, y: my - 30 };
    if (p < 0.45) {
      const t = ease(p / 0.45), out = t < 0.5 ? t * 2 : 2 - t * 2;
      hx = at.x + (home.x - at.x) * out; hy = at.y + (home.y - at.y) * out;
    } else if (p < 0.75) { hx = at.x; hy = at.y; } else { press = ease((p - 0.75) / 0.25); hx = at.x; hy = at.y + press * 9; }
    this._sleeve(c, W + 50, H + 40, hx + 92, hy + 70, 66);
    // 손등 + 말아 쥔 손가락
    c.fillStyle = skin(hx + 10, hy, hx + 90, hy + 80);
    c.beginPath(); c.ellipse(hx + 58, hy + 40, 40, 28, -0.55, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < 3; i++) {
      c.strokeStyle = skin(hx, hy, hx + 60, hy + 60); c.lineWidth = 14 - i;
      c.beginPath(); c.moveTo(hx + 40 + i * 9, hy + 58 + i * 6); c.quadraticCurveTo(hx + 22 + i * 6, hy + 70 + i * 4, hx + 18 + i * 8, hy + 52 + i * 5); c.stroke();
    }
    // 집게손가락 (탄을 받침)
    c.strokeStyle = skin(hx, hy, hx + 40, hy + 30); c.lineWidth = 14;
    c.beginPath(); c.moveTo(hx + 40, hy + 34); c.quadraticCurveTo(hx + 8, hy + 28, hx - 2, hy + 14 + press * 6); c.stroke();
    // 쥔 탄 (누르기 전까지)
    if (p > 0.2 && p < 0.95) {
      c.save(); c.translate(hx - 4, hy + 4 + press * 7); c.rotate(-0.1);
      const bg = c.createLinearGradient(0, -6, 0, 6); bg.addColorStop(0, '#e6c171'); bg.addColorStop(1, '#8b6424');
      c.fillStyle = bg; c.fillRect(-15, -5.5, 30, 11);
      c.fillStyle = '#9a5b36'; c.beginPath(); c.moveTo(-15, -5.5); c.quadraticCurveTo(-30, 0, -15, 5.5); c.closePath(); c.fill();
      c.restore();
    }
    // 엄지 (누름) + 손톱
    c.strokeStyle = skin(hx - 10, hy - 20, hx + 40, hy + 20); c.lineWidth = 17;
    c.beginPath(); c.moveTo(hx + 34, hy + 22); c.quadraticCurveTo(hx + 18, hy - 6 + press * 4, hx + 2, hy - 6 + press * 7); c.stroke();
    c.fillStyle = 'rgba(214,190,165,0.85)'; c.beginPath(); c.ellipse(hx - 1, hy - 7 + press * 7, 5.5, 4, -0.3, 0, Math.PI * 2); c.fill();
    // 화면 가장자리 그늘 (세상과 섞이게)
    const vg = c.createLinearGradient(0, H * 0.55, 0, H);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    c.fillStyle = vg; c.fillRect(0, H * 0.55, W, H * 0.45);
  }

  /** 소매: (x0,y0) 화면 밖 → (x1,y1) 손목, 굵기 w — 주름 몇 줄 */
  _sleeve(c, x0, y0, x1, y1, w) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const g = c.createLinearGradient(x0 + nx * w * 0.5, y0 + ny * w * 0.5, x0 - nx * w * 0.5, y0 - ny * w * 0.5);
    g.addColorStop(0, '#3a4128'); g.addColorStop(0.5, '#56603a'); g.addColorStop(1, '#2f3521');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x0 + nx * w * 0.55, y0 + ny * w * 0.55); c.lineTo(x1 + nx * w * 0.38, y1 + ny * w * 0.38);
    c.lineTo(x1 - nx * w * 0.38, y1 - ny * w * 0.38); c.lineTo(x0 - nx * w * 0.55, y0 - ny * w * 0.55);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(20,24,12,0.35)'; c.lineWidth = 2;
    for (let k = 0.3; k < 0.9; k += 0.2) {
      const px = x0 + dx * k, py = y0 + dy * k;
      c.beginPath(); c.moveTo(px + nx * w * 0.35, py + ny * w * 0.35); c.quadraticCurveTo(px + dx * 0.03, py + dy * 0.03, px - nx * w * 0.3, py - ny * w * 0.3); c.stroke();
    }
    // 소맷부리
    c.strokeStyle = '#2b3019'; c.lineWidth = 7;
    c.beginPath(); c.moveTo(x1 + nx * w * 0.4, y1 + ny * w * 0.4); c.lineTo(x1 - nx * w * 0.4, y1 - ny * w * 0.4); c.stroke();
  }
}
