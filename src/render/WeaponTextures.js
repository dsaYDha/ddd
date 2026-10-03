// 1인칭 무기·팔 모델용 절차적 텍스처 — 외부 이미지 파일 없음 (픽셀 계산·캔버스)
//  - 총 세부 텍스처 (RGBA, 이음매 없음): R 금속 결·미세 흠집·패임, G 나뭇결(합판 결·물관), B 그립 체커링, A 때·얼룩
//  - 팔 세부 텍스처 (RGBA, 이음매 없음): R 천 짜임(능직 + 립스톱 격자), G 피부결, B 천 주름, A 때·땀 얼룩
//  - 총구 화염 (캔버스): 왼쪽 절반 = 정면에서 본 별 모양 화염, 오른쪽 절반 = 옆에서 본 불꽃 기둥
//  세부 텍스처는 색이 아니라 '무늬 값'(0~1)만 담는다 — 실제 색은 정점색이고, 무늬를 어디에 어떻게 쓸지는
//  WeaponView 의 셰이더 패치가 재질 종류(kind)별로 정한다. 알파 채널에 값을 담으므로 캔버스(미리 곱한 알파)
//  대신 DataTexture 로 만든다 — 알파가 낮은 곳의 RGB 가 깎이지 않게.
import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const frac = (v) => v - Math.floor(v);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

// ---------------------------------------------------------------
// 주기적(타일링) 그래디언트 노이즈 — 격자 좌표를 주기로 감아 이음매가 없다
// ---------------------------------------------------------------
class PeriodicNoise {
  constructor(seed) {
    const rng = new RNG(seed);
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rng.float() * TAU;
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

  /** u,v ∈ [0,1) 텍스처 좌표, cx,cy = 기본 격자 수 (정수 → 이음매 없음) */
  fbm(u, v, cx, cy, oct = 4, gain = 0.5) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) {
      s += a * this.noise(u * cx * f, v * cy * f, cx * f, cy * f);
      n += a; a *= gain; f *= 2;
    }
    return s / n;
  }
}

/** 채널 배열 4개(0~1) → RGBA DataTexture (반복, 밉맵, 선형 값 — 색 공간 변환 없음) */
function packTexture(chs, S, anisotropy = 4) {
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(clamp01(chs[c][i]) * 255);
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** 감싸는(타일) 좌표에 부드러운 점 하나 — mode 'max' 는 밝게 긋기, 'min' 은 어둡게 찍기 */
function stamp(arr, S, x, y, val, radius, mode) {
  const r = Math.max(0.5, radius);
  const x0 = Math.floor(x - r - 1), x1 = Math.ceil(x + r + 1);
  const y0 = Math.floor(y - r - 1), y1 = Math.ceil(y + r + 1);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      const k = 1 - sstep(r * 0.4, r + 0.6, d);
      if (k <= 0) continue;
      const i = (((py % S) + S) % S) * S + (((px % S) + S) % S);
      if (mode === 'max') arr[i] = Math.max(arr[i], arr[i] + (val - arr[i]) * k);
      else arr[i] = Math.min(arr[i], arr[i] + (val - arr[i]) * k);
    }
  }
}

