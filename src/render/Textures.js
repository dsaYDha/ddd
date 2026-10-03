// 절차적 텍스처 (캔버스·픽셀 계산) — 외부 이미지 파일 없음.
// 나중에 실제 에셋으로 바꿀 때는 이 파일의 함수만 이미지 로더로 교체하면 된다.
//  - 지면: 낙엽, 흙길, 진흙, 지피식물(원거리 바닥), 드러난 흙(사면), 지면 미세 법선
//  - 나무껍질 색 + 법선 (세로 갈라짐·지의류 얼룩), 바위 색 + 법선, 목재(벗겨진 통나무)
//  - 잎 아틀라스 2048×1024 (잎 덩어리·고사리·야자·바나나·토란·덩굴·갈대·지피식물 등)
//  - 햇빛 얼룩(캐노피 틈) 패턴
import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(c, { repeat = true, srgb = true, anisotropy = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** RGBA 바이트 → 텍스처 (행 0 = v 0, 즉 아래쪽) */
function dataTexture(rgba, w, h, { srgb = true, repeat = true, anisotropy = 4 } = {}) {
  const t = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------
// 주기적(타일링) 그래디언트 노이즈 — 격자 좌표를 주기로 감아 이음매가 없다
// ---------------------------------------------------------------
class TileNoise {
  constructor(seed) {
    const rng = new RNG(seed);
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rng.float() * Math.PI * 2;
      this.gx[i] = Math.cos(a); this.gy[i] = Math.sin(a);
    }
    this.salt = seed;
  }

  /** x∈[0,px), y∈[0,py) 에서 주기적, 대략 [-1,1] */
  noise(x, y, px, py) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
    const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const s = this.salt, GX = this.gx, GY = this.gy;
    const h00 = hash2(x0 * 7919 + y0, s) & 255, h10 = hash2(x1 * 7919 + y0, s) & 255;
    const h01 = hash2(x0 * 7919 + y1, s) & 255, h11 = hash2(x1 * 7919 + y1, s) & 255;
    const n00 = GX[h00] * fx + GY[h00] * fy;
    const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
    const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
    const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.45;
  }

  /** u,v ∈ [0,1) 텍스처 좌표, cx,cy = 기본 격자 수 (정수) */
  fbm(u, v, cx, cy, oct = 4, gain = 0.5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) {
      s += a * this.noise(u * cx * f, v * cy * f, cx * f, cy * f);
      n += a; a *= gain; f *= 2;
    }
    return s / n;
  }
}

