// 큰 나무(교목층) 지오메트리 — 판근 줄기 + 큰 가지 → 잔가지 → 잎 덩어리, 착생식물, 감고 오르는 덩굴
//  - 줄기: 높이·둘레 방향 노이즈로 울퉁불퉁한 단면, 밑동이 퍼짐 (격자 곡면, 법선은 격자에서 계산)
//  - 판근: 줄기에서 바깥으로 뻗는 두꺼운 날개 (단면이 둥근 판을 길이 방향으로 쓸어 만듦, 위로 가며 비틀림)
//    물리 데이터(TreeVariants.fins)와 같은 방향·길이·높이
//  - 수관: 큰 가지 끝마다 잎 덩어리 무리 (교차 카드 + 둥근 법선 → 부피감)
//  LOD 0(가까이) / 1(중간) / 2(멀리) 를 같은 형태로 만든다.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';
import { MeshBuilder, tube, leafCluster } from './MeshBuilder.js';
import { ATLAS } from './Textures.js';
import { BIG_TREE_VARIANTS, finRidge } from '../world/TreeVariants.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;
export const BARK_ATTRS = { aMoss: 1, aPeel: 1 };
export const LEAF_ATTRS = { aWind: 3 };

/**
 * 격자 곡면: rows × cols 정점, 법선은 이웃 정점의 중심 차분으로 계산.
 * fn(i, j, jj) → { p:[x,y,z], uv:[u,v], c:[r,g,b], moss } (jj: 이음매 복제 열 번호)
 * o.wrap: 열 방향이 닫힌 고리 (마지막 열은 첫 열 위치를 UV만 달리해 복제), o.flip: 법선·감김 반대
 */
export function addGrid(mb, rows, cols, fn, o = {}) {
  const nc = o.wrap ? cols + 1 : cols;
  const pts = [];
  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let jj = 0; jj < nc; jj++) row.push(fn(i, o.wrap ? jj % cols : jj, jj));
    pts.push(row);
  }
  const base = mb.count;
  const du = new THREE.Vector3(), dv = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < rows; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(rows - 1, i + 1);
    for (let jj = 0; jj < nc; jj++) {
      let j0, j1;
      if (o.wrap) { const j = jj % cols; j0 = (j - 1 + cols) % cols; j1 = (j + 1) % cols; } else { j0 = Math.max(0, jj - 1); j1 = Math.min(nc - 1, jj + 1); }
      const a = pts[i][j1].p, b = pts[i][j0].p;
      du.set(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const jc = o.wrap ? jj % cols : jj;
      const c = pts[i1][jc].p, d = pts[i0][jc].p;
      dv.set(c[0] - d[0], c[1] - d[1], c[2] - d[2]);
      if (o.flip) n.crossVectors(du, dv); else n.crossVectors(dv, du);
      if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize();
      const v = pts[i][jj];
      if (mb.state.aMoss) mb.set('aMoss', v.moss ?? 0);
      mb.vertex(v.p[0], v.p[1], v.p[2], n.x, n.y, n.z, v.uv[0], v.uv[1], v.c[0], v.c[1], v.c[2]);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < nc - 1; j++) {
      const a = base + i * nc + j, b = a + nc;
      if (o.flip) mb.quad(a, a + 1, b + 1, b); else mb.quad(a, b, b + 1, a + 1);
    }
  }
}

/** 변형별 나무 껍질 색조 (회백색 ~ 적갈색) */
function barkTone(rng, variant) {
  const tones = [[1.0, 0.96, 0.9], [0.86, 0.78, 0.7], [1.04, 1.0, 0.92], [0.92, 0.84, 0.74], [0.95, 0.92, 0.84]];
  const t = tones[variant % tones.length];
  const k = rng.range(0.94, 1.04);
  return [t[0] * k, t[1] * k, t[2] * k];
}

/**
 * @param {number} variantIndex  BIG_TREE_VARIANTS 번호
 * @param {number} lod  0, 1, 2
 * @returns {{bark: THREE.BufferGeometry, leaves: THREE.BufferGeometry}}
 */
