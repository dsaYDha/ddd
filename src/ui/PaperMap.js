// =====================================================================
//  PaperMap — 5단계 종이 지도 (M 누르고 있기). MapData (등고선·개울·강·주요 오솔길·논·늪·격자) 를 캔버스에 한 번 그리고,
//   임무 목표·회수 지점은 연필 표시로만 (손으로 그은 듯 흔들린 선). 내 위치·적·작은 길·식생은 없다.
//   꺼내고 넣는 데 각 1초 (CSS 전환) — 그동안·들고 있는 동안 손이 바쁘다 (Game 이 사격 막고 느린 걸음).
//   브리핑 화면은 같은 그림을 작게 (drawTo).
//  7단계: 지도를 든 동안 연필 끝 커서 (마우스로 — 시점 대신) · 클릭 → 지원 요청 메뉴 (Game 이 항목을 정함) ·
//   요청한 지점은 연필 X 와 글 (내가 그은 표시뿐 — 실제 탄착·아군 위치는 지도에 없다)
// =====================================================================
import { RNG } from '../core/rng.js';

const PX = 1024;
const INK = { contour: '#8b5a2b', contourMajor: '#7a4a1f', water: '#3f6f9a', waterFill: 'rgba(96,140,180,0.45)', trail: '#3b3127', grid: 'rgba(40,70,110,0.45)', text: '#3a3226', paddy: '#6f7a3a', swamp: '#4f7792', pencil: 'rgba(58,56,60,0.88)' };