/** 높이장 → 접선 공간 법선 맵 (주기 경계, 행 0 = v 0) */
function normalFromHeight(h, W, H, strength) {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const ym = ((y - 1 + H) % H) * W, yp = ((y + 1) % H) * W, yr = y * W;
    for (let x = 0; x < W; x++) {
      const xm = (x - 1 + W) % W, xp = (x + 1) % W;
      const dx = (h[yr + xp] - h[yr + xm]) * strength;
      const dy = (h[yp + x] - h[ym + x]) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (yr + x) * 4;
      out[o] = clamp255((-dx * inv * 0.5 + 0.5) * 255);
      out[o + 1] = clamp255((-dy * inv * 0.5 + 0.5) * 255);
      out[o + 2] = clamp255((inv * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** sRGB 바이트 색 버퍼 */
function rgbaBuffer(W, H) { return new Uint8Array(W * H * 4); }
function put(buf, i, r, g, b, a = 255) {
  buf[i * 4] = clamp255(r); buf[i * 4 + 1] = clamp255(g); buf[i * 4 + 2] = clamp255(b); buf[i * 4 + 3] = a;
}

/** 이음매 없는 노이즈 필드 (캔버스 지면 텍스처 바탕색용) */
function tileField(seed, S, cells, oct) {
  const tn = new TileNoise(seed);
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = tn.fbm(x / S, y / S, cells, cells, oct);
  return out;
}

function fillNoise(ctx, size, base, noiseArr, amp) {
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const n = noiseArr[i] * amp;
    img.data[i * 4] = clamp255(base[0] + n * 255);
    img.data[i * 4 + 1] = clamp255(base[1] + n * 255);
    img.data[i * 4 + 2] = clamp255(base[2] + n * 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 타일 경계를 넘는 도형을 반대편에도 그려 이음매 제거 */
function wrapDraw(size, x, y, r, draw) {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox, py = y + oy;
      if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
      draw(px, py);
    }
  }
}

// ---------------------------------------------------------------
// 잎 그리기 도구
// ---------------------------------------------------------------
/** 잎 윤곽: 기부(0,0) → 끝(len,0) */
function leafPath(ctx, len, wid, shape = 'ellipse') {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  if (shape === 'lance') {
    ctx.bezierCurveTo(len * 0.2, -wid * 0.9, len * 0.6, -wid * 0.75, len, 0);
    ctx.bezierCurveTo(len * 0.6, wid * 0.75, len * 0.2, wid * 0.9, 0, 0);
  } else if (shape === 'round') {
    ctx.bezierCurveTo(len * 0.05, -wid * 1.15, len * 0.85, -wid * 1.1, len, 0);
    ctx.bezierCurveTo(len * 0.85, wid * 1.1, len * 0.05, wid * 1.15, 0, 0);
  } else if (shape === 'heart') {
    ctx.bezierCurveTo(-len * 0.12, -wid * 1.05, len * 0.62, -wid * 1.05, len, 0);
    ctx.bezierCurveTo(len * 0.62, wid * 1.05, -len * 0.12, wid * 1.05, 0, 0);
  } else {
    ctx.bezierCurveTo(len * 0.18, -wid * 1.02, len * 0.72, -wid * 0.95, len, 0);
    ctx.bezierCurveTo(len * 0.72, wid * 0.95, len * 0.18, wid * 1.02, 0, 0);
  }
  ctx.closePath();
}

/**
 * 잎 한 장: 잎맥 쪽이 밝고 가장자리가 어두운 그라데이션 + 주맥·곁맥 + 가끔 벌레 먹은 구멍
 * @param {object} c  { h, s, l } 기본 색 (HSL)
 */
function drawLeaf(ctx, rng, x, y, ang, len, wid, c, o = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const h = c.h, s = c.s, l = c.l;
  const g = ctx.createLinearGradient(0, -wid, 0, wid);
  g.addColorStop(0, hsl(h - 2, s, l * 0.74));
  g.addColorStop(0.42, hsl(h + 3, s + 4, l * 1.1));
  g.addColorStop(0.58, hsl(h + 3, s + 2, l * 1.02));
  g.addColorStop(1, hsl(h - 2, s, l * 0.66));
  ctx.fillStyle = g;
  leafPath(ctx, len, wid, o.shape);
  ctx.fill();
  if (o.edge) {
    ctx.strokeStyle = hsl(h - 25, s * 0.8, l * 0.8, 0.5);
    ctx.lineWidth = Math.max(0.6, wid * 0.12);
    ctx.stroke();
  }
  // 주맥
  ctx.strokeStyle = hsl(h + 10, Math.max(5, s - 12), Math.min(80, l * 1.45), 0.55);
  ctx.lineWidth = Math.max(0.5, wid * 0.09);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len * 0.93, 0); ctx.stroke();
  // 곁맥
  if (len > 16 && o.veins !== false) {
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = Math.max(0.4, wid * 0.045);
    const n = Math.max(3, Math.round(len / 9));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const w = wid * Math.sin(Math.PI * Math.min(1, 0.15 + t)) * 0.85;
      ctx.beginPath();
      ctx.moveTo(len * t, 0); ctx.quadraticCurveTo(len * (t + 0.05), -w * 0.6, len * (t + 0.12), -w);
      ctx.moveTo(len * t, 0); ctx.quadraticCurveTo(len * (t + 0.05), w * 0.6, len * (t + 0.12), w);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // 손상 (구멍·갈변)
  if (o.damage && rng.chance(o.damage)) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(len * rng.range(0.35, 0.8), rng.range(-wid * 0.45, wid * 0.45), wid * rng.range(0.12, 0.3), 0, 6.28);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  if (o.brown && rng.chance(o.brown)) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = hsl(rng.range(25, 40), 40, rng.range(25, 38), 0.75);
    ctx.beginPath(); ctx.arc(len, 0, len * rng.range(0.25, 0.5), 0, 6.28); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

const leafColor = (rng, base) => {
  const t = rng.float();
  // 대부분 짙은 녹색, 일부 연두(새 잎)·노란빛·올리브
  if (t < 0.06) return { h: rng.range(48, 60), s: rng.range(35, 50), l: rng.range(30, 40) };
  if (t < 0.16) return { h: base.h + rng.range(-6, 10), s: base.s + 8, l: base.l * rng.range(1.15, 1.35) };
  return { h: base.h + rng.range(-8, 8), s: base.s + rng.range(-6, 6), l: base.l * rng.range(0.8, 1.12) };
};

/** 가지에 잎이 달린 덩어리 (수관·덤불·어린 나무용) */
function drawTwigCluster(ctx, rng, R, o) {
  ctx.save();
  ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
  const cx = R.x + R.w / 2, by = R.y + R.h * 0.93;
  const twigs = [];
  // 주 가지: 아래 가운데 → 위
  const grow = (x, y, ang, len, w, depth) => {
    const pts = [[x, y]];
    let a = ang;
    const n = 6;
    for (let k = 1; k <= n; k++) {
      a += rng.range(-0.12, 0.12);
      x += Math.cos(a) * (len / n); y += Math.sin(a) * (len / n);
      pts.push([x, y]);
    }
    twigs.push({ pts, w, depth });
    if (depth < o.depth) {
      const kids = rng.int(o.kids[0], o.kids[1]);
      for (let k = 0; k < kids; k++) {
        const t = rng.range(0.25, 0.85);
        const p = pts[Math.round(t * n)];
        const side = k % 2 ? 1 : -1;
        grow(p[0], p[1], ang + side * rng.range(0.45, 0.95), len * rng.range(0.45, 0.7), w * 0.62, depth + 1);
      }
    }
  };
  // 부채꼴로 퍼지는 가지 (아래 가운데 한 점에서) → 카드 위쪽 80%가 잎으로 둥글게 차도록
  const fan = o.fan ?? 6;
  for (let i = 0; i < fan; i++) {
    const f = fan > 1 ? i / (fan - 1) - 0.5 : 0;
    const a = -Math.PI / 2 + f * (o.spread ?? 2.5) + rng.range(-0.12, 0.12);
    const len = R.h * o.reach * rng.range(0.8, 1.0) * (1 - 0.3 * Math.abs(f) * 2);
    grow(cx + rng.range(-R.w * 0.03, R.w * 0.03), by, a, len, o.twigW * (1 - 0.3 * Math.abs(f)), 0);
  }
  // 가지 그리기
  ctx.lineCap = 'round';
  for (const t of twigs) {
    ctx.strokeStyle = hsl(o.twigHue ?? 35, 22, 22 + t.depth * 4);
    ctx.lineWidth = t.w;
    ctx.beginPath();
    ctx.moveTo(t.pts[0][0], t.pts[0][1]);
    for (const p of t.pts) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }
  // 잎: 가지를 따라 번갈아, 끝으로 갈수록 작게 (아래쪽부터 그려 위가 덮음)
  const leaves = [];
  for (const t of twigs) {
    const n = t.pts.length - 1;
    const per = o.leavesPerTwig;
    for (let k = 0; k < per; k++) {
      const f = (k + 0.5) / per;
      if (t.depth === 0 && f < 0.12) continue;
      const i = Math.min(n - 1, Math.floor(f * n));
      const p0 = t.pts[i], p1 = t.pts[i + 1];
      const along = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const side = k % 2 ? 1 : -1;
      const a = along + side * rng.range(0.55, 1.15);
      const L = o.leafLen * rng.range(0.75, 1.15) * (1 - f * 0.3);
      leaves.push({ x: p0[0] + (p1[0] - p0[0]) * 0.5, y: p0[1] + (p1[1] - p0[1]) * 0.5, a, L, W: L * o.leafWid * rng.range(0.85, 1.15) });
    }
    const tip = t.pts[n], prev = t.pts[n - 1];
    const ta = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
    leaves.push({ x: tip[0], y: tip[1], a: ta + rng.range(-0.2, 0.2), L: o.leafLen * 0.85, W: o.leafLen * 0.85 * o.leafWid });
  }
  leaves.sort((p, q) => q.y - p.y);
  // 영역 가장자리에서 잘리는 잎은 그리지 않음 (알파 테스트 후 곧은 잘림선이 보이지 않게)
  const m = o.leafLen * 0.62;
  for (const lf of leaves) if (lf.x < R.x + m || lf.x > R.x + R.w - m || lf.y < R.y + m || lf.y > R.y + R.h - 4) lf.skip = true;
  for (const lf of leaves) if (!lf.skip) drawLeaf(ctx, rng, lf.x, lf.y, lf.a, lf.L, lf.W, leafColor(rng, o.color), { shape: o.shape, damage: o.damage, brown: o.brown });
  ctx.restore();
}

// ---------------------------------------------------------------
// 잎 아틀라스 2048×1024 (256 px 칸, 영역은 UV로 공유)
// ---------------------------------------------------------------
const AW = 2048, AH = 1024;
const cell = (col, row, cw = 1, ch = 1) => {
  const x = col * 256, y = row * 256, w = cw * 256, h = ch * 256;
  const inset = 2;
  return { x, y, w, h, u0: (x + inset) / AW, u1: (x + w - inset) / AW, v0: 1 - (y + h - inset) / AH, v1: 1 - (y + inset) / AH };
};
export const ATLAS = {
  clusterA: cell(0, 0, 2, 2),   // 큰 나무 수관: 윤기 나는 넓은 잎 가지
  clusterB: cell(2, 0, 2, 2),   // 어린 나무·덤불: 작은 잎이 빽빽한 가지
  clusterC: cell(4, 0, 2, 2),   // 하층 덤불: 크고 짙은 잎
  fern: cell(6, 0, 1, 2),       // 고사리 잎 (세로)
  palm: cell(7, 0, 1, 2),       // 야자·등나무 잎 (세로)
  banana: cell(0, 2, 1, 2),     // 바나나 잎
  bamboo: cell(1, 2, 1, 2),     // 대나무 잎 뭉치
  vine: cell(2, 2, 1, 2),       // 늘어진 덩굴
  reed: cell(3, 2, 1, 2),       // 갈대·부들
  taro: cell(4, 2),             // 토란 잎 (하트형)
  herb: cell(5, 2),             // 넓은잎 풀 (옆에서 본 포기)
  creeper: cell(6, 2),          // 바닥을 기는 덩굴 (위에서 본 모습)
  moss: cell(7, 2),             // 이끼 덩어리 (위에서)
  grass: cell(4, 3),            // 풀잎
  epiphyte: cell(5, 3),         // 착생 양치 (새둥지고사리)
  lily: cell(6, 3),             // 수련·부엽식물 (위에서)
  seedling: cell(7, 3),         // 어린 묘목
};

export function makeLeafAtlas(seed = 21) {
  const c = canvas(AW, AH);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  ctx.clearRect(0, 0, AW, AH);

  // 1) 수관 잎 덩어리 A — 윤기 나는 타원형 잎 (상록 활엽수)
  drawTwigCluster(ctx, rng, ATLAS.clusterA, {
    fan: 7, spread: 2.7, reach: 0.72, twigW: 6, depth: 1, kids: [2, 3], leavesPerTwig: 8, leafLen: 58, leafWid: 0.37,
    color: { h: 96, s: 38, l: 27 }, shape: 'ellipse', damage: 0.12, brown: 0.06,
  });
  // 2) 잎 덩어리 B — 작은 잎이 빽빽함 (어린 나무·덤불)
  drawTwigCluster(ctx, rng, ATLAS.clusterB, {
    fan: 8, spread: 2.8, reach: 0.74, twigW: 4.5, depth: 1, kids: [3, 4], leavesPerTwig: 11, leafLen: 38, leafWid: 0.44,
    color: { h: 88, s: 40, l: 31 }, shape: 'round', damage: 0.08, brown: 0.04,
  });
  // 3) 잎 덩어리 C — 크고 짙은 하층 잎
  drawTwigCluster(ctx, rng, ATLAS.clusterC, {
    fan: 6, spread: 2.6, reach: 0.7, twigW: 7, depth: 1, kids: [2, 3], leavesPerTwig: 6, leafLen: 88, leafWid: 0.4,
    color: { h: 102, s: 34, l: 22 }, shape: 'lance', damage: 0.18, brown: 0.08,
  });

  // 4) 고사리 잎 (깃꼴, 아래 → 위)
  {
    const R = ATLAS.fern;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const cx = R.x + R.w / 2;
    const top = R.y + 10, bot = R.y + R.h - 6;
    const spine = (t) => [cx + Math.sin(t * 2.2) * 6, bot - t * (bot - top)];
    ctx.strokeStyle = hsl(70, 30, 24); ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k <= 20; k++) { const p = spine(k / 20); if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
    ctx.stroke();
    const pinnae = 30;
    for (let i = 2; i < pinnae; i++) {
      const t = i / pinnae;
      const [px, py] = spine(t);
      const len = (R.w * 0.47) * Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)) * (1 - t * 0.25);
      for (const side of [-1, 1]) {
        const a = side > 0 ? -0.35 - t * 0.25 : Math.PI + 0.35 + t * 0.25;
        const col = { h: rng.range(84, 98), s: rng.range(36, 46), l: rng.range(26, 33) };
        ctx.save(); ctx.translate(px, py); ctx.rotate(a);
        // 작은 잎(우편)들이 붙은 깃
        ctx.strokeStyle = hsl(col.h, col.s, col.l * 0.8); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
        const segs = Math.max(4, Math.round(len / 7));
        for (let k = 0; k < segs; k++) {
          const s = (k + 0.5) / segs;
          const w = 5.5 * (1 - s * 0.7) + 1.5;
          for (const sd of [-1, 1]) {
            ctx.fillStyle = hsl(col.h + rng.range(-3, 3), col.s, col.l * rng.range(0.9, 1.15));
            ctx.beginPath();
            ctx.ellipse(len * s, sd * w * 0.55, w * 0.62, w * 0.42, sd * 0.5, 0, 6.28);
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // 5) 야자·등나무 잎 (긴 깃꼴, 잎이 아래로 처짐)
  {
    const R = ATLAS.palm;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const cx = R.x + R.w / 2;
    ctx.strokeStyle = hsl(55, 28, 30); ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, R.y + R.h - 2); ctx.lineTo(cx, R.y + 6); ctx.stroke();
    const n = 46;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const y = R.y + R.h - 12 - t * (R.h - 26);
      const len = R.w * 0.49 * Math.pow(Math.sin(Math.PI * (0.06 + 0.94 * t)), 0.55);
      for (const side of [-1, 1]) {
        const col = { h: rng.range(70, 88), s: rng.range(30, 40), l: rng.range(25, 33) };
        const a = side > 0 ? -0.55 + rng.range(-0.08, 0.08) : Math.PI + 0.55 + rng.range(-0.08, 0.08);
        drawLeaf(ctx, rng, cx + side * 3, y, a, len, rng.range(4.5, 6.5), col, { shape: 'lance', veins: false, brown: 0.12 });
      }
    }
    ctx.restore();
  }

  // 6) 바나나 잎 (넓은 잎, 평행 잎맥, 찢어진 틈, 갈변한 가장자리)
  {
    const R = ATLAS.banana;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const cx = R.x + R.w / 2, top = R.y + 8, bot = R.y + R.h - 6, hw = R.w * 0.46;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(cx, bot);
      ctx.bezierCurveTo(cx - hw * 1.18, bot - R.h * 0.2, cx - hw * 1.02, top + R.h * 0.12, cx, top);
      ctx.bezierCurveTo(cx + hw * 1.02, top + R.h * 0.12, cx + hw * 1.18, bot - R.h * 0.2, cx, bot);
    };
    const grad = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
    grad.addColorStop(0, hsl(88, 34, 27)); grad.addColorStop(0.46, hsl(84, 38, 37)); grad.addColorStop(0.54, hsl(84, 36, 34)); grad.addColorStop(1, hsl(88, 34, 26));
    ctx.fillStyle = grad; outline(); ctx.fill();
    ctx.save(); outline(); ctx.clip();
    ctx.strokeStyle = hsl(80, 30, 22, 0.35); ctx.lineWidth = 1.1;
    for (let y = top + 18; y < bot - 8; y += 6) {
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.quadraticCurveTo(cx - hw * 0.5, y - 10, cx - hw * 1.05, y - 26);
      ctx.moveTo(cx, y); ctx.quadraticCurveTo(cx + hw * 0.5, y - 10, cx + hw * 1.05, y - 26); ctx.stroke();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.strokeStyle = hsl(35, 38, 30, 0.85); ctx.lineWidth = 7; outline(); ctx.stroke();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 16; i++) {
      const y = rng.range(top + 30, bot - 25), side = rng.sign();
      ctx.lineWidth = rng.range(1.5, 4);
      ctx.beginPath(); ctx.moveTo(cx + side * rng.range(8, 30), y); ctx.lineTo(cx + side * hw * 1.2, y - rng.range(16, 34)); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hsl(70, 28, 55, 0.9); ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(cx, bot); ctx.lineTo(cx, top); ctx.stroke();
    ctx.restore();
  }

  // 7) 대나무 잎 뭉치
  {
    const R = ATLAS.bamboo;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const ox = R.x + R.w / 2;
    ctx.strokeStyle = hsl(60, 28, 30); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(ox, R.y + R.h - 4); ctx.quadraticCurveTo(ox + 10, R.y + R.h * 0.5, ox - 4, R.y + 16); ctx.stroke();
    for (let i = 0; i < 38; i++) {
      const t = rng.range(0.05, 0.95);
      const bx = ox + Math.sin(t * 3) * 6, byy = R.y + R.h - 8 - t * (R.h - 30);
      const side = rng.sign();
      const a = side > 0 ? rng.range(0.2, 1.1) : Math.PI - rng.range(0.2, 1.1);
      const len = rng.range(50, 92);
      drawLeaf(ctx, rng, bx, byy, a, len, len * 0.11, { h: rng.range(72, 86), s: rng.range(34, 44), l: rng.range(27, 36) }, { shape: 'lance', veins: false, brown: 0.08 });
    }
    ctx.restore();
  }

  // 8) 늘어진 덩굴 (줄기 + 하트형 잎)
  {
    const R = ATLAS.vine;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    for (let s = 0; s < 5; s++) {
      let x = R.x + R.w * (0.12 + 0.19 * s), y = R.y;
      const pts = [];
      ctx.strokeStyle = hsl(45, 25, 24); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y);
      const len = R.h * rng.range(0.6, 1.0);
      for (let k = 0; k < 16; k++) { x += rng.range(-6, 6); y += len / 16; ctx.lineTo(x, y); pts.push([x, y]); }
      ctx.stroke();
      for (const [px, py] of pts) {
        if (!rng.chance(0.85)) continue;
        const side = rng.sign();
        drawLeaf(ctx, rng, px, py, Math.PI / 2 + side * rng.range(0.4, 1.0), rng.range(14, 22), rng.range(8, 11),
          { h: rng.range(88, 104), s: rng.range(34, 44), l: rng.range(24, 32) }, { shape: 'heart', veins: false });
      }
    }
    ctx.restore();
  }

  // 9) 갈대·부들 (가는 잎 + 갈색 이삭)
  {
    const R = ATLAS.reed;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    ctx.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const bx = R.x + rng.range(20, R.w - 20), byy = R.y + R.h;
      const h = rng.range(R.h * 0.55, R.h - 10), lean = rng.range(-50, 50);
      ctx.strokeStyle = hsl(rng.range(70, 95), rng.range(26, 38), rng.range(22, 34));
      ctx.lineWidth = rng.range(2, 4.5);
      ctx.beginPath(); ctx.moveTo(bx, byy); ctx.quadraticCurveTo(bx + lean * 0.2, byy - h * 0.6, bx + lean, byy - h); ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const bx = R.x + rng.range(50, R.w - 50);
      const topY = R.y + rng.range(20, 90);
      ctx.strokeStyle = hsl(60, 25, 32); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(bx, R.y + R.h); ctx.lineTo(bx + 4, topY); ctx.stroke();
      ctx.fillStyle = hsl(25, 45, rng.range(20, 26));
      ctx.beginPath(); ctx.ellipse(bx + 4, topY + 30, 6, 24, 0, 0, 6.28); ctx.fill();
    }
    ctx.restore();
  }

  // 10) 토란 잎 (하트형, 잎자루가 붙는 곳에서 퍼지는 굵은 잎맥)
  {
    const R = ATLAS.taro;
    const cx = R.x + R.w / 2, cy = R.y + R.h * 0.3;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy + 60, 150);
    grad.addColorStop(0, hsl(92, 36, 34)); grad.addColorStop(1, hsl(98, 34, 24));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.bezierCurveTo(cx - 50, cy - 40, cx - 125, cy - 10, cx - 118, cy + 70);
    ctx.bezierCurveTo(cx - 105, cy + 140, cx - 30, cy + 168, cx, cy + 176);
    ctx.bezierCurveTo(cx + 30, cy + 168, cx + 105, cy + 140, cx + 118, cy + 70);
    ctx.bezierCurveTo(cx + 125, cy - 10, cx + 50, cy - 40, cx, cy);
    ctx.fill();
    ctx.strokeStyle = hsl(80, 26, 48, 0.75); ctx.lineWidth = 2.6;
    for (let k = -4; k <= 4; k++) {
      const a = Math.PI / 2 + k * 0.42;
      ctx.beginPath(); ctx.moveTo(cx, cy + 6);
      ctx.quadraticCurveTo(cx + Math.cos(a) * 60, cy + 6 + Math.sin(a) * 60, cx + Math.cos(a) * 112, cy + 10 + Math.sin(a) * 120);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 11) 넓은잎 풀 포기 (옆모습)
  {
    const R = ATLAS.herb;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const bx = R.x + R.w / 2, byy = R.y + R.h - 4;
    for (let i = 0; i < 11; i++) {
      const a = -Math.PI / 2 + rng.range(-1.15, 1.15);
      const stem = rng.range(30, 90);
      const sx = bx + Math.cos(a) * stem * 0.6, sy = byy + Math.sin(a) * stem;
      ctx.strokeStyle = hsl(80, 30, 26); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(bx + rng.range(-6, 6), byy); ctx.quadraticCurveTo(bx + Math.cos(a) * stem * 0.2, byy + Math.sin(a) * stem * 0.7, sx, sy); ctx.stroke();
      const la = a + rng.range(-0.3, 0.5) * Math.sign(Math.cos(a) || 1);
      drawLeaf(ctx, rng, sx, sy, la, rng.range(55, 95), rng.range(20, 30), leafColor(rng, { h: 95, s: 38, l: 28 }), { shape: 'ellipse', damage: 0.2, brown: 0.08 });
    }
    ctx.restore();
  }

  // 12) 바닥을 기는 덩굴 (위에서 본 매트)
  {
    const R = ATLAS.creeper;
    ctx.save(); ctx.beginPath(); ctx.arc(R.x + R.w / 2, R.y + R.h / 2, R.w * 0.48, 0, 6.28); ctx.clip();
    for (let s = 0; s < 9; s++) {
      let x = R.x + R.w / 2 + rng.range(-30, 30), y = R.y + R.h / 2 + rng.range(-30, 30);
      let a = rng.range(0, 6.28);
      ctx.strokeStyle = hsl(50, 25, 24); ctx.lineWidth = 1.8;
      const pts = [];
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 14; k++) { a += rng.range(-0.5, 0.5); x += Math.cos(a) * 9; y += Math.sin(a) * 9; ctx.lineTo(x, y); pts.push([x, y, a]); }
      ctx.stroke();
      for (const [px, py, pa] of pts) {
        for (const side of [-1, 1]) {
          if (!rng.chance(0.8)) continue;
          drawLeaf(ctx, rng, px, py, pa + side * rng.range(0.8, 1.6), rng.range(10, 17), rng.range(6, 9),
            leafColor(rng, { h: 96, s: 40, l: 28 }), { shape: rng.chance(0.5) ? 'heart' : 'round', veins: false });
        }
      }
    }
    ctx.restore();
  }

  // 13) 이끼 덩어리 (위에서, 가장자리가 보송보송)
  {
    const R = ATLAS.moss;
    const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
    // 울퉁불퉁한 덩어리 윤곽 + 안쪽 작은 반점 (알파 테스트 후에도 덩어리로 보이게)
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, 6.28), d = rng.range(0, R.w * 0.28);
      ctx.fillStyle = hsl(rng.range(74, 92), rng.range(38, 50), rng.range(18, 26));
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(22, 46), 0, 6.28); ctx.fill();
    }
    for (let i = 0; i < 1400; i++) {
      const a = rng.range(0, 6.28), d = Math.pow(rng.float(), 0.7) * R.w * 0.4;
      ctx.fillStyle = hsl(rng.range(70, 100), rng.range(35, 55), rng.range(20, 38));
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1.5, 4), 0, 6.28); ctx.fill();
    }
  }

  // 14) 풀잎
  {
    const R = ATLAS.grass;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    ctx.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const bx = R.x + rng.range(12, R.w - 12), byy = R.y + R.h;
      const h = rng.range(R.h * 0.4, R.h - 8), lean = rng.range(-45, 45);
      ctx.strokeStyle = hsl(rng.range(62, 85), rng.range(26, 38), rng.range(22, 36));
      ctx.lineWidth = rng.range(1.6, 3.6);
      ctx.beginPath(); ctx.moveTo(bx, byy); ctx.quadraticCurveTo(bx + lean * 0.25, byy - h * 0.65, bx + lean, byy - h); ctx.stroke();
    }
    ctx.restore();
  }

  // 15) 착생 양치 (새둥지고사리 — 띠 모양 잎이 방사상으로)
  {
    const R = ATLAS.epiphyte;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const bx = R.x + R.w / 2, byy = R.y + R.h - 20;
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + rng.range(-1.35, 1.35);
      drawLeaf(ctx, rng, bx, byy, a, rng.range(90, 125), rng.range(10, 15), { h: rng.range(78, 92), s: rng.range(38, 50), l: rng.range(30, 40) }, { shape: 'lance', brown: 0.2 });
    }
    ctx.fillStyle = hsl(25, 30, 18);
    ctx.beginPath(); ctx.ellipse(bx, byy + 6, 26, 14, 0, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  // 16) 수련·부엽식물 (위에서)
  {
    const R = ATLAS.lily;
    for (let i = 0; i < 6; i++) {
      const x = R.x + rng.range(50, R.w - 50), y = R.y + rng.range(50, R.h - 50), r = rng.range(26, 44);
      ctx.fillStyle = hsl(rng.range(88, 102), rng.range(32, 42), rng.range(24, 32));
      const notch = rng.range(0, 6.28);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, notch + 0.25, notch + 6.03); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = hsl(80, 25, 40, 0.4); ctx.lineWidth = 1;
      for (let k = 0; k < 8; k++) { const a = notch + 0.4 + k * 0.72; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9); ctx.stroke(); }
    }
  }

  // 17) 어린 묘목
  {
    const R = ATLAS.seedling;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x + 2, R.y + 2, R.w - 4, R.h - 4); ctx.clip();
    const bx = R.x + R.w / 2, byy = R.y + R.h - 2;
    ctx.strokeStyle = hsl(35, 30, 26); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(bx, byy); ctx.quadraticCurveTo(bx + 8, byy - 120, bx - 4, R.y + 30); ctx.stroke();
    for (let i = 0; i < 9; i++) {
      const t = 0.25 + (i / 9) * 0.75;
      const y = byy - t * (R.h - 40);
      const side = i % 2 ? 1 : -1;
      drawLeaf(ctx, rng, bx + side * 2, y, side > 0 ? -0.5 : Math.PI + 0.5, rng.range(45, 70), rng.range(16, 22), leafColor(rng, { h: 92, s: 42, l: 30 }), { shape: 'ellipse', damage: 0.15 });
    }
    ctx.restore();
  }

  return pullPushTexture(ctx);
}

