// 식생 지오메트리 (절차적). 각 함수는 LOD별 부품 지오메트리를 돌려준다.
// 부품 이름 = 머티리얼 키 (bark, crown, crownCards, palmLeaf, bananaLeaf, bambooLeaf, stem, fernLeaf, grass, shrubLeaf, rice)
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';
import { MeshBuilder, tube, leafStrip, card, srgb } from './MeshBuilder.js';
import { ATLAS } from './Textures.js';
import { BIG_TREE_VARIANTS } from '../world/TreeVariants.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// 텍스처가 있는 부품(잎·나무껍질)의 정점색은 텍스처에 곱해지는 '틴트' (1 근처)
const tint = (rng, k = 1, warm = 0) => {
  const v = rng.range(0.85, 1.12) * k;
  return [v * (1 + warm * 0.25 + rng.range(-0.04, 0.04)), v, v * (1 - warm * 0.4 + rng.range(-0.06, 0.04))];
};
const DEAD = [1.45, 1.05, 0.5];

// ---------------------------------------------------------------
// 큰 나무 (판근 + 굵은 줄기 + 우산형 수관 + 늘어진 덩굴)
// ---------------------------------------------------------------
export function buildBigTree(variantIndex, lod) {
  const V = BIG_TREE_VARIANTS[variantIndex];
  const rng = new RNG(1000 + variantIndex * 77);
  const noise = new Noise2D(55 + variantIndex);
  const H = V.height, R = V.trunkR;
  const bark = new MeshBuilder();
  const crown = new MeshBuilder();
  const cards = new MeshBuilder();
  const radial = lod === 0 ? 12 : 6;
  const barkCol = [1.0, 0.97, 0.9];
  const barkDark = [0.62, 0.6, 0.55];

  // 줄기: 약간 휘어짐
  const pts = [];
  const bend = [rng.range(-0.6, 0.6), rng.range(-0.6, 0.6)];
  const segs = lod === 0 ? 10 : 5;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(V3(bend[0] * Math.sin(t * Math.PI * 0.8), -0.4 + t * (H * V.crownBase + 1.5), bend[1] * Math.sin(t * Math.PI * 0.8)));
  }
  tube(bark, pts, (t) => R * (1 - 0.45 * t) * (t < 0.06 ? 1.25 - t * 4 : 1), radial,
    (t) => (t < 0.08 ? barkDark : barkCol), [2, 0.25]);

  // 판근: 줄기에서 바깥으로 퍼지는 얇은 판 (물리 데이터와 같은 각도·길이·높이)
  for (const f of V.fins) {
    const dir = V3(Math.cos(f.a), 0, Math.sin(f.a));
    const side = V3(-dir.z, 0, dir.x);
    const steps = lod === 0 ? 7 : 3;
    const thick = 0.16;
    const outer = [], inner = [];
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const r = R * 0.75 + (f.span + R * 0.25) * s;
      const y = f.h * Math.pow(1 - s, 1.8) + 0.05;
      outer.push({ r, y });
      inner.push({ r, y: -0.35 });
    }
    for (const sd of [-1, 1]) {
      const n = side.clone().multiplyScalar(sd);
      const base = bark.count;
      for (let i = 0; i <= steps; i++) {
        const o = outer[i], b = inner[i];
        const off = (thick / 2) * (1 - (i / steps) * 0.5) * sd;
        const c = barkDark;
        bark.vertex(dir.x * o.r + side.x * off, o.y, dir.z * o.r + side.z * off, n.x, n.y, n.z, i / steps, o.y * 0.25, c[0], c[1], c[2]);
        bark.vertex(dir.x * b.r + side.x * off, b.y, dir.z * b.r + side.z * off, n.x, n.y, n.z, i / steps, 0, c[0], c[1], c[2]);
      }
      for (let i = 0; i < steps; i++) {
        const a = base + i * 2;
        if (sd > 0) bark.quad(a, a + 1, a + 3, a + 2); else bark.quad(a, a + 2, a + 3, a + 1);
      }
    }
    // 위 모서리
    const base = bark.count;
    for (let i = 0; i <= steps; i++) {
      const o = outer[i];
      const off = (thick / 2) * (1 - (i / steps) * 0.5);
      const c = barkCol;
      bark.vertex(dir.x * o.r - side.x * off, o.y, dir.z * o.r - side.z * off, 0, 1, 0, 0, i / steps, c[0], c[1], c[2]);
      bark.vertex(dir.x * o.r + side.x * off, o.y, dir.z * o.r + side.z * off, 0, 1, 0, 1, i / steps, c[0], c[1], c[2]);
    }
    for (let i = 0; i < steps; i++) { const a = base + i * 2; bark.quad(a, a + 2, a + 3, a + 1); }
  }

  // 큰 가지 + 수관 덩어리 (불규칙한 여러 덩어리)
  const top = pts[pts.length - 1];
  const crownY = H * V.crownBase;
  const blobs = [{ x: top.x, y: H * 0.94, z: top.z, r: V.crownR * 0.42 }];
  const nb = lod === 0 ? 10 : 6;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const d = V.crownR * rng.range(0.4, 0.75);
    blobs.push({ x: top.x + Math.cos(a) * d, y: H * rng.range(0.8, 0.97), z: top.z + Math.sin(a) * d, r: V.crownR * rng.range(0.28, 0.42) });
  }
  const limbs = blobs.slice(1).filter((_, i) => i % 2 === 0);
  for (const b of limbs) {
    const p0 = V3(top.x, crownY - 1, top.z);
    const p1 = V3((top.x + b.x) / 2, (crownY + b.y) / 2 + 1, (top.z + b.z) / 2);
    const p2 = V3(b.x, b.y - b.r * 0.2, b.z);
    tube(bark, [p0, p1, p2], (t) => R * 0.4 * (1 - 0.65 * t), lod === 0 ? 6 : 4, () => barkCol, [1, 0.3]);
  }
  // 늘어진 덩굴 (리아나) — 구불구불하게
  if (lod === 0) {
    const vineCol = [0.55, 0.65, 0.42];
    for (let i = 0; i < 2; i++) {
      const b = blobs[1 + i * 3];
      const x0 = b.x * 0.75, z0 = b.z * 0.75;
      const vp = [];
      const n = 12;
      const bottom = rng.range(0.5, 6);
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const sw = Math.sin(t * Math.PI) * 1.4;
        vp.push(V3(x0 + Math.sin(t * 7 + i) * sw * 0.6, b.y - 1 - t * (b.y - 1 - bottom), z0 + Math.cos(t * 5 + i * 2) * sw * 0.6));
      }
      tube(bark, vp, () => 0.035, 4, () => vineCol, [1, 0.5]);
    }
  }

  // 잎 카드가 겉을 덮으므로 핵은 저폴리로 충분
  const ico = new THREE.IcosahedronGeometry(1, lod === 0 ? 1 : 0);
  for (const b of blobs) {
    const hue = rng.range(-0.04, 0.04);
    // 덩어리는 작게(속이 꽉 찬 어두운 핵), 겉은 잎 카드가 덮음
    const m = new THREE.Matrix4().compose(V3(b.x, b.y, b.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, 6), 0)), V3(b.r * 0.78, b.r * 0.45, b.r * 0.78));
    crown.addGeometry(ico, m, (local, world) => {
      const n = noise.fbm(world.x * 0.3, world.z * 0.3 + world.y * 0.2, 2);
      const lum = 0.35 + 0.65 * Math.max(0, local.y) + n * 0.25;
      const c = new THREE.Color().setHSL(0.26 + hue + n * 0.03, 0.36, 0.07 + 0.08 * lum);
      return [c.r, c.g, c.b];
    });
  }
  // 수관 정점 흔들림 (덩어리 모양을 울퉁불퉁하게)
  {
    const p = crown.pos;
    for (let i = 0; i < p.length; i += 3) {
      const n = noise.fbm(p[i] * 0.4, p[i + 2] * 0.4 + p[i + 1] * 0.3, 3);
      p[i] += n * 1.1; p[i + 1] += n * 1.2; p[i + 2] -= n * 0.9;
    }
  }
  // 수관 바깥·아래쪽 잎 카드 (실루엣과 올려다본 모습을 잎 질감으로)
  {
    const regs = [ATLAS.shrub, ATLAS.bamboo, ATLAS.shrub];
    const nCards = lod === 0 ? 150 : 60;
    for (let i = 0; i < nCards; i++) {
      const b = blobs[rng.int(0, blobs.length - 1)];
      const a = rng.range(0, Math.PI * 2), e = rng.range(-1.2, 0.5);
      const nrm = V3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
      const c = V3(b.x + nrm.x * b.r * 0.9, b.y + nrm.y * b.r * 0.5, b.z + nrm.z * b.r * 0.9);
      const size = rng.range(1.5, 2.6) * (lod === 0 ? 1 : 1.45);
      const right = V3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(size);
      const up = e < -0.5
        ? V3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(size * 0.9)          // 아래쪽: 수평에 가까운 카드
        : V3(0, 1, 0).multiplyScalar(size * 0.8).add(nrm.clone().multiplyScalar(0.5));
      card(cards, c, right, up, regs[i % 3], tint(rng, 0.7), nrm);
    }
  }
  return { bark: bark.build(), crown: crown.build(), crownCards: cards.build() };
}

