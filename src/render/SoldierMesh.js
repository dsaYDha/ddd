// 4단계 적 병사 화면 모델 — 판정 캡슐(Hitboxes.buildHitboxes)과 '같은 캡슐'로 만든 몸 + 천 모자(부니햇) + 탄띠 + 소총/경기관총.
//  · TargetMesh 마네킹과 같은 방식: 자세(서기·앉기·엎드리기·전환 진행도·쓰러짐)를 발 원점·yaw 0 국소 좌표로 buildHitboxes →
//    캡슐 표면에 꼭짓점 → 위치·yaw·쓰러짐 회전만 걸면 판정과 정확히 겹친다 (보이는 몸 = 맞는 몸).
//  · 정글 위장복: 꼭짓점 'camo' 속성이 있는 천(상의·하의·모자)에 셰이더가 국소 좌표 3D 잡음으로 짙은 녹색·갈색·검은 줄 얼룩을 칠함
//    (몸에 붙은 무늬 — 걸어도 미끄러지지 않음). 국적 표지·깃발 없음.
//  · 개인차: 변형(variant) 0~5 → 군복 바탕색·무늬 시드·피부색·모자(위장/단색)·체격(팔다리 굵기 ±6% — 화면만, 판정은 표준).
//  · 무기: 'rifle' 은 손 위치(오른손 권총손잡이, 왼손 총열덮개)에 맞춘 개머리판·몸통·곡선 탄창·총열덮개·총열,
//    'lmg' 는 더 길고 굵은 몸통·상자 탄통·접힌 양각대. 몸과 같은 지오메트리 (병사 하나 = 그리기 1번).
//  · 지오메트리는 (변형, 무기, 자세 모양 키)로 캐시 — 같은 모양 병사끼리 공유, 매 프레임 새로 만들지 않음.
//  · 구덩이(EnemyManager.pits): 어두운 구멍 + 낮은 흙·낙엽 둔덕 (병사는 pitDepth 만큼 내려가 머리·어깨만 보임).
import * as THREE from 'three';
import { buildHitboxes } from '../combat/Hitboxes.js';
import { addPatch, patchCanopy } from './Materials.js';

const RADIAL = 10;          // 캡슐 둘레 분할 (적은 멀리서 보는 경우가 많아 마네킹보다 조금 적게)
const CAP_RINGS = 4;        // 반구 위도 분할

const C = (hex) => new THREE.Color(hex);
// 변형: 군복 바탕(위장 무늬의 밝은 색)·하의 배율·피부·모자 무늬 여부·체격
const VARIANTS = [
  { cloth: C('#5d6640'), trousersK: 0.9, skin: C('#9a7b5c'), camoHat: true, build: 1.0 },
  { cloth: C('#646a46'), trousersK: 0.85, skin: C('#8a6b4e'), camoHat: false, build: 1.05 },
  { cloth: C('#55603d'), trousersK: 0.92, skin: C('#a68566'), camoHat: true, build: 0.95 },
  { cloth: C('#6b6a45'), trousersK: 0.88, skin: C('#7d5f45'), camoHat: true, build: 1.02 },
  { cloth: C('#596245'), trousersK: 0.86, skin: C('#94755a'), camoHat: false, build: 0.97 },
  { cloth: C('#60653f'), trousersK: 0.9, skin: C('#88684c'), camoHat: true, build: 1.06 },
];
const GEAR = {
  belt: C('#3a3726'), pouch: C('#4a4a30'), boot: C('#2a241b'), hatPlain: C('#5c5d3c'),
  metal: C('#1c1d1c'), furniture: C('#2a2b24'), wood: C('#4a3424'), mag: C('#222320'),
};
// 7단계 아군: 다른 위장복 (둥근 잎 무늬 — 셰이더 camo 값 100 이상) + 철모 (천 덮개). 국적 표지 없음.
const ALLY_VARIANTS = [
  { cloth: C('#626c45'), trousersK: 0.92, skin: C('#b08d6c'), helmet: C('#4c5233'), build: 1.0 },
  { cloth: C('#5d6844'), trousersK: 0.9, skin: C('#8f6c4f'), helmet: C('#50563a'), build: 1.04 },
  { cloth: C('#677049'), trousersK: 0.9, skin: C('#c29d7c'), helmet: C('#474d30'), build: 0.97 },
  { cloth: C('#5a6441'), trousersK: 0.94, skin: C('#9c7a5b'), helmet: C('#4e5436'), build: 1.03 },
  { cloth: C('#636b47'), trousersK: 0.9, skin: C('#7b5b40'), helmet: C('#4a5034'), build: 0.98 },
  { cloth: C('#5f6943'), trousersK: 0.91, skin: C('#a8866a'), helmet: C('#4d5335'), build: 1.05 },
];

