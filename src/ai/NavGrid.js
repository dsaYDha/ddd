// =====================================================================
//  NavGrid — 적 병사 경로 찾기용 격자 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   · 칸(기본 2m)마다 이동 비용 = 1 / 지면 속도(1단계 surfaces.speed) × 경사 배율 + 줄기·통나무 언저리 비용.
//     깊은 물·급경사·큰 줄기·대나무 덤불·덩굴 벽은 막힘. 오솔길 칸 표시, 몸높이 은폐(체적형 식생) 0~1.
//   · findPath(시작, 끝, {mode}) — 8방향 A* (이진 힙, 방문 표식 재사용, 노드 예산)
//       mode 'patrol': 오솔길 칸 비용 × trailMul (평소에는 길을 선호)
//       mode 'combat': 트인 칸 비용 × (1 + combatExposureMul × (1 − 은폐)) (몸을 숨길 수 있는 경로)
//     결과는 직선으로 걸을 수 있는 구간을 이어 줄인 월드 좌표 경유점 [{x, z}].
//   · findCover(위치, 위협, opts) — 마지막으로 확인한 위협 방향을 막는 엄폐물 (총알을 막는 줄기·통나무·바위 = bulletBlock full)
//     뒤 숨는 점·옆 내다보는 점. 없거나 모자라면 2순위로 숨기만 되는 수풀 (몸높이 은폐 ≥ cover.concealMin).
// =====================================================================
import { CONFIG } from '../config.js';
import { surfaceProps } from '../world/Surfaces.js';

const SQRT2 = Math.SQRT2;
const BLOCK_TYPES = new Set(['bambooDense', 'vineWall', 'bamboo']);
const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

export class NavGrid {
  /**
   * @param {import('../world/WorldQuery.js').WorldQuery} query
   * @param {{ trails?: Array<{line, halfWidth}> }} layout  data.layout (오솔길 표시용, 없어도 됨)
   */
  constructor(query, layout = null, opts = {}) {
    const N = CONFIG.ai.nav;
    this.query = query;
    this.cell = opts.cell ?? N.cell;
    this.half = query.half;
    this.n = Math.ceil((this.half * 2) / this.cell);
    const n2 = this.n * this.n;
    this.cost = new Float32Array(n2);      // 칸 비용 (m 당) — 0 이면 막힘
    this.trail = new Uint8Array(n2);
    this.conceal = new Uint8Array(n2);     // 몸높이 은폐 × 255
    // A* 작업 버퍼
    this._g = new Float32Array(n2);
    this._from = new Int32Array(n2);
    this._seen = new Int32Array(n2);
    this._closed = new Int32Array(n2);
    this._stamp = 0;
    this._heap = new Int32Array(n2);
    this._hf = new Float32Array(n2);
    this.lastStats = { expanded: 0, ok: false };
    this._build(layout);
  }

