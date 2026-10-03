// 절차적 텍스처 (캔버스로 그림) — 외부 이미지 파일 없음.
// 나중에 실제 에셋으로 바꿀 때는 이 파일의 함수만 이미지 로더로 교체하면 된다.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';

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

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

/** 이음매 없는 노이즈 필드 (주기적 경계) */
function tileableNoise(noise, size, scale, octaves = 4) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4D 토러스 대신 4개 샘플 가중 혼합으로 타일링
      const fx = x / size, fy = y / size;
      const a = noise.fbm(x / scale, y / scale, octaves);
      const b = noise.fbm((x - size) / scale, y / scale, octaves);
      const c = noise.fbm(x / scale, (y - size) / scale, octaves);
      const d = noise.fbm((x - size) / scale, (y - size) / scale, octaves);
      out[y * size + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
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
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

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
// 지면
// ---------------------------------------------------------------
export function makeLeafLitterTexture(seed = 11) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  fillNoise(ctx, S, [70, 56, 40], tileableNoise(noise, S, 60, 3), 0.06);
  // 부엽토 얼룩
  for (let i = 0; i < 120; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(8, 30);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(28, 25, rng.range(10, 18), 0.25);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.7, rng.range(0, 3), 0, 6.28); ctx.fill();
    });
  }
  // 잔가지
  ctx.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(10, 45), a = rng.range(0, 6.28);
    wrapDraw(S, x, y, len, (px, py) => {
      ctx.strokeStyle = hsl(25, 20, rng.range(14, 26), 0.8);
      ctx.lineWidth = rng.range(1, 2.5);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); ctx.stroke();
    });
  }
  // 낙엽 (갈색·황토·검붉은색, 일부 올리브)
  for (let i = 0; i < 1500; i++) {
    const x = rng.range(0, S), y = rng.range(0, S);
    const len = rng.range(7, 20), w = len * rng.range(0.3, 0.55), a = rng.range(0, 6.28);
    const t = rng.float();
    const col = t < 0.45 ? hsl(rng.range(22, 34), rng.range(28, 45), rng.range(18, 30))
      : t < 0.75 ? hsl(rng.range(30, 40), rng.range(30, 45), rng.range(26, 38))
        : t < 0.9 ? hsl(rng.range(8, 18), rng.range(25, 40), rng.range(16, 24))
          : hsl(rng.range(55, 75), rng.range(15, 28), rng.range(20, 28));
    wrapDraw(S, x, y, len, (px, py) => {
      ctx.save();
      ctx.translate(px, py); ctx.rotate(a);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.quadraticCurveTo(0, -w, len / 2, 0);
      ctx.quadraticCurveTo(0, w, -len / 2, 0);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,14,8,0.35)';
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.stroke();
      ctx.restore();
    });
  }
  return toTexture(c);
}

export function makeDirtTexture(seed = 12) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  fillNoise(ctx, S, [104, 76, 54], tileableNoise(noise, S, 40, 4), 0.09);
  // 다져진 자국·작은 돌
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
  return toTexture(c);
}

export function makeMudTexture(seed = 13) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  fillNoise(ctx, S, [52, 37, 25], tileableNoise(noise, S, 70, 4), 0.07);
  // 발자국 웅덩이·물기 고인 얼룩
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(10, 26);
    const a = rng.range(0, 6.28);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(30, 25, rng.range(12, 18), 0.6);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.55, a, 0, 6.28); ctx.fill();
      ctx.strokeStyle = hsl(32, 25, 30, 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(px, py, r * 1.05, r * 0.6, a, 0, 6.28); ctx.stroke();
    });
  }
  return toTexture(c);
}

export function makeGrassGroundTexture(seed = 14) {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  fillNoise(ctx, S, [58, 62, 36], tileableNoise(noise, S, 30, 3), 0.08);
  ctx.lineCap = 'round';
  for (let i = 0; i < 1400; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(4, 14), a = rng.range(0, 6.28);
    wrapDraw(S, x, y, len, (px, py) => {
      ctx.strokeStyle = hsl(rng.range(50, 80), rng.range(20, 35), rng.range(16, 32), 0.8);
      ctx.lineWidth = rng.range(0.8, 1.8);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); ctx.stroke();
    });
  }
  return toTexture(c);
}

export function makeRockTexture(seed = 15) {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  fillNoise(ctx, S, [88, 86, 76], tileableNoise(noise, S, 24, 5), 0.16);
  // 이끼
  for (let i = 0; i < 160; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(4, 18);
    wrapDraw(S, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(70, 95), rng.range(20, 35), rng.range(18, 30), 0.45);
      ctx.beginPath(); ctx.arc(px, py, r, 0, 6.28); ctx.fill();
    });
  }
  // 균열
  ctx.strokeStyle = 'rgba(30,28,24,0.5)';
  for (let i = 0; i < 25; i++) {
    let x = rng.range(0, S), y = rng.range(0, S);
    ctx.lineWidth = rng.range(0.6, 1.6);
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += rng.range(-14, 14); y += rng.range(-14, 14); ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return toTexture(c);
}

