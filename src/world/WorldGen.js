// 시드 고정 절차적 정글 맵 생성 (순수 데이터 — three.js 의존 없음, Node에서도 실행 가능)
import { CONFIG } from '../config.js';
import { Noise2D } from '../core/noise.js';
import { RNG } from '../core/rng.js';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { SURFACE } from './Surfaces.js';
import { LAYOUT, Polyline, PaddyField, valleyFloor, riverCenterZ } from './MapLayout.js';
import { placeFlora, buildGrids } from './Flora.js';
import { NO_WATER, VEG } from './WorldConstants.js';

export { NO_WATER, VEG };
export const BRUSH_GRASS = VEG.GRASS;
export const BRUSH_THICKET = VEG.THICKET;

export function generateWorld(seed = CONFIG.world.seed, onProgress = () => {}) {
  const t0 = now();
  const W = CONFIG.world;
  const size = W.size;
  const half = size / 2;
  const hRes = W.heightRes;
  const hN = Math.round(size / hRes) + 1;      // 높이맵 정점 수 (한 변)
  const sRes = W.surfaceRes;
  const sN = Math.round(size / sRes);          // 지면 격자 칸 수 (한 변)

  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  const noiseB = new Noise2D(seed ^ 0x5bd1e995);

  const data = {
    seed, size, half, hRes, hN, sRes, sN,
    height: new Float32Array(hN * hN),
    lowland: new Float32Array(hN * hN),
    surface: new Uint8Array(sN * sN),
    waterLevel: new Float32Array(sN * sN).fill(NO_WATER),
    waterKind: new Uint8Array(sN * sN),      // 0 없음, 1 개울, 2 늪, 3 논, 4 강
    vegKind: new Uint8Array(sN * sN),        // VEG.*
    splat: new Uint8Array(sN * sN * 4),      // 셰이더용: R 진흙, G 흙길, B 습기, A 지피식물 밀도
    layout: {},
    placements: {},
    supports: [],
    circles: [],
    timings: {},
  };

  // -------------------------------------------------------------
  // 1. 배치 요소 (개울, 논, 오솔길)
  // -------------------------------------------------------------
  const paddy = new PaddyField({
    ...LAYOUT.paddy,
    baseFloor: valleyFloor(LAYOUT.paddy.cx, LAYOUT.paddy.cz - 18) - 0.1,
  });
  const paddyWest = paddy.toWorld(-paddy.halfU - 2.5, -paddy.halfV + paddy.mainDikeRow * paddy.cellH);
  const paddyEast = paddy.toWorld(paddy.halfU + 2.5, -paddy.halfV + paddy.mainDikeRow * paddy.cellH);
  const paddySouth = paddy.toWorld(paddy.halfU - paddy.cellW * 1.0, paddy.halfV + 2.5);
  const resolve = (p) => (p[0] === 'paddyWest' ? paddyWest : p[0] === 'paddyEast' ? paddyEast : p[0] === 'paddySouth' ? paddySouth : p);

  const streams = LAYOUT.streams.map((def, i) => {
    const line = new Polyline(def.controls, { spacing: 1, meander: 7, meanderScale: 34, noise: noiseB, seedOffset: 10 + i * 17 });
    return { ...def, id: i, line };
  });

  const trails = LAYOUT.trails.map((def, i) => {
    const controls = def.controls.map(resolve);
    const line = new Polyline(controls, { spacing: 0.75, meander: 2.2, meanderScale: 16, noise: noiseB, seedOffset: 50 + i * 13 });
    return { ...def, id: i, line };
  });

  // 오솔길이 개울을 건너는 곳 = 여울 (얕고 넓게)
  for (const st of streams) {
    st.fords = [];
    for (const tr of trails) {
      for (let k = 0; k < tr.line.count; k += 2) {
        const c = st.line.closestS(tr.line.x[k], tr.line.z[k]);
        if (c.dist < 2.5 && !st.fords.some((f) => Math.abs(f - c.s) < 20)) st.fords.push(c.s);
      }
    }
  }

  // 개울 단면 파라미터 (호 길이 s의 함수)
  for (const st of streams) {
    const L = st.line.length;
    const N = Math.ceil(L) + 2;
    st.w = new Float32Array(N); st.depth = new Float32Array(N); st.drop = new Float32Array(N);
    st.bankW = new Float32Array(N); st.valleyW = new Float32Array(N); st.level = new Float32Array(N);
    const base = st.fords.length ? st.fords[0] : L * 0.4;
    const pools = st.pools.map((p) => ({ ...p, s: p.s < 0 ? base + p.s : p.s }));
    st.poolsAbs = pools;
    for (let s = 0; s < N; s++) {
      const n1 = 0.5 + 0.5 * noise.fbm(s / 40, 3.3 + st.id * 7, 2);
      const n2 = 0.5 + 0.5 * noise.fbm(s / 30, 9.1 + st.id * 7, 2);
      const n3 = 0.5 + 0.5 * noise.fbm(s / 22, 15.7 + st.id * 7, 2);
      const n4 = 0.5 + 0.5 * noise.fbm(s / 60, 21.4 + st.id * 7, 2);
      let w = 1.7 + 1.5 * n1;
      let depth = 0.26 + 0.24 * n2;             // 대부분 발목~무릎
      let drop = 0.45 + 1.25 * n3;              // 둑 높이
      let bankW = 1.8 + 1.6 * (1 - n3);         // 둑이 높을수록 가파르게
      for (const p of pools) {
        const k = Math.exp(-((s - p.s) ** 2) / (2 * (p.len / 2) ** 2));
        depth = lerp(depth, p.depth, k);         // 일부 허리 깊이
        w += 0.8 * k;
      }
      for (const f of st.fords) {
        const k = 1 - smoothstep(4, 12, Math.abs(s - f));
        depth = lerp(depth, 0.24, k);
        w = lerp(w, 3.4, k);
        drop = lerp(drop, 0.35, k);
        bankW = lerp(bankW, 5, k);
      }
      // 강 합류부는 강 수위로
      st.w[s] = w; st.depth[s] = depth; st.drop[s] = drop; st.bankW[s] = bankW;
      st.valleyW[s] = 15 + 14 * n4;
      const [px, pz] = st.line.pointAt(s);
      st.level[s] = valleyFloor(px, pz) - 0.55;
    }
  }

  const swamp = { ...LAYOUT.swamp };
  swamp.level = valleyFloor(swamp.x, swamp.z) - 0.6;
  const swampQ = (x, z) => Math.hypot(x - swamp.x, z - swamp.z) / swamp.radius + 0.2 * noise.fbm(x / 17 + 40, z / 17 - 40, 3);

  data.layout = { streams, trails, paddy, swamp, river: { ...LAYOUT.river, level: LAYOUT.riverLevel }, start: { ...W.start } };
  data.paddy = paddy;
  data.timings.layout = now() - t0;
  onProgress(0.1, '지형 배치');

  // -------------------------------------------------------------
  // 2. 거리장 스탬핑 (개울 1m, 오솔길 0.5m)
  // -------------------------------------------------------------
  const streamDist = new Float32Array(hN * hN).fill(1e9);
  const streamS = new Float32Array(hN * hN);
  const streamId = new Int8Array(hN * hN).fill(-1);
  for (const st of streams) {
    stampPolyline(st.line, 45, hN, hRes, half, streamDist, streamS, streamId, st.id);
  }
  const trailDist = new Float32Array(sN * sN).fill(1e9);
  const trailS = new Float32Array(sN * sN);
  const trailId = new Int8Array(sN * sN).fill(-1);
  for (const tr of trails) {
    stampPolylineCells(tr.line, 4, sN, sRes, half, trailDist, trailS, trailId, tr.id);
  }
  data.timings.stamp = now() - t0;

  // -------------------------------------------------------------
  // 3. 높이맵
  // -------------------------------------------------------------
  const H = data.height;
  const LOW = data.lowland;
  const streamParam = (st, s) => {
    const i = clamp(Math.round(s), 0, st.w.length - 1);
    return i;
  };
  const corridor = LAYOUT.corridor;
  const cliff = LAYOUT.cliff;
  const R = LAYOUT.river;

  // 3a. 기본 지형: 저지대 기준면 + 언덕·능선 + 잔기복
  const streamInfo = (idx) => {
    if (streamId[idx] < 0) return null;
    const st = streams[streamId[idx]];
    return { st, si: streamParam(st, streamS[idx]), sd: streamDist[idx] };
  };
  for (let j = 0; j < hN; j++) {
    const z = -half + j * hRes;
    for (let i = 0; i < hN; i++) {
      const x = -half + i * hRes;
      const idx = j * hN + i;
      const V = valleyFloor(x, z);

      // 언덕·능선
      const n1 = noise.fbm(x / 140 + 11.3, z / 140 - 4.2, 4);
      const r1 = noise.ridged(x / 95 - 2.1, z / 95 + 7.7, 3);
      let hill = 1.5 + 9 * (0.5 + 0.5 * n1) + 7 * r1 + 1.1 * noise.fbm(x / 30, z / 30, 3);
      hill = Math.max(hill, 0.3);

      // 저지대 마스크 (개울 골짜기는 좁고 가파르게)
      let m = 0;
      const si = streamInfo(idx);
      if (si) m = Math.max(m, 1 - smoothstep(si.st.valleyW[si.si] * 0.3, si.st.valleyW[si.si] * 0.3 + 28, si.sd));
      const q = swampQ(x, z);
      m = Math.max(m, 1 - smoothstep(1.3, 2.9, q));
      const psd = paddy.signedDistance(x, z);
      m = Math.max(m, 1 - smoothstep(8, 50, psd));
      const cd = Math.sqrt(segDist2(x, z, corridor[0][0], corridor[0][1], corridor[1][0], corridor[1][1]));
      m = Math.max(m, 1 - smoothstep(9, 42, cd));
      const rz = z - riverCenterZ(x);
      m = Math.max(m, 1 - smoothstep(R.halfWidth + 6, R.halfWidth + 50, Math.abs(rz)));
      LOW[idx] = m;

      // 잔기복: 여러 겹 노이즈 (숲 바닥의 둔덕·골)
      const micro = 0.14 * noise.fbm(x / 4.5, z / 4.5, 2) + 0.35 * noise.fbm(x / 11, z / 11, 2) * (1 - m * 0.6)
        + 0.11 * noiseB.fbm(x / 2.6 + 31, z / 2.6 - 7, 2) * (1 - m * 0.7);
      H[idx] = V + (1 - m) * hill + micro;
    }
  }

  // 3b. 물방울 침식: 언덕 사면에 빗물이 판 골(침식곡)과 쌓인 퇴적
  erodeTerrain(H, LOW, hN, rng.fork(77), CONFIG.world.erosion);
  data.timings.erosion = now() - t0;

  // 3c. 지형 요소: 개울 수로·둑, 늪, 논, 강, 절벽
  for (let j = 0; j < hN; j++) {
    const z = -half + j * hRes;
    for (let i = 0; i < hN; i++) {
      const x = -half + i * hRes;
      const idx = j * hN + i;
      const V = valleyFloor(x, z);
      let h = H[idx];
      const info = streamInfo(idx);
      const q = swampQ(x, z);
      const psd = paddy.signedDistance(x, z);
      const rz = z - riverCenterZ(x);

      // 개울 수로 + 둑
      if (info) {
        const { st, si, sd } = info;
        const w = st.w[si], bw = st.bankW[si], drop = st.drop[si], depth = st.depth[si];
        const level = st.level[si];
        const swampSuppress = st.name === 'west' ? smoothstep(1.0, 1.45, q) : 1;
        let target = null;
        if (sd < w) target = level - depth * (1 - (sd / w) ** 2);
        else if (sd < w + bw) target = level + drop * smoothstep(w, w + bw, sd);
        if (target !== null) {
          // 둑 바깥 쪽 원래 지형과 매끄럽게
          const outer = smoothstep(w + bw * 0.8, w + bw + 2, sd);
          const t = lerp(target, Math.min(h, level + drop + Math.max(0, h - V - drop)), outer);
          h = lerp(h, Math.min(h, t), swampSuppress);
        } else if (sd < w + bw + 6) {
          // 둑 위 범람원 — 수면보다 drop 만큼 높게 유지
          const k = 1 - smoothstep(w + bw, w + bw + 6, sd);
          h = lerp(h, Math.min(h, level + drop + (h - V) * 0.5), k * swampSuppress);
        }
      }

      // 늪: 수면 근처의 울퉁불퉁한 진흙 바닥 + 웅덩이
      if (q < 1.45) {
        const g = -0.62 + 0.95 * (0.5 + 0.5 * noise.fbm(x / 10 + 3, z / 10 - 7, 3));
        const core = swamp.level + g;
        if (q < 1.0) h = lerp(core, swamp.level + 0.28, smoothstep(0.82, 1.0, q));
        else h = lerp(swamp.level + 0.28, h, smoothstep(1.0, 1.45, q));
      }

      // 논: 칸마다 평평한 바닥, 바깥은 논둑 높이에 맞춰 이어짐
      if (psd < 22) {
        const [u, v] = paddy.toLocal(x, z);
        const uu = clamp(u, -paddy.halfU + 0.01, paddy.halfU - 0.01);
        const vv = clamp(v, -paddy.halfV + 0.01, paddy.halfV - 0.01);
        if (psd <= 0.4) {
          h = paddy.floorAtLocal(uu, vv) + 0.012 * noise.simplex(x * 0.7, z * 0.7);
        } else {
          const rim = paddy.floorAtLocal(uu, vv) + paddy.dikeHeight - 0.02;
          h = lerp(rim, h, smoothstep(2.5, 22, psd));
        }
      }

      // 남쪽 깊은 강
      const arz = Math.abs(rz);
      if (arz < R.halfWidth + 30) {
        const lvl = LAYOUT.riverLevel;
        let target;
        if (arz < R.halfWidth) target = lvl - R.depth * Math.sqrt(1 - (arz / R.halfWidth) ** 2) - 0.05;
        else target = lvl + 1.3 * smoothstep(R.halfWidth, R.halfWidth + 4, arz);
        const k = 1 - smoothstep(R.halfWidth + 4, R.halfWidth + 30, arz);
        h = lerp(h, Math.min(h, target), arz < R.halfWidth + 4 ? 1 : k);
        if (rz > R.halfWidth + 4) h += (rz - R.halfWidth - 4) * 0.6; // 건너편 둑
      }

      // 북·서쪽 절벽
      const dn = z + half + 5 * noise.fbm(x / 30, 1.5, 2);
      const dw = x + half + 5 * noise.fbm(z / 30, 8.5, 2);
      const cliffK = Math.max(smoothstep(cliff.width, cliff.steepStart, dn), smoothstep(cliff.width, cliff.steepStart, dw));
      if (cliffK > 0) {
        const rough = 1 + 0.25 * noise.fbm(x / 9, z / 9, 3);
        h += cliffK * (cliff.rise + 8 * (0.5 + 0.5 * noise.fbm(x / 50, z / 50, 2))) * rough;
      }
      // 동쪽은 완만한 오르막 (실제 차단은 밀집 대나무)
      h += smoothstep(160, 200, x) * 5 * smoothstep(R.halfWidth + 4, R.halfWidth + 30, arz);

      H[idx] = h;
    }
  }
  data.timings.height = now() - t0;
  onProgress(0.3, '높이맵');

  // 오솔길: 지형을 매끄럽게 다듬고 살짝 파이게
  const blurred = boxBlur(H, hN, 3);
  const trailFlatten = new Float32Array(hN * hN);
  for (let j = 0; j < hN; j++) {
    for (let i = 0; i < hN; i++) {
      const x = -half + i * hRes, z = -half + j * hRes;
      const si = cellIndex(x, z, sN, sRes, half);
      const d = trailDist[si];
      if (d > 4) continue;
      const tr = trails[trailId[si]];
      const hw = tr.halfWidth;
      const k = 1 - smoothstep(hw, hw + 2.2, d);
      const idx = j * hN + i;
      if (streamDist[idx] < 7 || paddy.signedDistance(x, z) < 1.5) continue;
      trailFlatten[idx] = k;
      H[idx] = lerp(H[idx], blurred[idx] - 0.07, k);
    }
  }
  data.timings.trails = now() - t0;

  // 높이 조회 (생성 단계에서 사용)
  const heightAt = (x, z) => sampleBilinear(H, hN, hRes, half, x, z);

  // -------------------------------------------------------------
  // 4. 지면 종류 / 수위 / 셰이더 스플랫 (0.5m)
  // -------------------------------------------------------------
  const blobs = LAYOUT.grassBlobs;
  const surface = data.surface;
  const WL = data.waterLevel;
  const WK = data.waterKind;
  const VK = data.vegKind;
  const SP = data.splat;
  const VC = CONFIG.vegetation;

  const trailMud = (tr, s) => {
    const n = noise.fbm(s / 18, 77 + tr.id * 5, 2);
    if (tr.mud !== 'auto') return tr.mud(s, n);
    const [px, pz] = tr.line.pointAt(s);
    const low = sampleBilinear(LOW, hN, hRes, half, px, pz);
    return clamp(0.12 + 0.62 * low + 0.38 * n, 0, 1);
  };
  // 오솔길 진흙 정도 캐시 (s 0.5m 간격)
  for (const tr of trails) {
    const n = Math.ceil(tr.line.length / 0.5) + 2;
    tr.mudCache = new Float32Array(n);
    for (let k = 0; k < n; k++) tr.mudCache[k] = trailMud(tr, k * 0.5);
  }
  const slopeDegAt = (x, z) => {
    const dx = (heightAt(x + 0.75, z) - heightAt(x - 0.75, z)) / 1.5;
    const dz = (heightAt(x, z + 0.75) - heightAt(x, z - 0.75)) / 1.5;
    return Math.atan(Math.hypot(dx, dz)) * 57.29578;
  };

  for (let j = 0; j < sN; j++) {
    const z = -half + (j + 0.5) * sRes;
    for (let i = 0; i < sN; i++) {
      const x = -half + (i + 0.5) * sRes;
      const c = j * sN + i;
      const ground = heightAt(x, z);
      let surf = SURFACE.GROUND_COVER;
      let veg = VEG.NONE;
      let mud = 0, dirt = 0, moist = 0, cover = 0;
      let wl = NO_WATER, wk = 0;

      // 수위
      const hi = Math.round((x + half) / hRes), hj = Math.round((z + half) / hRes);
      const hidx = clamp(hj, 0, hN - 1) * hN + clamp(hi, 0, hN - 1);
      const sid = streamId[hidx];
      const sd = sampleBilinear(streamDist, hN, hRes, half, x, z);
      let st = null, si = 0;
      if (sid >= 0) { st = streams[sid]; si = streamParam(st, streamS[hidx]); }
      const q = swampQ(x, z);
      const rz = z - riverCenterZ(x);
      if (Math.abs(rz) < R.halfWidth + 3.5) { wl = LAYOUT.riverLevel; wk = 4; }
      if (q < 1.06) { wl = Math.max(wl, swamp.level); wk = 2; }
      else if (st && sd < st.w[si] + st.bankW[si] * 0.6) {
        const westInSwamp = st.name === 'west' && q < 1.5;
        if (!westInSwamp) { wl = Math.max(wl, st.level[si]); wk = wk || 1; }
        else { wl = Math.max(wl, Math.max(st.level[si], swamp.level)); wk = 2; }
      }

      const pq = paddy.query(x, z);
      const depth = wl - ground;

      if (pq.inside) {
        if (pq.onDike) { surf = SURFACE.PACKED_DIRT; dirt = 0.85; moist = 0.35; }
        else { surf = SURFACE.PADDY; wl = pq.waterLevel; wk = 3; mud = 1; moist = 1; }
      } else if (q < 1.0) {
        if (depth > 0.55) surf = SURFACE.DEEP_WATER;
        else if (depth > 0.36) surf = SURFACE.SHALLOW_WATER;
        else surf = SURFACE.DEEP_MUD;
        mud = 1; moist = 1;
        if (depth < 0.22) veg = VEG.REED;
      } else if (depth > 0.55) {
        surf = SURFACE.DEEP_WATER; mud = 0.6; moist = 1;
      } else if (depth > 0.04) {
        surf = SURFACE.SHALLOW_WATER; mud = 0.6; moist = 1;
      } else {
        const td = trailDist[c];
        const tr = td < 4 ? trails[trailId[c]] : null;
        const inTrail = tr && td < tr.halfWidth;
        const bankZone = st && sd < st.w[si] + st.bankW[si] + 1.2 && !(st.name === 'west' && q < 1.5);
        const low = sampleBilinear(LOW, hN, hRes, half, x, z);
        if (inTrail) {
          const mudLevel = tr.mudCache[clamp(Math.round(trailS[c] / 0.5), 0, tr.mudCache.length - 1)];
          if (mudLevel > 0.62) { surf = SURFACE.SHALLOW_MUD; mud = 0.75; moist = 1; }
          else if (mudLevel > 0.4) { surf = SURFACE.WET_EARTH; mud = 0.3; moist = 0.8; }
          else { surf = SURFACE.PACKED_DIRT; moist = 0.15; }
          dirt = 1 - smoothstep(tr.halfWidth * 0.7, tr.halfWidth + 0.4, td);
          // 밟혀서 식물이 거의 없음 (가장자리만 드문드문)
          cover = 0.25 * smoothstep(tr.halfWidth * 0.6, tr.halfWidth, td);
          if (cover > 0.12) veg = VEG.COVER;
        } else if (bankZone) {
          // 개울가: 물가 진흙엔 물풀, 둑엔 양치류·물풀
          if (sd < st.w[si] + 0.9) { surf = SURFACE.SHALLOW_MUD; mud = 0.8; moist = 1; veg = VEG.REED; cover = 0.35; }
          else { surf = SURFACE.WET_EARTH; mud = 0.25; moist = 0.85; veg = VEG.BANK; cover = 0.8; }
        } else if (q < 1.2) {
          surf = SURFACE.SHALLOW_MUD; mud = 0.8; moist = 1; veg = VEG.REED; cover = 0.4;
        } else if (q < 1.45) {
          surf = SURFACE.WET_EARTH; mud = 0.25; moist = 0.8; veg = VEG.BANK; cover = 0.85;
        } else if (Math.abs(rz) < R.halfWidth + 5.5) {
          const near = Math.abs(rz) < R.halfWidth + 4.5;
          surf = near ? SURFACE.SHALLOW_MUD : SURFACE.WET_EARTH; mud = 0.6; moist = 1;
          veg = near ? VEG.REED : VEG.BANK; cover = near ? 0.35 : 0.75;
        } else {
          // 숲 바닥: 하층 밀도장에 따라 지피식물 / 덤불 / 밀집 덤불 / 키 큰 풀
          let gb = -1;
          for (let b = 0; b < blobs.length; b++) {
            const bl = blobs[b];
            const dx = x - bl.x, dz = z - bl.z;
            if (Math.abs(dx) > bl.r * 1.5 || Math.abs(dz) > bl.r * 1.5) continue;
            gb = Math.max(gb, 1 - Math.hypot(dx, dz) / bl.r - 0.28 * noise.fbm(x / 8, z / 8, 2));
          }
          const thicket = noiseB.fbm(x / 36 + 50, z / 36 - 20, 3) - VC.thicketThreshold + 0.12 * noise.fbm(x / 7, z / 7, 2);
          const shoulder = tr && td < tr.halfWidth + 1.4;
          let und = 0.5 + 0.36 * noise.fbm(x / 26 + 17, z / 26 - 9, 3) + 0.16 * noiseB.fbm(x / 7.5 + 3, z / 7.5 + 11, 2) + 0.08 * low;
          if (tr) und += 0.14 * (1 - smoothstep(tr.halfWidth + 1, tr.halfWidth + 7, td));           // 길가는 빛이 들어 덤불이 많음
          if (st) und += 0.1 * (1 - smoothstep(st.w[si] + st.bankW[si], st.w[si] + st.bankW[si] + 12, sd));
          const nCov = 0.5 + 0.5 * noise.fbm(x / 6 + 70, z / 6 - 30, 2);
          if (gb > 0 && !shoulder && paddy.signedDistance(x, z) > 1.5) {
            surf = SURFACE.BRUSH; veg = VEG.GRASS; cover = 0.9;
          } else if (thicket > 0 && low < 0.6 && !shoulder) {
            surf = SURFACE.BRUSH; veg = VEG.THICKET; cover = 1;
          } else if (shoulder && tr.mudCache[clamp(Math.round(trailS[c] / 0.5), 0, tr.mudCache.length - 1)] > 0.5) {
            surf = SURFACE.WET_EARTH; mud = 0.2; moist = 0.7; dirt = 0.3; veg = VEG.BANK;
            cover = 0.3 + 0.4 * smoothstep(tr.halfWidth, tr.halfWidth + 1.4, td);
          } else if (shoulder) {
            surf = SURFACE.GROUND_COVER; veg = VEG.COVER;
            cover = 0.35 + 0.45 * smoothstep(tr.halfWidth, tr.halfWidth + 1.4, td);
          } else if (slopeDegAt(x, z) > 42) {
            surf = SURFACE.LEAF_LITTER; veg = VEG.LITTER; cover = 0.25;            // 매우 가파른 사면: 흙이 드러남
          } else if (slopeDegAt(x, z) > 33) {
            surf = SURFACE.GROUND_COVER; veg = VEG.COVER; cover = 0.5 + 0.2 * nCov; // 가파른 사면: 지피식물 사이로 흙이 일부 보임
          } else if (low > 0.8 && noise.fbm(x / 14 + 9, z / 14 + 2, 2) > 0.25) {
            surf = SURFACE.WET_EARTH; moist = 0.7; mud = 0.12; veg = VEG.BANK; cover = 0.85;
          } else if (noiseB.fbm(x / 22 + 140, z / 22 - 60, 2) - 0.25 * und > VC.litterPatchThreshold) {
            // 짙은 그늘의 낙엽 바닥 (어린 묘목·이끼가 드문드문)
            surf = SURFACE.LEAF_LITTER; veg = VEG.LITTER; cover = 0.56 + 0.16 * nCov;
          } else if (und > VC.shrubThreshold) {
            surf = SURFACE.SHRUB; veg = VEG.SHRUB; cover = 0.9 + 0.1 * nCov;
          } else {
            surf = SURFACE.GROUND_COVER; veg = VEG.COVER; cover = 0.78 + 0.22 * nCov;
          }
          if (shoulder) dirt = Math.max(dirt, 0.35 * (1 - smoothstep(tr.halfWidth, tr.halfWidth + 1.4, td)));
          moist = Math.max(moist, 0.25 * low);
        }
      }

      surface[c] = surf;
      VK[c] = veg;
      WL[c] = wl > ground - 0.05 || wk === 3 ? wl : NO_WATER;
      WK[c] = WL[c] !== NO_WATER ? wk : 0;
      SP[c * 4] = (clamp(mud, 0, 1) * 255) | 0;
      SP[c * 4 + 1] = (clamp(dirt, 0, 1) * 255) | 0;
      SP[c * 4 + 2] = (clamp(moist, 0, 1) * 255) | 0;
      SP[c * 4 + 3] = (clamp(cover, 0, 1) * 255) | 0;
    }
  }
  data.timings.surface = now() - t0;
  onProgress(0.5, '지면 종류');

  // 경사 (도)
  const slopeAt = (x, z) => {
    const e = 1;
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
  };
  const surfAt = (x, z) => surface[cellIndex(x, z, sN, sRes, half)];
  const waterAt = (x, z) => WL[cellIndex(x, z, sN, sRes, half)];
  const trailDistAt = (x, z) => trailDist[cellIndex(x, z, sN, sRes, half)];
  const vegAt = (x, z) => VK[cellIndex(x, z, sN, sRes, half)];
  const lowAt = (x, z) => sampleBilinear(LOW, hN, hRes, half, x, z);
  const streamDistAt = (x, z) => sampleBilinear(streamDist, hN, hRes, half, x, z);
  const start = W.start;

  // -------------------------------------------------------------
  // 5~6. 식생·장애물 배치 + 캐노피·은폐·차폐(AO) 격자 (Flora.js)
  // -------------------------------------------------------------
  const ctx = {
    data, rng, noise, noiseB, half, sN, sRes, hN, hRes, start, streams, trails, paddy, swamp,
    heightAt, slopeAt, surfAt, waterAt, trailDistAt, vegAt, lowAt, streamDistAt, swampQ,
    cellIndex: (x, z) => cellIndex(x, z, sN, sRes, half),
    occ: new SpatialHash(4), jitterGrid,
  };
  placeFlora(ctx);
  data.timings.placement = now() - t0;
  onProgress(0.7, '식생 배치');
  buildGrids(ctx);
  data.timings.grids = now() - t0;

  // -------------------------------------------------------------
  // 7. 테스트 지점 (지형에 맞춰 위치·바라보는 방향 계산)
  // -------------------------------------------------------------
  const yawOf = (dx, dz) => Math.atan2(-dx, -dz);           // 바라보는 방향 → yaw (0 = 북)
  const along = (tr, s, ds = 3) => { const [ax, az] = tr.line.pointAt(s); const [bx, bz] = tr.line.pointAt(s + ds); return { x: ax, z: az, yaw: yawOf(bx - ax, bz - az) }; };
  const P = data.placements;
  data.testPoints = W.testPoints.map((p) => ({ ...p }));
  const setTP = (key, v) => Object.assign(data.testPoints.find((p) => p.key === key), v);
  const t1 = trails[0];
  setTP('1', along(t1, 0, 5));
  data.layout.start = { x: start.x, z: start.z, yaw: along(t1, 0, 5).yaw };
  setTP('2', along(t1, 34));
  {
    const e = along(t1, t1.line.length - 4, 2);
    setTP('3', { x: e.x, z: e.z, yaw: yawOf(swamp.x - e.x, swamp.z - e.z) });
  }
  {
    const vMain = -paddy.halfV + paddy.mainDikeRow * paddy.cellH;
    const [x, z] = paddy.toWorld(-paddy.halfU + 1.2, vMain);
    setTP('4', { x, z, yaw: yawOf(paddy.cos, paddy.sin) });
  }
  {
    const t3 = trails[2];
    const fordS = t3.line.closestS(88, 36).s;
    setTP('5', along(t3, Math.max(0, fordS - 6), 3));
  }
  {
    const g = LAYOUT.grassBlobs[0];
    setTP('6', { x: g.x - 4, z: g.z + 3, yaw: yawOf(1, -0.5) });
  }
  {
    let best = null, bestScore = Infinity;
    const ford = trails[2].line.pointAt(trails[2].line.closestS(88, 36).s);
    for (let z = -110; z < 110; z += 0.5) {
      for (let x = -150; x < 140; x += 0.5) {
        if (Math.hypot(x - start.x, z - start.z) > 145) continue;
        const sf = surfAt(x, z);
        if (sf !== SURFACE.WET_EARTH && sf !== SURFACE.SHALLOW_MUD) continue;
        const sl = slopeAt(x, z);
        if (sl < 26 || sl > 33) continue;
        // 주변도 경사가 이어져야 함
        if (slopeAt(x + 0.6, z) < 22 || slopeAt(x - 0.6, z) < 22 || slopeAt(x, z + 0.6) < 22 || slopeAt(x, z - 0.6) < 22) continue;
        const score = Math.hypot(x - ford[0], z - ford[1]);
        if (score < bestScore) { bestScore = score; best = [x, z]; }
      }
    }
    if (best) {
      const e = 0.5;
      const gx = heightAt(best[0] + e, best[1]) - heightAt(best[0] - e, best[1]);
      const gz = heightAt(best[0], best[1] + e) - heightAt(best[0], best[1] - e);
      setTP('7', { x: best[0], z: best[1], yaw: yawOf(gx, gz) });  // 오르막을 바라봄
      data.layout.slopeTest = { x: best[0], z: best[1], slope: slopeAt(best[0], best[1]) };
    }
  }
  {
    const g = LAYOUT.bambooGroves[0];
    let near = null, nd = Infinity;
    for (const b of P.bamboo) { const d = Math.hypot(b.x - g.x, b.z - g.z); if (d < nd) { nd = d; near = b; } }
    if (near) {
      const dx = start.x - near.x, dz = start.z - near.z, l = Math.hypot(dx, dz) || 1;
      const x = near.x + (dx / l) * (near.radius + 1.6), z = near.z + (dz / l) * (near.radius + 1.6);
      setTP('8', { x, z, yaw: yawOf(near.x - x, near.z - z) });
    }
  }

  {
    // 시작 지점에서 30~90m, 오솔길에서 떨어진 덤불 지대
    let best = null, bestScore = Infinity;
    for (let z = start.z - 90; z < start.z + 90; z += 1) {
      for (let x = start.x - 90; x < start.x + 90; x += 1) {
        const d = Math.hypot(x - start.x, z - start.z);
        if (d < 30 || d > 90) continue;
        const c = cellIndex(x, z, sN, sRes, half);
        if (VK[c] !== VEG.SHRUB || trailDist[c] < 8 || slopeAt(x, z) > 18) continue;
        let ok = true;
        for (let a = 0; a < 6.28 && ok; a += 0.8) {
          const v = VK[cellIndex(x + Math.cos(a) * 3, z + Math.sin(a) * 3, sN, sRes, half)];
          if (v !== VEG.SHRUB && v !== VEG.COVER && v !== VEG.THICKET) ok = false;
        }
        if (!ok || ctx.occ.any(x, z, 0.8)) continue;
        const score = Math.abs(d - 45);
        if (score < bestScore) { bestScore = score; best = [x, z]; }
      }
    }
    if (best) setTP('9', { x: best[0], z: best[1], yaw: yawOf(start.x - best[0], start.z - best[1]) });
  }

  data.timings.total = now() - t0;
  onProgress(1, '완료');
  return data;
}