  // -----------------------------------------------------------------
  // 만들기
  // -----------------------------------------------------------------
  _build(layout) {
    const q = this.query, N = CONFIG.ai.nav, n = this.n, cs = this.cell;
    const maxWade = CONFIG.movement.maxWadeDepth * 0.95;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -this.half + (i + 0.5) * cs, z = -this.half + (j + 0.5) * cs;
        const water = q.getWaterDepth(x, z);
        const slope = q.getSlope(x, z).deg;
        if (water > maxWade || slope >= N.blockSlopeDeg) { this.cost[k] = 0; continue; }
        const sp = surfaceProps(q.getSurfaceAt(x, z));
        let c = (1 / Math.max(0.12, sp.speed)) * (1 + Math.max(0, slope - 8) / 18);
        let blocked = false;
        q.circleGrid.forEachNear(x, z, cs * 0.75, (o) => {
          if (blocked || !o.tags.blocksMovement) return;
          const d = Math.hypot(o.x - x, o.z - z);
          if ((BLOCK_TYPES.has(o.type) || o.r >= N.trunkBlockR) && d < o.r + 0.3) blocked = true;
          else if (d < o.r + 0.7) c += 0.3;
        });
        if (blocked) { this.cost[k] = 0; continue; }
        const lift = q.getSupportHeight(x, z) - q.getTerrainHeight(x, z);
        if (lift > 1.0) { this.cost[k] = 0; continue; }
        if (lift > 0.42) c += 2;
        this.cost[k] = c;
        this.conceal[k] = Math.round(Math.min(1, Math.max(0, q.coverConcealment(x, z, 1.0))) * 255);
      }
    }
    // 오솔길 칸
    for (const tr of layout?.trails ?? []) {
      const L = tr.line, r = (tr.halfWidth ?? 1) + 0.8;
      for (let p = 0; p < L.count; p++) {
        const px = L.x[p], pz = L.z[p];
        const i0 = this._ci(px - r), i1 = this._ci(px + r), j0 = this._ci(pz - r), j1 = this._ci(pz + r);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          const cx = -this.half + (i + 0.5) * cs, cz = -this.half + (j + 0.5) * cs;
          if (Math.hypot(cx - px, cz - pz) <= r && this.cost[k] > 0) this.trail[k] = 1;
        }
      }
    }
    this.trails = layout?.trails ?? [];
  }

  _ci(v) {
    const i = Math.floor((v + this.half) / this.cell);
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  /** 월드 → 칸 번호 */
  index(x, z) { return this._ci(z) * this.n + this._ci(x); }
  centerOf(k, out = { x: 0, z: 0 }) {
    const i = k % this.n, j = (k / this.n) | 0;
    out.x = -this.half + (i + 0.5) * this.cell;
    out.z = -this.half + (j + 0.5) * this.cell;
    return out;
  }
  walkable(x, z) { return this.cost[this.index(x, z)] > 0; }
  concealAt(x, z) { return this.conceal[this.index(x, z)] / 255; }
  onTrail(x, z) { return this.trail[this.index(x, z)] === 1; }

  /** 가장 가까운 걸을 수 있는 칸 중심 (반경 r 칸 안) — 없으면 null */
  nearestOpen(x, z, r = 4) {
    const k0 = this.index(x, z);
    if (this.cost[k0] > 0) return this.centerOf(k0);
    const i0 = k0 % this.n, j0 = (k0 / this.n) | 0;
    let best = -1, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
      const k = j * this.n + i;
      if (!(this.cost[k] > 0)) continue;
      const d = di * di + dj * dj;
      if (d < bd) { bd = d; best = k; }
    }
    return best >= 0 ? this.centerOf(best) : null;
  }

  // -----------------------------------------------------------------
  // A*
  // -----------------------------------------------------------------
  /**
   * @param {{x,z}} a  시작   @param {{x,z}} b  끝
   * @param {{ mode?: 'patrol'|'combat'|'normal', maxNodes?: number }} opts
   * @returns {Array<{x,z}>|null}  경유점 (첫 점 = 시작 다음, 마지막 = 끝)
   */
  findPath(a, b, opts = {}) {
    const N = CONFIG.ai.nav, n = this.n;
    const mode = opts.mode ?? 'normal';
    const maxNodes = opts.maxNodes ?? N.maxNodes;
    let s = this.index(a.x, a.z);
    if (!(this.cost[s] > 0)) { const o = this.nearestOpen(a.x, a.z, 3); if (!o) return null; s = this.index(o.x, o.z); }
    let g = this.index(b.x, b.z);
    if (!(this.cost[g] > 0)) { const o = this.nearestOpen(b.x, b.z, 5); if (!o) return null; g = this.index(o.x, o.z); }
    const stamp = ++this._stamp;
    const G = this._g, F = this._from, seen = this._seen, closed = this._closed, heap = this._heap, hf = this._hf;
    const gi = g % n, gj = (g / n) | 0;
    const trailMul = N.trailMul, expMul = N.combatExposureMul;
    const minMul = mode === 'patrol' ? trailMul : 1;
    const H = (k) => {
      const di = Math.abs(k % n - gi), dj = Math.abs(((k / n) | 0) - gj);
      return (Math.max(di, dj) + (SQRT2 - 1) * Math.min(di, dj)) * minMul * 0.95;
    };
    let hn = 0;
    const push = (k, f) => {
      let i = hn++;
      heap[i] = k; hf[i] = f;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= hf[i]) break;
        const tk = heap[p], tf = hf[p]; heap[p] = heap[i]; hf[p] = hf[i]; heap[i] = tk; hf[i] = tf;
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      hn--;
      if (hn > 0) {
        heap[0] = heap[hn]; hf[0] = hf[hn];
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < hn && hf[l] < hf[m]) m = l;
          if (r < hn && hf[r] < hf[m]) m = r;
          if (m === i) break;
          const tk = heap[m], tf = hf[m]; heap[m] = heap[i]; hf[m] = hf[i]; heap[i] = tk; hf[i] = tf;
          i = m;
        }
      }
      return top;
    };
    seen[s] = stamp; G[s] = 0; F[s] = -1;
    push(s, H(s));
    let expanded = 0, found = false;
    while (hn > 0) {
      const k = pop();
      if (closed[k] === stamp) continue;
      closed[k] = stamp;
      if (k === g) { found = true; break; }
      if (++expanded > maxNodes) break;
      const i = k % n, j = (k / n) | 0;
      for (let d = 0; d < 8; d++) {
        const ni = i + DIRS[d][0], nj = j + DIRS[d][1];
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const nk = nj * n + ni;
        const c = this.cost[nk];
        if (!(c > 0) || closed[nk] === stamp) continue;
        // 대각선은 양옆이 막히지 않아야 (줄기 사이로 비집고 지나가지 않게)
        if (d >= 4 && (!(this.cost[j * n + ni] > 0) || !(this.cost[nj * n + i] > 0))) continue;
        let cm = c;
        if (mode === 'patrol' && this.trail[nk]) cm *= trailMul;
        else if (mode === 'combat') cm *= 1 + expMul * (1 - this.conceal[nk] / 255);
        const ng = G[k] + cm * DIRS[d][2];
        if (seen[nk] !== stamp || ng < G[nk]) {
          seen[nk] = stamp; G[nk] = ng; F[nk] = k;
          push(nk, ng + H(nk));
        }
      }
    }
    this.lastStats.expanded = expanded;
    this.lastStats.ok = found;
    if (!found) return null;
    // 칸 경로 → 월드 점 → 직선으로 걸을 수 있는 구간 잇기
    const cells = [];
    for (let k = g; k !== -1; k = F[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => this.centerOf(k, { x: 0, z: 0 }));
    pts[pts.length - 1] = { x: b.x, z: b.z };
    if (!this.walkable(b.x, b.z)) pts[pts.length - 1] = this.centerOf(g, { x: 0, z: 0 });
    return this._smooth({ x: a.x, z: a.z }, pts, mode);
  }

  /**
   * 직선 a→b 가 막힌 칸·크게 비싼 칸(진흙 2배 이상 차이)을 지나지 않고, 몸(반경 bodyR)이 줄기에 걸리지 않는지.
   * 칸(2m)보다 작은 줄기는 칸을 막지 않으므로 직선 구간마다 원기둥 충돌체를 따로 본다.
   */
  lineWalkable(a, b, maxCost = Infinity, bodyR = 0.32) {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(d / 0.5));
    const grid = this.query.circleGrid;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const c = this.cost[this.index(x, z)];
      if (!(c > 0) || c > maxCost) return false;
      const list = grid.at(x, z);
      for (let k = 0; k < list.length; k++) {
        const o = list[k];
        if (!o.tags.blocksMovement || o.r < 0.12) continue;
        if (Math.hypot(o.x - x, o.z - z) < o.r + bodyR) return false;
      }
    }
    return true;
  }

  _smooth(start, pts, mode) {
    if (pts.length <= 2) return pts;
    const out = [];
    let cur = start, i = 0;
    while (i < pts.length) {
      // 오솔길 순찰은 길 칸을 벗어나는 지름길을 만들지 않게 짧게만 당김
      const maxLook = mode === 'patrol' ? 4 : 12;
      let j = Math.min(pts.length - 1, i + maxLook);
      const curCost = this.cost[this.index(cur.x, cur.z)];
      for (; j > i; j--) if (this.lineWalkable(cur, pts[j], Math.max(curCost, 1.5) * 1.6)) break;
      out.push(pts[j]);
      cur = pts[j];
      i = j + 1;
    }
    return out;
  }

  // -----------------------------------------------------------------
  // 엄폐
  // -----------------------------------------------------------------
  /**
   * 위협 방향을 막는 엄폐 후보 (점수 높은 순, 최대 max 개).
   * @param {{x,z}} pos  지금 위치   @param {{x,z}} threat  위협 (마지막 확인 위치)
   * @param {{ radius?, max?, taken?: Array<{x,z}>, prefer?: {min, max} (위협까지 거리 선호), away?: boolean }} opts
   * @returns {Array<{x, z, hideX, hideZ, peekX, peekZ, r, kind: 'hard'|'soft', type, score}>}
   */
  findCover(pos, threat, opts = {}) {
    const C = CONFIG.ai.cover, q = this.query;
    const R = opts.radius ?? C.search, max = opts.max ?? 6;
    const taken = opts.taken ?? [];
    const pref = opts.prefer ?? null;
    const out = [];
    const add = (cx, cz, r, kind, type) => {
      let ux = cx - threat.x, uz = cz - threat.z;
      const ul = Math.hypot(ux, uz);
      if (ul < 3) return;
      ux /= ul; uz /= ul;
      const sd = r + C.standoff;
      const hideX = cx + ux * sd, hideZ = cz + uz * sd;
      if (!this.walkable(hideX, hideZ)) return;
      const dPos = Math.hypot(hideX - pos.x, hideZ - pos.z);
      if (dPos > R) return;
      for (const t of taken) if (Math.hypot(t.x - hideX, t.z - hideZ) < 2.2) return;
      // 옆으로 내다보는 점 (위협에서 볼 때 줄기 옆) — 왼쪽·오른쪽 중 걸을 수 있는 쪽
      const px = -uz, pz = ux;
      let side = 1;
      const peek = (sgn) => ({ x: cx + ux * sd * 0.6 + px * sgn * (r + C.peek), z: cz + uz * sd * 0.6 + pz * sgn * (r + C.peek) });
      let pk = peek(1);
      if (!this.walkable(pk.x, pk.z)) { side = -1; pk = peek(-1); }
      const dThreat = ul + sd;
      let score = (kind === 'hard' ? 10 : 4) + Math.min(r, 1) * 3 - dPos * 0.35;
      if (opts.away) score += (dThreat - Math.hypot(pos.x - threat.x, pos.z - threat.z)) * 0.25;
      if (pref) {
        if (dThreat < pref.min) score -= (pref.min - dThreat) * 0.4;
        if (dThreat > pref.max) score -= (dThreat - pref.max) * 0.2;
      }
      score += this.concealAt(hideX, hideZ) * 2;
      out.push({ x: cx, z: cz, hideX, hideZ, peekX: pk.x, peekZ: pk.z, side, r, kind, type, score, dThreat });
    };
    const visited = new Set();   // 격자 칸 여러 개에 걸친 물체는 여러 번 나온다
    q.circleGrid.forEachNear(pos.x, pos.z, R, (c) => {
      if (visited.has(c)) return;
      visited.add(c);
      if (c.tags.bulletBlock !== 'full' || !c.tags.blocksMovement || c.r < C.minRadius) return;
      add(c.x, c.z, c.r, 'hard', c.type);
    });
    q.supportGrid.forEachNear(pos.x, pos.z, R, (s) => {
      if (visited.has(s)) return;
      visited.add(s);
      if (s.tags.bulletBlock !== 'full') return;
      if (s.type === 'log') add((s.ax + s.bx) / 2, (s.az + s.bz) / 2, s.r + 0.2, 'hard', 'log');
      else if (s.type === 'rock') add(s.cx, s.cz, Math.max(s.rx, s.rz) * 0.8, 'hard', 'rock');
    });
    // 2순위: 숨기만 되는 수풀 (총알은 못 막음)
    if (out.length < max) {
      for (const rr of [3, 6, 10, 15]) {
        if (rr > R) break;
        for (let a = 0; a < 8; a++) {
          const ang = a * Math.PI / 4 + rr * 0.3;
          const x = pos.x + Math.cos(ang) * rr, z = pos.z + Math.sin(ang) * rr;
          if (!this.walkable(x, z)) continue;
          const cv = q.coverConcealment(x, z, 1.0);
          if (cv < C.concealMin) continue;
          let dup = false;
          for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < 2.2) { dup = true; break; }
          if (dup) continue;
          const dThreat = Math.hypot(x - threat.x, z - threat.z);
          let score = 3 + cv * 3 - rr * 0.3;
          if (pref) {
            if (dThreat < pref.min) score -= (pref.min - dThreat) * 0.4;
            if (dThreat > pref.max) score -= (dThreat - pref.max) * 0.2;
          }
          out.push({ x, z, hideX: x, hideZ: z, peekX: x, peekZ: z, side: 0, r: 0, kind: 'soft', type: 'bush', score, dThreat });
        }
      }
    }
    out.sort((p, q2) => q2.score - p.score);
    if (out.length > max) out.length = max;
    return out;
  }
}