/**
 * 투명 픽셀의 RGB를 주변 잎 색으로 채운 텍스처 (pull-push).
 * 캔버스는 투명 픽셀 RGB를 0으로 저장 → 밉맵에서 잎 가장자리가 검게 번지는 문제 방지.
 */
function pullPushTexture(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, W, H).data;
  // 피라미드: 0단계 = 불투명 픽셀만 가중치 1
  const levels = [];
  let w = W, h = H;
  let col = new Float32Array(W * H * 3), wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (img[i * 4 + 3] > 24) { col[i * 3] = img[i * 4]; col[i * 3 + 1] = img[i * 4 + 1]; col[i * 3 + 2] = img[i * 4 + 2]; wt[i] = 1; }
  }
  levels.push({ w, h, col, wt });
  while (w > 1 && h > 1) {
    const nw = w >> 1, nh = h >> 1;
    const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const o = y * nw + x;
        let r = 0, g = 0, b = 0, s = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = (y * 2 + dy) * w + x * 2 + dx;
            const k = wt[i];
            if (!k) continue;
            r += col[i * 3] * k; g += col[i * 3 + 1] * k; b += col[i * 3 + 2] * k; s += k;
          }
        }
        if (s > 0) { ncol[o * 3] = r / s; ncol[o * 3 + 1] = g / s; ncol[o * 3 + 2] = b / s; nwt[o] = Math.min(1, s); }
      }
    }
    levels.push({ w: nw, h: nh, col: ncol, wt: nwt });
    w = nw; h = nh; col = ncol; wt = nwt;
  }
  // push: 거친 단계의 색으로 빈 픽셀을 채움
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], P = levels[l + 1];
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const o = y * L.w + x;
        if (L.wt[o] > 0) continue;
        const px = Math.min(P.w - 1, x >> 1), py = Math.min(P.h - 1, y >> 1);
        const q = py * P.w + px;
        L.col[o * 3] = P.col[q * 3]; L.col[o * 3 + 1] = P.col[q * 3 + 1]; L.col[o * 3 + 2] = P.col[q * 3 + 2];
        L.wt[o] = 1e-6;
      }
    }
  }
  const base = levels[0];
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = ((H - 1 - y) * W + x) * 4;   // 캔버스 위쪽 = v 1
      out[o] = base.col[i * 3]; out[o + 1] = base.col[i * 3 + 1]; out[o + 2] = base.col[i * 3 + 2];
      out[o + 3] = img[i * 4 + 3];
    }
  }
  return dataTexture(out, W, H, { repeat: false, anisotropy: 4 });
}