// ---------------------------------------------------------------
// 야자수
// ---------------------------------------------------------------
export function buildPalm(variant, lod) {
  const rng = new RNG(2000 + variant * 31);
  const H = 8;
  const bark = new MeshBuilder();
  const leaves = new MeshBuilder();
  const lean = V3(rng.range(0.6, 1.2), 0, rng.range(-0.3, 0.3));
  const pts = [];
  const segs = lod === 0 ? 8 : 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(V3(lean.x * t * t, -0.3 + t * (H + 0.3), lean.z * t * t));
  }
  const ring = [0.95, 0.92, 0.86], ringDark = [0.7, 0.68, 0.62];
  tube(bark, pts, (t) => 0.19 - 0.06 * t, lod === 0 ? 8 : 5, (t) => (Math.floor(t * 40) % 2 ? ring : ringDark), [1, 0.6]);
  const top = pts[pts.length - 1];
  // 열매
  if (lod === 0) {
    const nut = new THREE.IcosahedronGeometry(0.11, 0);
    for (let i = 0; i < 6; i++) {
      const a = rng.range(0, 6.28);
      const m = new THREE.Matrix4().makeTranslation(top.x + Math.cos(a) * 0.2, top.y - 0.25 - rng.range(0, 0.15), top.z + Math.sin(a) * 0.2);
      bark.addGeometry(nut, m, () => [0.8, 0.62, 0.35]);
    }
  }
  const n = lod === 0 ? 14 : 8;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const dead = i % 5 === 4;
    const pitch = dead ? -1.1 : rng.range(0.15, 0.85);
    const col = dead ? DEAD : tint(rng, 1.05);
    leafStrip(leaves, {
      origin: top.clone(), yaw, pitch, length: rng.range(3.4, 4.6), width: 1.1, segs: lod === 0 ? 6 : 3,
      droop: dead ? 0.1 : rng.range(0.55, 0.85), region: ATLAS.palm, color: col, fold: 0.18,
    });
  }
  return { bark: bark.build(), palmLeaf: leaves.build() };
}