export function makeBarkTexture(seed = 16) {
  const W = 256, H = 512;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  const noise = new Noise2D(seed);
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 세로로 긴 줄무늬 (x 방향은 타일링)
      const fx = x / W;
      const a = noise.fbm(x / 10, y / 70, 4), b = noise.fbm((x - W) / 10, y / 70, 4);
      const n = a * (1 - fx) + b * fx;
      const m = noise.fbm(x / 40 + 9, y / 40, 3);
      const v = 0.5 + 0.5 * n;
      const lum = 70 + 55 * v + 18 * m;
      img.data[(y * W + x) * 4] = clamp255(lum * 0.92);
      img.data[(y * W + x) * 4 + 1] = clamp255(lum * 0.88 + 6 * m);
      img.data[(y * W + x) * 4 + 2] = clamp255(lum * 0.74);
      img.data[(y * W + x) * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 이끼 반점
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, W), y = rng.range(0, H), r = rng.range(3, 14);
    wrapDraw(W, x, y, r, (px, py) => {
      ctx.fillStyle = hsl(rng.range(70, 100), rng.range(18, 30), rng.range(22, 34), 0.35);
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 1.8, 0, 0, 6.28); ctx.fill();
    });
  }
  return toTexture(c);
}

/** 범용 타일링 노이즈 (RGBA 채널마다 다른 주파수) — 셰이더용 */
export function makeNoiseTexture(seed = 17) {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const noise = new Noise2D(seed);
  const a = tileableNoise(noise, S, 64, 4);
  const b = tileableNoise(noise, S, 24, 3);
  const cc = tileableNoise(noise, S, 9, 2);
  const d = tileableNoise(noise, S, 128, 3);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    img.data[i * 4] = clamp255(128 + a[i] * 180);
    img.data[i * 4 + 1] = clamp255(128 + b[i] * 180);
    img.data[i * 4 + 2] = clamp255(128 + cc[i] * 180);
    img.data[i * 4 + 3] = clamp255(128 + d[i] * 180);
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, { srgb: false });
}

// ---------------------------------------------------------------
// 잎 아틀라스 (알파 테스트용) — 영역 좌표는 ATLAS 상수로 공유
// ---------------------------------------------------------------
export const ATLAS = {
  fern:   { u0: 0.0, v0: 0.5, u1: 0.5, v1: 1.0 },
  palm:   { u0: 0.5, v0: 0.5, u1: 1.0, v1: 1.0 },
  banana: { u0: 0.0, v0: 0.0, u1: 0.5, v1: 0.5 },
  bamboo: { u0: 0.5, v0: 0.25, u1: 0.75, v1: 0.5 },
  shrub:  { u0: 0.75, v0: 0.25, u1: 1.0, v1: 0.5 },
  vine:   { u0: 0.5, v0: 0.0, u1: 0.75, v1: 0.25 },
  grass:  { u0: 0.75, v0: 0.0, u1: 1.0, v1: 0.25 },
};

