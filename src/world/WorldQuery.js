// 월드 물리 질의 API (three.js 의존 없음).
// 플레이어·적 공용 이동 컴포넌트(HumanMotor)와 2~4단계 시스템이 이 인터페이스만 사용한다.
import { CONFIG } from '../config.js';
import { SURFACE, surfaceProps } from './Surfaces.js';
import { NO_WATER, cellIndex, sampleBilinear } from './WorldGen.js';

const RAD2DEG = 180 / Math.PI;
const CIRCLE_PAD = 0.6; // 충돌 질의에 쓰는 최대 몸 반경
const VEG_ATTEN = { type: 'vegetation', get tags() { return CONFIG.objects.shrub; } };

/** 균일 격자 공간 인덱스 (원형 충돌체·지지형 장애물) */
class UniformGrid {
  constructor(size, cell) {
    this.half = size / 2;
    this.cell = cell;
    this.n = Math.ceil(size / cell) + 1;
    this.cells = new Array(this.n * this.n);
  }
  _idx(i, j) { return j * this.n + i; }
  _clampI(v) { return v < 0 ? 0 : v >= this.n ? this.n - 1 : v; }
  insertAABB(item, minX, minZ, maxX, maxZ) {
    const i0 = this._clampI(Math.floor((minX + this.half) / this.cell));
    const i1 = this._clampI(Math.floor((maxX + this.half) / this.cell));
    const j0 = this._clampI(Math.floor((minZ + this.half) / this.cell));
    const j1 = this._clampI(Math.floor((maxZ + this.half) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = this._idx(i, j);
        (this.cells[k] || (this.cells[k] = [])).push(item);
      }
    }
  }
  /** 해당 점이 속한 셀의 항목 (없으면 빈 배열) */
  at(x, z) {
    const i = this._clampI(Math.floor((x + this.half) / this.cell));
    const j = this._clampI(Math.floor((z + this.half) / this.cell));
    return this.cells[this._idx(i, j)] || EMPTY;
  }
  /** 5단계: 항목 빼기 (넣을 때와 같은 AABB) */
  removeAABB(item, minX, minZ, maxX, maxZ) {
    const i0 = this._clampI(Math.floor((minX + this.half) / this.cell));
    const i1 = this._clampI(Math.floor((maxX + this.half) / this.cell));
    const j0 = this._clampI(Math.floor((minZ + this.half) / this.cell));
    const j1 = this._clampI(Math.floor((maxZ + this.half) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[this._idx(i, j)];
        if (!list) continue;
        const k = list.indexOf(item);
        if (k >= 0) list.splice(k, 1);
      }
    }
  }
  /** 반경 안의 셀들을 돌며 콜백 (중복 가능 → stamp로 거름) */
  forEachNear(x, z, r, fn) {
    const i0 = this._clampI(Math.floor((x - r + this.half) / this.cell));
    const i1 = this._clampI(Math.floor((x + r + this.half) / this.cell));
    const j0 = this._clampI(Math.floor((z - r + this.half) / this.cell));
    const j1 = this._clampI(Math.floor((z + r + this.half) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[this._idx(i, j)];
        if (!list) continue;
        for (let k = 0; k < list.length; k++) fn(list[k]);
      }
    }
  }
}
const EMPTY = [];

export class WorldQuery {
  constructor(data) {
    this.data = data;
    this.paddy = data.paddy;
    this.half = data.half;
    this.size = data.size;
    this.wetness = CONFIG.weather.presets.clear.wetness; // 날씨 시스템이 갱신
    this.rainIntensity = 0;

    // 몸 반경만큼 넓혀 넣는다 → 위치가 속한 칸만 봐도 이웃 칸에 걸친 충돌체를 놓치지 않음
    this.circleGrid = new UniformGrid(data.size, 4);
    const PAD = CIRCLE_PAD;
    for (const c of data.circles) {
      this.circleGrid.insertAABB(c, c.x - c.r - PAD, c.z - c.r - PAD, c.x + c.r + PAD, c.z + c.r + PAD);
    }
    this.supportGrid = new UniformGrid(data.size, 4);
    for (const s of data.supports) this.addSupport(s);
    this._stamp = 0;
    this._ground = { terrain: 0, support: 0, surface: 0, waterLevel: NO_WATER, waterDepth: 0, onDike: false, obstacle: null };
    this._slope = { deg: 0, gx: 0, gz: 0 };
  }

