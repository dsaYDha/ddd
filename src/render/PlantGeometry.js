// 하층·중층 식물 지오메트리 (절차적). 함수마다 머티리얼 키별 지오메트리를 돌려준다.
//  leaves: 잎 아틀라스 머티리얼 (알파 테스트, 흔들림·밀림·역광)
//  stem:   텍스처 없는 줄기·풀잎 (정점색, 흔들림)
//  bark:   나무껍질 머티리얼 (줄기·리아나)
// 정점 속성 aWind = (가지 흔들림 m, 잎 떨림 m, 위상) — 같은 포기의 줄기와 잎은 같은 값을 써서 함께 움직인다.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';
import { MeshBuilder, tube, leafStrip, leafCluster, card } from './MeshBuilder.js';
import { ATLAS } from './Textures.js';
import { BARK_ATTRS, LEAF_ATTRS } from './TreeBuilder.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

// 잎 아틀라스에 곱해지는 틴트 (1 근처)
const tint = (rng, k = 1, warm = 0) => {
  const v = rng.range(0.86, 1.1) * k;
  return [v * (1 + warm * 0.25 + rng.range(-0.04, 0.04)), v, v * (1 - warm * 0.4 + rng.range(-0.06, 0.04))];
};
const DEAD = [1.5, 1.08, 0.52];
const leafMB = () => new MeshBuilder(LEAF_ATTRS);
const barkMB = () => new MeshBuilder(BARK_ATTRS);
const stemMB = () => new MeshBuilder(LEAF_ATTRS);
// HSL 은 sRGB 기준으로 해석 (three 의 기본은 선형 작업 공간이라 그대로 쓰면 색이 크게 밝아짐)
const col = (h, s, l) => { const c = new THREE.Color().setHSL(h, s, l, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };

/** 카드를 세운 교차 포기 (지피식물·풀 포기·묘목): 아래 가장자리가 땅에 박힘 */
function crossedCards(mb, rng, region, w, h, n, colr, sway = 0.04, y0 = -0.03) {
  const a0 = rng.range(0, Math.PI);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * Math.PI + rng.range(-0.15, 0.15);
    const right = V3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(w * 0.5);
    const up = V3(0, h * 0.5, 0);
    const c = V3(0, y0 + h * 0.5, 0);
    const n0 = V3(-Math.sin(a) * 0.35, 0.94, Math.cos(a) * 0.35).normalize();
    const p = [c.clone().sub(right).sub(up), c.clone().add(right).sub(up), c.clone().add(right).add(up), c.clone().sub(right).add(up)];
    const uv = [[region.u0, region.v0], [region.u1, region.v0], [region.u1, region.v1], [region.u0, region.v1]];
    const ph = rng.float();
    const ids = p.map((q, i) => {
      const t = Math.max(0, (q.y - y0) / h);
      mb.set('aWind', sway * t * t, 0.012 * t, ph);
      const ao = 0.55 + 0.45 * t;
      return mb.vertex(q.x, q.y, q.z, n0.x, n0.y, n0.z, uv[i][0], uv[i][1], colr[0] * ao, colr[1] * ao, colr[2] * ao);
    });
    mb.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

/** 바닥에 납작하게 깔린 카드 (기는 덩굴·이끼·수련) */
function flatCard(mb, rng, region, size, y, colr, rot = rng.range(0, TAU)) {
  const right = V3(Math.cos(rot), 0, Math.sin(rot)).multiplyScalar(size);
  const fwd = V3(-Math.sin(rot), 0, Math.cos(rot)).multiplyScalar(size);
  mb.set('aWind', 0.005, 0.006, rng.float());
  card(mb, V3(0, y, 0), right, fwd, region, colr, V3(0, 1, 0));
}

// ---------------------------------------------------------------
// 덤불 (높이 1.4m 기준) — 가는 줄기 몇 개 + 둥근 잎 덩어리
// ---------------------------------------------------------------
export function buildShrub(variant, lod) {
  const rng = new RNG(7000 + variant * 19);
  const leaves = leafMB(), stems = stemMB();
  const H = 1.4;
  const regions = variant === 0 ? [ATLAS.clusterB, ATLAS.clusterC] : variant === 1 ? [ATLAS.clusterC, ATLAS.herb] : [ATLAS.clusterB, ATLAS.clusterA];
  // 잎 덩어리가 반경 ≈0.7, 높이 ≈1.4 안에 들도록 (물리·시야 데이터의 덤불 크기와 같게)
  const blobs = [];
  const nb = rng.int(3, 5);
  for (let i = 0; i < nb; i++) {
    const a = rng.range(0, TAU), d = rng.range(0, 0.18);
    blobs.push({ c: V3(Math.cos(a) * d, rng.range(0.6, 0.85), Math.sin(a) * d), r: rng.range(0.24, 0.32) });
  }
  if (lod === 0) {
    for (const b of blobs) {
      const ph = rng.float();
      const pts = [V3(rng.range(-0.08, 0.08), -0.05, rng.range(-0.08, 0.08)), b.c.clone().multiplyScalar(0.5), b.c.clone()];
      tube(stems, pts, (t) => 0.018 * (1 - 0.6 * t), 3, () => col(0.08, 0.3, 0.16), [1, 1], false, (t) => stems.set('aWind', 0.05 * t * t, 0, ph));
    }
  }
  const n = lod === 0 ? 16 : 7;
  const size = lod === 0 ? 0.3 : 0.4;
  for (let i = 0; i < n; i++) {
    const b = blobs[i % blobs.length];
    const u = rng.range(0, TAU), v = Math.acos(rng.range(-0.5, 1));
    const lp = V3(Math.cos(u) * Math.sin(v), Math.cos(v) * 0.9, Math.sin(u) * Math.sin(v)).multiplyScalar(b.r * rng.range(0.5, 1));
    const c = b.c.clone().add(lp);
    const t = Math.min(1, c.y / H);
    leaves.set('aWind', 0.05 * t * t + 0.01, 0.018, rng.float());
    const ao = 0.6 + 0.4 * Math.min(1, (lp.y / b.r + 1) * 0.5 + 0.2);
    const k = rng.range(0.85, 1.08) * ao;
    leafCluster(leaves, c, size * rng.range(0.9, 1.1), regions[i % 2], [k, k, k * 0.96], c.clone().setY(c.y - 0.3), rng, lod === 0 ? 3 : 2, 0.9);
  }
  return { leaves: leaves.build(), stem: lod === 0 ? stems.build() : null };
}

// ---------------------------------------------------------------
// 토란 (높이 1.3m 기준) — 긴 잎자루 끝에 커다란 하트형 잎
// ---------------------------------------------------------------
export function buildTaro(variant, lod) {
  const rng = new RNG(7300 + variant * 13);
  const leaves = leafMB(), stems = stemMB();
  const n = lod === 0 ? rng.int(5, 7) : 4;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * TAU + rng.range(-0.3, 0.3);
    const len = rng.range(0.8, 1.15);
    const lean = rng.range(0.2, 0.42);
    const top = V3(Math.cos(yaw) * len * lean, len * Math.cos(lean * 0.9), Math.sin(yaw) * len * lean);
    const ph = rng.float();
    if (lod === 0) {
      tube(stems, [V3(0, -0.05, 0), top.clone().multiplyScalar(0.5).add(V3(0, 0.05, 0)), top], () => 0.02, 3, () => col(0.22, 0.4, 0.32), [1, 1], false,
        (t) => stems.set('aWind', 0.06 * t * t, 0, ph));
    }
    // 잎: 잎자루 끝에서 앞으로 기울어 늘어진 곡면 (3×3 격자)
    const size = rng.range(0.34, 0.46) * (lod === 0 ? 1 : 1.1);
    const fwd = V3(Math.cos(yaw), 0, Math.sin(yaw));
    const side = V3(-Math.sin(yaw), 0, Math.cos(yaw));
    const tilt = rng.range(0.35, 0.75);
    const R = ATLAS.taro;
    const base = leaves.count;
    const N = lod === 0 ? 3 : 2;
    const k = rng.range(0.88, 1.1);
    for (let a = 0; a <= N; a++) {
      for (let b = 0; b <= N; b++) {
        const u = a / N, v = b / N;              // u: 옆, v: 끝(0) → 밑 갈래(1)
        const x = (u - 0.5) * size * 1.9;
        const along = (0.72 - v) * size * 2.0;   // 잎자루 붙는 곳(v≈0.72) 기준 앞쪽(+)
        const cup = -Math.abs(u - 0.5) * size * 0.35;
        const droop = along > 0 ? -along * along * 0.55 : 0;
        const p = top.clone().add(fwd.clone().multiplyScalar(along * Math.cos(tilt))).add(side.clone().multiplyScalar(x));
        p.y += -along * Math.sin(tilt) + droop + cup * 0.6 + 0.04;
        const nrm = V3(0, 1, 0).add(fwd.clone().multiplyScalar(0.3)).normalize();
        leaves.set('aWind', 0.06 + 0.04 * Math.max(0, along), 0.02, ph);
        leaves.vertex(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, R.u0 + (R.u1 - R.u0) * u, R.v0 + (R.v1 - R.v0) * v, k, k, k * 0.95);
      }
    }
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
      const i0 = base + a * (N + 1) + b;
      leaves.quad(i0, i0 + (N + 1), i0 + (N + 1) + 1, i0 + 1);
    }
  }
  return { leaves: leaves.build(), stem: lod === 0 ? stems.build() : null };
}

