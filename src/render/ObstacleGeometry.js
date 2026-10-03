// 장애물 지오메트리: 쓰러진 통나무·드러난 뿌리 (X축 길이 1, 반경 1 — capsuleMatrix 로 배치), 바위
//  통나무: 울퉁불퉁한 원통 + 군데군데 벗겨진 껍질(aPeel 1) + 쪼개진 마구리(aPeel 2, 나이테) + 부러진 가지 그루터기
//  버섯·선반 버섯은 늘어나지 않도록 통나무마다 월드 좌표로 만들어 합친다 (buildLogDetails)
//  바위: 영역 왜곡 노이즈로 깎은 불규칙한 덩어리, 아래는 평평하게 묻힘 (색은 셰이더에서 월드 좌표 삼면 투영)
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { Noise2D } from '../core/noise.js';
import { MeshBuilder } from './MeshBuilder.js';
import { BARK_ATTRS, addGrid } from './TreeBuilder.js';

const TAU = Math.PI * 2;

/**
 * @param {number} variant 0·1: 통나무, 2: 오래 썩은 통나무, 3: 뿌리
 * @param {number} lod
 */
export function buildLog(variant, lod = 0) {
  const rng = new RNG(9000 + variant * 7);
  const noise = new Noise2D(9100 + variant);
  const mb = new MeshBuilder(BARK_ATTRS);
  const root = variant === 3;
  const radial = lod === 0 ? (root ? 8 : 14) : (root ? 5 : 7);
  const segs = lod === 0 ? (root ? 6 : 10) : 3;
  const rot = variant === 2;
  // 껍질이 벗겨진 띠 (둘레 방향 각도 구간 × 길이 구간)
  const peels = [];
  if (!root) {
    const n = rot ? 5 : rng.int(2, 3);
    for (let i = 0; i < n; i++) peels.push({ a: rng.range(0, TAU), w: rng.range(0.5, 1.4), x0: rng.range(-0.45, 0.2), x1: 0 });
    for (const p of peels) p.x1 = p.x0 + rng.range(0.15, 0.4);
  }
  const peelAt = (a, x) => {
    for (const p of peels) {
      const d = Math.abs(((a - p.a) % TAU + TAU + Math.PI) % TAU - Math.PI);
      if (d < p.w * 0.5 && x > p.x0 && x < p.x1) return 1;
    }
    return 0;
  };
  const radius = (a, x) => {
    let r = 1 + 0.07 * noise.fbm(Math.cos(a) * 1.5 + x * 3, Math.sin(a) * 1.5, 3) + 0.04 * noise.simplex(x * 12, a * 2);
    if (rot) r *= 1 - 0.12 * Math.max(0, noise.simplex(x * 4 + 3, a)) ;
    if (!root && peelAt(a, x)) r *= 0.93;               // 벗겨진 곳은 살짝 들어감
    if (root) r *= 1 - 0.35 * (x + 0.5);                 // 뿌리는 끝으로 가늘어짐
    return r;
  };
  // 몸통 격자 (행: 길이, 열: 둘레)
  const xs = [];
  for (let i = 0; i <= segs; i++) xs.push(-0.5 + i / segs);
  const tone = rot ? [0.72, 0.66, 0.58] : root ? [0.85, 0.78, 0.68] : [0.95, 0.9, 0.82];
  mb.set('aPeel', 0);
  addGrid(mb, xs.length, radial, (i, j, jj) => {
    const x = xs[i];
    const a = (j / radial) * TAU;
    const r = radius(a, x);
    const pe = peelAt(a, x);
    mb.set('aPeel', pe);
    const endDark = Math.min(1, Math.min(x + 0.5, 0.5 - x) * 8 + 0.4);
    return {
      p: [x, Math.cos(a) * r, Math.sin(a) * r],
      uv: [(jj / radial) * 1.0, x * 1.6],
      c: [tone[0] * endDark, tone[1] * endDark, tone[2] * endDark],
      moss: rot ? 0.5 : 0.15,
    };
  }, { wrap: true, flip: true });
  // 마구리 (쪼개진 단면, 나이테) — 뿌리는 끝을 닫지 않음(땅속)
  if (!root) {
    for (const end of [-0.5, 0.5]) {
      const s = Math.sign(end);
      mb.set('aPeel', 2); mb.set('aMoss', 0);
      const ctr = mb.vertex(end + s * 0.02, 0, 0, s, 0, 0, 0.5, 0.5, 1, 1, 1);
      const base = mb.count;
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * TAU;
        const r = radius(a, end) * 0.99;
        // 쪼개진 끝: 반경 방향으로 들쭉날쭉
        const jag = (rng.float() - 0.5) * 0.12 + (k % 2 ? 0.04 : -0.03);
        mb.vertex(end + s * jag, Math.cos(a) * r, Math.sin(a) * r, s, 0, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 1, 1, 1);
      }
      for (let k = 0; k < radial; k++) {
        if (s > 0) mb.tri(ctr, base + k, base + k + 1); else mb.tri(ctr, base + k + 1, base + k);
      }
    }
    // 부러진 가지 그루터기
    if (lod === 0) {
      mb.set('aPeel', 0); mb.set('aMoss', 0.3);
      const stubs = rng.int(1, 3);
      for (let k = 0; k < stubs; k++) {
        const x = rng.range(-0.35, 0.35), a = rng.range(-1.2, 1.2) + (rng.chance(0.5) ? 0 : Math.PI);
        const dir = new THREE.Vector3(rng.range(-0.3, 0.3), Math.cos(a), Math.sin(a)).normalize();
        const base = new THREE.Vector3(x, Math.cos(a) * 0.85, Math.sin(a) * 0.85);
        const len = rng.range(0.6, 1.4);
        const r0 = rng.range(0.12, 0.22);
        const ring = (p, r, cnt) => {
          const t1 = new THREE.Vector3(1, 0, 0).cross(dir).normalize();
          const t2 = dir.clone().cross(t1).normalize();
          const out = [];
          for (let q = 0; q <= cnt; q++) {
            const b = (q / cnt) * TAU;
            const n = t1.clone().multiplyScalar(Math.cos(b)).add(t2.clone().multiplyScalar(Math.sin(b)));
            out.push(mb.vertex(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r, n.x, n.y, n.z, q / cnt, 0, tone[0], tone[1], tone[2]));
          }
          return out;
        };
        const r1 = ring(base, r0, 5), r2 = ring(base.clone().addScaledVector(dir, len), r0 * 0.55, 5);
        for (let q = 0; q < 5; q++) mb.quad(r1[q], r1[q + 1], r2[q + 1], r2[q]);
      }
    }
  }
  return mb.build();
}