  // ---------------------------------------------------------------
  // 5단계: 실행 중 충돌체 더하기·빼기 (임무 오두막 벽, 개활지 깎기)
  // ---------------------------------------------------------------
  /** 원기둥 {x, z, r, y0, y1, type, tags} */
  addCircle(c) {
    const P = CIRCLE_PAD;
    this.circleGrid.insertAABB(c, c.x - c.r - P, c.z - c.r - P, c.x + c.r + P, c.z + c.r + P);
  }
  removeCircle(c) {
    const P = CIRCLE_PAD;
    this.circleGrid.removeAABB(c, c.x - c.r - P, c.z - c.r - P, c.x + c.r + P, c.z + c.r + P);
  }
  /** 지지형 장애물 (capsule {ax,ay,az,bx,by,bz,r} · ellipsoid {cx,cy,cz,rx,ry,rz,yaw}) */
  addSupport(s) {
    const b = supportBox(s);
    if (b) this.supportGrid.insertAABB(s, b[0], b[1], b[2], b[3]);
  }
  removeSupport(s) {
    const b = supportBox(s);
    if (b) this.supportGrid.removeAABB(s, b[0], b[1], b[2], b[3]);
  }

  // ---------------------------------------------------------------
  // 높이·경사
  // ---------------------------------------------------------------
  getTerrainHeight(x, z) {
    const d = this.data;
    return sampleBilinear(d.height, d.hN, d.hRes, d.half, x, z);
  }

  /** 지형 경사: deg, (gx,gz) = 높이 기울기 (오르막 방향 벡터, 크기 = tan) */
  getSlope(x, z, out = this._slope) {
    const e = 0.5;
    const gx = (this.getTerrainHeight(x + e, z) - this.getTerrainHeight(x - e, z)) / (2 * e);
    const gz = (this.getTerrainHeight(x, z + e) - this.getTerrainHeight(x, z - e)) / (2 * e);
    out.gx = gx; out.gz = gz;
    out.deg = Math.atan(Math.hypot(gx, gz)) * RAD2DEG;
    return out;
  }

  /** 지형 + 논둑 + 장애물(통나무·바위·뿌리) 중 가장 높은 지지면 */
  getSupportHeight(x, z, info = null) {
    let h = this.getTerrainHeight(x, z);
    let obstacle = null;
    let onDike = false;
    const pq = this.paddy.query(x, z);
    if (pq.inside && pq.onDike && pq.dikeTop > h) { h = pq.dikeTop; onDike = true; }
    const list = this.supportGrid.at(x, z);
    for (let k = 0; k < list.length; k++) {
      const top = shapeTop(list[k], x, z);
      if (top > h) { h = top; obstacle = list[k]; onDike = false; }
    }
    if (info) { info.obstacle = obstacle; info.onDike = onDike; }
    return h;
  }

  // ---------------------------------------------------------------
  // 지면 종류 / 물
  // ---------------------------------------------------------------
  getSurfaceAt(x, z) {
    const pq = this.paddy.query(x, z);
    if (pq.inside) return pq.onDike ? SURFACE.PACKED_DIRT : SURFACE.PADDY;
    const d = this.data;
    return d.surface[cellIndex(x, z, d.sN, d.sRes, d.half)];
  }

  getWaterLevel(x, z) {
    const pq = this.paddy.query(x, z);
    if (pq.inside) return pq.onDike ? NO_WATER : pq.waterLevel;
    const d = this.data;
    return d.waterLevel[cellIndex(x, z, d.sN, d.sRes, d.half)];
  }

  getWaterDepth(x, z) {
    const wl = this.getWaterLevel(x, z);
    if (wl === NO_WATER) return 0;
    return Math.max(0, wl - this.getTerrainHeight(x, z));
  }