// =================================================================
// 유틸
// =================================================================
function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function cellIndex(x, z, sN, sRes, half) {
  let i = Math.floor((x + half) / sRes);
  let j = Math.floor((z + half) / sRes);
  i = i < 0 ? 0 : i >= sN ? sN - 1 : i;
  j = j < 0 ? 0 : j >= sN ? sN - 1 : j;
  return j * sN + i;
}

export function sampleBilinear(arr, n, res, half, x, z) {
  let fx = (x + half) / res, fz = (z + half) / res;
  if (fx < 0) fx = 0; else if (fx > n - 1.001) fx = n - 1.001;
  if (fz < 0) fz = 0; else if (fz > n - 1.001) fz = n - 1.001;
  const i = fx | 0, j = fz | 0;
  const tx = fx - i, tz = fz - j;
  const k = j * n + i;
  const a = arr[k], b = arr[k + 1], c = arr[k + n], d = arr[k + n + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

/** 정점 격자(n×n, 간격 res)에 폴리라인 거리장 기록 */
function stampPolyline(line, radius, n, res, half, dist, sArr, idArr, id) {
  for (let k = 0; k < line.count - 1; k++) {
    const ax = line.x[k], az = line.z[k], bx = line.x[k + 1], bz = line.z[k + 1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius + half) / res));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + radius + half) / res));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - radius + half) / res));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + radius + half) / res));
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const s0 = line.s[k], s1 = line.s[k + 1];
    for (let j = j0; j <= j1; j++) {
      const pz = -half + j * res;
      for (let i = i0; i <= i1; i++) {
        const px = -half + i * res;
        let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t - px, cz = az + dz * t - pz;
        const d = Math.sqrt(cx * cx + cz * cz);
        const idx = j * n + i;
        if (d < dist[idx]) { dist[idx] = d; sArr[idx] = s0 + (s1 - s0) * t; idArr[idx] = id; }
      }
    }
  }
}