export function buildBigTree(variantIndex, lod) {
  const V = BIG_TREE_VARIANTS[variantIndex];
  const rng = new RNG(1000 + variantIndex * 77);
  const noise = new Noise2D(55 + variantIndex);
  const H = V.height, R = V.trunkR;
  const bark = new MeshBuilder(BARK_ATTRS);
  const leaves = new MeshBuilder(LEAF_ATTRS);
  const tone = barkTone(rng, variantIndex);
  const crownY = H * V.crownBase;

  // ---- 줄기 중심선 (완만한 휨 + 작은 굴곡)
  const B = V.bend;
  const center = (y) => {
    const t = Math.max(0, y) / H;
    return [B.ax * Math.pow(t, 1.6) + Math.sin(y * 0.31 + B.phase) * B.wobble * t, B.az * Math.pow(t, 1.6) + Math.cos(y * 0.27 + B.phase) * B.wobble * t];
  };
  // 줄기 반지름 (밑동 퍼짐 + 위로 가늘어짐)
  const trunkR = (y) => {
    const t = Math.min(1, Math.max(0, y) / crownY);
    const flare = 1 + 0.5 * Math.exp(-Math.max(0, y) / 0.9) + 0.18 * Math.exp(-Math.max(0, y) / 3.5);
    return R * (1 - 0.34 * t) * (y < 0 ? 1.7 : flare);
  };

  // ---- 판근이 줄기 단면에 주는 영향 (판근 사이 오목한 홈 → 차폐 색)
  const finNear = (theta, y) => {
    let best = 0;
    for (const f of V.fins) {
      if (y > f.h * 1.15) continue;
      const a = f.a + f.curl * Math.min(1, Math.max(0, y) / f.h);
      const d = Math.abs(((theta - a) % TAU + TAU + Math.PI) % TAU - Math.PI);
      const w = Math.exp(-(((d * R) / 0.55) ** 2)) * (1 - Math.max(0, y) / (f.h * 1.15));
      best = Math.max(best, w);
    }
    return best;
  };

  // ---- 줄기 격자
  const ringsY = [];
  {
    const y0 = -1.4, yTop = crownY + (lod === 2 ? 1 : 2.5);
    const n = lod === 0 ? 22 : lod === 1 ? 10 : 4;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      ringsY.push(y0 + (yTop - y0) * (lod === 2 ? t : t * t * 0.55 + t * 0.45)); // 밑동 쪽을 촘촘하게
    }
  }
  const radial = lod === 0 ? 24 : lod === 1 ? 12 : 6;
  const circ = TAU * R * 1.3;
  const uRep = Math.max(1, Math.round(circ / 2.2));
  addGrid(bark, ringsY.length, radial, (i, j, jj) => {
    const y = ringsY[i];
    const th = (j / radial) * TAU;
    const [cx, cz] = center(y);
    let r = trunkR(y);
    if (lod < 2) {
      r *= 1 + 0.07 * noise.fbm(Math.cos(th) * 1.3 + 5, Math.sin(th) * 1.3 + y * 0.18, 3) + 0.025 * noise.simplex(th * 4, y * 1.5);
      // 아래쪽 세로 골 (판근으로 이어지는 주름)
      r *= 1 + 0.05 * Math.sin(th * 7 + noise.simplex(y * 0.2, 3) * 2) * Math.exp(-Math.max(0, y) / 4);
    }
    const fin = finNear(th, y);
    const ao = (0.55 + 0.45 * Math.min(1, Math.max(0, y + 0.3) / 2.2)) * (1 - 0.35 * fin);
    const moss = Math.min(1, Math.max(0, 1 - y / 2.6) * 0.75 + fin * 0.25 + Math.max(0, noise.simplex(th * 1.2, y * 0.15) - 0.35) * 0.9);
    return {
      p: [cx + Math.cos(th) * r, y, cz + Math.sin(th) * r],
      uv: [(jj / radial) * uRep, y / 4.2],
      c: [tone[0] * ao, tone[1] * ao, tone[2] * ao],
      moss,
    };
  }, { wrap: true });

  // ---- 판근 (LOD 0·1)
  if (lod < 2) {
    for (const f of V.fins) {
      const NS = lod === 0 ? 7 : 4;
      const side = lod === 0 ? 5 : 2;     // 한쪽 옆면 정점 수
      const arc = lod === 0 ? 3 : 1;      // 꼭대기 둥근 부분
      const loopN = side * 2 + arc;
      const wob = rng.range(0, 6);
      addGrid(bark, NS + 1, loopN, (i, j) => {
        const s = i / NS;
        const { r, y: ridge } = finRidge(f, R, s);
        const a = f.a + 0.06 * Math.sin(s * 3 + wob);
        const dx = Math.cos(a), dz = Math.sin(a);
        const sx = -dz, sz = dx;
        // 단면: 위 모서리는 둥글고 얇게, 아래로 갈수록 오목하게 넓어져 땅으로 이어짐 + 줄기 쪽은 크게 퍼져 줄기와 합쳐짐
        const top = f.thick * 0.5 * (1 - 0.35 * s) + 0.035;
        const fillet = R * 0.55 * Math.max(0, 0.32 - s) ** 2 / 0.1;
        const halfW = (y) => {
          const y01 = Math.min(1, Math.max(0, y / Math.max(0.15, ridge)));
          return top + (top * 1.9 + 0.05) * (1 - y01) * (1 - y01) + fillet * (1 - 0.5 * y01);
        };
        const yBot = -1.0;
        let lat, y, nrmSide;
        if (j < side) {
          const t = j / (side - 1 || 1);
          y = yBot + (ridge - yBot) * (1 - (1 - t) * (1 - t));
          lat = -halfW(y); nrmSide = -1;
        } else if (j < side + arc) {
          const t = (j - side + 1) / (arc + 1);
          const w = halfW(ridge);
          const ang = Math.PI * (1 - t);
          lat = Math.cos(ang) * w; y = ridge + Math.sin(ang) * w * 0.85; nrmSide = 0;
        } else {
          const t = (j - side - arc) / (side - 1 || 1);
          y = yBot + (ridge - yBot) * (1 - t * t);
          lat = halfW(y); nrmSide = 1;
        }
        // 위로 갈수록 비틀림 (curl) + 날개의 물결
        const yk = Math.max(0, y) / Math.max(0.3, f.h);
        const curlOff = f.curl * r * yk * 0.45 + 0.1 * Math.sin(s * 5 + wob) * f.thick + 0.04 * Math.sin(s * 11 + y * 3 + wob);
        const L = lat + curlOff;
        const [cx, cz] = center(Math.max(0, y));
        const px = cx + dx * r + sx * L, pz = cz + dz * r + sz * L;
        // 땅에 닿는 곳·줄기와 만나는 곳은 어둡게 (차폐)
        const ao = (0.42 + 0.58 * Math.min(1, Math.max(0, y + 0.1) / 1.5)) * (0.68 + 0.32 * Math.min(1, s * 3));
        const moss = Math.min(1, (nrmSide === 0 ? 0.32 : 0.08) + Math.max(0, 1 - y / 1.2) * 0.25);
        // u: 단면 둘레를 따라 잰 거리 (텍스처가 늘어나지 않게)
        const span = ridge - yBot;
        const u = nrmSide < 0 ? (y - yBot) : nrmSide > 0 ? 2 * span + 0.3 - (y - yBot) : span + 0.15 + lat * 0.5;
        return {
          p: [px, y, pz],
          uv: [r / 2.1, u / 4.2],   // 껍질 세로 갈라짐이 판근 옆면에서도 위아래로
          c: [tone[0] * ao, tone[1] * ao, tone[2] * ao],
          moss,
        };
      }, { flip: true });
    }
  }

  // ---- 큰 가지 → 잔가지, 잎 덩어리 무리 (수관)
  const top = (() => { const [x, z] = center(crownY); return V3(x, crownY, z); })();
  const clumps = [];
  const limbs = [];
  const nLimb = V.limbs;
  const yaw0 = rng.range(0, TAU);
  for (let k = 0; k < nLimb; k++) {
    const yaw = yaw0 + (k / nLimb) * TAU + rng.range(-0.3, 0.3);
    const el = rng.range(0.32, 0.95);
    const L = V.crownR * rng.range(0.6, 0.92);
    const oy = crownY + rng.range(-1.5, 2.5);
    const [ocx, ocz] = center(oy);
    const o = V3(ocx, oy, ocz);
    const dir = V3(Math.cos(yaw) * Math.cos(el), Math.sin(el), Math.sin(yaw) * Math.cos(el));
    const end = o.clone().add(dir.clone().multiplyScalar(L));
    end.y = Math.min(end.y, H * 0.95);
    const mid = o.clone().lerp(end, 0.5).add(V3(0, L * 0.12, 0));
    const pts = [o, o.clone().lerp(mid, 0.5), mid, mid.clone().lerp(end, 0.6).add(V3(0, L * 0.04, 0)), end];
    limbs.push({ pts, yaw, L, r0: R * rng.range(0.32, 0.42) });
    clumps.push({ c: end.clone().add(V3(0, V.crownR * 0.1, 0)), r: V.crownR * rng.range(0.32, 0.42) });
    // 가지 중간에도 잎 무리 (수관이 납작한 우산이 되지 않게)
    clumps.push({ c: sampleCurve(pts, rng.range(0.5, 0.7)).add(V3(0, V.crownR * 0.12, 0)), r: V.crownR * rng.range(0.2, 0.27) });
    // 잔가지
    const nb = lod === 2 ? 0 : rng.int(2, 3);
    for (let b = 0; b < nb; b++) {
      const t = rng.range(0.45, 0.85);
      const bp = sampleCurve(pts, t);
      const by = yaw + rng.sign() * rng.range(0.5, 1.0);
      const be = rng.range(0.2, 0.75);
      const bl = L * rng.range(0.35, 0.55);
      const bdir = V3(Math.cos(by) * Math.cos(be), Math.sin(be), Math.sin(by) * Math.cos(be));
      const bend = bp.clone().add(bdir.clone().multiplyScalar(bl));
      bend.y = Math.min(bend.y, H * 0.97);
      limbs.push({ pts: [bp, bp.clone().lerp(bend, 0.5).add(V3(0, bl * 0.08, 0)), bend], yaw: by, L: bl, r0: R * 0.14 });
      clumps.push({ c: bend.clone().add(V3(0, V.crownR * 0.06, 0)), r: V.crownR * rng.range(0.22, 0.3) });
    }
  }
  // 줄기 꼭대기 위 가운데 덩어리
  clumps.push({ c: V3(top.x, H * 0.9, top.z), r: V.crownR * 0.38 });

  if (lod < 2) {
    for (const l of limbs) {
      tube(bark, l.pts, (t) => l.r0 * (1 - 0.7 * t) + 0.04, lod === 0 ? 8 : 4, (t) => {
        const ao = 0.75 + 0.25 * t;
        return [tone[0] * ao, tone[1] * ao, tone[2] * ao];
      }, [1, 0.25], false, (t) => bark.set('aMoss', 0.25 * (1 - t)));
    }
    // 줄기 윗부분 (수관 속으로 이어짐)
    const lead = [top.clone(), V3(top.x, crownY + (H - crownY) * 0.5, top.z), V3(top.x, H * 0.88, top.z)];
    tube(bark, lead, (t) => trunkR(crownY) * (1 - 0.7 * t), lod === 0 ? 10 : 5, () => tone, [2, 0.25]);
  } else {
    for (const l of limbs) tube(bark, [l.pts[0], l.pts[4] || l.pts[l.pts.length - 1]], (t) => l.r0 * (1 - 0.6 * t), 3, () => tone, [1, 0.25]);
  }

  // ---- 잎 덩어리 (덩어리 무리마다 바깥쪽·위쪽에 몰리게)
  const crownC = V3(top.x, H * 0.84, top.z);
  const regions = variantIndex === 2 || variantIndex === 4 ? [ATLAS.clusterB, ATLAS.clusterA, ATLAS.clusterC] : [ATLAS.clusterA, ATLAS.clusterA, ATLAS.clusterC];
  const perArea = lod === 0 ? 2.7 : lod === 1 ? 1.2 : 0.42;
  const sizeK = lod === 0 ? 1 : lod === 1 ? 1.55 : 2.6;
  const hueShift = rng.range(-0.05, 0.05);
  for (const cl of clumps) {
    const n = Math.max(lod === 2 ? 2 : 4, Math.round(cl.r * cl.r * perArea));
    const tintK = rng.range(0.88, 1.1);
    const warm = rng.range(-0.05, 0.12) + hueShift;
    for (let i = 0; i < n; i++) {
      // 납작한 타원체 껍질 쪽, 위쪽 반구에 많이
      const u = rng.range(0, TAU);
      const v = Math.acos(rng.range(-0.35, 1));
      const shell = Math.pow(rng.float(), 0.35);
      const lp = V3(Math.cos(u) * Math.sin(v) * cl.r * shell, Math.cos(v) * cl.r * 0.78 * shell, Math.sin(u) * Math.sin(v) * cl.r * shell);
      const c = cl.c.clone().add(lp);
      const out = c.clone().sub(crownC).add(lp.clone().multiplyScalar(1.5));
      const size = rng.range(0.85, 1.25) * sizeK;
      const ao = 0.5 + 0.5 * Math.min(1, Math.max(0, (lp.y / (cl.r * 0.78) + 1) * 0.5 + (shell - 0.6)));
      const k = tintK * ao * rng.range(0.9, 1.08);
      const col = [k * (1 + warm), k, k * (1 - warm * 1.5)];
      const height01 = Math.min(1, c.y / H);
      leaves.set('aWind', 0.08 + 0.18 * height01 * (lod === 2 ? 0.5 : 1), 0.025, rng.float());
      const region = regions[i % 3 === 2 ? 2 : rng.int(0, 1)];
      leafCluster(leaves, c, size, region, col, out, rng, lod === 2 ? 2 : 3, 0.85);
    }
  }

  if (lod === 0) addTreeExtras(bark, leaves, rng, noise, V, limbs, trunkR, center, crownY, tone);
  return { bark: bark.build(), leaves: leaves.build() };
}