// ---------------------------------------------------------------
// 등나무류 (높이 2.6m 기준) — 땅에서 아치형으로 뻗는 가시 깃꼴 잎 + 기어오르는 줄기
// ---------------------------------------------------------------
export function buildRattan(variant, lod) {
  const rng = new RNG(7600 + variant * 29);
  const leaves = leafMB(), stems = stemMB();
  const n = lod === 0 ? rng.int(6, 8) : 4;
  for (let i = 0; i < n; i++) {
    const ph = rng.float();
    leafStrip(leaves, {
      origin: V3(rng.range(-0.15, 0.15), 0.05, rng.range(-0.15, 0.15)), yaw: (i / n) * TAU + rng.range(-0.3, 0.3),
      pitch: rng.range(1.0, 1.3), length: rng.range(1.7, 2.3), width: 0.7, segs: lod === 0 ? 6 : 3,
      droop: rng.range(0.6, 0.85), region: ATLAS.palm, color: tint(rng, 1.02, 0.1), fold: 0.12,
      onSeg: (t) => leaves.set('aWind', 0.16 * t * t, 0.03 * t, ph),
    });
  }
  if (lod === 0) {
    for (let k = 0; k < 2; k++) {
      const a = rng.range(0, TAU), ph = rng.float();
      const pts = [];
      for (let s = 0; s <= 6; s++) {
        const t = s / 6;
        pts.push(V3(Math.cos(a) * t * 1.2 + Math.sin(t * 7) * 0.08, t * 2.6, Math.sin(a) * t * 1.2));
      }
      tube(stems, pts, () => 0.022, 4, () => col(0.12, 0.3, 0.2), [1, 1], false, (t) => stems.set('aWind', 0.08 * t * t, 0, ph));
    }
  }
  return { leaves: leaves.build(), stem: lod === 0 ? stems.build() : null };
}