// ---------------------------------------------------------------
// 총 세부 텍스처
//  R: 금속 — 0.5 근처의 잔 얼룩 + 길이 방향(u)으로 난 밝은 흠집(맨 쇠가 드러남, 0.75 이상) + 어두운 패임
//  G: 나뭇결 — u 방향으로 흐르는 합판 결 (어두운 가는 결 + 섬유) + 물관 자국
//  B: 체커링 — 다이아몬드 피라미드 (그립 손잡이 미끄럼 방지 무늬)
//  A: 때 — 낮은 주파수 얼룩 (손때·진흙이 마른 자국)
// ---------------------------------------------------------------
export function createRifleDetailTexture(size = 512, seed = 9101) {
  const S = size;
  const n1 = new PeriodicNoise(seed), n2 = new PeriodicNoise(seed + 7), n3 = new PeriodicNoise(seed + 13);
  const rng = new RNG(seed);
  const R = new Float32Array(S * S), G = new Float32Array(S * S), B = new Float32Array(S * S), A = new Float32Array(S * S);
  const CHECK = 24;   // 타일 한 장에 들어가는 체커링 줄 수 (정수 → 이음매 없음)
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;
      // 금속: 아주 잔 얼룩 + 조금 큰 얼룩
      R[i] = 0.5 + 0.13 * n1.fbm(u, v, 48, 48, 3) + 0.07 * n2.fbm(u, v, 6, 6, 2);
      // 나뭇결: 결이 u 방향으로 흐르고 v 방향으로 촘촘하다. 결 위치를 저주파 노이즈로 휘게 한다
      const warp = n2.fbm(u + 0.37, v + 0.11, 2, 6, 3);
      const ln = 0.5 + 0.5 * Math.sin(TAU * (v * 18 + warp * 1.3));
      const fiber = n3.fbm(u, v, 4, 96, 2);
      const band = n1.fbm(u + 0.2, v, 1, 5, 2);
      G[i] = 0.6 + 0.16 * fiber + 0.12 * band - 0.34 * Math.pow(ln, 7) - 0.08 * Math.pow(1 - ln, 10);
      // 체커링: (u+v), (u−v) 방향 삼각파의 최솟값 → 다이아몬드 피라미드
      const a = frac((u + v) * CHECK), b = frac((u - v) * CHECK);
      B[i] = Math.min(1 - Math.abs(a * 2 - 1), 1 - Math.abs(b * 2 - 1));
      // 때
      const g = n3.fbm(u + 0.5, v + 0.25, 5, 5, 4);
      A[i] = sstep(-0.05, 0.5, g) * (0.75 + 0.25 * n1.fbm(u, v, 24, 24, 2));
    }
  }
  // 흠집: 대부분 총 길이 방향(u), 일부는 아무 방향. 끝으로 갈수록 옅어진다
  const k = S / 512;
  for (let s = 0; s < 170; s++) {
    const x0 = rng.float() * S, y0 = rng.float() * S;
    const ang = rng.chance(0.72) ? rng.range(-0.22, 0.22) : rng.range(0, Math.PI);
    const len = rng.range(5, 46) * k;
    const val = rng.range(0.78, 0.95);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let t = 0; t < len; t += 0.5) stamp(R, S, x0 + ca * t, y0 + sa * t, 0.5 + (val - 0.5) * (1 - 0.6 * t / len), 0.55 * k, 'max');
  }
  // 패임 (녹·부식 점)
  for (let s = 0; s < 1100; s++) stamp(R, S, rng.float() * S, rng.float() * S, rng.range(0.18, 0.36), rng.range(0.4, 1.0) * k, 'min');
  // 물관 자국: 결 방향으로 짧은 어두운 줄
  for (let s = 0; s < 1600; s++) {
    const x0 = rng.float() * S, y0 = rng.float() * S, len = rng.range(2, 9) * k;
    for (let t = 0; t < len; t += 0.7) stamp(G, S, x0 + t, y0, 0.3, 0.45 * k, 'min');
  }
  return packTexture([R, G, B, A], S, 4);
}

// ---------------------------------------------------------------
// 팔 세부 텍스처
//  R: 천 — 능직 사선 + 실 교차 + 립스톱 격자(굵은 실)
//  G: 피부 — 모공·잔주름 + 얼룩덜룩한 혈색
//  B: 주름 — u(둘레) 방향으로 길쭉한 능선 노이즈 (소매 주름 음영·요철)
//  A: 때 — 진흙·땀 얼룩
// ---------------------------------------------------------------
export function createArmsDetailTexture(size = 512, seed = 9202) {
  const S = size;
  const n1 = new PeriodicNoise(seed), n2 = new PeriodicNoise(seed + 5), n3 = new PeriodicNoise(seed + 11);
  const R = new Float32Array(S * S), G = new Float32Array(S * S), B = new Float32Array(S * S), A = new Float32Array(S * S);
  const TW = 56, RIP = 14;   // 타일당 능직 사선 수, 립스톱 격자 수
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const i = y * S + x;
      const tw = 0.5 + 0.5 * Math.sin(TAU * (u + v) * TW);
      const cross = Math.sin(TAU * u * TW * 2) * Math.sin(TAU * v * TW * 2);
      const du = frac(u * RIP), dv = frac(v * RIP);
      const d = Math.min(du, 1 - du, dv, 1 - dv);
      const rip = 1 - sstep(0.0, 0.07, d);
      R[i] = 0.42 + 0.24 * tw + 0.08 * cross + 0.22 * rip + 0.08 * n1.fbm(u, v, 32, 32, 2);
      G[i] = 0.5 + 0.22 * n2.fbm(u, v, 64, 64, 2) + 0.18 * n3.fbm(u, v, 4, 4, 3);
      // 주름: 능선 노이즈 (1 − |n|) — 둘레 방향(u)으로 길게
      const f = n1.fbm(u + 0.3, v + 0.6, 3, 10, 3);
      B[i] = clamp01(0.25 + 0.75 * Math.pow(1 - Math.abs(f), 3) + 0.1 * n2.fbm(u, v, 6, 20, 2));
      const g = n3.fbm(u + 0.15, v + 0.4, 4, 4, 4);
      A[i] = sstep(0.0, 0.55, g) * (0.7 + 0.3 * n2.fbm(u, v, 20, 20, 2));
    }
  }
  return packTexture([R, G, B, A], S, 4);
}