// ---------------------------------------------------------------
// 지면
// ---------------------------------------------------------------
export function makeLeafLitterTexture(seed = 11) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  fillNoise(ctx, S, [62, 48, 34], tileField(seed, S, 8, 3), 0.07);
  for (let i = 0; i < 120; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(8, 30);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(28, 25, rng.range(10, 18), 0.25);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.7, rng.range(0, 3), 0, 6.28); ctx.fill();
    });
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(10, 45), a = rng.range(0, 6.28);
    wrapDraw(S, x, y, len, (px, py) => {
      ctx.strokeStyle = hsl(25, 20, rng.range(14, 26), 0.8);
      ctx.lineWidth = rng.range(1, 2.5);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); ctx.stroke();
    });
  }
  // 낙엽 (갈색·황토·검붉은색, 일부 올리브·초록 — 막 떨어진 잎)
  for (let i = 0; i < 1500; i++) {
    const x = rng.range(0, S), y = rng.range(0, S);
    const len = rng.range(8, 22), w = len * rng.range(0.3, 0.55), a = rng.range(0, 6.28);
    const t = rng.float();
    const col = t < 0.42 ? { h: rng.range(22, 34), s: rng.range(28, 45), l: rng.range(18, 30) }
      : t < 0.7 ? { h: rng.range(30, 40), s: rng.range(30, 45), l: rng.range(25, 36) }
        : t < 0.84 ? { h: rng.range(8, 18), s: rng.range(25, 40), l: rng.range(16, 24) }
          : { h: rng.range(55, 85), s: rng.range(18, 30), l: rng.range(18, 27) };
    wrapDraw(S, x, y, len, (px, py) => drawLeaf(ctx, rng, px - Math.cos(a) * len / 2, py - Math.sin(a) * len / 2, a, len, w, col, { veins: false }));
  }
  return toTexture(c);
}