// ---------------------------------------------------------------
// 나무고사리 (높이 4m 기준) — 섬유질 줄기 + 왕관처럼 펼친 큰 잎
// ---------------------------------------------------------------
export function buildTreeFern(variant, lod) {
  const rng = new RNG(7900 + variant * 7);
  const bark = barkMB(), leaves = leafMB();
  const H = 4;
  const lean = V3(rng.range(-0.35, 0.35), 0, rng.range(-0.35, 0.35));
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push(V3(lean.x * t * t + Math.sin(t * 5) * 0.04, -0.3 + t * (H + 0.3), lean.z * t * t));
  }
  tube(bark, pts, (t) => 0.13 * (1 - 0.25 * t) * (t < 0.1 ? 1.25 : 1), lod === 0 ? 7 : 4, (t) => {
    const k = 0.42 + 0.12 * t;
    return [k, k * 0.86, k * 0.7];
  }, [1, 0.6], false, (t) => bark.set('aMoss', 0.55 * (1 - t)));
  const top = pts[pts.length - 1];
  const n = lod === 0 ? rng.int(11, 14) : 7;
  for (let i = 0; i < n; i++) {
    const ph = rng.float();
    const dead = i % 6 === 5;
    leafStrip(leaves, {
      origin: top.clone(), yaw: (i / n) * TAU + rng.range(-0.25, 0.25), pitch: dead ? -0.9 : rng.range(0.25, 0.8),
      length: rng.range(1.9, 2.6), width: 0.95, segs: lod === 0 ? 6 : 3, droop: dead ? 0.15 : rng.range(0.55, 0.85),
      region: ATLAS.fern, color: dead ? DEAD : tint(rng, 1.05, 0.05), fold: 0.1, taperBase: 0.15,
      onSeg: (t) => leaves.set('aWind', 0.05 + 0.14 * t * t, 0.025 * t, ph),
    });
  }
  // 새로 말려 나오는 잎 (작은 덩어리)
  if (lod === 0) {
    leaves.set('aWind', 0.05, 0.01, rng.float());
    leafCluster(leaves, top.clone().add(V3(0, 0.25, 0)), 0.22, ATLAS.fern, [1.15, 1.2, 0.9], V3(0, 1, 0), rng, 2, 1.2);
  }
  return { bark: bark.build(), leaves: leaves.build() };
}