/** 셀 중심 격자(n×n, 간격 res)에 기록 */
function stampPolylineCells(line, radius, n, res, half, dist, sArr, idArr, id) {
  for (let k = 0; k < line.count - 1; k++) {
    const ax = line.x[k], az = line.z[k], bx = line.x[k + 1], bz = line.z[k + 1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius + half) / res));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + radius + half) / res));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - radius + half) / res));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + radius + half) / res));
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const s0 = line.s[k], s1 = line.s[k + 1];
    for (let j = j0; j <= j1; j++) {
      const pz = -half + (j + 0.5) * res;
      for (let i = i0; i <= i1; i++) {
        const px = -half + (i + 0.5) * res;
        let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t - px, cz = az + dz * t - pz;
        const d = Math.sqrt(cx * cx + cz * cz);
        const idx = j * n + i;
        if (d < dist[idx]) { dist[idx] = d; sArr[idx] = s0 + (s1 - s0) * t; idArr[idx] = id; }
      }
    }
  }
}

/**
 * 물방울 수력 침식 (Hans Beyer 방식 단순화). mask(저지대)가 높은 곳은 침식하지 않는다.
 * 빗방울이 경사를 따라 흐르며 흙을 깎고 느려지면 내려놓아 자연스러운 골·퇴적 지형을 만든다.
 */