// ---------------------------------------------------------------
// 바나나 나무
// ---------------------------------------------------------------
export function buildBanana(variant, lod) {
  const rng = new RNG(3000 + variant * 17);
  const H = 2.6;
  const stem = new MeshBuilder();
  const leaves = new MeshBuilder();
  const stemCol = srgb('#6f7a4c'), stemDark = srgb('#4f4a32');
  tube(stem, [V3(0, -0.2, 0), V3(0.03, H * 0.5, 0), V3(0.05, H, 0.02)], (t) => 0.13 - 0.04 * t, lod === 0 ? 7 : 5,
    (t) => (t < 0.2 ? stemDark : stemCol), [1, 0.5]);
  const n = lod === 0 ? 8 : 5;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const old = i % 4 === 3;
    const c = old ? DEAD : tint(rng, 1.1);
    leafStrip(leaves, {
      origin: V3(0.05, H - rng.range(0, 0.35), 0.02), yaw, pitch: old ? -0.7 : rng.range(0.25, 0.75), length: rng.range(1.7, 2.3), width: 0.7,
      segs: lod === 0 ? 5 : 3, droop: old ? 0.25 : rng.range(0.35, 0.6), region: ATLAS.banana, color: c, fold: 0.06, taperBase: 0.12,
    });
  }
  return { stem: stem.build(), bananaLeaf: leaves.build() };
}