// ---------------------------------------------------------------
// 어린 나무 (높이 5m 기준) — 가는 줄기, 0.35H 위부터 가지와 잎 덩어리 (물리 수관 원기둥과 같은 높이)
// ---------------------------------------------------------------
export function buildSapling(variant, lod) {
  const rng = new RNG(4500 + variant * 23);
  const bark = barkMB(), leaves = leafMB();
  const H = 5;
  const lean = [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)];
  const pts = [];
  const segs = lod === 0 ? 6 : 3;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(V3(lean[0] * t * t + Math.sin(t * 4 + variant) * 0.08, -0.25 + t * (H + 0.25), lean[1] * t * t));
  }
  const tone = [0.9, 0.86, 0.78];
  tube(bark, pts, (t) => 0.07 * (1 - 0.65 * t) + 0.01, lod === 0 ? 6 : 3, () => tone, [1, 0.5], false, (t) => bark.set('aMoss', 0.3 * (1 - t)));
  const regions = [ATLAS.clusterB, ATLAS.clusterA, ATLAS.clusterB];
  const branches = lod === 0 ? rng.int(4, 6) : 3;
  const clumps = [];
  for (let b = 0; b < branches; b++) {
    const t = rng.range(0.52, 0.95);
    const p = pts[0].clone().lerp(pts[segs], t);
    p.x = pts[Math.round(t * segs)].x; p.z = pts[Math.round(t * segs)].z;
    const a = (b / branches) * TAU + rng.range(-0.4, 0.4);
    const len = rng.range(0.3, 0.7) * (1.2 - t * 0.5);
    const end = p.clone().add(V3(Math.cos(a) * len, len * rng.range(0.35, 0.8), Math.sin(a) * len));
    if (lod === 0) tube(bark, [p, p.clone().lerp(end, 0.5).add(V3(0, 0.06, 0)), end], (tt) => 0.025 * (1 - 0.6 * tt) + 0.006, 3, () => tone, [1, 0.5]);
    clumps.push({ c: end, r: rng.range(0.4, 0.6) * (1.15 - t * 0.3) });
  }
  clumps.push({ c: pts[segs].clone().add(V3(0, 0.1, 0)), r: 0.55 });
  // 줄기에 바로 붙은 잎 무리 (층층이 보이지 않게 사이를 메움)
  for (let k = 0; k < 2; k++) clumps.push({ c: pts[0].clone().lerp(pts[segs], rng.range(0.6, 0.88)), r: 0.45 });
  const per = lod === 0 ? 3 : 2;
  const size = lod === 0 ? 0.45 : 0.68;
  for (const cl of clumps) {
    for (let i = 0; i < per; i++) {
      const lp = V3(rng.range(-1, 1), rng.range(-0.4, 0.6), rng.range(-1, 1)).multiplyScalar(cl.r * 0.6);
      const c = cl.c.clone().add(lp);
      const t = Math.min(1, c.y / H);
      leaves.set('aWind', 0.05 + 0.1 * t, 0.025, rng.float());
      const k = rng.range(0.88, 1.08) * (0.75 + 0.25 * t);
      leafCluster(leaves, c, size * rng.range(0.85, 1.2), regions[(i + variant) % 3], [k, k, k * 0.95], lp, rng, lod === 0 ? 3 : 2, 0.9);
    }
  }
  return { bark: bark.build(), leaves: leaves.build() };
}

// ---------------------------------------------------------------
// 야자수 (높이 8m 기준)
// ---------------------------------------------------------------
export function buildPalm(variant, lod) {
  const rng = new RNG(2000 + variant * 31);
  const H = 8;
  const bark = barkMB(), leaves = leafMB();
  const lean = V3(rng.range(0.6, 1.3), 0, rng.range(-0.3, 0.3));
  const pts = [];
  const segs = lod === 0 ? 10 : 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(V3(lean.x * t * t, -0.3 + t * (H + 0.3), lean.z * t * t));
  }
  // 고리 무늬 줄기 (정점색으로 고리, 껍질 텍스처는 밝게)
  tube(bark, pts, (t) => 0.2 - 0.06 * t + (t < 0.06 ? 0.06 : 0), lod === 0 ? 9 : 5,
    (t) => (Math.floor(t * 46) % 2 ? [1.08, 1.04, 0.96] : [0.8, 0.76, 0.7]), [1, 0.5], false, (t) => bark.set('aMoss', 0.25 * (1 - t)));
  const top = pts[pts.length - 1];
  if (lod === 0) {
    const nut = new THREE.IcosahedronGeometry(0.11, 0);
    bark.set('aMoss', 0);
    for (let i = 0; i < 6; i++) {
      const a = rng.range(0, TAU);
      const m = new THREE.Matrix4().makeTranslation(top.x + Math.cos(a) * 0.22, top.y - 0.25 - rng.range(0, 0.15), top.z + Math.sin(a) * 0.22);
      bark.addGeometry(nut, m, () => [0.75, 0.6, 0.38]);
    }
  }
  const n = lod === 0 ? 15 : 9;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * TAU + rng.range(-0.2, 0.2);
    const dead = i % 5 === 4;
    const ph = rng.float();
    leafStrip(leaves, {
      origin: top.clone(), yaw, pitch: dead ? -1.15 : rng.range(0.1, 0.85), length: rng.range(3.4, 4.6), width: 1.15,
      segs: lod === 0 ? 7 : 3, droop: dead ? 0.1 : rng.range(0.55, 0.9), region: ATLAS.palm, color: dead ? DEAD : tint(rng, 1.04, 0.08), fold: 0.18,
      onSeg: (t) => leaves.set('aWind', 0.08 + 0.3 * t * t, 0.03 * t, ph),
    });
  }
  return { bark: bark.build(), leaves: leaves.build() };
}

