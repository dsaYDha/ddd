// =====================================================================
//  MapData — 5단계 종이 지도 내용 (순수 로직). 지형 데이터로 만든 등고선 지도:
//   등고선 (marching squares, interval m 간격, 5개마다 굵은 계곡선), 개울·강, 주요 오솔길, 논 (둑 격자), 늪, 격자 좌표 (100m).
//   작은 길·식생·적·내 위치는 없다. 임무 목표와 회수 지점은 연필 표시로만 (PaperMap 이 mission.marks 를 그림).
//  buildMapData(data, query, opts) → { size, half, contours: [{level, major, segs: Float32Array(x0,z0,x1,z1,…)}],
//    streams: [[x,z]…][], river: {north: [[x,z]…], south}, trails: [[x,z]…][], paddy: [[x,z]…], paddyDikes: segs, swamp: [[x,z]…], grid }
// =====================================================================
import { LAYOUT, riverCenterZ } from '../world/MapLayout.js';

/**
 * @param {object} data   generateWorld 결과
 * @param {object} query  WorldQuery
 * @param {{ step?: number, interval?: number }} opts  step: 표본 간격 m (기본 2 — 개울 바닥·가장자리 비탈까지 맞게), interval: 등고선 간격 m (기본 2)
 */
export function buildMapData(data, query, opts = {}) {
  const step = opts.step ?? 2, interval = opts.interval ?? 2;
  const half = data.half, n = Math.floor((half * 2) / step) + 1;
  // 높이 표본 (지도 범위 안쪽만 — 가장자리 절벽 바깥은 그리지 않음)
  const H = new Float32Array(n * n);
  let hmin = Infinity, hmax = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + i * step, z = -half + j * step;
      const h = query.getTerrainHeight(x, z);
      H[j * n + i] = h;
      if (h < hmin) hmin = h;
      if (h > hmax) hmax = h;
    }
  }
  const contours = [];
  const l0 = Math.ceil(hmin / interval) * interval;
  for (let level = l0; level <= hmax; level += interval) {
    const segs = marching(H, n, step, half, level);
    if (segs.length) contours.push({ level, major: Math.round(level / interval) % 5 === 0, segs: new Float32Array(segs) });
  }
  const line = (ln, every = 3) => {
    const out = [];
    for (let k = 0; k < ln.count; k += every) out.push([ln.x[k], ln.z[k]]);
    out.push([ln.x[ln.count - 1], ln.z[ln.count - 1]]);
    return out;
  };
  const L = data.layout;
  const streams = L.streams.map((st) => line(st.line, 2));
  const trails = L.trails.map((tr) => line(tr.line, 3));
  const river = { north: [], south: [] };
  for (let x = -half; x <= half; x += 6) {
    const zc = riverCenterZ(x);
    river.north.push([x, zc - LAYOUT.river.halfWidth]);
    river.south.push([x, zc + LAYOUT.river.halfWidth]);
  }
  const pd = data.paddy;
  let paddy = null, paddyDikes = [];
  if (pd) {
    paddy = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([u, v]) => pd.toWorld(u * pd.halfU, v * pd.halfV));
    for (let c = 1; c < pd.cols; c++) {
      const u = -pd.halfU + c * pd.cellW;
      paddyDikes.push([pd.toWorld(u, -pd.halfV), pd.toWorld(u, pd.halfV)]);
    }
    for (let r = 1; r < pd.rows; r++) {
      const v = -pd.halfV + r * pd.cellH;
      paddyDikes.push([pd.toWorld(-pd.halfU, v), pd.toWorld(pd.halfU, v)]);
    }
  }
  const sw = L.swamp;
  const swamp = [];
  for (let k = 0; k <= 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const r = sw.radius * (1 + 0.08 * Math.sin(a * 3 + 1.2) + 0.05 * Math.sin(a * 7));
    swamp.push([sw.x + Math.cos(a) * r, sw.z + Math.sin(a) * r]);
  }
  return { size: data.size, half, step, interval, hmin, hmax, contours, streams, trails, river, paddy, paddyDikes, swamp, grid: 100 };
}

/** marching squares: 격자 H (n×n, 간격 step) 의 level 등고선 선분 [x0,z0,x1,z1,…] */
function marching(H, n, step, half, level) {
  const out = [];
  const X = (i) => -half + i * step;
  const lerp = (a, b, va, vb) => a + (b - a) * ((level - va) / ((vb - va) || 1e-9));
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i + 1], d = H[(j + 1) * n + i];
      let code = 0;
      if (a >= level) code |= 1;
      if (b >= level) code |= 2;
      if (c >= level) code |= 4;
      if (d >= level) code |= 8;
      if (code === 0 || code === 15) continue;
      const x0 = X(i), x1 = X(i + 1), z0 = X(j), z1 = X(j + 1);
      // 변 위 교점: 위(ab) 오른쪽(bc) 아래(dc) 왼쪽(ad)
      const top = () => [lerp(x0, x1, a, b), z0];
      const right = () => [x1, lerp(z0, z1, b, c)];
      const bottom = () => [lerp(x0, x1, d, c), z1];
      const left = () => [x0, lerp(z0, z1, a, d)];
      const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: case 14: seg(left(), top()); break;
        case 2: case 13: seg(top(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(right(), bottom()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), bottom()); break;
        case 5: seg(left(), top()); seg(right(), bottom()); break;
        case 10: seg(top(), right()); seg(left(), bottom()); break;
        default: break;
      }
    }
  }
  return out;
}