/**
 * 통나무마다 버섯·선반 버섯 (월드 좌표) — 늘어남 없이 한 메시로 합침.
 * @param {Array} logs  Flora 의 P.log (ax..bz, r)
 */
export function buildLogDetails(logs, seed = 31) {
  const rng = new RNG(seed);
  const mb = new MeshBuilder(BARK_ATTRS);
  mb.set('aPeel', 3);
  const half = new THREE.SphereGeometry(1, 6, 3, 0, TAU, 0, Math.PI / 2);
  const cap = new THREE.SphereGeometry(1, 5, 2, 0, TAU, 0, Math.PI / 2);
  const stem = new THREE.CylinderGeometry(0.15, 0.2, 1, 5, 1);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (const L of logs) {
    if (!rng.chance(0.7)) continue;
    const ax = L.ax, ay = L.ay, az = L.az, dx = L.bx - L.ax, dy = L.by - L.ay, dz = L.bz - L.az;
    const len = Math.hypot(dx, dy, dz);
    const along = new THREE.Vector3(dx, dy, dz).normalize();
    const side = new THREE.Vector3(-along.z, 0, along.x).normalize();
    // 선반 버섯 (옆면에 층층이)
    const shelves = rng.int(0, 4);
    const fungusCol = rng.chance(0.5) ? [0.95, 0.85, 0.65] : [0.9, 0.55, 0.3];
    for (let k = 0; k < shelves; k++) {
      const t = rng.range(0.15, 0.85), sd = rng.sign();
      const yOff = rng.range(-0.1, 0.35) * L.r;
      p.set(ax + dx * t, ay + dy * t + yOff, az + dz * t).addScaledVector(side, sd * L.r * 0.97);
      const size = rng.range(0.07, 0.16);
      const yaw = Math.atan2(side.x * sd, side.z * sd);
      q.setFromEuler(new THREE.Euler(0, yaw, 0));
      s.set(size, size * 0.35, size * 0.8);
      m.compose(p, q, s);
      mb.addGeometry(half, m, (local) => {
        const k2 = 0.75 + 0.35 * local.y;
        return [fungusCol[0] * k2, fungusCol[1] * k2, fungusCol[2] * k2];
      });
    }
    // 작은 버섯 무리 (윗면·밑동)
    if (rng.chance(0.45)) {
      const t = rng.range(0.1, 0.9);
      const base = new THREE.Vector3(ax + dx * t, ay + dy * t + L.r * 0.92, az + dz * t);
      const n = rng.int(3, 7);
      for (let k = 0; k < n; k++) {
        const h = rng.range(0.04, 0.09), cr = rng.range(0.025, 0.05);
        const o = base.clone().add(new THREE.Vector3(rng.range(-0.12, 0.12), 0, rng.range(-0.12, 0.12)));
        m.compose(o.clone().add(new THREE.Vector3(0, h / 2, 0)), q.identity(), s.set(cr * 0.5, h, cr * 0.5));
        mb.addGeometry(stem, m, () => [0.9, 0.86, 0.78]);
        m.compose(o.clone().add(new THREE.Vector3(0, h, 0)), q.identity(), s.set(cr, cr * 0.6, cr));
        const cc = rng.chance(0.6) ? [0.75, 0.55, 0.38] : [0.92, 0.88, 0.8];
        mb.addGeometry(cap, m, () => cc);
      }
    }
    void len;
  }
  return mb.count ? mb.build() : null;
}