// ---------------------------------------------------------------
// 바나나 (높이 2.6m 기준) — 거짓줄기 + 찢어진 넓은 잎
// ---------------------------------------------------------------
export function buildBanana(variant, lod) {
  const rng = new RNG(3000 + variant * 17);
  const H = 2.6;
  const stems = stemMB(), leaves = leafMB();
  const ph0 = rng.float();
  const stemCol = col(0.2, 0.32, 0.36), stemDark = col(0.12, 0.3, 0.24);
  tube(stems, [V3(0, -0.2, 0), V3(0.03, H * 0.5, 0), V3(0.05, H, 0.02)], (t) => 0.14 - 0.045 * t, lod === 0 ? 8 : 5,
    (t) => (t < 0.25 ? stemDark : stemCol), [1, 0.5], false, (t) => stems.set('aWind', 0.05 * t * t, 0, ph0));
  const n = lod === 0 ? 9 : 5;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * TAU + rng.range(-0.3, 0.3);
    const old = i % 4 === 3;
    leafStrip(leaves, {
      origin: V3(0.05, H - rng.range(0, 0.35), 0.02), yaw, pitch: old ? -0.7 : rng.range(0.3, 0.9), length: rng.range(1.7, 2.4), width: 0.72,
      segs: lod === 0 ? 6 : 3, droop: old ? 0.25 : rng.range(0.4, 0.65), region: ATLAS.banana, color: old ? DEAD : tint(rng, 1.08, 0.05),
      fold: 0.07, taperBase: 0.12, onSeg: (t) => leaves.set('aWind', 0.05 + 0.16 * t * t, 0.03 * t, ph0),
    });
  }
  return { stem: stems.build(), leaves: leaves.build() };
}

// ---------------------------------------------------------------
// 대나무 군락 (반경 1m, 높이 12m 기준)
// ---------------------------------------------------------------
export function buildBamboo(variant, lod) {
  const rng = new RNG(4000 + variant * 13);
  const H = 12;
  const stems = stemMB(), leaves = leafMB();
  const culms = lod === 0 ? 26 : lod === 1 ? 11 : 5;
  for (let i = 0; i < culms; i++) {
    const a = rng.range(0, TAU), d = Math.sqrt(rng.float()) * 0.85;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const out = rng.range(0.08, 0.3) + d * 0.25;
    const h = H * rng.range(0.7, 1.05);
    const pts = [];
    const segs = lod === 0 ? 7 : lod === 1 ? 3 : 2;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const o = out * h * t * t * 0.5;
      pts.push(V3(bx + Math.cos(a) * o, -0.2 + t * h, bz + Math.sin(a) * o));
    }
    const r = rng.range(0.035, 0.065);
    const green = col(0.2 + rng.range(-0.03, 0.03), 0.42, rng.range(0.3, 0.42));
    const yellow = col(0.15, 0.5, 0.5);
    const node = col(0.12, 0.3, 0.24);
    const c = rng.chance(0.15) ? yellow : green;
    const ph = rng.float();
    const swayAt = (y) => 0.4 * (y / H) * (y / H);
    tube(stems, pts, (t) => r * (1 - 0.4 * t) * (lod === 2 ? 1.6 : 1), lod === 0 ? 5 : 3,
      (t) => (Math.abs(((t * h) % 0.45) - 0.02) < 0.03 ? node : c), [1, 1], false, (t, p) => stems.set('aWind', swayAt(p.y), 0, ph));
    const sprays = lod === 0 ? 8 : lod === 1 ? 3 : 3;
    for (let k = 0; k < sprays; k++) {
      const t = rng.range(0.4, 1.0);
      const idx = Math.min(pts.length - 1, Math.round(t * segs));
      const p = pts[idx].clone().add(V3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3));
      leaves.set('aWind', swayAt(p.y), 0.03, ph);
      leafCluster(leaves, p, rng.range(0.55, 0.85) * (lod === 0 ? 1 : lod === 1 ? 1.3 : 1.9), ATLAS.bamboo, tint(rng, 1.04, 0.15), V3(Math.cos(a), 0.2, Math.sin(a)), rng, lod === 2 ? 1 : 2, 1.0);
    }
  }
  return { stem: stems.build(), leaves: leaves.build() };
}