// ---------------------------------------------------------------
// 총구 화염 — 검은 바탕(가산 혼합이라 검정 = 투명)
//  왼쪽 절반: 정면에서 본 화염 (밝은 핵 + 불규칙한 꽃잎·가시)
//  오른쪽 절반: 옆에서 본 불꽃 (왼쪽 끝 = 총구, 오른쪽으로 뻗어 나감)
// ---------------------------------------------------------------
export function createFlashTexture(size = 256, seed = 9303) {
  const c = document.createElement('canvas');
  c.width = size * 2; c.height = size;
  const ctx = c.getContext('2d');
  const rng = new RNG(seed);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size * 2, size);
  ctx.globalCompositeOperation = 'lighter';

  // --- 정면
  const cx = size / 2, cy = size / 2, R0 = size / 2;
  const petals = 7;
  for (let p = 0; p < petals; p++) {
    const ang = (p / petals) * TAU + rng.range(-0.25, 0.25);
    const len = R0 * rng.range(0.55, 0.95);
    const wid = rng.range(0.16, 0.3);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, len);
    g.addColorStop(0, 'rgba(255,240,200,0.95)');
    g.addColorStop(0.35, 'rgba(255,170,70,0.75)');
    g.addColorStop(1, 'rgba(120,40,5,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang - wid) * R0 * 0.12, cy + Math.sin(ang - wid) * R0 * 0.12);
    ctx.quadraticCurveTo(cx + Math.cos(ang - wid * 0.4) * len * 0.6, cy + Math.sin(ang - wid * 0.4) * len * 0.6, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.quadraticCurveTo(cx + Math.cos(ang + wid * 0.4) * len * 0.6, cy + Math.sin(ang + wid * 0.4) * len * 0.6, cx + Math.cos(ang + wid) * R0 * 0.12, cy + Math.sin(ang + wid) * R0 * 0.12);
    ctx.closePath();
    ctx.fill();
  }
  // 가는 가시 (불티 줄기)
  ctx.lineCap = 'round';
  for (let p = 0; p < 14; p++) {
    const ang = rng.float() * TAU, len = R0 * rng.range(0.35, 0.98);
    ctx.strokeStyle = `rgba(255,${(150 + rng.float() * 80) | 0},60,${rng.range(0.25, 0.55).toFixed(2)})`;
    ctx.lineWidth = rng.range(1, 3) * size / 256;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R0 * 0.42);
  core.addColorStop(0, 'rgba(255,255,245,1)');
  core.addColorStop(0.3, 'rgba(255,235,170,0.9)');
  core.addColorStop(1, 'rgba(255,150,40,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  // --- 옆 (x: 0 = 총구 → size 끝). 오른쪽 절반으로 잘라 그림 — 타원이 왼쪽(정면 별) 칸으로 번지면
  //     큰 정면 판 가장자리에 잘린 밝은 쐐기로 보였다
  const ox = size, oy = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, 0, size, size);
  ctx.clip();
  for (let k = 0; k < 9; k++) {
    const t = k / 8;
    const px = ox + size * (0.06 + t * 0.62);
    const rx = size * (0.12 + 0.24 * (1 - Math.abs(t - 0.35) * 1.4));
    const ry = size * (0.07 + 0.18 * Math.sin(Math.min(1, t * 1.5 + 0.15) * Math.PI)) * rng.range(0.8, 1.15);
    const g = ctx.createRadialGradient(px, oy, 0, px, oy, Math.max(rx, ry));
    const a = 0.55 * (1 - t * 0.75);
    g.addColorStop(0, `rgba(255,${(230 - t * 90) | 0},${(150 - t * 110) | 0},${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(120,30,0,0)');
    ctx.save();
    ctx.translate(px, oy + rng.range(-0.03, 0.03) * size);
    ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
    ctx.translate(-px, -oy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, oy, Math.max(rx, ry), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  // 총구 바로 앞 밝은 핵
  const sc = ctx.createRadialGradient(ox + size * 0.08, oy, 0, ox + size * 0.08, oy, size * 0.22);
  sc.addColorStop(0, 'rgba(255,255,240,1)');
  sc.addColorStop(0.4, 'rgba(255,210,120,0.7)');
  sc.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = sc;
  ctx.fillRect(ox, 0, size, size);
  // 총구 쪽 끝(u = 0.5)을 검게 녹임: 핵이 가장자리까지 밝아서 옆 불꽃 판의 앞끝이 칼로 자른 듯한 밝은 직선으로 보였다
  // (화염은 깊이 검사 없이 총 위에 그려지므로 판 끝이 그대로 드러남). 바탕이 불투명 검정이라 검정 덧칠 = 밝기 × (1 − α)
  ctx.globalCompositeOperation = 'source-over';
  const edge = ctx.createLinearGradient(ox, 0, ox + size * 0.12, 0);
  edge.addColorStop(0, 'rgba(0,0,0,1)');
  edge.addColorStop(0.45, 'rgba(0,0,0,0.4)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(ox, 0, size * 0.12, size);
  ctx.restore();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}