export class PaperMap {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `<div id="papermap"><canvas width="${PX}" height="${PX}"></canvas><canvas class="overlay" width="${PX}" height="${PX}"></canvas></div>
      <div id="mapmenu"><div class="title"></div><div class="items"></div></div>`);
    this.el = root.querySelector('#papermap');
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.overlay = this.el.querySelector('canvas.overlay');
    this.octx = this.overlay.getContext('2d');
    this.menuEl = root.querySelector('#mapmenu');
    this.menuTitle = this.menuEl.querySelector('.title');
    this.menuItems = this.menuEl.querySelector('.items');
    this.cursor = null;          // 7단계: 연필 커서 (지도 px) — null 이면 없음
    this.marks = [];             // 7단계: 요청 표시 [{x, z, label}] (월드 좌표)
    this._menuKey = '';
    this.state = 'down';         // 'down' | 'raising' | 'up' | 'lowering'
    this.t = 0;
    this.drawn = null;
  }

  /** 지도 그리기 (임무마다): md = buildMapData 결과, marks = mission.marks, title */
  draw(md, marks, title = '') {
    const c = this.ctx, S = PX / md.size, H = md.half;
    const X = (x) => (x + H) * S, Y = (z) => (z + H) * S;
    this._paper(c);
    // 강 (채움 + 강둑 선)
    if (md.river.north.length) {
      c.beginPath();
      md.river.north.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
      for (let i = md.river.south.length - 1; i >= 0; i--) c.lineTo(X(md.river.south[i][0]), Y(md.river.south[i][1]));
      c.closePath();
      c.fillStyle = INK.waterFill; c.fill();
      c.strokeStyle = INK.water; c.lineWidth = 1.6;
      for (const bank of [md.river.north, md.river.south]) { c.beginPath(); bank.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.stroke(); }
    }
    // 늪: 윤곽 + 늪 기호 (짧은 풀 묶음)
    if (md.swamp.length) {
      c.beginPath(); md.swamp.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.closePath();
      c.fillStyle = 'rgba(110,150,170,0.18)'; c.fill();
      c.setLineDash([6, 4]); c.strokeStyle = INK.swamp; c.lineWidth = 1.2; c.stroke(); c.setLineDash([]);
      let cx = 0, cz = 0; for (const [x, z] of md.swamp) { cx += x; cz += z; } cx /= md.swamp.length; cz /= md.swamp.length;
      const rng = new RNG(7);
      c.strokeStyle = INK.swamp; c.lineWidth = 1;
      for (let k = 0; k < 26; k++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(0, 0.75) * Math.hypot(md.swamp[0][0] - cx, md.swamp[0][1] - cz);
        const px = X(cx + Math.cos(a) * r), py = Y(cz + Math.sin(a) * r);
        c.beginPath(); c.moveTo(px - 6, py); c.lineTo(px + 6, py);
        for (const dx of [-4, 0, 4]) { c.moveTo(px + dx, py); c.lineTo(px + dx * 1.4, py - 6); }
        c.stroke();
      }
    }
    // 등고선 (2m, 10m 마다 굵게 + 높이 숫자 몇 군데)
    for (const ct of md.contours) {
      c.strokeStyle = ct.major ? INK.contourMajor : INK.contour;
      c.lineWidth = ct.major ? 1.5 : 0.7;
      c.globalAlpha = ct.major ? 0.85 : 0.6;
      c.beginPath();
      const s = ct.segs;
      for (let i = 0; i < s.length; i += 4) { c.moveTo(X(s[i]), Y(s[i + 1])); c.lineTo(X(s[i + 2]), Y(s[i + 3])); }
      c.stroke();
      if (ct.major && s.length > 40) {
        c.globalAlpha = 0.9; c.fillStyle = INK.contourMajor; c.font = '11px serif';
        for (let i = 0; i < s.length; i += 4 * Math.max(60, Math.floor(s.length / 4 / 3))) {
          const x = X(s[i]), y = Y(s[i + 1]);
          if (x < 40 || y < 40 || x > PX - 40 || y > PX - 40) continue;
          c.fillText(String(Math.round(ct.level)), x + 2, y - 2);
        }
      }
    }
    c.globalAlpha = 1;
    // 논 (윤곽 + 둑 + 기호)
    if (md.paddy) {
      c.strokeStyle = INK.paddy; c.lineWidth = 1.6;
      c.beginPath(); md.paddy.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.stroke();
      c.lineWidth = 0.7;
      for (const [[x0, z0], [x1, z1]] of md.paddyDikes) { c.beginPath(); c.moveTo(X(x0), Y(z0)); c.lineTo(X(x1), Y(z1)); c.stroke(); }
      let px = 0, pz = 0; for (const [x, z] of md.paddy) { px += x; pz += z; } px /= md.paddy.length; pz /= md.paddy.length;
      c.fillStyle = INK.paddy; c.font = 'italic 14px serif'; c.fillText('논', X(px) - 7, Y(pz) + 5);
    }
    // 개울
    c.strokeStyle = INK.water; c.lineWidth = 2.2; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const st of md.streams) { c.beginPath(); st.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.stroke(); }
    // 주요 오솔길 (긴 점선)
    c.strokeStyle = INK.trail; c.lineWidth = 1.6; c.setLineDash([9, 5]);
    for (const tr of md.trails) { c.beginPath(); tr.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z)))); c.stroke(); }
    c.setLineDash([]);
    // 격자 (100m) + 좌표 숫자 (동향 00~04 · 북향 00~04 — 북쪽이 위)
    c.strokeStyle = INK.grid; c.lineWidth = 1; c.fillStyle = 'rgba(40,60,95,0.85)'; c.font = '13px monospace';
    const n = Math.round(md.size / md.grid);
    for (let i = 0; i <= n; i++) {
      const p = (i / n) * PX;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, PX); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(PX, p); c.stroke();
      if (i < n) {
        const lbl = String(i).padStart(2, '0');
        c.fillText(lbl, p + 4, 14); c.fillText(lbl, p + 4, PX - 6);
        const nl = String(n - 1 - i).padStart(2, '0');   // 북향: 아래(남)가 00
        c.fillText(nl, 4, p + (PX / n) - 6); c.fillText(nl, PX - 22, p + (PX / n) - 6);
      }
    }
    // 북쪽 화살표 + 축척 막대
    c.save(); c.translate(PX - 70, 70);
    c.fillStyle = INK.text; c.strokeStyle = INK.text; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -30); c.lineTo(9, 10); c.lineTo(0, 3); c.lineTo(-9, 10); c.closePath(); c.fill();
    c.font = 'bold 16px serif'; c.fillText('N', -5, -36);
    c.restore();
    c.fillStyle = INK.text; c.strokeStyle = INK.text; c.lineWidth = 2;
    const sb = 100 * S;
    c.beginPath(); c.moveTo(40, PX - 40); c.lineTo(40 + sb, PX - 40); c.moveTo(40, PX - 46); c.lineTo(40, PX - 34); c.moveTo(40 + sb, PX - 46); c.lineTo(40 + sb, PX - 34); c.moveTo(40 + sb / 2, PX - 43); c.lineTo(40 + sb / 2, PX - 37); c.stroke();
    c.font = '12px serif'; c.fillText('0', 36, PX - 50); c.fillText('100 m', 40 + sb - 18, PX - 50);
    c.fillText(`등고선 간격 ${md.interval} m`, 40, PX - 18);
    if (title) { c.font = 'bold 15px serif'; c.fillText(title, 40, 36); }
    // 연필 표시
    this._pencil(c, marks, X, Y);
    this.drawn = { size: md.size, half: H };
    this.marks = [];
    this.cursor = null;
    this._drawOverlay();
  }

  // ---- 7단계: 커서·요청 표시·메뉴 ----------------------------------------
  /** 월드 x,z → 지도 px */
  toMap(x, z) { const D = this.drawn; return D ? { u: (x + D.half) * PX / D.size, v: (z + D.half) * PX / D.size } : { u: 0, v: 0 }; }
  /** 지도 px → 월드 x,z */
  toWorld(u, v) { const D = this.drawn; return D ? { x: u * D.size / PX - D.half, z: v * D.size / PX - D.half } : { x: 0, z: 0 }; }

  /** 커서 켜기 (지도 가운데 또는 마지막 자리) */
  cursorOn() { if (!this.cursor) { this.cursor = { u: this._lastU ?? PX / 2, v: this._lastV ?? PX / 2 }; this._drawOverlay(); } }
  cursorOff() { if (this.cursor) { this._lastU = this.cursor.u; this._lastV = this.cursor.v; this.cursor = null; this._drawOverlay(); } }

  /** 커서 이동: rel {dx, dy} (화면 px 이동량) 또는 abs {x, y} (화면 좌표 — 끌어서 보기) */
  moveCursor(rel, abs = null) {
    if (!this.cursor) return;
    const r = this.overlay.getBoundingClientRect();
    const k = r.width > 10 ? PX / r.width : 1;
    if (abs) { this.cursor.u = (abs.x - r.left) * k; this.cursor.v = (abs.y - r.top) * k; } else if (rel) { this.cursor.u += rel.dx * k * 0.85; this.cursor.v += rel.dy * k * 0.85; }
    this.cursor.u = Math.max(8, Math.min(PX - 8, this.cursor.u));
    this.cursor.v = Math.max(8, Math.min(PX - 8, this.cursor.v));
    this._drawOverlay();
  }

  /** 커서가 가리키는 월드 지점 */
  cursorWorld() { return this.cursor ? this.toWorld(this.cursor.u, this.cursor.v) : null; }

  /** 요청 표시 추가 (연필 X + 글) */
  addMark(x, z, label) { this.marks.push({ x, z, label, seed: this.marks.length * 13 + 5 }); this._drawOverlay(); }

  _drawOverlay() {
    const c = this.octx;
    c.clearRect(0, 0, PX, PX);
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = INK.pencil; c.fillStyle = INK.pencil;
    c.font = 'italic bold 22px "Comic Sans MS", cursive, serif';
    for (const m of this.marks) {
      const { u, v } = this.toMap(m.x, m.z);
      const rng = new RNG(m.seed);
      const j = () => rng.range(-1.4, 1.4);
      c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(u - 11 + j(), v - 11 + j()); c.lineTo(u + 11 + j(), v + 11 + j());
      c.moveTo(u - 11 + j(), v + 11 + j()); c.lineTo(u + 11 + j(), v - 11 + j()); c.stroke();
      c.fillText(m.label, u + 14, v - 10);
    }
    const k = this.cursor;
    if (k) {
      // 연필 끝 (가리키는 점) + 연필 몸통
      c.save(); c.translate(k.u, k.v);
      c.fillStyle = 'rgba(40,38,44,0.95)';
      c.beginPath(); c.arc(0, 0, 2.6, 0, Math.PI * 2); c.fill();
      c.rotate(-0.75);
      c.fillStyle = '#d6b25a'; c.fillRect(10, -5, 70, 10);
      c.fillStyle = '#e8d2a6'; c.beginPath(); c.moveTo(10, -5); c.lineTo(0, 0); c.lineTo(10, 5); c.closePath(); c.fill();
      c.fillStyle = '#3a3836'; c.beginPath(); c.moveTo(4, -2); c.lineTo(0, 0); c.lineTo(4, 2); c.closePath(); c.fill();
      c.fillStyle = '#c98c8c'; c.fillRect(80, -5, 9, 10);
      c.restore();
      c.strokeStyle = 'rgba(40,38,44,0.35)'; c.lineWidth = 1;
      c.beginPath(); c.arc(k.u, k.v, 16, 0, Math.PI * 2); c.stroke();
    }
  }

  /** 지원 요청 메뉴: items [{label, off?}], index — null 이면 닫음 */
  setMenu(title, items, index = 0) {
    if (!items) { if (this._menuKey) { this.menuEl.style.display = 'none'; this._menuKey = ''; } return; }
    const key = `${title}|${index}|${items.map((i) => i.label + (i.off ? '0' : '1')).join('/')}`;
    if (key === this._menuKey) return;
    this._menuKey = key;
    this.menuEl.style.display = 'block';
    this.menuTitle.textContent = title;
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    this.menuItems.innerHTML = items.map((it, i) => `<div class="it${i === index ? ' sel' : ''}${it.off ? ' off' : ''}"><span class="k">${i + 1}</span>${esc(it.label)}</div>`).join('');
  }

  /** 종이 바탕: 누런 종이 + 섬유 얼룩 + 접힌 자국 */
  _paper(c) {
    c.fillStyle = '#dccfa8';
    c.fillRect(0, 0, PX, PX);
    const rng = new RNG(31);
    for (let k = 0; k < 2600; k++) {
      c.fillStyle = `rgba(${rng.chance(0.5) ? '90,70,40' : '255,250,230'},${rng.range(0.02, 0.07).toFixed(3)})`;
      const x = rng.range(0, PX), y = rng.range(0, PX), r = rng.range(1, 6);
      c.fillRect(x, y, r, r * rng.range(0.2, 1));
    }
    // 얼룩 (물 자국)
    for (let k = 0; k < 5; k++) {
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(120,95,55,0.08)'); g.addColorStop(1, 'rgba(120,95,55,0)');
      c.save(); c.translate(rng.range(0, PX), rng.range(0, PX)); c.scale(rng.range(60, 160), rng.range(40, 120));
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill(); c.restore();
    }
    // 접힌 자국 (가로·세로 가운데)
    c.strokeStyle = 'rgba(80,60,30,0.18)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(PX / 2, 0); c.lineTo(PX / 2, PX); c.moveTo(0, PX / 2); c.lineTo(PX, PX / 2); c.stroke();
    c.strokeStyle = 'rgba(255,255,240,0.25)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(PX / 2 + 2, 0); c.lineTo(PX / 2 + 2, PX); c.moveTo(0, PX / 2 + 2); c.lineTo(PX, PX / 2 + 2); c.stroke();
  }

  /** 연필로 그은 표시 (흔들린 선·숫자·글) */
  _pencil(c, marks, X, Y) {
    const rng = new RNG(97);
    const wob = (pts, w = 1.6) => {
      c.beginPath();
      pts.forEach(([x, y], i) => {
        const jx = x + rng.range(-1.2, 1.2), jy = y + rng.range(-1.2, 1.2);
        if (i) c.lineTo(jx, jy); else c.moveTo(jx, jy);
      });
      c.lineWidth = w * 1.5; c.stroke();
    };
    const circle = (cx, cy, r, open = 0) => {
      const pts = [];
      const a0 = rng.range(0, Math.PI * 2), n = 28;
      for (let i = 0; i <= n + 2; i++) {
        const a = a0 + (i / n) * Math.PI * 2 * (1 - open);
        const rr = r * (1 + rng.range(-0.05, 0.05));
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
      wob(pts);
    };
    c.strokeStyle = INK.pencil; c.fillStyle = INK.pencil;
    c.font = 'italic bold 26px "Comic Sans MS", cursive, serif';
    const S = (r) => Math.max(12, X(r) - X(0));
    for (const m of marks ?? []) {
      const x = X(m.x), y = Y(m.z);
      if (m.kind === 'circle') {
        circle(x, y, S(m.r) + 6);
        c.fillText(m.label, x + S(m.r) + 9, y - S(m.r) - 2);
      } else if (m.kind === 'segment') {
        const x2 = X(m.x2), y2 = Y(m.z2);
        const dx = x2 - x, dy = y2 - y, L = Math.hypot(dx, dy) || 1, nx = -dy / L * 14, ny = dx / L * 14;
        wob([[x - nx, y - ny], [x + nx, y + ny]], 2);
        wob([[x2 - nx, y2 - ny], [x2 + nx, y2 + ny]], 2);
        wob([[x + nx * 0.5, y + ny * 0.5], [x2 + nx * 0.5, y2 + ny * 0.5]], 1.2);
        wob([[x - nx * 0.5, y - ny * 0.5], [x2 - nx * 0.5, y2 - ny * 0.5]], 1.2);
        c.fillText(m.label, (x + x2) / 2 + nx * 1.6, (y + y2) / 2 + ny * 1.6);
      } else if (m.kind === 'area') {
        c.setLineDash([7, 6]);
        circle(x, y, S(m.r), 0);
        c.setLineDash([]);
        c.fillText(`${m.label}`, x - 40, y - S(m.r) - 8);
        c.font = 'italic bold 32px "Comic Sans MS", cursive, serif'; c.fillText('?', x - 8, y + 10);
        c.font = 'italic bold 26px "Comic Sans MS", cursive, serif';
      } else if (m.kind === 'lz') {
        circle(x, y, S(m.r) + 4);
        const r = S(m.r) * 0.6;
        wob([[x - r, y - r], [x + r, y + r]], 1.8); wob([[x - r, y + r], [x + r, y - r]], 1.8);
        c.fillText(m.label, x + S(m.r) + 8, y + 5);
      } else if (m.kind === 'start') {
        const r = S(m.r) + 4;
        wob([[x, y - r], [x + r * 0.9, y + r * 0.6], [x - r * 0.9, y + r * 0.6], [x, y - r]], 1.8);
        c.fillText(m.label, x + r + 6, y + 5);
      }
    }
  }

  /** 다른 캔버스(브리핑)에 같은 그림을 */
  drawTo(canvas) {
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(this.canvas, 0, 0, canvas.width, canvas.height);
  }

  /** held: 키를 누르고 있나. 돌려줌: 손이 바쁜가 (꺼내는 중·든 상태·넣는 중) */
  update(dt, held, raiseTime = 1) {
    const prev = this.state;
    if (held && (this.state === 'down' || this.state === 'lowering')) {
      this.t = this.state === 'lowering' ? raiseTime - this.t : 0;    // 넣다가 다시 꺼내면 거기서부터
      this.state = 'raising';
    } else if (!held && (this.state === 'up' || this.state === 'raising')) {
      this.t = this.state === 'raising' ? raiseTime - this.t : 0;
      this.state = 'lowering';
    }
    if (this.state === 'raising' || this.state === 'lowering') {
      this.t += dt;
      if (this.t >= raiseTime) { this.state = this.state === 'raising' ? 'up' : 'down'; this.t = 0; }
    }
    if (prev !== this.state || this.state === 'raising' || this.state === 'lowering') this._apply(raiseTime);
    return this.state !== 'down';
  }

  _apply(raiseTime) {
    let k = this.state === 'up' ? 1 : this.state === 'down' ? 0 : this.t / raiseTime;
    if (this.state === 'lowering') k = 1 - k;
    k = k * k * (3 - 2 * k);
    const s = this.el.style;
    s.display = k > 0.001 ? 'block' : 'none';
    s.transform = `translate(-50%, ${(1 - k) * 105}%) rotate(${(1 - k) * 8 - 1.2}deg)`;
    s.opacity = String(Math.min(1, k * 3));
  }

  hideNow() { this.state = 'down'; this.t = 0; this._apply(1); this.cursorOff(); this.setMenu(null); }
}