// ---------------------------------------------------------------
// 코끼리풀 (높이 1.75m 기준) — 가까이: 잎 지오메트리 / 멀리: 교차 카드
// ---------------------------------------------------------------
export function buildElephantGrass(variant, lod) {
  const rng = new RNG(6000 + variant * 11);
  if (lod === 1) {
    const mb = leafMB();
    crossedCards(mb, rng, ATLAS.grass, 1.6, 2.0, 3, [1.05, 1.05, 0.95], 0.18, -0.05);
    return { leaves: mb.build() };
  }
  const mb = stemMB();
  const blades = 30;
  const ph = rng.float();
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, TAU);
    const ox = Math.cos(a) * rng.range(0, 0.28), oz = Math.sin(a) * rng.range(0, 0.28);
    const h = rng.range(1.3, 2.1), lean = rng.range(0.15, 0.7), w = rng.range(0.018, 0.034);
    const lk = rng.range(0.75, 1.15), hk = rng.range(-0.02, 0.03);
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const sx = -dirz, sz = dirx;
    const base = mb.count;
    const segs = 4;
    const tipDry = rng.chance(0.5);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const px = ox + dirx * lean * t * t * h * 0.5, pz = oz + dirz * lean * t * t * h * 0.5;
      const py = t * h - lean * t * t * t * 0.4;
      const ww = w * (1 - t * 0.9);
      const g = col(0.23 + hk - (tipDry ? 0.08 : 0) * t, 0.42, (0.15 + 0.13 * t) * lk);
      mb.set('aWind', 0.18 * t * t, 0.02 * t, ph);
      mb.vertex(px - sx * ww, py, pz - sz * ww, dirx * 0.55, 0.8, dirz * 0.55, 0, t, g[0], g[1], g[2]);
      mb.vertex(px + sx * ww, py, pz + sz * ww, dirx * 0.55, 0.8, dirz * 0.55, 1, t, g[0], g[1], g[2]);
      if (k > 0) { const b = base + (k - 1) * 2; mb.quad(b, b + 2, b + 3, b + 1); }
    }
  }
  return { stem: mb.build() };
}

// ---------------------------------------------------------------
// 갈대·부들 (높이 1.8m 기준) — variant 1 = 부들(갈색 이삭)
// ---------------------------------------------------------------
export function buildReed(variant, lod) {
  const rng = new RNG(6500 + variant * 3);
  if (lod === 1) {
    const mb = leafMB();
    crossedCards(mb, rng, ATLAS.reed, 1.2, 1.9, 2, [1, 1, 0.95], 0.12, -0.05);
    return { leaves: mb.build() };
  }
  const mb = stemMB();
  const ph = rng.float();
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU);
    const ox = Math.cos(a) * rng.range(0, 0.2), oz = Math.sin(a) * rng.range(0, 0.2);
    const h = rng.range(1.2, 1.9), lean = rng.range(0.05, 0.35), w = rng.range(0.012, 0.022);
    const dirx = Math.cos(a), dirz = Math.sin(a), sx = -dirz, sz = dirx;
    const base = mb.count;
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const px = ox + dirx * lean * t * t * h * 0.4, pz = oz + dirz * lean * t * t * h * 0.4;
      const g = col(0.24, 0.4, 0.13 + 0.13 * t);
      const nx = dirx * 0.6, nz = dirz * 0.6, ny = 0.8;
      mb.set('aWind', 0.12 * t * t, 0.01 * t, ph);
      mb.vertex(px - sx * w, t * h, pz - sz * w, nx, ny, nz, 0, t, g[0], g[1], g[2]);
      mb.vertex(px + sx * w, t * h, pz + sz * w, nx, ny, nz, 1, t, g[0], g[1], g[2]);
      if (k > 0) { const b = base + (k - 1) * 2; mb.quad(b, b + 2, b + 3, b + 1); }
    }
  }
  if (variant === 1) {
    // 부들 이삭
    for (let i = 0; i < 4; i++) {
      const x = rng.range(-0.15, 0.15), z = rng.range(-0.15, 0.15), h = rng.range(1.5, 1.9);
      tube(mb, [V3(x, 0, z), V3(x, h - 0.3, z)], () => 0.006, 3, () => col(0.2, 0.34, 0.3), [1, 1], false, (t) => mb.set('aWind', 0.12 * t * t, 0, ph));
      tube(mb, [V3(x, h - 0.3, z), V3(x, h, z)], () => 0.028, 5, () => col(0.07, 0.5, 0.2), [1, 1], true, () => mb.set('aWind', 0.12, 0, ph));
    }
  }
  return { stem: mb.build() };
}

// ---------------------------------------------------------------
// 물 위 수생식물 (지름 2m 기준)
// ---------------------------------------------------------------
export function buildWaterPlant(variant) {
  const rng = new RNG(6800 + variant);
  const mb = leafMB();
  for (let i = 0; i < 3; i++) {
    const rot = rng.range(0, TAU);
    mb.set('aWind', 0.01, 0.005, rng.float());
    const off = V3(rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4));
    const right = V3(Math.cos(rot), 0, Math.sin(rot)).multiplyScalar(0.55);
    const fwd = V3(-Math.sin(rot), 0, Math.cos(rot)).multiplyScalar(0.55);
    card(mb, off.setY(0.01 + i * 0.004), right, fwd, ATLAS.lily, tint(rng, 1.0), V3(0, 1, 0));
  }
  if (variant === 1) crossedCards(mb, rng, ATLAS.herb, 0.6, 0.7, 2, tint(rng, 1.0), 0.04, -0.05);
  return { leaves: mb.build() };
}