export function makeDirtTexture(seed = 12) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  fillNoise(ctx, S, [100, 74, 52], tileField(seed, S, 12, 4), 0.09);
  for (let i = 0; i < 700; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(1, 3.5);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(20, 35), rng.range(10, 25), rng.range(30, 50), 0.7);
      ctx.beginPath(); ctx.arc(px, py, r, 0, 6.28); ctx.fill();
    });
  }
  for (let i = 0; i < 60; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(12, 40);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(22, 30, rng.range(22, 32), 0.18);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.45, rng.range(0, 3), 0, 6.28); ctx.fill();
    });
  }
  // 밟혀 박힌 낙엽 조각
  for (let i = 0; i < 160; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(6, 14), a = rng.range(0, 6.28);
    wrapDraw(S, x, y, len, (px, py) => drawLeaf(ctx, rng, px, py, a, len, len * 0.4, { h: rng.range(20, 35), s: 30, l: rng.range(18, 26) }, { veins: false }));
  }
  return toTexture(c);
}

export function makeMudTexture(seed = 13) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  fillNoise(ctx, S, [50, 36, 25], tileField(seed, S, 7, 4), 0.07);
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(10, 26);
    const a = rng.range(0, 6.28);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(30, 25, rng.range(12, 18), 0.45);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.55, a, 0, 6.28); ctx.fill();
    });
  }
  return toTexture(c);
}