/** 바위 (반지름 1 기준, 배치에서 rx·ry·rz 로 늘림) */
export function buildRock(variant, lod = 0) {
  const noise = new Noise2D(9500 + variant * 3);
  const warp = new Noise2D(9600 + variant * 3);
  const ico = new THREE.IcosahedronGeometry(1, lod === 0 ? 4 : 2);
  const mb = new MeshBuilder(BARK_ATTRS);
  mb.addGeometry(ico, new THREE.Matrix4(), () => [1, 1, 1]);
  const p = mb.pos;
  // 영역 왜곡 노이즈로 깎고, 층리 방향으로 살짝 각지게, 아래쪽은 평평하게
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const wx = warp.fbm(x * 1.1 + 3, z * 1.1 + y, 2) * 0.45, wz = warp.fbm(z * 1.1 - 4, x * 1.1 - y, 2) * 0.45;
    const n = noise.fbm(x * 1.3 + wx, z * 1.3 + wz + y * 0.9, 4);
    const ridge = 1 - Math.abs(noise.simplex(x * 2.4 + wz, y * 2.4 + wx));
    let k = 1 + 0.26 * n + 0.08 * ridge * ridge;
    // 평평한 면 (절리)
    const facet = Math.max(0, x * 0.8 + y * 0.6 - 0.55);
    k -= facet * 0.5;
    let ny = y * k;
    if (ny < -0.35) ny = -0.35 + (ny + 0.35) * 0.25;
    p[i] = x * k; p[i + 1] = ny; p[i + 2] = z * k;
  }
  // 이끼: 위쪽과 노이즈
  const ex = mb.extra.aMoss.data;
  for (let v = 0; v < mb.count; v++) {
    const y = p[v * 3 + 1];
    ex[v] = Math.max(0, Math.min(1, (y - 0.1) * 1.2)) * 0.6;
  }
  const g = mb.build();
  g.computeVertexNormals();
  return g;
}