  /** 한 번에 필요한 지면 정보 (할당 없음 — 반환 객체 재사용) */
  getGroundInfo(x, z, out = this._ground) {
    out.terrain = this.getTerrainHeight(x, z);
    out.support = this.getSupportHeight(x, z, out);
    out.surface = this.getSurfaceAt(x, z);
    out.waterLevel = this.getWaterLevel(x, z);
    out.waterDepth = out.waterLevel === NO_WATER ? 0 : Math.max(0, out.waterLevel - out.terrain);
    // 장애물·논둑 위라면 물·진흙 영향 없음
    if (out.obstacle || out.onDike) {
      if (out.obstacle) out.surface = SURFACE.PACKED_DIRT;
      out.waterDepth = Math.max(0, out.waterLevel - out.support);
    }
    return out;
  }

  surfaceProps(id) { return surfaceProps(id); }

  // ---------------------------------------------------------------
  // 충돌
  // ---------------------------------------------------------------
  /** 원기둥 충돌체 밖으로 밀어냄. 반환: 충돌했으면 true */
  resolveCircles(pos, radius, y0, y1) {
    let hit = false;
    for (let iter = 0; iter < 5; iter++) {
      let moved = false;
      const list = this.circleGrid.at(pos.x, pos.z);
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (!c.tags.blocksMovement || y1 < c.y0 || y0 > c.y1) continue;
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const rr = c.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-4;
        const push = rr - d + 1e-4;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        moved = true; hit = true;
      }
      if (!moved) break;
    }
    return hit;
  }

  /** 점에서 반경 안 가장 가까운 원기둥까지의 여유 거리 (기울이기 제한용) */
  clearanceAt(x, z, y) {
    let best = Infinity;
    this.circleGrid.forEachNear(x, z, 3, (c) => {
      if (!c.tags.blocksMovement || y < c.y0 || y > c.y1) return;
      const d = Math.hypot(x - c.x, z - c.z) - c.r;
      if (d < best) best = d;
    });
    return best;
  }

  /** 안전 경계 (자연 장애물 뒤에 숨겨둔 최후 경계) */
  clampToBounds(pos) {
    const m = this.half - CONFIG.world.safetyMargin;
    if (pos.x < -m) pos.x = -m; else if (pos.x > m) pos.x = m;
    if (pos.z < -m) pos.z = -m; else if (pos.z > m) pos.z = m;
  }

  // ---------------------------------------------------------------
  // 은폐·캐노피
  // ---------------------------------------------------------------
  _cIdx(x, z) {
    const n = this.data.cN;
    let i = Math.floor(x + this.half), j = Math.floor(z + this.half);
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return j * n + i;
  }
  getCanopyCover(x, z) { return this.data.canopy[this._cIdx(x, z)]; }
  /** 지점의 체적형 식생 요약: 최고 높이와 구간별 σ (디버그·AI용) */
  getCover(x, z) {
    const k = this._cIdx(x, z);
    const NB = this.data.coverBandEdges.length - 1;
    return { height: this.data.coverHeight[k], bands: this.data.coverBands.subarray(k * NB, k * NB + NB) };
  }

  /** 지면에서 bodyH 높이까지의 몸이 주변 식생에 가려지는 비율 (0~1) */
  coverConcealment(x, z, bodyH) {
    const E = this.data.coverBandEdges, B = this.data.coverBands;
    const NB = E.length - 1;
    const k = this._cIdx(x, z) * NB;
    const h = Math.max(0.3, bodyH);
    let c = 0;
    for (let b = 0; b < NB && E[b] < h; b++) {
      const o = Math.min(h, E[b + 1]) - E[b];
      c += (o / h) * (1 - Math.exp(-B[k + b] * 1.6));
    }
    return c;
  }

  // ---------------------------------------------------------------
  // raycastWorld — mode 'vision' (visionBlock 기준) / 'bullet' (bulletBlock 기준)
  // ---------------------------------------------------------------
  /**
   * @returns {{hit:boolean, distance:number, point:{x,y,z}, object:{type,tags}|null,
   *            transmittance:number, passed:Array<{type,distance,block}>}}
   *  vision: transmittance(남은 가시도)가 0.05 아래로 떨어지면 hit
   *  bullet: bulletBlock 'full'에 닿으면 hit, 'partial'은 passed에 기록하고 계속 (관통은 2단계)
   */
  raycastWorld(origin, direction, maxDist = 150, mode = 'vision') {
    const T = CONFIG.objects;
    const dl = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dx = direction.x / dl, dy = direction.y / dl, dz = direction.z / dl;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const vision = mode === 'vision';
    const res = { hit: false, distance: maxDist, point: null, object: null, transmittance: 1, passed: [], mode };

    // 1) 원기둥 충돌체 교차 구간 수집 (2D 광선-원 교차 + 높이 확인)
    const events = [];
    const stamp = ++this._stamp;
    const hd = Math.hypot(dx, dz);
    const step = this.circleGrid.cell * 0.5;
    if (hd > 1e-6) {
      for (let t = 0; t <= maxDist + step; t += step) {
        const px = ox + dx * t, pz = oz + dz * t;
        const list = this.circleGrid.at(px, pz);
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          if (c._ray === stamp) continue;
          c._ray = stamp;
          // |O + tD - C|² = r² (수평면)
          const fx = ox - c.x, fz = oz - c.z;
          const a = dx * dx + dz * dz;
          const b = 2 * (fx * dx + fz * dz);
          const cc = fx * fx + fz * fz - c.r * c.r;
          const disc = b * b - 4 * a * cc;
          if (disc < 0) continue;
          const sq = Math.sqrt(disc);
          let t0 = (-b - sq) / (2 * a);
          const t1 = (-b + sq) / (2 * a);
          if (t1 < 0 || t0 > maxDist) continue;
          if (t0 < 0) t0 = 0;
          const y = oy + dy * t0;
          if (y < c.y0 || y > c.y1) continue;
          events.push({ t: t0, c });
        }
      }
    }
    events.sort((a, b) => a.t - b.t);
    let ei = 0;

    // 2) 광선 진행 (0.2m 간격): 지형·장애물·물·체적형 식생·캐노피
    const STEP = 0.2;
    const bandEdges = this.data.coverBandEdges, bands = this.data.coverBands;
    const NB = bandEdges.length - 1, bandTop = bandEdges[NB];
    const sigCanopy = -Math.log(1 - T.canopy.visionBlock);
    const sigWater = -Math.log(1 - Math.min(0.99, T.water.visionBlock)) * 4;
    let inWater = false;
    let lastAtten = null;
    for (let t = 0; t <= maxDist; t += STEP) {
      // 이 구간 안에 들어온 원기둥 처리
      while (ei < events.length && events[ei].t <= t) {
        const { c, t: tc } = events[ei++];
        if (vision) {
          res.transmittance *= 1 - c.tags.visionBlock;
          lastAtten = c;
          if (res.transmittance < 0.05) return finish(res, tc, ox, oy, oz, dx, dy, dz, c.type, c.tags, true);
          res.passed.push({ type: c.type, distance: tc, block: c.tags.visionBlock });
        } else {
          if (c.tags.bulletBlock === 'full') return finish(res, tc, ox, oy, oz, dx, dy, dz, c.type, c.tags, true);
          if (c.tags.bulletBlock === 'partial') res.passed.push({ type: c.type, distance: tc, block: 'partial' });
        }
      }
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      if (Math.abs(px) > this.half || Math.abs(pz) > this.half) break;

      // 지형
      const th = this.getTerrainHeight(px, pz);
      if (py < th) return finish(res, t, ox, oy, oz, dx, dy, dz, 'terrain', T.terrain, true);
      // 논둑·통나무·바위·뿌리
      const pq = this.paddy.query(px, pz);
      if (pq.inside && pq.onDike && py < pq.dikeTop) return finish(res, t, ox, oy, oz, dx, dy, dz, 'dike', T.dike, true);
      const sl = this.supportGrid.at(px, pz);
      for (let k = 0; k < sl.length; k++) {
        const s = sl[k];
        if (insideShape(s, px, py, pz)) {
          if (vision ? s.tags.visionBlock >= 0.95 : s.tags.bulletBlock === 'full') {
            return finish(res, t, ox, oy, oz, dx, dy, dz, s.type, s.tags, true);
          }
        }
      }
      // 물
      const wl = this.getWaterLevel(px, pz);
      const under = wl !== NO_WATER && py < wl;
      if (under && !inWater && !vision) res.passed.push({ type: 'water', distance: t, block: T.water.bulletBlock });
      inWater = under;
      if (vision) {
        if (under) { res.transmittance *= Math.exp(-sigWater * STEP); lastAtten = { type: 'water', tags: T.water }; }
        // 풀·덤불·고사리 (체적형): 지면 위 높이 구간의 σ
        const k = this._cIdx(px, pz);
        const hh = py - th;
        if (hh < bandTop) {
          let b = 0;
          while (hh >= bandEdges[b + 1]) b++;
          const sg = bands[k * NB + b];
          if (sg > 0) {
            res.transmittance *= Math.exp(-sg * STEP);
            lastAtten = VEG_ATTEN;
          }
        }
        // 캐노피
        const cv = this.data.canopy[k];
        if (cv > 0.05 && py > this.data.canopyLow[k] && py < this.data.canopyHigh[k]) {
          res.transmittance *= Math.exp(-sigCanopy * cv * STEP);
          lastAtten = { type: 'canopy', tags: T.canopy };
        }
        if (res.transmittance < 0.05) {
          return finish(res, t, ox, oy, oz, dx, dy, dz, lastAtten.type, lastAtten.tags, true);
        }
      }
    }
    return finish(res, maxDist, ox, oy, oz, dx, dy, dz, null, null, false);
  }
}