/** 원거리 숲 바닥: 위에서 본 지피식물 (작은 잎·고사리·이끼 + 어두운 틈) */
export function makeGroundCoverTexture(seed = 14) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  fillNoise(ctx, S, [34, 38, 22], tileField(seed, S, 8, 3), 0.06);
  // 이끼 얼룩
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(14, 40);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(70, 95), rng.range(30, 45), rng.range(16, 26), 0.35);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * rng.range(0.6, 1), rng.range(0, 3), 0, 6.28); ctx.fill();
    });
  }
  // 낙엽 몇 장 (틈새)
  for (let i = 0; i < 180; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(8, 18), a = rng.range(0, 6.28);
    wrapDraw(S, x, y, len, (px, py) => drawLeaf(ctx, rng, px, py, a, len, len * 0.4, { h: rng.range(22, 36), s: 32, l: rng.range(18, 28) }, { veins: false }));
  }
  // 고사리 (위에서 본 별 모양)
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), n = rng.int(5, 8), L = rng.range(24, 44);
    wrapDraw(S, x, y, L, (px, py) => {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 6.28 + rng.range(-0.2, 0.2);
        ctx.strokeStyle = hsl(rng.range(84, 96), 40, rng.range(22, 30)); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); ctx.stroke();
        for (let s = 0.2; s < 1; s += 0.12) {
          for (const sd of [-1, 1]) {
            const qx = px + Math.cos(a) * L * s, qy = py + Math.sin(a) * L * s;
            ctx.fillStyle = hsl(rng.range(84, 98), 42, rng.range(22, 31));
            ctx.beginPath(); ctx.ellipse(qx + Math.cos(a + sd * 1.3) * 3, qy + Math.sin(a + sd * 1.3) * 3, 3.6 * (1.1 - s), 1.6, a + sd * 1.3, 0, 6.28); ctx.fill();
          }
        }
      }
    });
  }
  // 넓은 잎·작은 잎 (대부분)
  for (let i = 0; i < 2300; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(7, 22), a = rng.range(0, 6.28);
    const col = leafColor(rng, { h: 94, s: 38, l: 25 });
    wrapDraw(S, x, y, len, (px, py) => drawLeaf(ctx, rng, px, py, a, len, len * rng.range(0.32, 0.5), col, { shape: rng.chance(0.3) ? 'round' : 'ellipse', veins: false }));
  }
  return toTexture(c);
}