// ---------------------------------------------------------------
// 대나무 군락 (반경 1m, 높이 12m 기준)
// ---------------------------------------------------------------
export function buildBamboo(variant, lod) {
  const rng = new RNG(4000 + variant * 13);
  const H = 12;
  const stem = new MeshBuilder();
  const leaves = new MeshBuilder();
  const culms = lod === 0 ? 24 : 11;
  for (let i = 0; i < culms; i++) {
    const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.float()) * 0.85;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const out = rng.range(0.08, 0.3) + d * 0.25;
    const h = H * rng.range(0.7, 1.05);
    const pts = [];
    const segs = lod === 0 ? 6 : 3;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const o = out * h * t * t * 0.5;
      pts.push(V3(bx + Math.cos(a) * o, -0.2 + t * h, bz + Math.sin(a) * o));
    }
    const r = rng.range(0.035, 0.065);
    const green = new THREE.Color().setHSL(0.19 + rng.range(-0.03, 0.03), 0.35, rng.range(0.28, 0.4));
    const node = new THREE.Color().setHSL(0.13, 0.3, 0.22);
    tube(stem, pts, (t) => r * (1 - 0.4 * t), lod === 0 ? 5 : 4,
      (t) => (Math.abs(((t * h) % 0.45) - 0.02) < 0.03 ? [node.r, node.g, node.b] : [green.r, green.g, green.b]), [1, 1]);
    // 잎 뭉치 (위쪽 절반)
    const sprays = lod === 0 ? 7 : 3;
    for (let k = 0; k < sprays; k++) {
      const t = rng.range(0.45, 1.0);
      const idx = Math.min(pts.length - 1, Math.round(t * segs));
      const p = pts[idx];
      const ya = rng.range(0, Math.PI * 2);
      const right = V3(Math.cos(ya), 0, Math.sin(ya)).multiplyScalar(rng.range(0.5, 0.8));
      const up = V3(Math.cos(ya + 1.57) * 0.3, rng.range(0.6, 0.9), Math.sin(ya + 1.57) * 0.3);
      card(leaves, p.clone().add(V3(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4)), right, up, ATLAS.bamboo, tint(rng, 1.05, 0.2));
    }
  }
  return { stem: stem.build(), bambooLeaf: leaves.build() };
}

// ---------------------------------------------------------------
// 어린 나무 (높이 5m 기준) — 가는 줄기 + 층층이 펼친 잎 뭉치
// ---------------------------------------------------------------
export function buildSapling(variant, lod) {
  const rng = new RNG(4500 + variant * 23);
  const H = 5;
  const bark = new MeshBuilder();
  const leaves = new MeshBuilder();
  const pts = [];
  const lean = [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)];
  const segs = lod === 0 ? 5 : 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(V3(lean[0] * t * t + Math.sin(t * 4 + variant) * 0.08, -0.2 + t * H, lean[1] * t * t));
  }
  const col = [0.95, 0.9, 0.82];
  tube(bark, pts, (t) => 0.065 * (1 - 0.6 * t), lod === 0 ? 5 : 3, () => col, [1, 0.5]);
  const n = lod === 0 ? 11 : 5;
  for (let i = 0; i < n; i++) {
    const t = rng.range(0.42, 1.0);
    const p = pts[Math.min(pts.length - 1, Math.round(t * segs))].clone();
    p.y = -0.2 + t * H;
    const a = rng.range(0, Math.PI * 2);
    const reach = rng.range(0.4, 1.0) * (1.2 - t * 0.5);
    const c = p.clone().add(V3(Math.cos(a) * reach, 0, Math.sin(a) * reach));
    const size = rng.range(0.8, 1.25) * (1.15 - t * 0.35);
    const flat = rng.chance(0.6);
    const right = V3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(size);
    const up = flat ? V3(Math.cos(a), rng.range(0.1, 0.35), Math.sin(a)).multiplyScalar(size) : V3(0, size * 0.8, 0);
    card(leaves, c, right, up, i % 3 === 2 ? ATLAS.vine : ATLAS.shrub, tint(rng, 1.1));
  }
  return { bark: bark.build(), saplingLeaf: leaves.build() };
}