// ---------------------------------------------------------------
// 얽힌 덩굴 벽 한 마디 (벽 방향 = 로컬 x, 길이 ≈1.9m, 높이 4m 기준)
// ---------------------------------------------------------------
export function buildVineWall(variant, lod) {
  const rng = new RNG(8300 + variant * 5);
  const leaves = leafMB(), bark = barkMB();
  const H = 4;
  const rows = lod === 0 ? 3 : 2;
  for (let r = 0; r < rows; r++) {
    const z = (r / Math.max(1, rows - 1) - 0.5) * 0.8;
    const n = lod === 0 ? 4 : 2;
    for (let k = 0; k < n; k++) {
      const x = (k / n - 0.5) * 1.9 + rng.range(-0.15, 0.15);
      const h = H * rng.range(0.75, 1.05);
      const w = lod === 0 ? 0.55 : 1.0;
      const ph = rng.float();
      const R = ATLAS.vine;
      const yaw = rng.range(-0.25, 0.25);
      const right = V3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(w * 0.5);
      const base = leaves.count;
      const segs = 3;
      const kk = rng.range(0.85, 1.05);
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const c = V3(x + Math.sin(t * 3 + k) * 0.1, h * (1 - t) - 0.1, z + Math.cos(t * 2 + r) * 0.08);
        leaves.set('aWind', 0.03 + 0.06 * t, 0.02, ph);
        // 덩굴 카드: 위(v1)가 걸린 곳, 아래로 늘어짐
        const v = R.v1 - (R.v1 - R.v0) * t;
        leaves.vertex(c.x - right.x, c.y, c.z - right.z, 0, 0.3, z >= 0 ? 1 : -1, R.u0, v, kk, kk, kk);
        leaves.vertex(c.x + right.x, c.y, c.z + right.z, 0, 0.3, z >= 0 ? 1 : -1, R.u1, v, kk, kk, kk);
        if (s > 0) { const b = base + (s - 1) * 2; leaves.quad(b, b + 2, b + 3, b + 1); }
      }
    }
  }
  // 잎 덩어리 (빈틈 메우기)
  const nc = lod === 0 ? 12 : 6;
  for (let i = 0; i < nc; i++) {
    const c = V3(rng.range(-0.95, 0.95), rng.range(0.3, H * 0.95), rng.range(-0.4, 0.4));
    leaves.set('aWind', 0.04, 0.02, rng.float());
    const k = rng.range(0.8, 1.05);
    leafCluster(leaves, c, rng.range(0.45, 0.7) * (lod === 0 ? 1 : 1.3), i % 2 ? ATLAS.clusterC : ATLAS.clusterB, [k, k, k], V3(0, 0.2, c.z >= 0 ? 1 : -1), rng, 2, 1);
  }
  // 얽힌 줄기
  if (lod === 0) {
    for (let k = 0; k < 6; k++) {
      const pts = [];
      const z0 = rng.range(-0.4, 0.4);
      const x0 = rng.range(-1, 1), x1 = rng.range(-1, 1);
      for (let s = 0; s <= 6; s++) {
        const t = s / 6;
        pts.push(V3(x0 + (x1 - x0) * t + Math.sin(t * 6 + k) * 0.15, -0.1 + t * H * rng.range(0.8, 1), z0 + Math.cos(t * 5 + k) * 0.15));
      }
      tube(bark, pts, () => rng.range(0.02, 0.045), 4, () => [0.6, 0.55, 0.45], [1, 0.5], false, () => bark.set('aMoss', 0.4));
    }
  }
  return { leaves: leaves.build(), bark: lod === 0 ? bark.build() : null };
}

// ---------------------------------------------------------------
// 모 (높이 0.5m 기준)
// ---------------------------------------------------------------
export function buildRice(lod = 0) {
  const rng = new RNG(8000);
  if (lod === 1) {
    const mb = leafMB();
    crossedCards(mb, rng, ATLAS.grass, 0.55, 0.55, 2, [0.85, 1.15, 0.6], 0.05, -0.02);
    return { leaves: mb.build() };
  }
  const mb = stemMB();
  const ph = rng.float();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + rng.range(-0.4, 0.4);
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const sx = -dirz, sz = dirx;
    const h = rng.range(0.38, 0.55), lean = rng.range(0.15, 0.35), w = 0.014;
    const base = mb.count;
    for (let k = 0; k <= 2; k++) {
      const t = k / 2;
      const px = dirx * lean * t * t * h, pz = dirz * lean * t * t * h;
      const g = col(0.22, 0.45, 0.22 + 0.14 * t);
      mb.set('aWind', 0.05 * t * t, 0.01 * t, ph);
      mb.vertex(px - sx * w, t * h, pz - sz * w, 0, 1, 0, 0, t, g[0], g[1], g[2]);
      mb.vertex(px + sx * w, t * h, pz + sz * w, 0, 1, 0, 1, t, g[0], g[1], g[2]);
      if (k > 0) { const b = base + (k - 1) * 2; mb.quad(b, b + 2, b + 3, b + 1); }
    }
  }
  return { stem: mb.build() };
}

