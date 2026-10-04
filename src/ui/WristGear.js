// =====================================================================
//  WristGear — 5단계 손목 나침반 + 시계 (N 누르고 있기). 왼 손목을 들어 올려 보는 그림 (캔버스 2D):
//   나침반 = 액체 속 문자판이 실제 북쪽을 가리키며 돌고, 위쪽 기준선에서 지금 향한 방위를 읽는다 (숫자 표시 없음 — 눈금뿐).
//   시계 = 바늘 시계 (게임 시각). 꺼내고 넣는 데 각 1초, 그동안·들고 있는 동안 손이 바쁘다.
// =====================================================================
const W = 520, H = 360;

export class WristGear {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `<div id="wristgear"><canvas width="${W}" height="${H}"></canvas></div>`);
    this.el = root.querySelector('#wristgear');
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.state = 'down';
    this.t = 0;
    this._card = 0;          // 문자판 각 (액체 감쇠로 천천히 따라감)
    this._cardV = 0;
  }

  /** held, heading (북쪽에서 시계 방향 도), hours (0~24), dt — 돌려줌: 손이 바쁜가 */
  update(dt, held, heading, hours, raiseTime = 1) {
    if (held && (this.state === 'down' || this.state === 'lowering')) {
      this.t = this.state === 'lowering' ? raiseTime - this.t : 0;
      this.state = 'raising';
    } else if (!held && (this.state === 'up' || this.state === 'raising')) {
      this.t = this.state === 'raising' ? raiseTime - this.t : 0;
      this.state = 'lowering';
    }
    if (this.state === 'raising' || this.state === 'lowering') {
      this.t += dt;
      if (this.t >= raiseTime) { this.state = this.state === 'raising' ? 'up' : 'down'; this.t = 0; }
    }
    let k = this.state === 'up' ? 1 : this.state === 'down' ? 0 : this.t / raiseTime;
    if (this.state === 'lowering') k = 1 - k;
    k = k * k * (3 - 2 * k);
    const s = this.el.style;
    s.display = k > 0.001 ? 'block' : 'none';
    if (k > 0.001) {
      s.transform = `translateY(${(1 - k) * 110}%) rotate(${(1 - k) * -10}deg)`;
      // 문자판: 액체 속이라 약간 출렁이며 따라감 (2차 감쇠)
      let target = -heading;
      let d = target - this._card;
      d = ((d + 540) % 360) - 180;
      this._cardV += (d * 26 - this._cardV * 7) * Math.min(dt, 0.05);
      this._card += this._cardV * Math.min(dt, 0.05);
      if (this.state === 'raising' && this.t < dt * 1.5) { this._card = target; this._cardV = 0; }
      this._draw(hours);
    }
    return this.state !== 'down';
  }

  hideNow() { this.state = 'down'; this.t = 0; this.el.style.display = 'none'; }

  _draw(hours) {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    // 팔 (소매 + 손목 피부) — 아래 왼쪽에서 비스듬히
    c.save();
    c.translate(W * 0.5, H * 0.62);
    c.rotate(-0.18);
    c.fillStyle = '#4a5233';
    c.beginPath(); c.moveTo(-W * 0.62, 40); c.lineTo(-W * 0.62, 150); c.lineTo(-150, 150); c.lineTo(-140, 60); c.closePath(); c.fill();
    c.fillStyle = '#8d6a4c';
    c.beginPath(); c.moveTo(-150, 62); c.lineTo(W * 0.52, 32); c.quadraticCurveTo(W * 0.6, 80, W * 0.52, 132); c.lineTo(-150, 150); c.closePath(); c.fill();
    c.fillStyle = 'rgba(60,40,25,0.35)';
    c.beginPath(); c.moveTo(-150, 125); c.lineTo(W * 0.52, 112); c.lineTo(W * 0.52, 132); c.lineTo(-150, 150); c.closePath(); c.fill();
    // 손목 끈 (나일론)
    c.fillStyle = '#2b2d22';
    c.fillRect(-120, 40, 300, 104);
    c.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = -120; x < 180; x += 6) c.fillRect(x, 40, 2, 104);
    c.restore();
    this._compass(c, W * 0.33, H * 0.5, 92);
    this._watch(c, W * 0.71, H * 0.47, 70, hours);
  }

  _compass(c, x, y, R) {
    // 몸통 (녹색 도장 금속) + 회전 베젤 눈금
    c.save(); c.translate(x, y);
    c.fillStyle = '#39402b'; c.beginPath(); c.arc(0, 0, R + 10, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#1d2016'; c.lineWidth = 2;
    for (let i = 0; i < 60; i++) { const a = i / 60 * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * (R + 4), Math.sin(a) * (R + 4)); c.lineTo(Math.cos(a) * (R + 10), Math.sin(a) * (R + 10)); c.stroke(); }
    // 액체 창
    const g = c.createRadialGradient(-R * 0.3, -R * 0.35, 4, 0, 0, R);
    g.addColorStop(0, '#d9d6c4'); g.addColorStop(1, '#a9a58e');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
    // 문자판 (실제 북쪽을 향해 돔)
    c.save(); c.rotate(this._card * Math.PI / 180);
    c.strokeStyle = '#2c2a22'; c.fillStyle = '#2c2a22';
    for (let d = 0; d < 360; d += 5) {
      const a = (d - 90) * Math.PI / 180, L = d % 30 === 0 ? 13 : d % 10 === 0 ? 8 : 4;
      c.lineWidth = d % 30 === 0 ? 2 : 1;
      c.beginPath(); c.moveTo(Math.cos(a) * (R - 3), Math.sin(a) * (R - 3)); c.lineTo(Math.cos(a) * (R - 3 - L), Math.sin(a) * (R - 3 - L)); c.stroke();
    }
    c.font = 'bold 20px serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const L = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    for (const [t, d] of L) {
      const a = (d - 90) * Math.PI / 180;
      c.save(); c.translate(Math.cos(a) * (R - 32), Math.sin(a) * (R - 32)); c.rotate(d * Math.PI / 180);
      c.fillStyle = t === 'N' ? '#9c2a1c' : '#2c2a22'; c.fillText(t, 0, 0); c.restore();
    }
    c.font = '11px serif';
    for (let d = 30; d < 360; d += 30) {
      if (d % 90 === 0) continue;
      const a = (d - 90) * Math.PI / 180;
      c.save(); c.translate(Math.cos(a) * (R - 26), Math.sin(a) * (R - 26)); c.rotate(d * Math.PI / 180);
      c.fillText(String(d / 10), 0, 0); c.restore();
    }
    // 바늘 (북 = 붉은 쪽)
    c.fillStyle = '#9c2a1c'; c.beginPath(); c.moveTo(0, -R + 40); c.lineTo(6, 0); c.lineTo(-6, 0); c.closePath(); c.fill();
    c.fillStyle = '#e8e4d2'; c.beginPath(); c.moveTo(0, R - 40); c.lineTo(6, 0); c.lineTo(-6, 0); c.closePath(); c.fill();
    c.restore();
    // 기준선 (위쪽 고정 — 향한 방향을 읽는 곳) + 축
    c.strokeStyle = '#b8401c'; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(0, -R - 6); c.lineTo(0, -R + 16); c.stroke();
    c.fillStyle = '#4a4a40'; c.beginPath(); c.arc(0, 0, 4, 0, Math.PI * 2); c.fill();
    // 유리 반사
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.beginPath(); c.ellipse(-R * 0.3, -R * 0.42, R * 0.45, R * 0.18, -0.5, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  _watch(c, x, y, R, hours) {
    c.save(); c.translate(x, y);
    c.fillStyle = '#4d4f4a'; c.beginPath(); c.arc(0, 0, R + 9, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#1b1c18'; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#d8d3bd'; c.fillStyle = '#d8d3bd';
    for (let i = 0; i < 60; i++) {
      const a = i / 60 * Math.PI * 2, L = i % 5 === 0 ? 10 : 4;
      c.lineWidth = i % 5 === 0 ? 2.5 : 1;
      c.beginPath(); c.moveTo(Math.cos(a) * (R - 4), Math.sin(a) * (R - 4)); c.lineTo(Math.cos(a) * (R - 4 - L), Math.sin(a) * (R - 4 - L)); c.stroke();
    }
    c.font = 'bold 14px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const [n, a] of [[12, -90], [3, 0], [6, 90], [9, 180]]) c.fillText(String(n), Math.cos(a * Math.PI / 180) * (R - 24), Math.sin(a * Math.PI / 180) * (R - 24));
    const h = ((hours % 12) + 12) % 12, m = (hours % 1) * 60;
    const hand = (ang, len, w, col) => {
      c.save(); c.rotate(ang); c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round';
      c.beginPath(); c.moveTo(0, 8); c.lineTo(0, -len); c.stroke(); c.restore();
    };
    hand((h / 12) * Math.PI * 2, R * 0.5, 5, '#e6e1cb');
    hand((m / 60) * Math.PI * 2, R * 0.78, 3, '#e6e1cb');
    c.fillStyle = '#c9c4ad'; c.beginPath(); c.arc(0, 0, 4, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.1)'; c.beginPath(); c.ellipse(-R * 0.3, -R * 0.4, R * 0.4, R * 0.15, -0.5, 0, Math.PI * 2); c.fill();
    c.restore();
  }
}