/** 착생식물·감고 오르는 덩굴·늘어진 덩굴 (가까운 LOD만) */
function addTreeExtras(bark, leaves, rng, noise, V, limbs, trunkR, center, crownY, tone) {
  // 착생 양치 (큰 가지가 갈라지는 곳, 줄기 중간)
  const spots = [];
  for (const l of limbs.slice(0, V.limbs)) if (rng.chance(0.65)) spots.push(sampleCurve(l.pts, rng.range(0.05, 0.3)));
  for (let k = 0; k < 2; k++) {
    const y = rng.range(4, crownY * 0.85), th = rng.range(0, TAU);
    const [cx, cz] = center(y);
    const r = trunkR(y);
    spots.push(V3(cx + Math.cos(th) * r, y, cz + Math.sin(th) * r));
  }
  for (const p of spots) {
    leaves.set('aWind', 0.05, 0.03, rng.float());
    const k = rng.range(0.85, 1.1);
    leafCluster(leaves, p.clone().add(V3(0, 0.3, 0)), rng.range(0.45, 0.75), ATLAS.epiphyte, [k, k, k * 0.95], V3(0, 1, 0), rng, 3, 1);
  }
  // 줄기를 감고 오르는 덩굴 (나선 + 잎)
  const vines = rng.int(1, 2);
  for (let v = 0; v < vines; v++) {
    const th0 = rng.range(0, TAU), turns = rng.range(0.6, 1.4) * (rng.chance(0.5) ? 1 : -1);
    const y1 = crownY * rng.range(0.6, 1.0);
    const pts = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = -0.2 + t * y1;
      const th = th0 + turns * TAU * t;
      const [cx, cz] = center(y);
      const r = trunkR(y) * (1 + 0.04) + 0.04;
      pts.push(V3(cx + Math.cos(th) * r, y, cz + Math.sin(th) * r));
    }
    tube(bark, pts, () => 0.035, 4, () => [0.55, 0.5, 0.42], [1, 0.5], false, () => bark.set('aMoss', 0.3));
    for (let i = 2; i < n; i++) {
      if (!rng.chance(0.8)) continue;
      const p = pts[i];
      const [cx, cz] = center(p.y);
      const out = V3(p.x - cx, 0, p.z - cz).normalize();
      leaves.set('aWind', 0.02, 0.03, rng.float());
      const k = rng.range(0.85, 1.1);
      leafCluster(leaves, p.clone().add(out.clone().multiplyScalar(0.25)), rng.range(0.32, 0.5), ATLAS.vine, [k, k, k], out, rng, 2, 1.4);
    }
  }
  // 늘어진 덩굴 (큰 가지에서 아래로)
  const hang = rng.int(2, 4);
  for (let h = 0; h < hang; h++) {
    const l = limbs[rng.int(0, limbs.length - 1)];
    const p0 = sampleCurve(l.pts, rng.range(0.4, 0.9));
    const len = rng.range(3, Math.min(12, p0.y - 1.5));
    if (len < 2) continue;
    const pts = [];
    const sw = rng.range(0, TAU);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(V3(p0.x + Math.sin(t * 3 + sw) * 0.25 * t, p0.y - t * len, p0.z + Math.cos(t * 2.5 + sw) * 0.25 * t));
    }
    tube(bark, pts, () => 0.025, 3, () => [0.5, 0.48, 0.4], [1, 0.5]);
    for (let i = 3; i <= 8; i += 2) {
      leaves.set('aWind', 0.12 * (i / 8), 0.04, rng.float());
      leafCluster(leaves, pts[i], rng.range(0.3, 0.45), ATLAS.vine, [1, 1, 1], V3(0, 0, 1), rng, 2, 1.6);
    }
  }
  void noise;
}

/** 꺾은선 위 t(0~1) 지점 */
function sampleCurve(pts, t) {
  const f = t * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return pts[i].clone().lerp(pts[i + 1], f - i);
}