/** 사면에 드러난 흙 (붉은 갈색 라테라이트 + 잔뿌리 + 자갈) */
export function makeSoilTexture(seed = 18) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  fillNoise(ctx, S, [80, 60, 44], tileField(seed, S, 10, 4), 0.1);
  for (let i = 0; i < 80; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(10, 36);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(20, 34), rng.range(22, 34), rng.range(18, 30), 0.3);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.4, rng.range(-0.3, 0.3), 0, 6.28); ctx.fill();
    });
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    let x = rng.range(0, S), y = rng.range(0, S);
    let a = rng.range(0, 6.28);
    ctx.strokeStyle = hsl(28, 25, rng.range(16, 26), 0.85);
    ctx.lineWidth = rng.range(0.8, 2.2);
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) { a += rng.range(-0.6, 0.6); x += Math.cos(a) * 8; y += Math.sin(a) * 8; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  for (let i = 0; i < 500; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(1, 4);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(20, 40), rng.range(5, 20), rng.range(32, 52), 0.85);
      ctx.beginPath(); ctx.arc(px, py, r, 0, 6.28); ctx.fill();
    });
  }
  return toTexture(c);
}

/** 지면 미세 법선 (자갈·낙엽 가장자리의 요철) */
export function makeGroundDetailNormal(seed = 19) {
  const S = 256;
  const tn = new TileNoise(seed);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const a = tn.fbm(u, v, 16, 16, 3);
      const b = Math.abs(tn.noise(u * 24, v * 24, 24, 24));
      h[y * S + x] = a * 0.6 + (1 - b) * 0.4;
    }
  }
  return dataTexture(normalFromHeight(h, S, S, 2.2), S, S, { srgb: false });
}

// ---------------------------------------------------------------
// 나무껍질 (색 + 법선): 세로로 갈라진 틈, 판 모양 껍질, 가로 균열, 지의류 얼룩
// ---------------------------------------------------------------
export function makeBarkTextures(seed = 16) {
  const W = 512, H = 1024;
  const tn = new TileNoise(seed);
  const tw = new TileNoise(seed + 1);
  const height = new Float32Array(W * H);
  const color = rgbaBuffer(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      // 물결치는 세로 갈라짐 (가로 12칸 × 세로 3칸의 길쭉한 노이즈가 0을 지나는 곳)
      const warp = tw.fbm(u, v, 6, 3, 2) * 0.035;
      const f = tn.fbm(u + warp, v, 12, 3, 3);
      const groove = 1 - sstep(0.0, 0.16, Math.abs(f));
      const fine = tw.fbm(u, v, 48, 24, 3);
      const crackN = tn.noise(u * 8, v * 40, 8, 40);
      const crack = (1 - sstep(0.0, 0.07, Math.abs(crackN))) * sstep(0.1, 0.4, tw.noise(u * 5, v * 5, 5, 5));
      const plate = tn.fbm(u, v, 24, 6, 2);
      const h = 0.62 + 0.18 * plate + 0.12 * fine - 0.62 * groove - 0.22 * crack;
      height[y * W + x] = h;
      // 색: 회갈색 판 + 어두운 틈 + 지의류(밝은 회녹색) 얼룩
      const tone = 0.5 + 0.5 * tw.fbm(u, v, 3, 3, 3);
      let r = mix(92, 128, tone), g = mix(80, 112, tone), b = mix(64, 92, tone);
      r += fine * 18; g += fine * 16; b += fine * 12;
      const lichen = sstep(0.18, 0.42, tn.fbm(u + 0.37, v + 0.11, 4, 2, 4)) * (1 - groove);
      r = mix(r, 168, lichen * 0.55); g = mix(g, 166, lichen * 0.55); b = mix(b, 146, lichen * 0.55);
      const greenSpot = sstep(0.25, 0.5, tw.fbm(u + 0.6, v + 0.2, 6, 3, 3)) * 0.5;
      r = mix(r, 74, greenSpot); g = mix(g, 88, greenSpot); b = mix(b, 50, greenSpot);
      const dark = groove * 0.78 + crack * 0.4;
      r = mix(r, 34, dark); g = mix(g, 28, dark); b = mix(b, 22, dark);
      put(color, y * W + x, r, g, b);
    }
  }
  return {
    map: dataTexture(color, W, H),
    normalMap: dataTexture(normalFromHeight(height, W, H, 7), W, H, { srgb: false }),
  };
}