// ---------------------------------------------------------------
// 고사리 (높이 1m 기준)
// ---------------------------------------------------------------
export function buildFern(variant) {
  const rng = new RNG(5000 + variant * 7);
  const mb = new MeshBuilder();
  const n = rng.int(7, 11);
  for (let i = 0; i < n; i++) {
    const c = tint(rng, 1.1);
    leafStrip(mb, {
      origin: V3(0, 0.02, 0), yaw: (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3), pitch: rng.range(0.7, 1.15),
      length: rng.range(0.85, 1.15), width: 0.42, segs: 3, droop: rng.range(0.7, 1.0), region: ATLAS.fern,
      color: c, fold: 0.05, taperBase: 0.3,
    });
  }
  return { fernLeaf: mb.build() };
}

// ---------------------------------------------------------------
// 코끼리풀 (높이 2m 기준) — 가까이: 잎 지오메트리 / 멀리: 교차 카드
// ---------------------------------------------------------------
export function buildElephantGrass(variant, lod) {
  const rng = new RNG(6000 + variant * 11);
  const mb = new MeshBuilder();
  if (lod === 1) {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      const right = V3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.75);
      const c = [1.05, 1.05, 0.95];
      card(mb, V3(0, 1.0, 0), right, V3(0, 1.0, 0), ATLAS.grass, c);
    }
    return { grassCard: mb.build() };
  }
  const blades = 16;
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, Math.PI * 2);
    const ox = Math.cos(a) * rng.range(0, 0.25), oz = Math.sin(a) * rng.range(0, 0.25);
    const h = rng.range(1.4, 2.1), lean = rng.range(0.15, 0.6), w = rng.range(0.03, 0.05);
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
      const g = new THREE.Color().setHSL(0.2 - (tipDry ? 0.05 : 0) * t, 0.36, 0.1 + 0.07 * t);
      mb.vertex(px - sx * ww, py, pz - sz * ww, dirx * 0.3, 0.9, dirz * 0.3, 0, t, g.r, g.g, g.b);
      mb.vertex(px + sx * ww, py, pz + sz * ww, dirx * 0.3, 0.9, dirz * 0.3, 1, t, g.r, g.g, g.b);
      if (k > 0) { const b = base + (k - 1) * 2; mb.quad(b, b + 2, b + 3, b + 1); }
    }
  }
  return { grass: mb.build() };
}

// ---------------------------------------------------------------
// 덩굴·덤불 (높이 1.4m 기준)
// ---------------------------------------------------------------
export function buildShrub(variant) {
  const rng = new RNG(7000 + variant * 19);
  const mb = new MeshBuilder();
  const n = 13;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2), e = rng.range(0.1, 1.2);
    const r = 0.65;
    const nrm = V3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
    const c = V3(nrm.x * r, 0.55 + nrm.y * 0.7, nrm.z * r);
    const right = V3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(rng.range(0.45, 0.6));
    const up = V3(0, rng.range(0.4, 0.55), 0).add(nrm.clone().multiplyScalar(0.15));
    card(mb, c, right, up, ATLAS.shrub, tint(rng, 1.1), nrm);
  }
  // 늘어진 덩굴 카드
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    const right = V3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.3);
    card(mb, V3(Math.cos(a) * 0.6, 0.75, Math.sin(a) * 0.6), right, V3(0, 0.7, 0), ATLAS.vine, tint(rng, 1.0));
  }
  return { shrubLeaf: mb.build() };
}

