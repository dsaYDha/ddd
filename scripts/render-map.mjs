// 생성된 맵을 위에서 본 PNG로 출력 (지면 종류 + 음영 + 식생·장애물)
// 사용: node scripts/render-map.mjs [출력경로] [배율]
import fs from 'node:fs';
import { generateWorld, sampleBilinear } from '../src/world/WorldGen.js';
import { encodePNG } from './png.mjs';
import { CONFIG } from '../src/config.js';

const out = process.argv[2] || 'map.png';
const scale = Number(process.argv[3] || 2); // 픽셀/m
const data = generateWorld(CONFIG.world.seed);
console.log('timings(ms)', Object.fromEntries(Object.entries(data.timings).map(([k, v]) => [k, Math.round(v)])));
const counts = Object.fromEntries(Object.entries(data.placements).map(([k, v]) => [k, v.length]));
console.log('placements', counts, 'circles', data.circles.length, 'supports', data.supports.length);

const COLORS = [
  [196, 150, 96],  // packedDirt
  [92, 84, 52],    // leafLitter
  [110, 86, 60],   // wetEarth
  [120, 84, 50],   // shallowMud
  [70, 48, 30],    // deepMud
  [96, 120, 80],   // paddy
  [70, 130, 150],  // shallowWater
  [30, 70, 120],   // deepWater
  [150, 170, 70],  // brush
];
const { size, half, sN, sRes, hN, hRes } = data;
const W = size * scale;
const img = new Uint8Array(W * W * 3);
const H = data.height;
for (let py = 0; py < W; py++) {
  for (let px = 0; px < W; px++) {
    const x = -half + (px + 0.5) / scale, z = -half + (py + 0.5) / scale;
    const si = Math.min(sN - 1, Math.floor((z + half) / sRes)) * sN + Math.min(sN - 1, Math.floor((x + half) / sRes));
    const c = COLORS[data.surface[si]];
    const h = sampleBilinear(H, hN, hRes, half, x, z);
    const hx = sampleBilinear(H, hN, hRes, half, x + 1, z) - sampleBilinear(H, hN, hRes, half, x - 1, z);
    const hz = sampleBilinear(H, hN, hRes, half, x, z + 1) - sampleBilinear(H, hN, hRes, half, x, z - 1);
    const shade = Math.max(0.35, Math.min(1.4, 1 + (-hx * 0.6 - hz * 0.4) * 0.45));
    const slope = Math.atan(Math.hypot(hx, hz) / 2) * 57.3;
    let r = c[0] * shade, g = c[1] * shade, b = c[2] * shade;
    if (slope > 35) { r = r * 0.6 + 90; g = g * 0.6 + 20; b = b * 0.6 + 20; }
    const contour = (h % 2 + 2) % 2 < 0.08 / 1 ? 0.8 : 1;
    const o = (py * W + px) * 3;
    img[o] = Math.min(255, r * contour); img[o + 1] = Math.min(255, g * contour); img[o + 2] = Math.min(255, b * contour);
  }
}
const dot = (x, z, rad, col) => {
  const cx = (x + half) * scale, cz = (z + half) * scale, rr = rad * scale;
  for (let py = Math.floor(cz - rr); py <= cz + rr; py++) for (let px = Math.floor(cx - rr); px <= cx + rr; px++) {
    if (px < 0 || py < 0 || px >= W || py >= W) continue;
    if ((px - cx) ** 2 + (py - cz) ** 2 > rr * rr) continue;
    const o = (py * W + px) * 3; img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2];
  }
};
for (const t of data.placements.bigTree) dot(t.x, t.z, 1.2, [20, 60, 20]);
for (const t of data.placements.palm) dot(t.x, t.z, 0.6, [60, 140, 40]);
for (const t of data.placements.banana) dot(t.x, t.z, 0.4, [140, 200, 60]);
for (const t of data.placements.bamboo) dot(t.x, t.z, t.radius, [180, 200, 90]);
for (const s of data.supports) {
  if (s.type === 'log') for (let k = 0; k <= 10; k++) dot(s.ax + (s.bx - s.ax) * k / 10, s.az + (s.bz - s.az) * k / 10, s.r, [60, 30, 10]);
  if (s.type === 'rock') dot(s.cx, s.cz, Math.max(s.rx, s.rz) * 0.8, [140, 140, 140]);
}
const st = CONFIG.world.start;
dot(st.x, st.z, 2.5, [255, 0, 0]);
for (const p of data.testPoints) dot(p.x, p.z, 1.6, [255, 0, 255]);
// 150m 반경
for (let a = 0; a < 6.283; a += 0.002) dot(st.x + Math.cos(a) * 150, st.z + Math.sin(a) * 150, 0.4, [255, 60, 60]);
fs.writeFileSync(out, encodePNG(W, W, img));
console.log(`저장: ${out}`);