// ---------------------------------------------------------------
// 셰이더: 정글 위장 무늬 (camo > 0.5 인 꼭짓점 — 값 자체가 무늬 시드)
// ---------------------------------------------------------------
function patchCamo(material) {
  return addPatch(material, 'soldierCamo2', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float camo;\nvarying float vCamo;\nvarying vec3 vCamoP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCamo = camo;\n  vCamoP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vCamo;
varying vec3 vCamoP;
float camoH( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float camoN( vec3 x ) {
  vec3 i = floor( x ); vec3 f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( camoH( i ), camoH( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( camoH( i + vec3( 0.0, 1.0, 0.0 ) ), camoH( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
              mix( mix( camoH( i + vec3( 0.0, 0.0, 1.0 ) ), camoH( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( camoH( i + vec3( 0.0, 1.0, 1.0 ) ), camoH( i + 1.0 ), f.x ), f.y ), f.z );
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if ( vCamo > 100.5 ) {
    // 7단계 아군: 둥근 잎 얼룩 (밝은 녹색 바탕 + 갈색·짙은 녹색·작은 검은 점) — 가까이선 달라 보이고, 멀리·어두우면 비슷한 올리브색
    vec3 cp = vCamoP * vec3( 5.6 ) + vCamo * vec3( 1.31, 2.17, 0.73 );
    float n1 = camoN( cp ) * 0.6 + camoN( cp * 2.1 + 5.3 ) * 0.4;
    float n2 = camoN( cp * 1.2 + 17.0 ) * 0.6 + camoN( cp * 2.7 + 9.0 ) * 0.4;
    vec3 base = diffuseColor.rgb;
    vec3 c = mix( base, base * vec3( 0.95, 0.72, 0.52 ), smoothstep( 0.5, 0.54, n2 ) );   // 갈색 잎
    c = mix( c, base * vec3( 0.5, 0.62, 0.42 ), smoothstep( 0.55, 0.59, n1 ) );          // 짙은 녹색
    c = mix( c, base * 0.25, smoothstep( 0.73, 0.76, n1 ) );                              // 검은 점
    diffuseColor.rgb = c;
  } else if ( vCamo > 0.5 ) {
    // 가로로 길쭉한 얼룩 (호랑이 줄무늬 계열) — 국소 좌표 m 기준
    vec3 cp = vCamoP * vec3( 4.2, 8.5, 4.2 ) + vCamo * vec3( 7.31, 3.17, 5.73 );
    float n1 = camoN( cp ) * 0.62 + camoN( cp * 2.3 + 3.1 ) * 0.38;
    float n2 = camoN( cp * 1.35 + 11.0 ) * 0.6 + camoN( cp * 3.1 + 7.0 ) * 0.4;
    vec3 base = diffuseColor.rgb;
    vec3 c = mix( base, base * vec3( 1.0, 0.74, 0.5 ), smoothstep( 0.55, 0.6, n2 ) );   // 갈색
    c = mix( c, base * vec3( 0.42, 0.52, 0.36 ), smoothstep( 0.5, 0.55, n1 ) );          // 짙은 녹색
    c = mix( c, base * 0.2, smoothstep( 0.66, 0.7, n1 ) );                                // 검은 줄
    diffuseColor.rgb = c;
  }`);
  });
}

// ---------------------------------------------------------------
// 지오메트리 재료
// ---------------------------------------------------------------
function newBuf() { return { pos: [], nor: [], col: [], camo: [], idx: [] }; }

/** 캡슐 (TargetMesh 와 같은 꼴, 색은 colorAt(s, L) → [Color, camo]) */
function addCapsule(buf, a, b, r, colorAt) {
  let ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z;
  const L = Math.hypot(ax, ay, az);
  if (L < 1e-6) { ax = 0; ay = 1; az = 0; } else { ax /= L; ay /= L; az /= L; }
  let hx = 0, hy = 1, hz = 0;
  if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; }
  let ux = hy * az - hz * ay, uy = hz * ax - hx * az, uz = hx * ay - hy * ax;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
  const base = buf.pos.length / 3;
  const ring = (cx, cy, cz, phi) => {
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let k = 0; k <= RADIAL; k++) {
      const th = (k / RADIAL) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const nx = ax * sp + (ux * ct + vx * st) * cp;
      const ny = ay * sp + (uy * ct + vy * st) * cp;
      const nz = az * sp + (uz * ct + vz * st) * cp;
      const px = cx + nx * r, py = cy + ny * r, pz = cz + nz * r;
      buf.pos.push(px, py, pz);
      buf.nor.push(nx, ny, nz);
      const s = (px - a.x) * ax + (py - a.y) * ay + (pz - a.z) * az;
      const [c, camo] = colorAt(s, L, r);
      buf.col.push(c.r, c.g, c.b);
      buf.camo.push(camo);
    }
  };
  for (let i = 0; i <= CAP_RINGS; i++) ring(a.x, a.y, a.z, -Math.PI / 2 + (i / CAP_RINGS) * (Math.PI / 2));
  for (let i = 0; i <= CAP_RINGS; i++) ring(b.x, b.y, b.z, (i / CAP_RINGS) * (Math.PI / 2));
  const rings = (CAP_RINGS + 1) * 2, row = RADIAL + 1;
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < RADIAL; k++) {
      const p0 = base + i * row + k, p1 = p0 + 1, p2 = p0 + row + 1, p3 = p0 + row;
      buf.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
}

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** 상자: 중심 c, 축 u·v·w (단위), 반 크기 hu·hv·hw */
function addBox(buf, c, u, v, w, hu, hv, hw, color, camo = 0) {
  const faces = [
    [u, v, w, hu, hv, hw], [u.clone().negate(), v, w.clone().negate(), hu, hv, hw],
    [w, v, u.clone().negate(), hw, hv, hu], [w.clone().negate(), v, u, hw, hv, hu],
    [v, w, u, hv, hw, hu], [v.clone().negate(), w.clone().negate(), u, hv, hw, hu],
  ];
  // 면마다: 법선 n = 첫 축, 면 위 두 축 (a, b)
  for (const [n, a0, b0, hn, ha, hb] of faces) {
    const a = a0, b = b0.clone();
    // a × b 가 n 과 같은 방향이 되게 (바깥을 향한 감김)
    const cr = V3().crossVectors(a, b);
    if (cr.dot(n) < 0) b.negate();
    const base = buf.pos.length / 3;
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = c.clone().addScaledVector(n, hn).addScaledVector(a, sa * ha).addScaledVector(b, sb * hb);
      buf.pos.push(p.x, p.y, p.z);
      buf.nor.push(n.x, n.y, n.z);
      buf.col.push(color.r, color.g, color.b);
      buf.camo.push(camo);
    }
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** 원기둥 (a → b, 반경 r0 → r1), 양 끝 막음 */
function addCylinder(buf, a, b, r0, r1, color, camo = 0, radial = 8, capEnds = true) {
  const axis = V3().subVectors(b, a);
  const L = axis.length();
  if (L < 1e-6) return;
  axis.divideScalar(L);
  const h = Math.abs(axis.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
  const u = V3().crossVectors(axis, h).normalize();
  const v = V3().crossVectors(u, axis);
  const base = buf.pos.length / 3;
  const slope = (r0 - r1) / L;
  for (let k = 0; k <= radial; k++) {
    const th = (k / radial) * Math.PI * 2;
    const dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
    const n = dir.clone().addScaledVector(axis, slope).normalize();
    for (const [p, r] of [[a, r0], [b, r1]]) {
      const q = p.clone().addScaledVector(dir, r);
      buf.pos.push(q.x, q.y, q.z);
      buf.nor.push(n.x, n.y, n.z);
      buf.col.push(color.r, color.g, color.b);
      buf.camo.push(camo);
    }
  }
  // (u, v, 축) 은 왼손 좌표 → 이 순서가 바깥을 향함
  for (let k = 0; k < radial; k++) {
    const p0 = base + k * 2, p1 = p0 + 1, p2 = p0 + 3, p3 = p0 + 2;
    buf.idx.push(p0, p1, p2, p0, p2, p3);
  }
  if (!capEnds) return;
  for (const [p, r, sgn] of [[a, r0, -1], [b, r1, 1]]) {
    const c0 = buf.pos.length / 3;
    buf.pos.push(p.x, p.y, p.z); buf.nor.push(axis.x * sgn, axis.y * sgn, axis.z * sgn);
    buf.col.push(color.r, color.g, color.b); buf.camo.push(camo);
    for (let k = 0; k <= radial; k++) {
      const th = (k / radial) * Math.PI * 2;
      const q = p.clone().addScaledVector(u, Math.cos(th) * r).addScaledVector(v, Math.sin(th) * r);
      buf.pos.push(q.x, q.y, q.z); buf.nor.push(axis.x * sgn, axis.y * sgn, axis.z * sgn);
      buf.col.push(color.r, color.g, color.b); buf.camo.push(camo);
    }
    for (let k = 0; k < radial; k++) {
      if (sgn > 0) buf.idx.push(c0, c0 + 2 + k, c0 + 1 + k); else buf.idx.push(c0, c0 + 1 + k, c0 + 2 + k);
    }
  }
}

/** 부니햇: 머리 캡슐 위에 챙 넓은 천 모자 (꼭대기 → 처진 챙 양면) */
function addHat(buf, head, color, camo) {
  const a = V3(head.a.x, head.a.y, head.a.z), b = V3(head.b.x, head.b.y, head.b.z);
  const up = V3().subVectors(b, a).normalize();
  const r = head.r;
  const h = Math.abs(up.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
  const u = V3().crossVectors(up, h).normalize();
  const v = V3().crossVectors(u, up);
  const N = 14;
  const crownBot = b.clone().addScaledVector(up, -0.015), crownTop = b.clone().addScaledVector(up, r + 0.035);
  // 꼭대기 (살짝 좁아지는 원기둥 + 덮개)
  addCylinder(buf, crownBot, crownTop, r * 1.1, r * 0.95, color, camo, N, true);
  // 챙: 안쪽 원(r·1.08) → 바깥(0.19m)은 아래로 처짐 — 위·아래 면
  const inner = r * 1.08, outer = 0.19, droop = 0.035;
  for (const side of [1, -1]) {
    const base = buf.pos.length / 3;
    for (let k = 0; k <= N; k++) {
      const th = (k / N) * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
      const pIn = crownBot.clone().addScaledVector(dir, inner).addScaledVector(up, 0.004 * side);
      const pOut = crownBot.clone().addScaledVector(dir, outer).addScaledVector(up, -droop + 0.004 * side);
      const tang = V3().subVectors(pOut, pIn).normalize();
      const n = V3().crossVectors(V3().crossVectors(dir, up), tang).normalize().multiplyScalar(side);
      if (n.dot(up) * side < 0) n.negate();
      for (const p of [pIn, pOut]) {
        buf.pos.push(p.x, p.y, p.z); buf.nor.push(n.x, n.y, n.z);
        buf.col.push(color.r, color.g, color.b); buf.camo.push(camo);
      }
    }
    for (let k = 0; k < N; k++) {
      const p0 = base + k * 2, p1 = p0 + 1, p2 = p0 + 3, p3 = p0 + 2;
      if (side > 0) buf.idx.push(p0, p2, p1, p0, p3, p2); else buf.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
}

/** 7단계 철모: 머리를 덮는 둥근 돔 (귀 위까지) + 짧은 챙 — 천 덮개라 위장 무늬 */
function addHelmet(buf, head, color, camo) {
  const a = V3(head.a.x, head.a.y, head.a.z), b = V3(head.b.x, head.b.y, head.b.z);
  const up = V3().subVectors(b, a).normalize();
  const r = head.r * 1.32;
  const h = Math.abs(up.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
  const u = V3().crossVectors(up, h).normalize();
  const v = V3().crossVectors(u, up);
  const center = b.clone().addScaledVector(up, -0.02);
  const N = 16, RINGS = 5;
  const base = buf.pos.length / 3;
  // 돔: 위도 0 (꼭대기) → 95° (가장자리, 살짝 벌어짐)
  for (let i = 0; i <= RINGS; i++) {
    const lat = (i / RINGS) * (Math.PI / 2) * 1.06;
    const cr = Math.sin(lat) * r * (i === RINGS ? 1.06 : 1), cy = Math.cos(lat) * r * 0.82;
    for (let k = 0; k <= N; k++) {
      const th = (k / N) * Math.PI * 2;
      const dir = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
      const p = center.clone().addScaledVector(dir, cr).addScaledVector(up, cy);
      const n = dir.clone().multiplyScalar(Math.sin(lat)).addScaledVector(up, Math.cos(lat)).normalize();
      buf.pos.push(p.x, p.y, p.z); buf.nor.push(n.x, n.y, n.z);
      buf.col.push(color.r, color.g, color.b); buf.camo.push(camo);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let k = 0; k < N; k++) {
      const p0 = base + i * (N + 1) + k, p1 = p0 + 1, p2 = p0 + N + 2, p3 = p0 + N + 1;
      buf.idx.push(p0, p1, p2, p0, p2, p3);   // 바깥을 향함
    }
  }
  // 아래쪽 안감 (어두운 고리 — 안이 보일 때)
  const rim = base + RINGS * (N + 1);
  const inner = buf.pos.length / 3;
  const dark = C('#1e1f18');
  for (let k = 0; k <= N; k++) {
    const p = V3(buf.pos[(rim + k) * 3], buf.pos[(rim + k) * 3 + 1], buf.pos[(rim + k) * 3 + 2]);
    const q = p.clone().lerp(center, 0.25);
    for (const w of [p, q]) { buf.pos.push(w.x, w.y, w.z); buf.nor.push(-up.x, -up.y, -up.z); buf.col.push(dark.r, dark.g, dark.b); buf.camo.push(0); }
  }
  for (let k = 0; k < N; k++) { const p0 = inner + k * 2; buf.idx.push(p0, p0 + 3, p0 + 1, p0, p0 + 2, p0 + 3); }   // 아래를 향함
}

/** 7단계 아군 소총 (플레이어와 같은 7.62 계열 — 나무 개머리판·총열덮개, 굽은 30발 탄창, 권총형 손잡이) */
function addRifle762(buf, caps) {
  const hR = vec(caps.find((c) => c.part === 'forearmR').b);
  const hL = vec(caps.find((c) => c.part === 'forearmL').b);
  const f = V3().subVectors(hL, hR);
  f.x *= 0.35; f.y *= 0.35;
  f.normalize();
  let r = V3().crossVectors(f, V3(0, 1, 0));
  if (r.lengthSq() < 1e-6) r = V3(1, 0, 0);
  r.normalize();
  const u = V3().crossVectors(r, f).normalize();
  const bore = hR.clone().addScaledVector(u, 0.075);
  const at = (s, du = 0) => bore.clone().addScaledVector(f, s).addScaledVector(u, du);
  addBox(buf, at(-0.19, -0.03), r, u, f, 0.021, 0.052, 0.14, GEAR.wood);       // 나무 개머리판
  addBox(buf, at(0.04, -0.005), r, u, f, 0.024, 0.04, 0.12, GEAR.metal);       // 몸통
  addBox(buf, at(0.11, -0.08), r, u, f, 0.015, 0.05, 0.032, GEAR.mag);         // 굽은 탄창 (두 토막)
  addBox(buf, at(0.14, -0.155), r, u.clone().addScaledVector(f, 0.35).normalize(), f, 0.015, 0.04, 0.03, GEAR.mag);
  addBox(buf, at(-0.035, -0.065), r, u, f, 0.012, 0.038, 0.016, GEAR.wood);    // 권총형 손잡이
  addBox(buf, at(0.3, -0.008), r, u, f, 0.025, 0.03, 0.15, GEAR.wood);         // 나무 총열덮개
  addCylinder(buf, at(0.42, 0.01), at(0.72, 0.01), 0.011, 0.01, GEAR.metal, 0, 6);
  addBox(buf, at(0.66, 0.042), r, u, f, 0.005, 0.022, 0.008, GEAR.metal);      // 가늠쇠
}

const mid = (p, q) => V3((p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2);
const vec = (p) => V3(p.x, p.y, p.z);

/** 몸 좌표틀 (가슴·골반 쌍 캡슐, 어깨) → { up, right, front } */
function bodyFrame(caps) {
  const by = (part) => caps.filter((c) => c.part === part);
  const pel = by('pelvis'), ch = by('upperChest'), ua = by('upperArmL'), ub = by('upperArmR');
  const pc = mid(mid(pel[0].a, pel[0].b), mid(pel[1].a, pel[1].b));
  const cc = mid(mid(ch[0].a, ch[0].b), mid(ch[1].a, ch[1].b));
  const up = V3().subVectors(cc, pc).normalize();
  const right = V3().subVectors(vec(ub[0].a), vec(ua[0].a));
  right.addScaledVector(up, -right.dot(up)).normalize();
  const front = V3().crossVectors(up, right).normalize();
  return { up, right, front, pelvisTop: mid(pel[0].b, pel[1].b), chest: cc };
}

/** 탄띠 + 탄입대 4개 (허리 앞) + 가슴을 가로지르는 멜빵 */
function addBelt(buf, caps, F) {
  const { up, right, front, pelvisTop } = F;
  const pr = caps.find((c) => c.part === 'pelvis').r;
  const beltC = pelvisTop.clone().addScaledVector(up, 0.035);
  for (const off of [-0.15, -0.075, 0.075, 0.15]) {
    const c = beltC.clone().addScaledVector(front, pr + 0.022).addScaledVector(right, off).addScaledVector(up, -0.02);
    addBox(buf, c, right, up, front, 0.032, 0.045, 0.022, GEAR.pouch, 0);
  }
  // 수통 (오른쪽 뒤 허리)
  const can = beltC.clone().addScaledVector(right, pr + 0.07).addScaledVector(front, -0.06).addScaledVector(up, -0.05);
  addCylinder(buf, can.clone().addScaledVector(up, -0.07), can.clone().addScaledVector(up, 0.07), 0.045, 0.045, GEAR.pouch, 0, 8);
  // 멜빵: 왼쪽 어깨 → 오른쪽 허리 (가슴 앞)
  const shL = vec(caps.find((c) => c.part === 'upperArmL').a);
  const chestR = caps.find((c) => c.part === 'upperChest').r;
  const p0 = shL.clone().addScaledVector(front, chestR * 0.55).addScaledVector(up, 0.02);
  const p1 = beltC.clone().addScaledVector(right, 0.12).addScaledVector(front, pr * 0.9);
  addCylinder(buf, p0, p1, 0.018, 0.018, GEAR.belt, 0, 6, false);
}

/** 총: 손 위치에 맞춰 (오른손 = 권총손잡이, 왼손 = 총열덮개) */
function addWeapon(buf, caps, kind) {
  const hR = vec(caps.find((c) => c.part === 'forearmR').b);
  const hL = vec(caps.find((c) => c.part === 'forearmL').b);
  // 총열 방향: 오른손 → 왼손에서 위·옆 성분을 줄임 (조준선과 나란한 쪽으로)
  const f = V3().subVectors(hL, hR);
  f.x *= 0.35; f.y *= 0.35;
  f.normalize();
  const upW = V3(0, 1, 0);
  let r = V3().crossVectors(f, upW);
  if (r.lengthSq() < 1e-6) r = V3(1, 0, 0);
  r.normalize();
  const u = V3().crossVectors(r, f).normalize();
  const bore = hR.clone().addScaledVector(u, 0.075);
  const at = (s, du = 0) => bore.clone().addScaledVector(f, s).addScaledVector(u, du);
  if (kind === 'lmg') {
    addBox(buf, at(-0.2, -0.02), r, u, f, 0.022, 0.05, 0.13, GEAR.wood);           // 개머리판
    addBox(buf, at(0.1, 0), r, u, f, 0.032, 0.05, 0.2, GEAR.metal);               // 몸통
    addBox(buf, at(0.06, -0.11), r, u, f, 0.045, 0.06, 0.07, GEAR.mag);           // 탄통
    addBox(buf, at(-0.02, -0.07), r, u, f, 0.014, 0.04, 0.018, GEAR.furniture);   // 권총손잡이
    addBox(buf, at(0.38, -0.005), r, u, f, 0.028, 0.03, 0.1, GEAR.metal);         // 가스관·총열덮개
    addCylinder(buf, at(0.3, 0.01), at(0.86, 0.01), 0.016, 0.014, GEAR.metal, 0, 7); // 총열
    addCylinder(buf, at(0.86, 0.01), at(0.92, 0.01), 0.021, 0.021, GEAR.metal, 0, 7); // 소염기
    // 접힌 양각대 (총열 아래)
    for (const s of [-1, 1]) addCylinder(buf, at(0.66, -0.01).addScaledVector(r, 0.012 * s), at(0.4, -0.03).addScaledVector(r, 0.02 * s), 0.006, 0.006, GEAR.metal, 0, 5);
    addBox(buf, at(0.24, 0.07), r, u, f, 0.012, 0.03, 0.05, GEAR.metal);          // 운반 손잡이
  } else {
    addBox(buf, at(-0.17, -0.025), r, u, f, 0.02, 0.05, 0.12, GEAR.furniture);    // 개머리판
    addBox(buf, at(0.05, 0), r, u, f, 0.024, 0.042, 0.13, GEAR.metal);            // 몸통
    // 곡선 탄창 (두 토막으로 앞쪽으로 휨)
    addBox(buf, at(0.12, -0.08), r, u, f, 0.014, 0.05, 0.03, GEAR.mag);
    addBox(buf, at(0.15, -0.155), r, u.clone().addScaledVector(f, 0.3).normalize(), f, 0.014, 0.04, 0.028, GEAR.mag);
    addBox(buf, at(-0.03, -0.065), r, u, f, 0.012, 0.038, 0.016, GEAR.furniture); // 권총손잡이
    addBox(buf, at(0.3, -0.005), r, u, f, 0.026, 0.03, 0.12, GEAR.furniture);     // 총열덮개
    addCylinder(buf, at(0.4, 0.01), at(0.66, 0.01), 0.011, 0.01, GEAR.metal, 0, 6); // 총열
    addBox(buf, at(0.56, 0.045), r, u, f, 0.005, 0.025, 0.008, GEAR.metal);       // 가늠쇠
  }
}

/** 병사 한 명 모양 (국소 자세, 변형, 무기, 편 'enemy'|'ally') → BufferGeometry */
export function buildSoldierGeometry(localPose, variant = 0, weapon = 'rifle', side = 'enemy') {
  const ally = side === 'ally';
  const VV = ally ? ALLY_VARIANTS : VARIANTS;
  const V = VV[((variant % VV.length) + VV.length) % VV.length];
  const seed = (ally ? 101 : 1) + variant * 1.37;
  const caps = buildHitboxes(localPose, []);
  const buf = newBuf();
  const trousers = V.cloth.clone().multiplyScalar(V.trousersK);
  for (const cap of caps) {
    const part = cap.part;
    const build = part === 'head' || part === 'neck' ? 1 : V.build;
    let fn;
    switch (part) {
      case 'head': case 'neck': fn = () => [V.skin, 0]; break;
      case 'upperChest': case 'abdomen': case 'upperArmL': case 'upperArmR': fn = () => [V.cloth, seed]; break;
      case 'forearmL': case 'forearmR': fn = (s, L) => (s > L - 0.07 ? [V.skin, 0] : [V.cloth, seed]); break;
      case 'pelvis': fn = (s, L, r) => (s > L + r - 0.05 ? [GEAR.belt, 0] : [trousers, seed]); break;
      case 'shinL': case 'shinR': fn = (s, L) => (s > L - 0.13 ? [GEAR.boot, 0] : [trousers, seed]); break;
      default: fn = () => [trousers, seed];
    }
    addCapsule(buf, cap.a, cap.b, cap.r * build, fn);
  }
  const F = bodyFrame(caps);
  if (ally) addHelmet(buf, caps.find((c) => c.part === 'head'), V.helmet, seed + 0.5);
  else addHat(buf, caps.find((c) => c.part === 'head'), V.camoHat ? V.cloth : GEAR.hatPlain, V.camoHat ? seed : 0);
  addBelt(buf, caps, F);
  if (weapon === 'rifle762') addRifle762(buf, caps);
  else if (weapon !== 'none') addWeapon(buf, caps, weapon);   // 5단계: 플레이어가 주워 간 총은 없음
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setAttribute('camo', new THREE.Float32BufferAttribute(buf.camo, 1));
  g.setIndex(buf.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(buf.idx, 1) : new THREE.Uint16BufferAttribute(buf.idx, 1));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------
// 6단계: 플레이어 몸 (내려다보면 보이는 다리·몸통·군화·장비) — 머리·목·팔은 빼고 (1인칭 화면 모델이 팔·총)
//  swing: 걸음 위상 각 (rad, 다리를 앞뒤로 흔듦), wounds: 붕대·지혈대를 감은 상처 [{part, bandaged, tourniquet, type}]
// ---------------------------------------------------------------
const PLAYER = {   // 내려다보면 가까이·위에서 보므로 적 병사 색과 비슷한 밝기 (너무 어두우면 숲 바닥에서 검은 덩어리로 보임)
  cloth: C('#5e6640'), trousers: C('#59603d'), boot: C('#2e2924'), bootCanvas: C('#535a3a'), belt: C('#6e6d4a'),
  pouch: C('#5f6540'), canteen: C('#525a38'), cap: C('#3a3a33'), bandage: C('#d6cfbb'), stain: C('#7a3a2c'), strap: C('#3c3e2a'),
};
const HIDE_PARTS = new Set(['head', 'neck', 'upperArmL', 'upperArmR', 'forearmL', 'forearmR']);
const LEG = { thighL: 'L', shinL: 'L', thighR: 'R', shinR: 'R' };

/** 다리 흔들기: 엉덩이(대퇴 a)를 축으로 몸 오른쪽 축 둘레 회전, 뒤로 간 다리는 무릎을 굽힘 */
function swingLegs(caps, F, swing) {
  if (!swing) return;
  const axis = F.right;
  const rot = (p, pivot, ang) => {
    const v = V3(p.x - pivot.x, p.y - pivot.y, p.z - pivot.z).applyAxisAngle(axis, ang);
    p.x = pivot.x + v.x; p.y = pivot.y + v.y; p.z = pivot.z + v.z;
  };
  for (const side of ['L', 'R']) {
    const th = caps.find((c) => c.part === `thigh${side}`), sh = caps.find((c) => c.part === `shin${side}`);
    if (!th || !sh) continue;
    const a = (side === 'L' ? 1 : -1) * swing;
    const hip = { x: th.a.x, y: th.a.y, z: th.a.z };
    rot(th.b, hip, a); rot(sh.a, hip, a); rot(sh.b, hip, a);
    // + 회전 = 다리가 앞으로 (아래 −Y → −Z). 뒤로 간 다리는 무릎을 굽혀 발이 뒤로 들림
    const bend = Math.max(0, -a) * 1.1;
    if (bend > 0) rot(sh.b, { x: sh.a.x, y: sh.a.y, z: sh.a.z }, -bend);
  }
}

/** 상처에 감은 붕대·지혈대 (그 부위 캡슐 둘레 띠) */
function addDressings(buf, caps, wounds) {
  for (const w of wounds ?? []) {
    if (!w.bandaged && !w.tourniquet) continue;
    const cs = caps.filter((c) => c.part === w.part);
    if (!cs.length) continue;
    if (cs.length >= 2) {
      // 몸통 쌍 캡슐: 둘을 감싸는 띠
      const a = mid(cs[0].a, cs[1].a), b = mid(cs[0].b, cs[1].b);
      const half = Math.hypot(cs[0].a.x - cs[1].a.x, cs[0].a.y - cs[1].a.y, cs[0].a.z - cs[1].a.z) / 2;
      const c = a.clone().lerp(b, 0.5), dir = V3().subVectors(b, a).normalize();
      addCylinder(buf, c.clone().addScaledVector(dir, -0.05), c.clone().addScaledVector(dir, 0.05), cs[0].r + half + 0.01, cs[0].r + half + 0.01, PLAYER.bandage, 0, 14, false);
      continue;
    }
    const cap = cs[0], a = vec(cap.a), b = vec(cap.b), dir = V3().subVectors(b, a).normalize();
    if (w.tourniquet) {
      // 지혈대: 상처 위쪽 (몸 쪽 끝) 검은 끈 + 조이는 막대
      const c = a.clone().lerp(b, 0.12);
      addCylinder(buf, c.clone().addScaledVector(dir, -0.018), c.clone().addScaledVector(dir, 0.018), cap.r * 1.1, cap.r * 1.1, PLAYER.strap, 0, 12, false);
      const side = V3().crossVectors(dir, V3(0, 1, 0));
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize();
      addCylinder(buf, c.clone().addScaledVector(side, cap.r * 1.1 - 0.06), c.clone().addScaledVector(side, cap.r * 1.1 + 0.06), 0.006, 0.006, PLAYER.belt, 0, 5);
    }
    if (w.bandaged) {
      const c = a.clone().lerp(b, 0.5);
      const half = w.type === 'graze' ? 0.035 : 0.06;
      addCylinder(buf, c.clone().addScaledVector(dir, -half), c.clone().addScaledVector(dir, half), cap.r * 1.12, cap.r * 1.12, PLAYER.bandage, 0, 12, false);
      // 배어 나온 피 (작은 얼룩 띠)
      addCylinder(buf, c.clone().addScaledVector(dir, -0.012), c.clone().addScaledVector(dir, 0.012), cap.r * 1.13, cap.r * 1.13, PLAYER.stain, 0, 12, false);
    }
  }
}

/** 플레이어 장비: 탄띠·탄입대 4·구급낭·수통 2 (양 엉덩이 뒤)·멜빵 */
function addPlayerGear(buf, caps, F) {
  const { up, right, front, pelvisTop } = F;
  const pr = caps.find((c) => c.part === 'pelvis').r;
  const beltC = pelvisTop.clone().addScaledVector(up, 0.035);
  // 탄띠 (골반 둘레 고리)
  addCylinder(buf, beltC.clone().addScaledVector(up, -0.025), beltC.clone().addScaledVector(up, 0.025), pr + 0.105, pr + 0.105, PLAYER.belt, 0, 16, false);
  for (const off of [-0.17, -0.09, 0.09, 0.17]) {
    const c = beltC.clone().addScaledVector(front, pr + 0.075).addScaledVector(right, off).addScaledVector(up, -0.03);
    addBox(buf, c, right, up, front, 0.036, 0.055, 0.026, PLAYER.pouch, 0);
    addBox(buf, c.clone().addScaledVector(up, 0.052).addScaledVector(front, 0.004), right, up, front, 0.038, 0.012, 0.028, PLAYER.pouch, 0);   // 덮개
  }
  // 구급낭 (왼쪽 앞 옆)
  addBox(buf, beltC.clone().addScaledVector(right, -(pr + 0.09)).addScaledVector(front, 0.03).addScaledVector(up, -0.03), right, up, front, 0.026, 0.045, 0.04, PLAYER.pouch, 0);
  // 수통 2 (양쪽 엉덩이 뒤) — 뚜껑 포함
  for (const sgn of [-1, 1]) {
    const can = beltC.clone().addScaledVector(right, sgn * (pr + 0.06)).addScaledVector(front, -0.09).addScaledVector(up, -0.07);
    addCylinder(buf, can.clone().addScaledVector(up, -0.08), can.clone().addScaledVector(up, 0.07), 0.05, 0.05, PLAYER.canteen, 0, 10);
    addCylinder(buf, can.clone().addScaledVector(up, 0.07), can.clone().addScaledVector(up, 0.095), 0.018, 0.018, PLAYER.cap, 0, 8);
  }
  // 멜빵: 앞 탄띠 → 어깨 (양쪽)
  const chest = caps.filter((c) => c.part === 'upperChest');
  const chR = chest[0].r;
  for (const sgn of [-1, 1]) {
    const p0 = beltC.clone().addScaledVector(right, sgn * 0.13).addScaledVector(front, pr + 0.06);
    const p1 = F.chest.clone().addScaledVector(right, sgn * 0.12).addScaledVector(front, chR + 0.05).addScaledVector(up, 0.12);
    addCylinder(buf, p0, p1, 0.016, 0.016, PLAYER.belt, 0, 6, false);
  }
}

/** 플레이어 몸 지오메트리 (국소 자세: 발 원점, yaw 0 — 앞 −Z) */
export function buildPlayerGeometry(localPose, swing = 0, wounds = null) {
  const caps = buildHitboxes(localPose, []);
  const F = bodyFrame(caps);
  swingLegs(caps, F, swing);
  const buf = newBuf();
  for (const cap of caps) {
    if (HIDE_PARTS.has(cap.part)) continue;
    let fn;
    switch (cap.part) {
      case 'upperChest': case 'abdomen': fn = () => [PLAYER.cloth, 0]; break;
      case 'pelvis': fn = (s, L, r) => (s > L + r - 0.05 ? [PLAYER.belt, 0] : [PLAYER.trousers, 0]); break;
      case 'shinL': case 'shinR': fn = (s, L) => (s > L - 0.06 ? [PLAYER.boot, 0] : s > L - 0.17 ? [PLAYER.bootCanvas, 0] : [PLAYER.trousers, 0]); break;
      default: fn = () => [PLAYER.trousers, 0];
    }
    addCapsule(buf, cap.a, cap.b, cap.r * (cap.part.startsWith('shin') ? 1.06 : 1.02), fn);
  }
  // 군화 앞코 (발목 끝에서 앞으로)
  for (const side of ['L', 'R']) {
    const sh = caps.find((c) => c.part === `shin${side}`);
    if (!sh) continue;
    const ank = vec(sh.b), legDir = V3().subVectors(vec(sh.b), vec(sh.a)).normalize();
    const fwd = F.front.clone().addScaledVector(legDir, -F.front.dot(legDir)).normalize();
    const toe = ank.clone().addScaledVector(fwd, 0.1).addScaledVector(legDir, sh.r * 0.6);
    addCapsule(buf, ank.clone().addScaledVector(legDir, sh.r * 0.5), toe, sh.r * 0.85, () => [PLAYER.boot, 0]);
  }
  addPlayerGear(buf, caps, F);
  addDressings(buf, caps, wounds);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setAttribute('camo', new THREE.Float32BufferAttribute(buf.camo, 1));
  g.setIndex(buf.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(buf.idx, 1) : new THREE.Uint16BufferAttribute(buf.idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** 플레이어 몸 재질 (병사와 같은 셰이더 — 무늬 없음) */
export function playerBodyMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  patchCamo(m);
  patchCanopy(m, { sun: 1, sky: 0.7 });
  return m;
}

// ---------------------------------------------------------------
// 자세 → 캐시 키 (HumanEntity.pose 가 이미 1/12·0.02 단위로 끊어 줌)
// ---------------------------------------------------------------
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '');
function shapeKey(p) {
  const prog = p.stanceProgress ?? 1;
  return `${p.stance}|${prog >= 1 ? p.stance : p.stanceFrom}|${f3(prog)}|${f3(p.lean || 0)}|${f3(p.bodyPitch || 0)}|${f3(p.eyeHeight)}`;
}
function localPose(p) {
  const prog = p.stanceProgress ?? 1;
  return {
    x: 0, y: 0, z: 0, yaw: 0, stance: p.stance, stanceFrom: prog >= 1 ? p.stance : p.stanceFrom, stanceProgress: prog,
    lean: p.lean || 0, arms: 'rifle', bodyPitch: p.bodyPitch || 0, eyeHeight: p.eyeHeight,
  };
}

const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _qYaw = new THREE.Quaternion();
const _qFall = new THREE.Quaternion();

export class SoldierMeshes {
  /** @param {THREE.Scene} scene  @param {{ query?: object }} opts  query: 구덩이 둔덕을 지면에 맞춤 */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.query = opts.query ?? null;
    this.root = new THREE.Group();
    this.root.name = 'soldiers';
    scene.add(this.root);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCamo(this.material);
    patchCanopy(this.material, { sun: 1, sky: 0.7 });
    this._geo = new Map();       // 키 → { geometry, users }
    this._items = new Map();     // 병사 → { mesh, key }
    // 구덩이
    this.pitMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCanopy(this.pitMaterial, { sun: 1, sky: 0.7 });
    this._pitGeo = buildPitGeometry();
    this._pits = new Map();      // pit 객체 → mesh
  }

  /** 병사 목록·구덩이 목록에 맞춰 메시를 만들고 지우고 놓는다 (매 프레임) */
  update(soldiers, pits = []) {
    for (const [s, item] of this._items) if (!soldiers.includes(s)) this._remove(s, item);
    for (const s of soldiers) {
      let item = this._items.get(s);
      if (!item) item = this._add(s);
      this._place(s, item);
    }
    for (const [p, mesh] of this._pits) if (!pits.includes(p)) { this.root.remove(mesh); this._pits.delete(p); }
    for (const p of pits) if (!this._pits.has(p)) this._addPit(p);
  }

  /** 디버그 수: 병사 메시·캐시된 모양 */
  get counts() { return { soldiers: this._items.size, shapes: this._geo.size, pits: this._pits.size }; }

  clear() {
    for (const [s, item] of this._items) this._remove(s, item);
    for (const mesh of this._pits.values()) this.root.remove(mesh);
    this._pits.clear();
  }

  dispose() {
    this.clear();
    for (const e of this._geo.values()) e.geometry.dispose();
    this._geo.clear();
    this.material.dispose();
    this.pitMaterial.dispose();
    this._pitGeo.dispose();
    this.scene.remove(this.root);
  }

  // -------------------------------------------------------------
  _kind(s) {
    if (s.weaponTaken) return 'none';
    if (s.weaponData?.bipod) return 'lmg';
    return s.weaponData?.family === 'player' ? 'rifle762' : 'rifle';
  }

  _side(s) { return s.faction === 'friend' ? 'ally' : 'enemy'; }

  _acquire(s, pose) {
    const key = `${this._side(s)}|${s.variant ?? 0}|${this._kind(s)}|${shapeKey(pose)}`;
    let e = this._geo.get(key);
    if (!e) { e = { geometry: buildSoldierGeometry(localPose(pose), s.variant ?? 0, this._kind(s), this._side(s)), users: 0 }; this._geo.set(key, e); }
    e.users++;
    return { key, geometry: e.geometry };
  }

  _release(key) {
    const e = this._geo.get(key);
    if (!e) return;
    if (--e.users <= 0) { e.geometry.dispose(); this._geo.delete(key); }
  }

  _add(s) {
    const pose = s.person.pose ?? s.pose();
    const { key, geometry } = this._acquire(s, pose);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = 'soldier';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    const item = { mesh, key };
    this._items.set(s, item);
    return item;
  }

  _remove(s, item) {
    this.root.remove(item.mesh);
    this._release(item.key);
    this._items.delete(s);
  }

  _place(s, item) {
    const pose = s.pose();
    const key = `${this._side(s)}|${s.variant ?? 0}|${this._kind(s)}|${shapeKey(pose)}`;
    if (key !== item.key) {
      const next = this._acquire(s, pose);
      this._release(item.key);
      item.key = next.key;
      item.mesh.geometry = next.geometry;
    }
    _qYaw.setFromAxisAngle(_up, pose.yaw || 0);
    item.mesh.quaternion.copy(_qYaw);
    let lift = 0;
    const fall = pose.fall;
    if (fall && fall.angle) {
      const kl = Math.hypot(fall.ax, fall.az) || 1;
      _axis.set(fall.ax / kl, 0, fall.az / kl);
      _qFall.setFromAxisAngle(_axis, fall.angle);
      item.mesh.quaternion.premultiply(_qFall);
      lift = fall.lift || 0;
    }
    item.mesh.position.set(pose.x, pose.y + lift, pose.z);
  }

  _addPit(p) {
    const mesh = new THREE.Mesh(this._pitGeo, this.pitMaterial);
    mesh.name = 'spiderPit';
    mesh.receiveShadow = true;
    // 지면 경사에 맞춰 기울임
    const q = this.query;
    if (q) {
      const h = (x, z) => q.getTerrainHeight(x, z);
      const e = 0.6;
      const nx = h(p.x - e, p.z) - h(p.x + e, p.z), nz = h(p.x, p.z - e) - h(p.x, p.z + e);
      const n = new THREE.Vector3(nx, 2 * e, nz).normalize();
      mesh.quaternion.setFromUnitVectors(_up, n);
    }
    mesh.position.set(p.x, p.y + 0.01, p.z);
    this.root.add(mesh);
    this._pits.set(p, mesh);
  }
}

/** 구덩이: 어두운 구멍 (원판) + 흙·낙엽 둔덕 고리 (꼭짓점 색으로 얼룩) */
export function buildPitGeometry() {
  const buf = newBuf();
  const N = 18;
  const hole = C('#120e0a'), dirt = C('#4a3a26'), litter = C('#5a5232'), leaf = C('#3f4a25');
  // 구멍
  const c0 = 0;
  buf.pos.push(0, 0.005, 0); buf.nor.push(0, 1, 0); buf.col.push(hole.r, hole.g, hole.b); buf.camo.push(0);
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2;
    buf.pos.push(Math.cos(a) * 0.36, 0.005, Math.sin(a) * 0.36); buf.nor.push(0, 1, 0);
    buf.col.push(hole.r, hole.g, hole.b); buf.camo.push(0);
  }
  for (let k = 0; k < N; k++) buf.idx.push(c0, c0 + 2 + k, c0 + 1 + k);
  // 둔덕: 안쪽 가장자리 (0.36) → 꼭대기 (0.5, 높이 0.09) → 바깥 (0.75, 0)
  const prof = [[0.36, 0.0], [0.44, 0.085], [0.56, 0.09], [0.75, 0.0]];
  const base = buf.pos.length / 3;
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const wob = 1 + 0.12 * Math.sin(a * 3 + 1.3) + 0.06 * Math.sin(a * 7);
    prof.forEach(([r, y], i) => {
      const rr = r * (i === 0 ? 1 : wob);
      buf.pos.push(ca * rr, y * wob, sa * rr);
      const ny = i === 0 ? 0.4 : i === prof.length - 1 ? 0.8 : 1;
      const n = new THREE.Vector3(ca * (i === 0 ? -0.6 : i === prof.length - 1 ? 0.5 : 0), ny, sa * (i === 0 ? -0.6 : i === prof.length - 1 ? 0.5 : 0)).normalize();
      buf.nor.push(n.x, n.y, n.z);
      const c = i === 0 ? dirt : ((k * 7 + i * 3) % 5 === 0 ? leaf : litter);
      buf.col.push(c.r, c.g, c.b); buf.camo.push(0);
    });
  }
  const P = prof.length;
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < P - 1; i++) {
      const p0 = base + k * P + i, p1 = p0 + 1, p2 = p0 + P + 1, p3 = p0 + P;
      buf.idx.push(p0, p2, p1, p0, p3, p2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}