function erodeTerrain(H, low, n, rng, o) {
  const R = o.radius;
  const offs = [], wts = [];
  let wsum = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const w = 1 - d / (R + 0.001);
      offs.push(dy * n + dx); wts.push(w); wsum += w;
    }
  }
  for (let k = 0; k < wts.length; k++) wts[k] /= wsum;
  const margin = R + 2;
  const heightGrad = (x, y, out) => {
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
    const i = iy * n + ix;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + n], h11 = H[i + n + 1];
    out.gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
    out.gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
    out.h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
    return out;
  };
  const g0 = { gx: 0, gy: 0, h: 0 }, g1 = { gx: 0, gy: 0, h: 0 };
  for (let d = 0; d < o.drops; d++) {
    let x = margin + rng.float() * (n - 2 * margin - 1);
    let y = margin + rng.float() * (n - 2 * margin - 1);
    if (low[(y | 0) * n + (x | 0)] > 0.75) continue;
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let step = 0; step < o.maxSteps; step++) {
      const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
      const i = iy * n + ix;
      heightGrad(x, y, g0);
      dx = dx * o.inertia - g0.gx * (1 - o.inertia);
      dy = dy * o.inertia - g0.gy * (1 - o.inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len; dy /= len;
      const nx = x + dx, ny = y + dy;
      if (nx < margin || ny < margin || nx >= n - margin - 1 || ny >= n - margin - 1) break;
      const dh = heightGrad(nx, ny, g1).h - g0.h;
      const mask = 1 - low[i];
      const cap = Math.max(-dh * speed * water * o.capacity, 0.01);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * o.deposit;
        sed -= amt;
        H[i] += amt * (1 - fx) * (1 - fy);
        H[i + 1] += amt * fx * (1 - fy);
        H[i + n] += amt * (1 - fx) * fy;
        H[i + n + 1] += amt * fx * fy;
      } else {
        const amt = Math.min((cap - sed) * o.erode, -dh) * mask;
        for (let k = 0; k < offs.length; k++) H[i + offs[k]] -= amt * wts[k];
        sed += amt;
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * o.gravity));
      water *= 1 - o.evaporate;
      x = nx; y = ny;
    }
  }
}