// ---------------------------------------------------------------
// 지피식물 종류 (GroundCover 가 플레이어 주변에 동적으로 배치) — 높이·폭 1 기준, 배치에서 크기 조절
// ---------------------------------------------------------------
export function buildGroundCoverSpecies() {
  const out = {};
  {
    const rng = new RNG(9100), mb = leafMB();
    flatCard(mb, rng, ATLAS.creeper, 0.5, 0.03, [0.95, 1, 0.92]);
    flatCard(mb, rng, ATLAS.creeper, 0.42, 0.05, [1.05, 1.08, 0.95]);
    out.creeper = mb.build();
  }
  {
    const rng = new RNG(9150), mb = leafMB();
    flatCard(mb, rng, ATLAS.moss, 0.5, 0.025, [1, 1, 1]);
    out.moss = mb.build();
  }
  {
    const rng = new RNG(9200), mb = leafMB();
    crossedCards(mb, rng, ATLAS.herb, 1.0, 1.0, 2, [1, 1, 0.96], 0.04);
    out.herb = mb.build();
  }
  {
    const rng = new RNG(9300), mb = leafMB();
    const n = 6, ph = rng.float();
    for (let i = 0; i < n; i++) {
      leafStrip(mb, {
        origin: V3(0, 0.02, 0), yaw: (i / n) * TAU + rng.range(-0.3, 0.3), pitch: rng.range(0.75, 1.15),
        length: rng.range(0.85, 1.1), width: 0.46, segs: 2, droop: rng.range(0.7, 1.0), region: ATLAS.fern,
        color: tint(rng, 1.05), fold: 0.05, taperBase: 0.3, onSeg: (t) => mb.set('aWind', 0.05 * t * t, 0.015 * t, ph),
      });
    }
    out.fern = mb.build();
  }
  {
    const rng = new RNG(9400), mb = leafMB();
    crossedCards(mb, rng, ATLAS.grass, 0.9, 1.0, 3, [1, 1.02, 0.94], 0.06);
    out.grassTuft = mb.build();
  }
  {
    const rng = new RNG(9500), mb = leafMB();
    crossedCards(mb, rng, ATLAS.seedling, 0.85, 1.0, 2, [1, 1, 0.95], 0.05);
    out.seedling = mb.build();
  }
  {
    const rng = new RNG(9600), mb = leafMB();
    crossedCards(mb, rng, ATLAS.grass, 0.7, 1.0, 3, [0.92, 1.0, 0.85], 0.08);
    crossedCards(mb, rng, ATLAS.reed, 0.5, 0.9, 1, [1, 1, 0.9], 0.08);
    out.bankGrass = mb.build();
  }
  return out;
}

// ---------------------------------------------------------------
// 굵은 리아나 (큰 나무 사이로 늘어진 덩굴) — 월드 좌표로 바로 만들어 청크별로 합침
// ---------------------------------------------------------------
export function buildLianas(list, seed = 77) {
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  const bark = barkMB(), leaves = leafMB();
  for (const L of list) {
    const pts = [];
    const n = 12;
    const midY = (L.ay + L.by) / 2;
    const sag = Math.max(0.5, midY - L.sagY);
    const side = V3(-(L.bz - L.az), 0, L.bx - L.ax).normalize();
    const wob = rng.range(0, 10);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = V3(L.ax + (L.bx - L.ax) * t, L.ay + (L.by - L.ay) * t - sag * 4 * t * (1 - t), L.az + (L.bz - L.az) * t);
      p.addScaledVector(side, noise.simplex(t * 3 + wob, 1) * 0.6 * Math.sin(Math.PI * t));
      pts.push(p);
    }
    tube(bark, pts, (t, a) => L.r * (1 + 0.15 * Math.sin(a * 2 + t * 20)), 4, () => [0.62, 0.56, 0.46], [1, 0.4], false,
      () => bark.set('aMoss', 0.35));
    // 매달린 잎
    for (let i = 2; i < n - 1; i++) {
      if (!rng.chance(0.45)) continue;
      const p = pts[i];
      leaves.set('aWind', 0.1, 0.03, rng.float());
      const k = rng.range(0.85, 1.05);
      leafCluster(leaves, p.clone().add(V3(0, -0.35, 0)), rng.range(0.3, 0.5), ATLAS.vine, [k, k, k], side, rng, 2, 1.5);
    }
  }
  return { bark: bark.count ? bark.build() : null, leaves: leaves.count ? leaves.build() : null };
}
