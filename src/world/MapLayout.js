// 맵 배치 정의: 개울·오솔길 경로, 늪, 논, 강, 가장자리 장애물.
// 좌표계: x = 동(+)/서(-), z = 남(+)/북(-), y = 위. 맵 범위 -200 ~ 200.
import { clamp, smoothstep } from '../core/math.js';

// ---------------------------------------------------------------
// 폴리라인 (Catmull-Rom 보간 + 1m 간격 재표본화 + 사행 노이즈)
// ---------------------------------------------------------------
export class Polyline {
  /**
   * @param {Array<[number,number]>} controls
   * @param {object} opts { spacing, meander, meanderScale, noise }
   */
  constructor(controls, opts = {}) {
    const spacing = opts.spacing ?? 1;
    const dense = [];
    const n = controls.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = controls[Math.max(0, i - 1)];
      const p1 = controls[i];
      const p2 = controls[i + 1];
      const p3 = controls[Math.min(n - 1, i + 2)];
      const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const steps = Math.max(2, Math.ceil(segLen / (spacing * 0.5)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        dense.push(catmull(p0, p1, p2, p3, t));
      }
    }
    dense.push(controls[n - 1].slice());

    // 사행 (경로에 수직으로 노이즈 변위)
    if (opts.meander && opts.noise) {
      let s = 0;
      const out = [];
      for (let i = 0; i < dense.length; i++) {
        if (i > 0) s += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
        const a = dense[Math.max(0, i - 1)], b = dense[Math.min(dense.length - 1, i + 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        // 양 끝에서는 변위를 줄여 연결점이 어긋나지 않게
        const fade = Math.min(1, i / 12, (dense.length - 1 - i) / 12);
        const off = opts.meander * fade * opts.noise.fbm(s / (opts.meanderScale ?? 40), opts.seedOffset ?? 0, 3);
        out.push([dense[i][0] - tz * off, dense[i][1] + tx * off]);
      }
      dense.length = 0;
      dense.push(...out);
    }

    // 균일 간격 재표본화
    const xs = [dense[0][0]], zs = [dense[0][1]], ss = [0];
    let acc = 0, total = 0;
    for (let i = 1; i < dense.length; i++) {
      const ax = dense[i - 1][0], az = dense[i - 1][1];
      const bx = dense[i][0], bz = dense[i][1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l <= 0) continue;
      let d = spacing - acc;
      while (d <= l) {
        const t = d / l;
        xs.push(ax + (bx - ax) * t);
        zs.push(az + (bz - az) * t);
        ss.push(total + d);
        d += spacing;
      }
      acc = l - (d - spacing);
      total += l;
    }
    const last = dense[dense.length - 1];
    if (Math.hypot(last[0] - xs[xs.length - 1], last[1] - zs[zs.length - 1]) > spacing * 0.25) {
      xs.push(last[0]); zs.push(last[1]); ss.push(total);
    }
    this.x = Float32Array.from(xs);
    this.z = Float32Array.from(zs);
    this.s = Float32Array.from(ss);
    this.length = total;
    this.count = xs.length;
  }

  /** 호 길이 s 에서의 위치 */
  pointAt(s) {
    const i = this.indexAt(s);
    const j = Math.min(this.count - 1, i + 1);
    const span = this.s[j] - this.s[i];
    const t = span > 0 ? clamp((s - this.s[i]) / span, 0, 1) : 0;
    return [this.x[i] + (this.x[j] - this.x[i]) * t, this.z[i] + (this.z[j] - this.z[i]) * t];
  }

  indexAt(s) {
    let lo = 0, hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** 가장 가까운 점의 호 길이 (전수 탐색 — 생성 단계에서만 사용) */
  closestS(px, pz) {
    let best = Infinity, bestS = 0;
    for (let i = 0; i < this.count - 1; i++) {
      const ax = this.x[i], az = this.z[i], bx = this.x[i + 1], bz = this.z[i + 1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
      t = clamp(t, 0, 1);
      const cx = ax + dx * t - px, cz = az + dz * t - pz;
      const d = cx * cx + cz * cz;
      if (d < best) { best = d; bestS = this.s[i] + (this.s[i + 1] - this.s[i]) * t; }
    }
    return { s: bestS, dist: Math.sqrt(best) };
  }
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

// ---------------------------------------------------------------
// 논: 회전된 직사각형 영역을 칸으로 나누고 칸 사이에 좁은 논둑
// ---------------------------------------------------------------
export class PaddyField {
  constructor(def) {
    Object.assign(this, def);
    this.cos = Math.cos(def.rot);
    this.sin = Math.sin(def.rot);
    this.halfU = (def.cols * def.cellW) / 2;
    this.halfV = (def.rows * def.cellH) / 2;
    // 칸별 바닥 높이 (rows × cols)
    this.floors = new Float32Array(def.rows * def.cols);
    for (let r = 0; r < def.rows; r++) {
      for (let c = 0; c < def.cols; c++) {
        this.floors[r * def.cols + c] = def.baseFloor - def.rowStep * r - def.colStep * c;
      }
    }
    this._q = { inside: false, onDike: false, dikeTop: 0, floor: 0, waterLevel: 0, row: -1, col: -1, main: false, sd: 0 };
  }

  toLocal(x, z) {
    const dx = x - this.cx, dz = z - this.cz;
    return [dx * this.cos + dz * this.sin, -dx * this.sin + dz * this.cos];
  }

  toWorld(u, v) {
    return [this.cx + u * this.cos - v * this.sin, this.cz + u * this.sin + v * this.cos];
  }

  /** 논 경계로부터의 부호 거리 (안쪽 음수) */
  signedDistance(x, z) {
    const [u, v] = this.toLocal(x, z);
    const dx = Math.abs(u) - this.halfU, dv = Math.abs(v) - this.halfV;
    const ox = Math.max(dx, 0), ov = Math.max(dv, 0);
    return Math.hypot(ox, ov) + Math.min(Math.max(dx, dv), 0);
  }

  floorAtLocal(u, v) {
    const c = Math.floor((u + this.halfU) / this.cellW);
    const r = Math.floor((v + this.halfV) / this.cellH);
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return -Infinity;
    return this.floors[r * this.cols + c];
  }

  /** 점이 논둑 위인지, 어느 칸인지 — 매 프레임 호출되므로 할당 없음 */
  query(x, z) {
    const q = this._q;
    const [u, v] = this.toLocal(x, z);
    const outer = this.dikeHalf;
    q.inside = Math.abs(u) <= this.halfU + outer && Math.abs(v) <= this.halfV + outer;
    q.onDike = false; q.main = false; q.row = -1; q.col = -1;
    if (!q.inside) return q;

    // 가장 가까운 세로선·가로선까지 거리
    const fu = (u + this.halfU) / this.cellW;
    const fv = (v + this.halfV) / this.cellH;
    const lineU = Math.round(fu), lineV = Math.round(fv);
    const du = Math.abs(fu - lineU) * this.cellW;
    const dv = Math.abs(fv - lineV) * this.cellH;
    const mainHalf = this.mainDikeHalf;
    const isMainRow = lineV === this.mainDikeRow;
    const half = isMainRow ? mainHalf : this.dikeHalf;
    if (du <= this.dikeHalf || dv <= half) {
      q.onDike = true;
      q.main = dv <= mainHalf && isMainRow;
      // 인접 칸 바닥 중 가장 높은 것 + 논둑 높이
      const h = this.dikeHalf + 0.05;
      const m = Math.max(mainHalf, this.dikeHalf) + 0.05;
      let top = -Infinity;
      top = Math.max(top, this.floorAtLocal(u - h, v - m), this.floorAtLocal(u + h, v - m), this.floorAtLocal(u - h, v + m), this.floorAtLocal(u + h, v + m));
      top = Math.max(top, this.floorAtLocal(u, v - m), this.floorAtLocal(u, v + m), this.floorAtLocal(u - h, v), this.floorAtLocal(u + h, v));
      if (top === -Infinity) top = this.baseFloor;
      q.dikeTop = top + (q.main ? this.mainDikeHeight : this.dikeHeight);
      q.floor = top;
      q.waterLevel = -Infinity;
    } else {
      const c = clamp(Math.floor(fu), 0, this.cols - 1);
      const r = clamp(Math.floor(fv), 0, this.rows - 1);
      q.col = c; q.row = r;
      q.floor = this.floors[r * this.cols + c];
      q.waterLevel = q.floor + this.waterDepth;
    }
    return q;
  }

  /** 렌더링용 논둑 선분 목록 */
  dikeSegments() {
    const segs = [];
    const { rows, cols, cellW, cellH } = this;
    for (let c = 0; c <= cols; c++) {
      for (let r = 0; r < rows; r++) {
        const u = -this.halfU + c * cellW;
        const v0 = -this.halfV + r * cellH, v1 = v0 + cellH;
        const fl = Math.max(c > 0 ? this.floors[r * cols + c - 1] : -Infinity, c < cols ? this.floors[r * cols + c] : -Infinity);
        segs.push({ u0: u, v0, u1: u, v1, half: this.dikeHalf, top: fl + this.dikeHeight, bottom: fl - 0.45 });
      }
    }
    for (let r = 0; r <= rows; r++) {
      const main = r === this.mainDikeRow;
      for (let c = 0; c < cols; c++) {
        const v = -this.halfV + r * cellH;
        const u0 = -this.halfU + c * cellW, u1 = u0 + cellW;
        const fl = Math.max(r > 0 ? this.floors[(r - 1) * cols + c] : -Infinity, r < rows ? this.floors[r * cols + c] : -Infinity);
        segs.push({
          u0, v0: v, u1, v1: v,
          half: main ? this.mainDikeHalf : this.dikeHalf,
          top: fl + (main ? this.mainDikeHeight : this.dikeHeight),
          bottom: fl - 0.45, main,
        });
      }
    }
    return segs;
  }
}

// ---------------------------------------------------------------
// 고정 배치 (시드에 따라 세부 형태만 달라짐)
// ---------------------------------------------------------------
export const LAYOUT = {
  riverLevel: 1.6,
  river: { baseZ: 184, halfWidth: 12, depth: 2.9 },

  // 개울: 북쪽 절벽 아래 샘에서 시작해 남쪽 강으로
  streams: [
    {
      name: 'east',
      controls: [[100, -168], [93, -132], [103, -96], [97, -58], [91, -18], [88, 36], [80, 76], [69, 112], [59, 146], [52, 196]],
      pools: [{ s: -26, depth: 1.08, len: 9 }, { s: 120, depth: 0.95, len: 7 }, { s: 300, depth: 1.0, len: 8 }], // s<0 → 여울 기준 상대 위치
    },
    {
      name: 'west',
      controls: [[-132, -168], [-121, -130], [-110, -92], [-97, -52], [-80, -16], [-62, 18], [-67, 52], [-81, 92], [-93, 132], [-99, 196]],
      pools: [{ s: 90, depth: 1.0, len: 8 }, { s: 300, depth: 0.95, len: 7 }],
    },
  ],

  swamp: { x: -62, z: 18, radius: 27 },

  paddy: {
    cx: 38, cz: 30, rot: 0.12,
    cols: 5, rows: 4, cellW: 13, cellH: 11,
    dikeHalf: 0.3, mainDikeHalf: 0.6, mainDikeRow: 2,
    dikeHeight: 0.28, mainDikeHeight: 0.32,
    waterDepth: 0.1, rowStep: 0.1, colStep: 0.025,
  },

  // 늪 → 논 사이 저지대 통로
  corridor: [[-40, 24], [4, 30]],

  // 오솔길. mud: 'auto' 또는 호 길이 s → 진흙 정도(0~1)
  trails: [
    {
      name: 'T1', halfWidth: 1.0,
      controls: [[-10, -50], [-18, -42], [-27, -30], [-35, -17], [-42, -6], [-47, 4]],
      mud: (s, n) => (s < 22 ? 0.05 : s < 30 ? 0.05 + ((s - 22) / 8) * 0.7 : 0.78 + 0.12 * n),
    },
    { name: 'T2', halfWidth: 0.9, controls: [[-47, 4], [-39, 16], [-26, 24], [-12, 29], ['paddyWest']], mud: 'auto' },
    { name: 'T3', halfWidth: 1.0, controls: [['paddyEast'], [77, 34], [88, 36], [100, 33], [124, 20], [148, 2], [164, -6]], mud: 'auto' },
    { name: 'T4', halfWidth: 0.9, controls: [[-10, -50], [-3, -68], [8, -95], [21, -124], [30, -160]], mud: 'auto' },
    { name: 'T5', halfWidth: 0.9, controls: [[-47, 4], [-60, -12], [-80, -26], [-108, -30], [-140, -24], [-168, -36]], mud: 'auto' },
    { name: 'T6', halfWidth: 0.9, controls: [['paddySouth'], [42, 70], [44, 98], [32, 130], [22, 166]], mud: 'auto' },
  ],

  // 코끼리풀 군락 (개활지)
  grassBlobs: [
    { x: 18, z: -30, r: 15 }, { x: 34, z: 1, r: 10 }, { x: -86, z: 52, r: 15 }, { x: -22, z: 62, r: 12 },
    { x: 118, z: -62, r: 17 }, { x: -118, z: -88, r: 14 }, { x: 58, z: 108, r: 15 }, { x: 142, z: 88, r: 13 },
    { x: -140, z: 22, r: 15 }, { x: 108, z: 140, r: 12 }, { x: 74, z: -20, r: 10 }, { x: -60, z: -40, r: 9 },
  ],

  // 대나무 숲 고정 위치 (그 외는 개울 둑을 따라 무작위)
  bambooGroves: [{ x: -40, z: -72, r: 7 }, { x: 60, z: -60, r: 6 }, { x: -120, z: 120, r: 7 }, { x: 140, z: -120, r: 6 }],

  // 동쪽 가장자리 밀집 대나무 띠
  bambooBelt: { xStart: 171, visualDepth: 14 },

  // 북·서쪽 절벽
  cliff: { width: 26, steepStart: 10, rise: 26 },
};

/** 저지대 기준 높이 (북→남으로 완만히 낮아짐) */
export function valleyFloor(x, z) {
  return 8.0 - 0.012 * (z + 50) - 0.004 * x - 3.0 * smoothstep(130, 178, z);
}

/** 강 중심선 z */
export function riverCenterZ(x) {
  return LAYOUT.river.baseZ + 4 * Math.sin(x / 37) + 2.5 * Math.sin(x / 13 + 1);
}