export function makeLeafAtlas(seed = 21) {
  const S = 1024;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  ctx.clearRect(0, 0, S, S);
  // 캔버스 y는 아래로 → 텍스처 v 는 위로 (flipY)
  const region = (r) => ({ x: r.u0 * S, y: (1 - r.v1) * S, w: (r.u1 - r.u0) * S, h: (r.v1 - r.v0) * S });

  // 1) 고사리 잎 (세로 줄기 + 양쪽 깃털 잎)
  {
    const R = region(ATLAS.fern);
    const cx = R.x + R.w / 2;
    ctx.strokeStyle = hsl(80, 30, 22); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx, R.y + R.h - 4); ctx.quadraticCurveTo(cx + 6, R.y + R.h / 2, cx, R.y + 8); ctx.stroke();
    for (let i = 0; i < 26; i++) {
      const t = i / 26;
      const y = R.y + R.h - 14 - t * (R.h - 30);
      const len = (R.w * 0.46) * Math.sin(Math.PI * (0.15 + 0.85 * t)) * (1 - t * 0.35);
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(cx + 3 * Math.sin(t * 3), y);
        ctx.rotate(side * (1.25 - t * 0.25));
        ctx.fillStyle = hsl(rng.range(78, 92), rng.range(28, 38), rng.range(26, 34));
        // 작은 톱니 잎
        ctx.beginPath();
        ctx.moveTo(0, 0);
        const segs = 7;
        for (let k = 0; k <= segs; k++) {
          const s = k / segs;
          ctx.lineTo(-side * 0 + s * len * 0.0 + (s * len) * 0 + 0, -s * len);
          ctx.lineTo(side * 5 * (1 - s), -s * len - 3);
        }
        ctx.lineTo(0, -len);
        for (let k = segs; k >= 0; k--) {
          const s = k / segs;
          ctx.lineTo(-side * 5 * (1 - s), -s * len - 3);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // 2) 야자 잎 (긴 깃털형) — 촘촘한 작은 잎
  {
    const R = region(ATLAS.palm);
    const cx = R.x + R.w / 2;
    ctx.strokeStyle = hsl(60, 25, 30); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(cx, R.y + R.h - 2); ctx.lineTo(cx, R.y + 6); ctx.stroke();
    ctx.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const t = i / 70;
      const y = R.y + R.h - 10 - t * (R.h - 20);
      const len = R.w * 0.48 * Math.sin(Math.PI * (0.08 + 0.92 * t)) ** 0.6;
      for (const side of [-1, 1]) {
        const droop = rng.range(0.3, 0.5);
        const ex = cx + side * len, ey = y + len * droop * 0.3;
        const mx = cx + side * len * 0.5, my = y - len * 0.2;
        ctx.fillStyle = hsl(rng.range(64, 84), rng.range(26, 36), rng.range(26, 36));
        // 가늘고 긴 잎 (양쪽 곡선)
        const w = rng.range(5, 8);
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.quadraticCurveTo(mx, my - w, ex, ey);
        ctx.quadraticCurveTo(mx, my + w, cx, y + w * 0.5);
        ctx.fill();
        if (rng.chance(0.2)) {
          ctx.strokeStyle = hsl(35, 30, 36, 0.9);
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(cx + side * len * 0.82, y + len * droop * 0.2); ctx.lineTo(ex, ey); ctx.stroke();
        }
      }
    }
  }

  // 3) 바나나 잎 (넓은 잎, 가운데 잎맥, 찢어진 틈)
  {
    const R = region(ATLAS.banana);
    const cx = R.x + R.w / 2;
    const top = R.y + 6, bot = R.y + R.h - 6;
    const hw = R.w * 0.46;
    const grad = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0);
    grad.addColorStop(0, hsl(85, 30, 30));
    grad.addColorStop(0.5, hsl(82, 34, 38));
    grad.addColorStop(1, hsl(85, 30, 30));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, bot);
    ctx.bezierCurveTo(cx - hw * 1.2, bot - R.h * 0.2, cx - hw, top + R.h * 0.15, cx, top);
    ctx.bezierCurveTo(cx + hw, top + R.h * 0.15, cx + hw * 1.2, bot - R.h * 0.2, cx, bot);
    ctx.fill();
    // 찢어진 틈 (투명하게 지움)
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 14; i++) {
      const y = rng.range(top + 30, bot - 30);
      const side = rng.sign();
      ctx.lineWidth = rng.range(2, 5);
      ctx.beginPath();
      ctx.moveTo(cx + side * 8, y);
      ctx.lineTo(cx + side * hw * 1.1, y - rng.range(10, 30));
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    // 갈변한 가장자리
    ctx.strokeStyle = hsl(35, 35, 30, 0.7);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx, bot);
    ctx.bezierCurveTo(cx - hw * 1.2, bot - R.h * 0.2, cx - hw, top + R.h * 0.15, cx, top);
    ctx.stroke();
    ctx.strokeStyle = hsl(70, 25, 52, 0.9); ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(cx, bot); ctx.lineTo(cx, top); ctx.stroke();
    ctx.strokeStyle = hsl(80, 25, 26, 0.45); ctx.lineWidth = 1.2;
    for (let y = top + 20; y < bot - 10; y += 9) {
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx - hw * 0.95, y - 22); ctx.moveTo(cx, y); ctx.lineTo(cx + hw * 0.95, y - 22); ctx.stroke();
    }
  }

  // 4) 대나무 잎 뭉치 (가는 잎 여러 장)
  {
    const R = region(ATLAS.bamboo);
    const ox = R.x + R.w / 2, oy = R.y + R.h - 6;
    ctx.strokeStyle = hsl(60, 25, 30); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, R.y + 20); ctx.stroke();
    for (let i = 0; i < 22; i++) {
      const by = oy - rng.range(10, R.h - 30);
      const a = rng.range(-1.3, 1.3);
      const len = rng.range(40, 80), w = len * 0.14;
      ctx.save(); ctx.translate(ox, by); ctx.rotate(a);
      ctx.fillStyle = hsl(rng.range(68, 82), rng.range(28, 40), rng.range(28, 38));
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(w, -len * 0.5, 0, -len); ctx.quadraticCurveTo(-w, -len * 0.5, 0, 0); ctx.fill();
      ctx.restore();
    }
  }

  // 5) 덤불 잎 뭉치 (넓은 잎 + 덩굴)
  {
    const R = region(ATLAS.shrub);
    for (let i = 0; i < 70; i++) {
      const x = R.x + rng.range(18, R.w - 18), y = R.y + rng.range(18, R.h - 12);
      const len = rng.range(18, 36), w = len * rng.range(0.4, 0.6), a = rng.range(-2, 2) - Math.PI / 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = hsl(rng.range(75, 100), rng.range(22, 36), rng.range(20, 32));
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(w, len * 0.5, 0, len); ctx.quadraticCurveTo(-w, len * 0.5, 0, 0); ctx.fill();
      ctx.restore();
    }
  }

  // 6) 덩굴 (늘어진 줄기 + 하트형 잎)
  {
    const R = region(ATLAS.vine);
    for (let s = 0; s < 4; s++) {
      let x = R.x + R.w * (0.2 + 0.2 * s), y = R.y;
      ctx.strokeStyle = hsl(50, 25, 25); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x, y);
      const pts = [];
      for (let k = 0; k < 10; k++) { x += rng.range(-8, 8); y += R.h / 10; ctx.lineTo(x, y); pts.push([x, y]); }
      ctx.stroke();
      for (const [px, py] of pts) {
        for (const side of [-1, 1]) {
          if (!rng.chance(0.75)) continue;
          ctx.fillStyle = hsl(rng.range(80, 100), rng.range(25, 38), rng.range(24, 34));
          ctx.beginPath(); ctx.ellipse(px + side * 9, py, 9, 7, side * 0.5, 0, 6.28); ctx.fill();
        }
      }
    }
  }

  // 7) 풀잎 카드 (원거리 코끼리풀)
  {
    const R = region(ATLAS.grass);
    for (let i = 0; i < 60; i++) {
      const bx = R.x + rng.range(8, R.w - 8), by = R.y + R.h;
      const h = rng.range(R.h * 0.5, R.h - 6), lean = rng.range(-30, 30);
      ctx.strokeStyle = hsl(rng.range(55, 75), rng.range(20, 32), rng.range(28, 42));
      ctx.lineWidth = rng.range(1.5, 3.5);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + lean * 0.3, by - h * 0.6, bx + lean, by - h); ctx.stroke();
    }
  }

  return dilatedAlphaTexture(ctx, S);
}