/** 지지형 장애물의 평면 AABB (처음 부를 때 모양 값을 채움) */
function supportBox(s) {
  if (s.kind === 'capsule') {
    s.dx = s.bx - s.ax; s.dz = s.bz - s.az;
    s.len2 = s.dx * s.dx + s.dz * s.dz;
    return [Math.min(s.ax, s.bx) - s.r, Math.min(s.az, s.bz) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.az, s.bz) + s.r];
  }
  if (s.kind === 'ellipsoid') {
    s.cos = Math.cos(s.yaw); s.sin = Math.sin(s.yaw);
    const m = Math.max(s.rx, s.rz);
    return [s.cx - m, s.cz - m, s.cx + m, s.cz + m];
  }
  return null;
}

function finish(res, t, ox, oy, oz, dx, dy, dz, type, tags, hit) {
  res.hit = hit;
  res.distance = t;
  res.point = { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t };
  res.object = type ? { type, tags } : null;
  return res;
}

/** 지지형 장애물의 윗면 높이 (발자국 밖이면 -Infinity) */
export function shapeTop(s, x, z) {
  if (s.kind === 'capsule') {
    let t = s.len2 > 0 ? ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = s.ax + s.dx * t - x, cz = s.az + s.dz * t - z;
    const d2 = cx * cx + cz * cz;
    if (d2 >= s.r * s.r) return -Infinity;
    return s.ay + (s.by - s.ay) * t + Math.sqrt(s.r * s.r - d2);
  }
  if (s.kind === 'ellipsoid') {
    const dx = x - s.cx, dz = z - s.cz;
    const lx = dx * s.cos + dz * s.sin, lz = -dx * s.sin + dz * s.cos;
    const e = (lx / s.rx) ** 2 + (lz / s.rz) ** 2;
    if (e >= 1) return -Infinity;
    return s.cy + s.ry * Math.sqrt(1 - e);
  }
  return -Infinity;
}

function insideShape(s, x, y, z) {
  if (s.kind === 'capsule') {
    let t = s.len2 > 0 ? ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = s.ax + s.dx * t - x, cz = s.az + s.dz * t - z;
    const cy = s.ay + (s.by - s.ay) * t - y;
    return cx * cx + cz * cz + cy * cy < s.r * s.r;
  }
  if (s.kind === 'ellipsoid') {
    const dx = x - s.cx, dz = z - s.cz;
    const lx = dx * s.cos + dz * s.sin, lz = -dx * s.sin + dz * s.cos;
    return (lx / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 + (lz / s.rz) ** 2 < 1;
  }
  return false;
}