function boxBlur(src, n, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const ii = i + k;
        if (ii < 0 || ii >= n) continue;
        s += src[j * n + ii]; c++;
      }
      tmp[j * n + i] = s / c;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const jj = j + k;
        if (jj < 0 || jj >= n) continue;
        s += tmp[jj * n + i]; c++;
      }
      out[j * n + i] = s / c;
    }
  }
  return out;
}

export function jitterGrid(rng, half, spacing, fn) {
  for (let z = -half; z < half; z += spacing) {
    for (let x = -half; x < half; x += spacing) {
      fn(x + rng.float() * spacing, z + rng.float() * spacing);
    }
  }
}

/** 배치 중 겹침 검사용 간단한 공간 해시 */
export class SpatialHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  add(x, z, r) {
    const i = Math.floor(x / this.cell), j = Math.floor(z / this.cell);
    const k = this.key(i, j);
    let a = this.map.get(k);
    if (!a) { a = []; this.map.set(k, a); }
    a.push(x, z, r);
  }
  any(x, z, r) {
    const reach = Math.ceil((r + 2) / this.cell);
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    for (let j = cj - reach; j <= cj + reach; j++) {
      for (let i = ci - reach; i <= ci + reach; i++) {
        const a = this.map.get(this.key(i, j));
        if (!a) continue;
        for (let k = 0; k < a.length; k += 3) {
          const dx = a[k] - x, dz = a[k + 1] - z, rr = a[k + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  }
}