/**
 * 투명 픽셀의 RGB를 주변 잎 색으로 채운 DataTexture.
 * (캔버스는 투명 픽셀 RGB를 0으로 저장 → 밉맵에서 잎 가장자리가 검게 번지는 문제 방지)
 */
function dilatedAlphaTexture(ctx, S) {
  const img = ctx.getImageData(0, 0, S, S);
  const src = img.data;
  const rgb = new Float32Array(S * S * 3);
  const filled = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    if (src[i * 4 + 3] > 8) { filled[i] = 1; rgb[i * 3] = src[i * 4]; rgb[i * 3 + 1] = src[i * 4 + 1]; rgb[i * 3 + 2] = src[i * 4 + 2]; }
  }
  for (let pass = 0; pass < 12; pass++) {
    const next = filled.slice();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        if (x > 0 && filled[i - 1]) { r += rgb[(i - 1) * 3]; g += rgb[(i - 1) * 3 + 1]; b += rgb[(i - 1) * 3 + 2]; n++; }
        if (x < S - 1 && filled[i + 1]) { r += rgb[(i + 1) * 3]; g += rgb[(i + 1) * 3 + 1]; b += rgb[(i + 1) * 3 + 2]; n++; }
        if (y > 0 && filled[i - S]) { r += rgb[(i - S) * 3]; g += rgb[(i - S) * 3 + 1]; b += rgb[(i - S) * 3 + 2]; n++; }
        if (y < S - 1 && filled[i + S]) { r += rgb[(i + S) * 3]; g += rgb[(i + S) * 3 + 1]; b += rgb[(i + S) * 3 + 2]; n++; }
        if (n) { rgb[i * 3] = r / n; rgb[i * 3 + 1] = g / n; rgb[i * 3 + 2] = b / n; next[i] = 1; }
      }
    }
    filled.set(next);
  }
  // 아래위 뒤집기 (CanvasTexture flipY 와 같은 방향: 캔버스 위쪽 = v 1)
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x, o = ((S - 1 - y) * S + x) * 4;
      out[o] = rgb[i * 3]; out[o + 1] = rgb[i * 3 + 1]; out[o + 2] = rgb[i * 3 + 2];
      out[o + 3] = src[i * 4 + 3];
    }
  }
  const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