// ---------------------------------------------------------------
// 모 (높이 0.5m 기준)
// ---------------------------------------------------------------
export function buildRice() {
  const rng = new RNG(8000);
  const mb = new MeshBuilder();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const dirx = Math.cos(a), dirz = Math.sin(a);
    const sx = -dirz, sz = dirx;
    const h = rng.range(0.38, 0.55), lean = rng.range(0.15, 0.35), w = 0.014;
    const base = mb.count;
    for (let k = 0; k <= 2; k++) {
      const t = k / 2;
      const px = dirx * lean * t * t * h, pz = dirz * lean * t * t * h;
      const g = new THREE.Color().setHSL(0.21, 0.36, 0.15 + 0.1 * t);
      mb.vertex(px - sx * w, t * h, pz - sz * w, 0, 1, 0, 0, t, g.r, g.g, g.b);
      mb.vertex(px + sx * w, t * h, pz + sz * w, 0, 1, 0, 1, t, g.r, g.g, g.b);
      if (k > 0) { const b = base + (k - 1) * 2; mb.quad(b, b + 2, b + 3, b + 1); }
    }
  }
  return { rice: mb.build() };
}

// ---------------------------------------------------------------
// 장애물: 통나무·뿌리 (X축 길이 1, 반경 1), 바위
// ---------------------------------------------------------------
export function buildLog(variant, lod = 0) {
  const rng = new RNG(9000 + variant);
  const noise = new Noise2D(9100 + variant);
  const mb = new MeshBuilder();
  const radial = lod === 0 ? 10 : 6;
  const segs = lod === 0 ? 8 : 3;
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(V3(-0.5 + i / segs, 0, 0));
  const moss = [0.6, 0.78, 0.42], wood = [0.9, 0.82, 0.72], dark = [0.55, 0.5, 0.44];
  tube(mb, pts, (t) => 1 + 0.08 * noise.simplex(t * 6, variant), radial,
    (t, a) => {
      const up = Math.sin(a + Math.PI / 2);
      return up > 0.4 ? moss : (t < 0.03 || t > 0.97) ? dark : wood;
    }, [1, 4]);
  // 마구리 (나이테 색)
  for (const end of [-0.5, 0.5]) {
    const c = [1.3, 1.1, 0.8];
    const ctr = mb.vertex(end, 0, 0, Math.sign(end), 0, 0, 0.5, 0.5, c[0], c[1], c[2]);
    const base = mb.count;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      mb.vertex(end, Math.cos(a) * 0.95, Math.sin(a) * 0.95, Math.sign(end), 0, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8);
    }
    for (let k = 0; k < radial; k++) {
      if (end > 0) mb.tri(ctr, base + k, base + k + 1); else mb.tri(ctr, base + k + 1, base + k);
    }
  }
  void rng;
  return mb.build();
}

export function buildRock(variant, lod = 0) {
  const noise = new Noise2D(9500 + variant * 3);
  const ico = new THREE.IcosahedronGeometry(1, lod === 0 ? 3 : 1);
  const mb = new MeshBuilder();
  const m = new THREE.Matrix4();
  mb.addGeometry(ico, m, (local) => {
    const moss = Math.max(0, local.y) > 0.45;
    return moss ? [0.75, 0.95, 0.55] : [1, 1, 0.95];
  });
  // 정점 변위 (각진 바위)
  const p = mb.pos;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const n = 1 + 0.18 * noise.fbm(x * 1.4 + variant, z * 1.4 + y, 3) + 0.06 * noise.simplex(x * 5, y * 5 + z);
    p[i] = x * n; p[i + 1] = y * n; p[i + 2] = z * n;
  }
  const g = mb.build();
  g.computeVertexNormals();
  // UV: 구면 매핑
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const x = g.attributes.position.getX(i), y = g.attributes.position.getY(i), z = g.attributes.position.getZ(i);
    uv.setXY(i, Math.atan2(z, x) / Math.PI + 1, y * 0.8);
  }
  return g;
}
