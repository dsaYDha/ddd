// 시드 고정 절차적 정글 맵 생성 (순수 데이터 — three.js 의존 없음, Node에서도 실행 가능)
import { CONFIG } from '../config.js';
import { Noise2D } from '../core/noise.js';
import { RNG } from '../core/rng.js';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { SURFACE } from './Surfaces.js';
import { LAYOUT, Polyline, PaddyField, valleyFloor, riverCenterZ } from './MapLayout.js';
import { BIG_TREE_VARIANTS } from './TreeVariants.js';

export const NO_WATER = -10000;
export const BRUSH_GRASS = 1;
export const BRUSH_THICKET = 2;

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
    brushKind: new Uint8Array(sN * sN),
    splat: new Uint8Array(sN * sN * 4),      // 셰이더용: R 진흙, G 흙길, B 습기, A 풀
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

      // 저지대 마스크
      let m = 0;
      const sd = streamDist[idx];
      let st = null, si = 0;
      if (streamId[idx] >= 0) {
        st = streams[streamId[idx]];
        si = streamParam(st, streamS[idx]);
        m = Math.max(m, 1 - smoothstep(st.valleyW[si] * 0.4, st.valleyW[si] * 0.4 + 36, sd));
      }
      const q = swampQ(x, z);
      m = Math.max(m, 1 - smoothstep(1.3, 2.9, q));
      const psd = paddy.signedDistance(x, z);
      m = Math.max(m, 1 - smoothstep(8, 50, psd));
      const cd = Math.sqrt(segDist2(x, z, corridor[0][0], corridor[0][1], corridor[1][0], corridor[1][1]));
      m = Math.max(m, 1 - smoothstep(9, 42, cd));
      const rz = z - riverCenterZ(x);
      m = Math.max(m, 1 - smoothstep(R.halfWidth + 6, R.halfWidth + 50, Math.abs(rz)));
      LOW[idx] = m;

      const micro = 0.14 * noise.fbm(x / 4.5, z / 4.5, 2) + 0.35 * noise.fbm(x / 11, z / 11, 2) * (1 - m * 0.6);
      let h = V + (1 - m) * hill + micro;

      // 개울 수로 + 둑
      if (st) {
        const w = st.w[si], bw = st.bankW[si], drop = st.drop[si], depth = st.depth[si];
        const level = st.level[si];
        const swampSuppress = st.name === 'west' ? smoothstep(1.0, 1.45, q) : 1;
        let target = null;
        if (sd < w) target = level - depth * (1 - (sd / w) ** 2);
        else if (sd < w + bw) target = level + drop * smoothstep(w, w + bw, sd) + (h - V) * smoothstep(w, w + bw, sd) * 0;
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
        if (psd <= 0.4) {
          const [u, v] = paddy.toLocal(x, z);
          const uu = clamp(u, -paddy.halfU + 0.01, paddy.halfU - 0.01);
          const vv = clamp(v, -paddy.halfV + 0.01, paddy.halfV - 0.01);
          h = paddy.floorAtLocal(uu, vv) + 0.012 * noise.simplex(x * 0.7, z * 0.7);
        } else {
          const [u, v] = paddy.toLocal(x, z);
          const uu = clamp(u, -paddy.halfU + 0.01, paddy.halfU - 0.01);
          const vv = clamp(v, -paddy.halfV + 0.01, paddy.halfV - 0.01);
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
  const BK = data.brushKind;
  const SP = data.splat;

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

  for (let j = 0; j < sN; j++) {
    const z = -half + (j + 0.5) * sRes;
    for (let i = 0; i < sN; i++) {
      const x = -half + (i + 0.5) * sRes;
      const c = j * sN + i;
      const ground = heightAt(x, z);
      let surf = SURFACE.LEAF_LITTER;
      let mud = 0, dirt = 0, moist = 0, grass = 0;
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
      } else if (depth > 0.55) {
        surf = SURFACE.DEEP_WATER; mud = 0.6; moist = 1;
      } else if (depth > 0.04) {
        surf = SURFACE.SHALLOW_WATER; mud = 0.6; moist = 1;
      } else {
        const td = trailDist[c];
        const tr = td < 4 ? trails[trailId[c]] : null;
        const inTrail = tr && td < tr.halfWidth;
        const bankZone = st && sd < st.w[si] + st.bankW[si] + 1.2 && !(st.name === 'west' && q < 1.5);
        if (inTrail) {
          const mudLevel = tr.mudCache[clamp(Math.round(trailS[c] / 0.5), 0, tr.mudCache.length - 1)];
          if (mudLevel > 0.62) { surf = SURFACE.SHALLOW_MUD; mud = 0.75; moist = 1; }
          else if (mudLevel > 0.4) { surf = SURFACE.WET_EARTH; mud = 0.3; moist = 0.8; }
          else { surf = SURFACE.PACKED_DIRT; moist = 0.15; }
          dirt = 1 - smoothstep(tr.halfWidth * 0.7, tr.halfWidth + 0.4, td);
        } else if (bankZone) {
          if (sd < st.w[si] + 0.9) { surf = SURFACE.SHALLOW_MUD; mud = 0.8; moist = 1; }
          else { surf = SURFACE.WET_EARTH; mud = 0.3; moist = 0.85; }
        } else if (q < 1.2) {
          surf = SURFACE.SHALLOW_MUD; mud = 0.8; moist = 1;
        } else if (q < 1.45) {
          surf = SURFACE.WET_EARTH; mud = 0.3; moist = 0.8;
        } else if (Math.abs(rz) < R.halfWidth + 5.5) {
          surf = Math.abs(rz) < R.halfWidth + 4.5 ? SURFACE.SHALLOW_MUD : SURFACE.WET_EARTH; mud = 0.6; moist = 1;
        } else {
          // 풀숲 / 덤불
          let gb = -1;
          for (let b = 0; b < blobs.length; b++) {
            const bl = blobs[b];
            const dx = x - bl.x, dz = z - bl.z;
            if (Math.abs(dx) > bl.r * 1.5 || Math.abs(dz) > bl.r * 1.5) continue;
            gb = Math.max(gb, 1 - Math.hypot(dx, dz) / bl.r - 0.28 * noise.fbm(x / 8, z / 8, 2));
          }
          const low = sampleBilinear(LOW, hN, hRes, half, x, z);
          const thicket = noiseB.fbm(x / 36 + 50, z / 36 - 20, 3) - 0.38 + 0.12 * noise.fbm(x / 7, z / 7, 2);
          const shoulder = tr && td < tr.halfWidth + 1.4;
          if (gb > 0 && !shoulder && paddy.signedDistance(x, z) > 1.5) {
            surf = SURFACE.BRUSH; BK[c] = BRUSH_GRASS; grass = 1;
          } else if (thicket > 0 && low < 0.6 && !shoulder) {
            surf = SURFACE.BRUSH; BK[c] = BRUSH_THICKET; grass = 0.5;
          } else if (shoulder && tr.mudCache[clamp(Math.round(trailS[c] / 0.5), 0, tr.mudCache.length - 1)] > 0.5) {
            surf = SURFACE.WET_EARTH; mud = 0.2; moist = 0.7; dirt = 0.3;
          } else if (low > 0.8 && noise.fbm(x / 14 + 9, z / 14 + 2, 2) > 0.25) {
            surf = SURFACE.WET_EARTH; moist = 0.7; mud = 0.15;
          } else {
            moist = 0.25 * low;
          }
          if (shoulder) dirt = Math.max(dirt, 0.35 * (1 - smoothstep(tr.halfWidth, tr.halfWidth + 1.4, td)));
        }
      }

      surface[c] = surf;
      WL[c] = wl > ground - 0.05 || wk === 3 ? wl : NO_WATER;
      WK[c] = WL[c] !== NO_WATER ? wk : 0;
      SP[c * 4] = (clamp(mud, 0, 1) * 255) | 0;
      SP[c * 4 + 1] = (clamp(dirt, 0, 1) * 255) | 0;
      SP[c * 4 + 2] = (clamp(moist, 0, 1) * 255) | 0;
      SP[c * 4 + 3] = (clamp(grass, 0, 1) * 255) | 0;
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
  const brushAt = (x, z) => BK[cellIndex(x, z, sN, sRes, half)];
  const lowAt = (x, z) => sampleBilinear(LOW, hN, hRes, half, x, z);
  const start = W.start;
  const inBounds = (x, z, m = 4) => Math.abs(x) < half - m && Math.abs(z) < half - m;
  const isDryGround = (s) => s === SURFACE.LEAF_LITTER || s === SURFACE.WET_EARTH || s === SURFACE.BRUSH || s === SURFACE.PACKED_DIRT;
  const outsideCliff = (x, z) => z > -half + LAYOUT.cliff.width + 2 && x > -half + LAYOUT.cliff.width + 2;

  // -------------------------------------------------------------
  // 5. 식생·장애물 배치
  // -------------------------------------------------------------
  const P = data.placements;
  const circles = data.circles;
  const supports = data.supports;
  const T = CONFIG.objects;

  // 원형 충돌체 공간 해시 (배치 중 겹침 방지)
  const occ = new SpatialHash(4);
  const free = (x, z, r) => !occ.any(x, z, r);

  // --- 큰 나무 (상층)
  P.bigTree = [];
  {
    const r = rng.fork(1);
    jitterGrid(r, half, 10.5, (x, z) => {
      if (!inBounds(x, z, 3) || !outsideCliff(x, z) || x > LAYOUT.bambooBelt.xStart - 2) return;
      const s = surfAt(x, z);
      if (!isDryGround(s) || s === SURFACE.PACKED_DIRT) return;
      if (brushAt(x, z) === BRUSH_GRASS) return;
      if (trailDistAt(x, z) < 3.5 || Math.hypot(x - start.x, z - start.z) < 7) return;
      if (paddy.signedDistance(x, z) < 6 || swampQ(x, z) < 1.25) return;
      if (waterAt(x, z) !== NO_WATER) return;
      if (slopeAt(x, z) > 36) return;
      const low = lowAt(x, z);
      if (!r.chance(lerp(0.88, 0.4, low))) return;
      const variant = r.int(0, BIG_TREE_VARIANTS.length - 1);
      const V = BIG_TREE_VARIANTS[variant];
      const scale = r.range(0.85, 1.22);
      const trunkR = V.trunkR * scale;
      const colR = trunkR * 1.25;
      if (!free(x, z, colR + 1.6)) return;
      const tree = {
        x, z, y: heightAt(x, z) - 0.15, rot: r.range(0, Math.PI * 2), variant, scale,
        height: V.height * scale, trunkR, crownR: V.crownR * scale, rank: r.float(),
      };
      P.bigTree.push(tree);
      occ.add(x, z, colR);
      circles.push({ x, z, r: colR, y0: tree.y - 1, y1: tree.y + tree.height, type: 'bigTree', tags: T.bigTree });
      // 판근 — 렌더링과 같은 형태의 낮은 지지형 장애물 (끝으로 갈수록 낮아짐)
      const cr = Math.cos(tree.rot), sr = Math.sin(tree.rot);
      for (const f of V.fins) {
        // 렌더링 좌표계와 동일: 로컬 (cos a, sin a) 를 Y축 회전 rot 으로
        const lx = Math.cos(f.a), lz = Math.sin(f.a);
        const wx = lx * cr + lz * sr, wz = -lx * sr + lz * cr;
        const span = f.span * scale;
        const ax = x + wx * trunkR * 0.7, az = z + wz * trunkR * 0.7;
        const bx = x + wx * (trunkR + span), bz = z + wz * (trunkR + span);
        supports.push({
          kind: 'capsule', type: 'root', tags: T.root, fin: true,
          ax, az, ay: tree.y + f.h * scale * 0.85, bx, bz, by: heightAt(bx, bz) - 0.05, r: 0.12 * scale + 0.04,
        });
      }
    });
  }

  // --- 드러난 큰 뿌리
  P.root = [];
  {
    const r = rng.fork(2);
    for (const tree of P.bigTree) {
      if (!r.chance(0.6)) continue;
      const n = r.int(1, 3);
      for (let k = 0; k < n; k++) {
        const a = r.range(0, Math.PI * 2);
        const big = r.chance(0.18);
        const rad = big ? r.range(0.3, 0.37) : r.range(0.1, 0.24);
        const len = r.range(2.5, 5.5);
        const ax = tree.x + Math.cos(a) * (tree.trunkR + 0.2), az = tree.z + Math.sin(a) * (tree.trunkR + 0.2);
        const bx = ax + Math.cos(a + r.range(-0.4, 0.4)) * len, bz = az + Math.sin(a + r.range(-0.4, 0.4)) * len;
        if (waterAt(bx, bz) !== NO_WATER || trailDistAt(bx, bz) < 0.8) continue;
        const ay = heightAt(ax, az) + rad * 0.25, by = heightAt(bx, bz) - rad * 0.5;
        const sup = { kind: 'capsule', type: 'root', tags: T.root, ax, az, ay, bx, bz, by, r: rad };
        supports.push(sup);
        P.root.push(sup);
      }
    }
  }

  // --- 쓰러진 통나무
  P.log = [];
  {
    const r = rng.fork(3);
    const addLog = (cx, cz, angle, len, rad, forced = false) => {
      const dx = Math.cos(angle) * len / 2, dz = Math.sin(angle) * len / 2;
      const ax = cx - dx, az = cz - dz, bx = cx + dx, bz = cz + dz;
      if (!forced) {
        for (let k = 0; k <= 4; k++) {
          const px = lerp(ax, bx, k / 4), pz = lerp(az, bz, k / 4);
          if (!inBounds(px, pz, 6) || waterAt(px, pz) !== NO_WATER || paddy.signedDistance(px, pz) < 2) return false;
          if (trailDistAt(px, pz) < 1.5 || occ.any(px, pz, rad + 0.2)) return false;
          const s = surfAt(px, pz);
          if (s === SURFACE.DEEP_MUD) return false;
        }
        if (Math.abs(heightAt(ax, az) - heightAt(bx, bz)) > len * 0.4) return false;
        // 가운데가 뜨거나 묻히지 않게
        if (Math.abs(heightAt(cx, cz) - (heightAt(ax, az) + heightAt(bx, bz)) / 2) > rad * 0.6) return false;
      }
      let ay = heightAt(ax, az) + rad * 0.72, by = heightAt(bx, bz) + rad * 0.72;
      if (forced) {
        // 오솔길을 가로지르는 통나무: 오솔길 중앙 높이에 맞춤
        const c = heightAt(cx, cz) + rad * 0.72;
        ay = Math.max(c, Math.min(ay, c + 0.25));
        by = Math.max(c, Math.min(by, c + 0.25));
      }
      const log = { kind: 'capsule', type: 'log', tags: T.log, ax, az, ay, bx, bz, by, r: rad, rot: r.range(0, 6.28), variant: r.int(0, 1) };
      supports.push(log);
      P.log.push(log);
      return true;
    };
    // 시작 지점 오솔길을 가로막는 통나무 (점프 테스트용)
    const t1 = trails[0];
    {
      const s = 13;
      const [px, pz] = t1.line.pointAt(s);
      const [qx, qz] = t1.line.pointAt(s + 1);
      const ang = Math.atan2(qz - pz, qx - px) + Math.PI / 2;
      addLog(px, pz, ang + 0.2, 5, 0.36, true);
    }
    {
      const t4 = trails[3];
      const [px, pz] = t4.line.pointAt(26);
      const [qx, qz] = t4.line.pointAt(27);
      addLog(px, pz, Math.atan2(qz - pz, qx - px) + Math.PI / 2 - 0.3, 5, 0.3, true);
    }
    let tries = 0;
    while (P.log.length < 150 && tries++ < 4000) {
      const x = r.range(-half + 30, half - 30), z = r.range(-half + 30, half - 32);
      const s = surfAt(x, z);
      if (!isDryGround(s) || slopeAt(x, z) > 24) continue;
      const rad = r.chance(0.3) ? r.range(0.18, 0.26) : r.range(0.28, 0.5);
      addLog(x, z, r.range(0, Math.PI), r.range(4, 11), rad);
    }
  }

  // --- 바위
  P.rock = [];
  {
    const r = rng.fork(4);
    const addRock = (x, z, size, inWater = false) => {
      const rx = size * r.range(0.8, 1.25), rz = size * r.range(0.7, 1.1), ry = size * r.range(0.45, 0.8);
      if (occ.any(x, z, Math.max(rx, rz) * 0.8)) return;
      const y = heightAt(x, z) - ry * (inWater ? 0.25 : 0.38);
      const rock = { kind: 'ellipsoid', type: 'rock', tags: T.rock, cx: x, cy: y, cz: z, rx, ry, rz, yaw: r.range(0, Math.PI * 2), variant: r.int(0, 3), seed: r.int(0, 1e6) };
      supports.push(rock);
      P.rock.push(rock);
    };
    // 개울 속·둑의 바위
    for (const st of streams) {
      for (let s = 10; s < st.line.length - 15; s += r.range(4, 11)) {
        if (st.fords.some((f) => Math.abs(f - s) < 9)) continue;
        const [px, pz] = st.line.pointAt(s);
        if (st.name === 'west' && swampQ(px, pz) < 1.6) continue;
        const off = r.range(-st.w[Math.round(s)] - 2, st.w[Math.round(s)] + 2);
        const [qx, qz] = st.line.pointAt(s + 1);
        const tx = qx - px, tz = qz - pz;
        addRock(px - tz * off, pz + tx * off, r.range(0.35, 1.3), true);
      }
    }
    let tries = 0;
    while (P.rock.length < 300 && tries++ < 5000) {
      const x = r.range(-half + 25, half - 25), z = r.range(-half + 25, half - 30);
      const s = surfAt(x, z);
      if (!isDryGround(s) || trailDistAt(x, z) < 1.6 || paddy.signedDistance(x, z) < 3) continue;
      const sl = slopeAt(x, z);
      if (!r.chance(0.25 + sl / 30)) continue;
      addRock(x, z, r.chance(0.15) ? r.range(1.2, 2.4) : r.range(0.25, 0.9));
    }
  }

  // --- 야자수 (중층)
  P.palm = [];
  {
    const r = rng.fork(5);
    jitterGrid(r, half, 7.5, (x, z) => {
      if (!inBounds(x, z, 5) || !outsideCliff(x, z) || x > LAYOUT.bambooBelt.xStart - 2) return;
      const s = surfAt(x, z);
      if (!(isDryGround(s) || s === SURFACE.SHALLOW_MUD) || s === SURFACE.PACKED_DIRT) return;
      if (trailDistAt(x, z) < 2 || waterAt(x, z) !== NO_WATER) return;
      const q = swampQ(x, z), psd = paddy.signedDistance(x, z);
      if (psd < 2.5) return;
      const sd = sampleBilinear(streamDist, hN, hRes, half, x, z);
      let p = 0.07;
      if (q > 1.0 && q < 2.1) p = 0.55;
      else if (psd < 16) p = 0.42;
      else if (sd < 14) p = 0.32;
      if (!r.chance(p) || !free(x, z, 1.4)) return;
      const palm = { x, z, y: heightAt(x, z), rot: r.range(0, 6.28), height: r.range(6, 11.5), lean: r.range(0.03, 0.22), variant: r.int(0, 1), rank: r.float() };
      P.palm.push(palm);
      occ.add(x, z, 0.25);
      circles.push({ x, z, r: 0.22, y0: palm.y - 0.5, y1: palm.y + palm.height, type: 'palm', tags: T.palm });
    });
  }

  // --- 바나나 나무
  P.banana = [];
  {
    const r = rng.fork(6);
    jitterGrid(r, half, 6, (x, z) => {
      if (!inBounds(x, z, 6) || !outsideCliff(x, z) || x > LAYOUT.bambooBelt.xStart - 2) return;
      const psd = paddy.signedDistance(x, z);
      const low = lowAt(x, z);
      let p = 0.035;
      if (psd > 2.5 && psd < 15) p = 0.5;
      else if (low > 0.6) p = 0.12;
      if (trailDistAt(x, z) < 3.5 && low > 0.4) p += 0.15;
      if (!r.chance(p)) return;
      const n = r.int(2, 4);
      for (let k = 0; k < n; k++) {
        const bx = x + r.range(-1.6, 1.6), bz = z + r.range(-1.6, 1.6);
        const s = surfAt(bx, bz);
        if (!isDryGround(s) || s === SURFACE.PACKED_DIRT || trailDistAt(bx, bz) < 1.6 || waterAt(bx, bz) !== NO_WATER) continue;
        if (paddy.signedDistance(bx, bz) < 2.2 || !free(bx, bz, 0.7)) continue;
        const b = { x: bx, z: bz, y: heightAt(bx, bz), rot: r.range(0, 6.28), height: r.range(2.4, 4.2), variant: r.int(0, 1), rank: r.float() };
        P.banana.push(b);
        occ.add(bx, bz, 0.2);
        circles.push({ x: bx, z: bz, r: 0.14, y0: b.y - 0.3, y1: b.y + b.height, type: 'banana', tags: T.banana });
      }
    });
  }

  // --- 대나무 군락
  P.bamboo = [];
  {
    const r = rng.fork(7);
    const groves = LAYOUT.bambooGroves.map((g) => ({ ...g }));
    for (const st of streams) {
      for (let s = 20; s < st.line.length - 20; s += r.range(18, 34)) {
        if (!r.chance(0.5)) continue;
        if (st.fords.some((f) => Math.abs(f - s) < 14)) continue;
        const [px, pz] = st.line.pointAt(s);
        const [qx, qz] = st.line.pointAt(s + 1);
        const side = r.sign();
        const off = side * (st.w[Math.round(s)] + st.bankW[Math.round(s)] + r.range(3, 8));
        groves.push({ x: px - (qz - pz) * off, z: pz + (qx - px) * off, r: r.range(4, 7) });
      }
    }
    for (let k = 0; k < 10; k++) groves.push({ x: r.range(-160, 150), z: r.range(-160, 150), r: r.range(4, 7) });
    for (const g of groves) {
      const n = Math.round(g.r * 0.8) + r.int(1, 3);
      for (let k = 0; k < n; k++) {
        const a = r.range(0, 6.28), d = Math.sqrt(r.float()) * g.r;
        const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d;
        if (!inBounds(x, z, 6) || !outsideCliff(x, z) || x > LAYOUT.bambooBelt.xStart - 3) continue;
        const s = surfAt(x, z);
        if (!isDryGround(s) || s === SURFACE.PACKED_DIRT || trailDistAt(x, z) < 2.6 || waterAt(x, z) !== NO_WATER) continue;
        if (paddy.signedDistance(x, z) < 4 || Math.hypot(x - start.x, z - start.z) < 6) continue;
        const cr = r.range(0.85, 1.3);
        if (!free(x, z, cr + 0.15)) continue;
        const b = { x, z, y: heightAt(x, z), rot: r.range(0, 6.28), height: r.range(9, 15), radius: cr, variant: r.int(0, 1), rank: r.float() };
        P.bamboo.push(b);
        occ.add(x, z, cr);
        circles.push({ x, z, r: cr, y0: b.y - 0.5, y1: b.y + b.height, type: 'bamboo', tags: T.bamboo });
      }
    }
  }

  // --- 어린 나무 (중하층, 숲을 빽빽하게)
  P.sapling = [];
  {
    const r = rng.fork(13);
    jitterGrid(r, half, 4.2, (x, z) => {
      if (!inBounds(x, z, 4) || !outsideCliff(x, z) || x > LAYOUT.bambooBelt.xStart - 2) return;
      const s = surfAt(x, z);
      if (!(s === SURFACE.LEAF_LITTER || s === SURFACE.WET_EARTH || (s === SURFACE.BRUSH && brushAt(x, z) === BRUSH_THICKET))) return;
      if (trailDistAt(x, z) < 1.8 || waterAt(x, z) !== NO_WATER || paddy.signedDistance(x, z) < 4 || swampQ(x, z) < 1.2) return;
      if (slopeAt(x, z) > 35 || Math.hypot(x - start.x, z - start.z) < 3) return;
      const low = lowAt(x, z);
      if (!r.chance(lerp(0.6, 0.32, low)) || !free(x, z, 0.8)) return;
      const height = r.range(3, 8);
      const sp = { x, z, y: heightAt(x, z), rot: r.range(0, 6.28), height, variant: r.int(0, 2), rank: r.float() };
      P.sapling.push(sp);
      occ.add(x, z, 0.12);
      circles.push({ x, z, r: 0.07, y0: sp.y - 0.3, y1: sp.y + height, type: 'sapling', tags: T.sapling });
      circles.push({ x, z, r: height * 0.22, y0: sp.y + height * 0.42, y1: sp.y + height, type: 'saplingCrown', tags: T.saplingCrown });
    });
  }

  // --- 동쪽 가장자리 밀집 대나무 띠 (통과 불가)
  P.bambooDense = [];
  {
    const r = rng.fork(8);
    const x0 = LAYOUT.bambooBelt.xStart;
    // 충돌체: 촘촘한 격자 (몸 반경 포함 빈틈 없음)
    for (let x = x0; x <= half + 1; x += 2) {
      for (let z = -half; z <= half; z += 2) {
        const cx = x + r.range(-0.25, 0.25), cz = z + r.range(-0.25, 0.25);
        circles.push({ x: cx, z: cz, r: 1.6, y0: -50, y1: 200, type: 'bambooDense', tags: T.bambooDense, hidden: true });
      }
    }
    // 시각용 군락
    for (let x = x0 + 0.5; x <= x0 + LAYOUT.bambooBelt.visualDepth; x += 2.8) {
      for (let z = -half + 1; z <= half - 1; z += 2.8) {
        const cx = x + r.range(-0.9, 0.9), cz = z + r.range(-0.9, 0.9);
        if (Math.abs(z - riverCenterZ(cx)) < R.halfWidth + 1) continue;
        P.bambooDense.push({ x: cx, z: cz, y: heightAt(cx, cz), rot: r.range(0, 6.28), height: r.range(10, 16), radius: 1.3, variant: r.int(0, 1), rank: r.float() });
      }
    }
  }

  // --- 코끼리풀 / 덤불 / 고사리 (하층)
  P.grass = [];
  P.shrub = [];
  P.fern = [];
  {
    const r = rng.fork(9);
    jitterGrid(r, half, 1.15, (x, z) => {
      if (!inBounds(x, z, 2)) return;
      const c = cellIndex(x, z, sN, sRes, half);
      if (BK[c] !== BRUSH_GRASS || surface[c] !== SURFACE.BRUSH) return;
      if (occ.any(x, z, 0.1)) return;
      P.grass.push({ x, z, y: heightAt(x, z), rot: r.range(0, 6.28), height: r.range(1.5, 2.5), variant: r.int(0, 2), rank: r.float() });
    });
    const r2 = rng.fork(10);
    jitterGrid(r2, half, 1.7, (x, z) => {
      if (!inBounds(x, z, 2)) return;
      const c = cellIndex(x, z, sN, sRes, half);
      if (BK[c] !== BRUSH_THICKET || surface[c] !== SURFACE.BRUSH) return;
      if (occ.any(x, z, 0.2)) return;
      P.shrub.push({ x, z, y: heightAt(x, z), rot: r2.range(0, 6.28), height: r2.range(1.0, 1.9), variant: r2.int(0, 2), rank: r2.float() });
    });
    const r3 = rng.fork(11);
    jitterGrid(r3, half, 1.9, (x, z) => {
      if (!inBounds(x, z, 2) || x > LAYOUT.bambooBelt.xStart + 2) return;
      const s = surfAt(x, z);
      if (s !== SURFACE.LEAF_LITTER && s !== SURFACE.WET_EARTH) return;
      if (trailDistAt(x, z) < 1.4 || waterAt(x, z) !== NO_WATER || paddy.signedDistance(x, z) < 1.5) return;
      if (Math.hypot(x - start.x, z - start.z) < 2.5) return;
      const sd = sampleBilinear(streamDist, hN, hRes, half, x, z);
      const p = (s === SURFACE.WET_EARTH ? 0.5 : 0.55) + (sd < 15 ? 0.25 : 0) - 0.25 * Math.max(0, noise.fbm(x / 20 + 5, z / 20, 2));
      if (!r3.chance(p) || occ.any(x, z, 0.15)) return;
      P.fern.push({ x, z, y: heightAt(x, z), rot: r3.range(0, 6.28), height: r3.range(0.55, 1.2), variant: r3.int(0, 2), rank: r3.float() });
    });
  }
  // --- 논의 모 (시각용)
  P.rice = [];
  {
    const r = rng.fork(12);
    for (let row = 0; row < paddy.rows; row++) {
      for (let col = 0; col < paddy.cols; col++) {
        const u0 = -paddy.halfU + col * paddy.cellW, v0 = -paddy.halfV + row * paddy.cellH;
        const floor = paddy.floors[row * paddy.cols + col];
        const fallow = r.chance(0.15); // 일부 논은 비어 있음
        if (fallow) continue;
        for (let u = u0 + 0.6; u < u0 + paddy.cellW - 0.6; u += 0.42) {
          for (let v = v0 + 0.6; v < v0 + paddy.cellH - 0.6; v += 0.34) {
            if (!r.chance(0.92)) continue;
            const [x, z] = paddy.toWorld(u + r.range(-0.05, 0.05), v + r.range(-0.05, 0.05));
            P.rice.push({ x, z, y: floor, rot: r.range(0, 6.28), height: r.range(0.38, 0.62), variant: 0, rank: r.float() });
          }
        }
      }
    }
  }
  data.timings.placement = now() - t0;
  onProgress(0.7, '식생 배치');

  // -------------------------------------------------------------
  // 6. 캐노피(하늘 가림) 맵 + 은폐(cover) 맵 — 1m
  // -------------------------------------------------------------
  const cN = size; // 1m 셀
  const canopy = new Float32Array(cN * cN);      // 0~1 가림 정도
  const canopyLow = new Float32Array(cN * cN).fill(1e4);
  const canopyHigh = new Float32Array(cN * cN).fill(-1e4);
  const stampCanopy = (cx, cz, rad, alpha, y0, y1, holeScale) => {
    const i0 = Math.max(0, Math.floor(cx - rad + half)), i1 = Math.min(cN - 1, Math.ceil(cx + rad + half));
    const j0 = Math.max(0, Math.floor(cz - rad + half)), j1 = Math.min(cN - 1, Math.ceil(cz + rad + half));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i - half + 0.5, z = j - half + 0.5;
        const d = Math.hypot(x - cx, z - cz) / rad;
        if (d >= 1) continue;
        const holes = smoothstep(-0.35, 0.25, noise.fbm(x / holeScale + 100, z / holeScale - 100, 3));
        const a = alpha * Math.sqrt(1 - d * d) * holes;
        const k = j * cN + i;
        canopy[k] = 1 - (1 - canopy[k]) * (1 - a);
        canopyLow[k] = Math.min(canopyLow[k], y0);
        canopyHigh[k] = Math.max(canopyHigh[k], y1);
      }
    }
  };
  for (const t of P.bigTree) {
    const top = t.y + t.height;
    stampCanopy(t.x, t.z, t.crownR * 1.1, 0.97, top - t.height * 0.32, top + 1, 5.5);
  }
  for (const p of P.palm) stampCanopy(p.x, p.z, 3.6, 0.55, p.y + p.height - 2, p.y + p.height + 1, 2.5);
  for (const b of P.bamboo) stampCanopy(b.x, b.z, 3.5, 0.6, b.y + b.height * 0.45, b.y + b.height, 2.5);
  for (const b of P.bambooDense) stampCanopy(b.x, b.z, 3.2, 0.7, b.y + b.height * 0.4, b.y + b.height, 2.5);
  for (const b of P.banana) stampCanopy(b.x, b.z, 1.8, 0.45, b.y + 1.2, b.y + b.height, 2);
  data.canopy = canopy;
  data.canopyLow = canopyLow;
  data.canopyHigh = canopyHigh;
  data.cN = cN;

  // 은폐 맵: 체적형 식생 (코끼리풀·덤불·고사리)의 높이와 1m당 소광계수
  const coverHeight = new Float32Array(cN * cN);
  const coverSigma = new Float32Array(cN * cN);
  const stampCover = (cx, cz, rad, height, sigma) => {
    const i0 = Math.max(0, Math.floor(cx - rad + half)), i1 = Math.min(cN - 1, Math.floor(cx + rad + half));
    const j0 = Math.max(0, Math.floor(cz - rad + half)), j1 = Math.min(cN - 1, Math.floor(cz + rad + half));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * cN + i;
        coverHeight[k] = Math.max(coverHeight[k], height);
        coverSigma[k] = Math.max(coverSigma[k], sigma);
      }
    }
  };
  const sig = (vb) => -Math.log(1 - Math.min(vb, 0.99));
  for (const g of P.grass) stampCover(g.x, g.z, 0.6, g.height, sig(T.elephantGrass.visionBlock));
  for (const s of P.shrub) stampCover(s.x, s.z, 0.85, s.height, sig(T.shrub.visionBlock));
  for (const f of P.fern) stampCover(f.x, f.z, 0.55, f.height * 0.8, sig(T.fern.visionBlock));
  data.coverHeight = coverHeight;
  data.coverSigma = coverSigma;

  // -------------------------------------------------------------
  // 7. 테스트 지점 (지형에 맞춰 위치·바라보는 방향 계산)
  // -------------------------------------------------------------
  const yawOf = (dx, dz) => Math.atan2(-dx, -dz);           // 바라보는 방향 → yaw (0 = 북)
  const along = (tr, s, ds = 3) => { const [ax, az] = tr.line.pointAt(s); const [bx, bz] = tr.line.pointAt(s + ds); return { x: ax, z: az, yaw: yawOf(bx - ax, bz - az) }; };
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

function jitterGrid(rng, half, spacing, fn) {
  for (let z = -half; z < half; z += spacing) {
    for (let x = -half; x < half; x += spacing) {
      fn(x + rng.float() * spacing, z + rng.float() * spacing);
    }
  }
}

/** 배치 중 겹침 검사용 간단한 공간 해시 */
class SpatialHash {
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