// ---------------------------------------------------------------
// 바위 (색 + 법선): 층리·균열·지의류 반점
// ---------------------------------------------------------------
export function makeRockTextures(seed = 15) {
  const S = 512;
  const tn = new TileNoise(seed);
  const tw = new TileNoise(seed + 7);
  const height = new Float32Array(S * S);
  const color = rgbaBuffer(S, S);
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const n = tn.fbm(u, v, 6, 6, 5);
      const ridge = 1 - Math.abs(tw.fbm(u, v, 5, 5, 3));
      const crack = 1 - sstep(0.0, 0.05, Math.abs(tn.noise(u * 9 + n * 2, v * 9, 9, 9)));
      const strata = Math.sin((v + n * 0.08) * Math.PI * 2 * 7) * 0.5 + 0.5;
      const h = 0.5 + 0.3 * n + 0.15 * ridge * ridge - 0.35 * crack + 0.05 * strata;
      height[y * S + x] = h;
      const tone = 0.5 + 0.5 * tw.fbm(u + 0.3, v, 3, 3, 3);
      let r = mix(78, 116, tone) + n * 30, g = mix(76, 112, tone) + n * 28, b = mix(68, 98, tone) + n * 24;
      r += strata * 6; g += strata * 5;
      const lichen = sstep(0.32, 0.55, tw.fbm(u + 0.7, v + 0.2, 8, 8, 3));
      r = mix(r, 150, lichen * 0.5); g = mix(g, 148, lichen * 0.5); b = mix(b, 120, lichen * 0.5);
      r = mix(r, 30, crack * 0.75); g = mix(g, 28, crack * 0.75); b = mix(b, 24, crack * 0.75);
      put(color, y * S + x, r, g, b);
    }
  }
  return {
    map: dataTexture(color, S, S),
    normalMap: dataTexture(normalFromHeight(height, S, S, 5), S, S, { srgb: false }),
  };
}

/** 껍질이 벗겨진 목재 (나뭇결) */
export function makeWoodTexture(seed = 20) {
  const W = 256, H = 512;
  const tn = new TileNoise(seed);
  const color = rgbaBuffer(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const warp = tn.fbm(u, v, 4, 2, 3) * 0.06;
      const grain = 0.5 + 0.5 * Math.sin((u + warp) * Math.PI * 2 * 22);
      const rot = sstep(0.2, 0.55, tn.fbm(u + 0.4, v + 0.2, 3, 3, 3));
      const crack = 1 - sstep(0.0, 0.04, Math.abs(tn.noise(u * 10, v * 3, 10, 3)));
      let r = mix(150, 118, grain), g = mix(126, 98, grain), b = mix(96, 74, grain);
      r = mix(r, 74, rot * 0.7); g = mix(g, 58, rot * 0.7); b = mix(b, 44, rot * 0.7);
      r = mix(r, 40, crack); g = mix(g, 32, crack); b = mix(b, 26, crack);
      put(color, y * W + x, r, g, b);
    }
  }
  return dataTexture(color, W, H);
}

/** 범용 타일링 노이즈 (RGBA 채널마다 다른 주파수) — 셰이더용 */
export function makeNoiseTexture(seed = 17) {
  const S = 256;
  const tn = new TileNoise(seed);
  const out = rgbaBuffer(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      put(out, y * S + x,
        128 + tn.fbm(u, v, 4, 4, 4) * 180,
        128 + tn.fbm(u + 0.31, v + 0.17, 10, 10, 3) * 180,
        128 + tn.fbm(u + 0.53, v + 0.71, 28, 28, 2) * 180,
        clamp255(128 + tn.fbm(u + 0.11, v + 0.43, 2, 2, 3) * 180));
    }
  }
  return dataTexture(out, S, S, { srgb: false });
}

/**
 * 캐노피 틈으로 떨어지는 햇빛 얼룩 패턴 (R: 0~1, 타일링).
 * 값의 분포를 평탄하게(히스토그램 균등화) 만들어, 셰이더에서 문턱값 t 를 주면 밝은 면적이 (1-t) 가 되게 한다.
 * → 캐노피 덮임이 클수록 얼룩이 작고 드물어진다.
 */
export function makeSunfleckTexture(seed = 23) {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(seed);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  // 덩어리진 분포: 군집 중심 주변에 작은 둥근 얼룩 (잎 사이 틈의 핀홀 상)
  for (let k = 0; k < 40; k++) {
    const cx = rng.range(0, S), cy = rng.range(0, S), spread = rng.range(10, 34);
    const n = rng.int(5, 14);
    for (let i = 0; i < n; i++) {
      const x = cx + rng.gauss() * spread * 0.5, y = cy + rng.gauss() * spread * 0.5;
      const r = rng.range(2.5, 9);
      const a = rng.range(0.3, 0.75);
      const e = rng.range(1.0, 1.4), rot = rng.range(0, 3);
      wrapDraw(S, x, y, r * 1.8, (px, py) => {
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 1.6);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.6, `rgba(255,255,255,${a * 0.55})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(px, py, r * 1.6, r * 1.6 / e, rot, 0, 6.28); ctx.fill();
      });
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  const blobs = ctx.getImageData(0, 0, S, S).data;
  const tn = new TileNoise(seed);
  const field = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      field[i] = (blobs[i * 4] / 255) * 0.7 + (0.5 + 0.5 * tn.fbm(x / S, y / S, 6, 6, 3)) * 0.3 + rng.float() * 0.002;
    }
  }
  // 히스토그램 균등화 (순위 → 0~1)
  const order = Array.from(field.keys()).sort((a, b) => field[a] - field[b]);
  const out = rgbaBuffer(S, S);
  for (let r = 0; r < order.length; r++) {
    const v = (r / (order.length - 1)) * 255;
    put(out, order[r], v, v, v);
  }
  return dataTexture(out, S, S, { srgb: false, anisotropy: 1 });
}
