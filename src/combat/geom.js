// 전투 판정용 순수 벡터·기하 함수 — {x,y,z} 평범한 객체만 쓴다 (three.js 없이 Node 헤드리스 시뮬에서도 동작).
//  각도 규약 (프로젝트 공통): yaw 0 = -Z(북), +yaw = 왼쪽(위에서 볼 때 반시계), pitch + = 위.
//  out 인자를 받는 함수는 결과를 out 에 쓰고 out 을 돌려준다 (매 프레임 쓰레기 객체를 만들지 않으려고).
//  out 이 입력과 같은 객체여도 안전하게 계산한다.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

export function set(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; }
export function copy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function add(o, a, b) { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function sub(o, a, b) { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function scale(o, a, s) { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
/** o = a + b·s */
export function addScaled(o, a, b, s) { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; }
/** o = a + (b - a)·t */
export function lerp3(o, a, b, t) { o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; return o; }
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export function cross(o, a, b) {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z;
  return o;
}
export const len = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export function distSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
export const dist = (a, b) => Math.sqrt(distSq(a, b));
/** 길이 0 이면 그대로(0 벡터) 둔다 — 호출 쪽에서 방향이 없는 경우를 판단 */
export function normalize(o, a) {
  const l = len(a);
  return l > 1e-12 ? scale(o, a, 1 / l) : copy(o, a);
}

// ---------------------------------------------------------------
// 방향 ↔ yaw/pitch
// ---------------------------------------------------------------
/** (-sin yaw·cos pitch, sin pitch, -cos yaw·cos pitch) */
export function dirFromYawPitch(yaw, pitch, out = v3()) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function yawPitchFromDir(d, out = { yaw: 0, pitch: 0 }) {
  out.yaw = Math.atan2(-d.x, -d.z);
  out.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  return out;
}

/**
 * 임의 방향을 (dyaw, dpitch) 만큼 비튼다 (rad, +dyaw = 왼쪽, +dpitch = 위).
 * 방향 자신의 국소 기저를 쓴다: right = normalize(-d.z, 0, d.x), up = cross(right, d),
 * d' = normalize(d - right·tan(dyaw) + up·tan(dpitch)).  수직 방향(위·아래)이면 right = +X 로 대신한다.
 */
export function deviate(dir, dyaw, dpitch, out = v3()) {
  const dx = dir.x, dy = dir.y, dz = dir.z;
  let rx = -dz, rz = dx;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-9) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  // up = cross(right, dir), right.y = 0
  const ux = -rz * dy, uy = rz * dx - rx * dz, uz = rx * dy;
  const ty = Math.tan(dyaw), tp = Math.tan(dpitch);
  out.x = dx - rx * ty + ux * tp;
  out.y = dy + uy * tp;
  out.z = dz - rz * ty + uz * tp;
  return normalize(out, out);
}

/**
 * 진행 방향을 정확히 angle(rad)만큼, 방향 둘레의 방위각 azimuth(rad)로 꺾는다 (굴절·도탄 흩어짐).
 * azimuth 0 = 오른쪽, π/2 = 위.  dir 는 단위 벡터.
 */
export function deflect(dir, angle, azimuth, out = v3()) {
  const dx = dir.x, dy = dir.y, dz = dir.z;
  let rx = -dz, rz = dx;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-9) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  const ux = -rz * dy, uy = rz * dx - rx * dz, uz = rx * dy;
  const c = Math.cos(azimuth), s = Math.sin(azimuth);
  // d·cosθ + (right·cosφ + up·sinφ)·sinθ — 단위 벡터끼리 직교라 길이 1 유지
  const ca = Math.cos(angle), sa = Math.sin(angle);
  out.x = dx * ca + (rx * c + ux * s) * sa;
  out.y = dy * ca + uy * s * sa;
  out.z = dz * ca + (rz * c + uz * s) * sa;
  return normalize(out, out);
}

/** 면 법선 n(단위)에 대한 반사: o = d - 2(d·n)n */
export function reflect(o, d, n) {
  const k = 2 * dot(d, n);
  o.x = d.x - n.x * k; o.y = d.y - n.y * k; o.z = d.z - n.z * k;
  return o;
}

/** 균일한 원판 표본 (radius: rad) → {a, b} */
export function randomInDisc(rng, radius, out = { a: 0, b: 0 }) {
  const r = radius * Math.sqrt(rng.float());
  const t = rng.float() * Math.PI * 2;
  out.a = r * Math.cos(t);
  out.b = r * Math.sin(t);
  return out;
}

// ---------------------------------------------------------------
// 선분·캡슐
// ---------------------------------------------------------------
/** 점 p 와 선분 a-b 사이 거리² (투영 비율은 out.t) */
export function pointSegDistSq(p, a, b, out = null) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + abx * t - p.x, cy = a.y + aby * t - p.y, cz = a.z + abz * t - p.z;
  if (out) out.t = t;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * 두 선분 p0-p1, q0-q1 의 최근접점 (Ericson, Real-Time Collision Detection 5.1.9).
 * s = p 선분 위 비율, t = q 선분 위 비율. 자주 부르는 곳은 out 을 넘겨 재사용할 것.
 */
export function closestSegSeg(p0, p1, q0, q1, out = { distSq: 0, s: 0, t: 0 }) {
  const d1x = p1.x - p0.x, d1y = p1.y - p0.y, d1z = p1.z - p0.z;
  const d2x = q1.x - q0.x, d2y = q1.y - q0.y, d2z = q1.z - q0.z;
  const rx = p0.x - q0.x, ry = p0.y - q0.y, rz = p0.z - q0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS * a * e ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const cx = rx + d1x * s - d2x * t, cy = ry + d1y * s - d2y * t, cz = rz + d1z * s - d2z * t;
  out.distSq = cx * cx + cy * cy + cz * cz;
  out.s = s;
  out.t = t;
  return out;
}

/**
 * 선분(시작 o, 변위 d — 숫자로 받아 할당 없음)이 캡슐(축 p-q, 반경 r)에 처음 들어가는 비율 t ∈ [0,1].
 * 시작점이 이미 안이면 0, 닿지 않으면 -1.
 * 캡슐 = 유한 원기둥 ∪ 양 끝 구 → 처음 들어가는 지점 = 각 부분의 진입 t 중 최소 (시작점이 밖일 때).
 */
export function segCapsuleRaw(ox, oy, oz, dx, dy, dz, px, py, pz, qx, qy, qz, r) {
  const bax = qx - px, bay = qy - py, baz = qz - pz;
  const oax = ox - px, oay = oy - py, oaz = oz - pz;
  const baba = bax * bax + bay * bay + baz * baz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const r2 = r * r;
  // 시작점이 안인가 (축 선분까지 거리 ≤ r)
  {
    let u = baba > 0 ? baoa / baba : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const cx = oax - bax * u, cy = oay - bay * u, cz = oaz - baz * u;
    if (cx * cx + cy * cy + cz * cz <= r2) return 0;
  }
  const rdrd = dx * dx + dy * dy + dz * dz;
  if (rdrd <= 0) return -1;
  let best = Infinity;
  // 몸통 (무한 원기둥과의 교차 중 축 범위 안)
  const bard = bax * dx + bay * dy + baz * dz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba * rdrd - bard * bard;
  if (a > 1e-12 * baba * rdrd) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r2 * baba;
    const h = b * b - a * c;
    if (h >= 0) {
      const t = (-b - Math.sqrt(h)) / a;
      const y = baoa + t * bard;
      if (t >= 0 && y > 0 && y < baba) best = t;
    }
  }
  // 양 끝 구
  for (let k = 0; k < 2; k++) {
    const cx = k ? qx : px, cy = k ? qy : py, cz = k ? qz : pz;
    const ocx = ox - cx, ocy = oy - cy, ocz = oz - cz;
    const b = dx * ocx + dy * ocy + dz * ocz;
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r2;
    const h = b * b - rdrd * c;
    if (h < 0) continue;
    const t = (-b - Math.sqrt(h)) / rdrd;
    if (t >= 0 && t < best) best = t;
  }
  return best <= 1 ? best : -1;
}

/** 선분 a→b 와 캡슐 cap = {a, b, r} — 처음 들어가는 비율 t ∈ [0,1], 시작점이 안이면 0, 없으면 -1 */
export function segCapsule(a, b, cap) {
  const p = cap.a, q = cap.b;
  return segCapsuleRaw(a.x, a.y, a.z, b.x - a.x, b.y - a.y, b.z - a.z, p.x, p.y, p.z, q.x, q.y, q.z, cap.r);
}

/** 캡슐 표면 점에서 바깥쪽 단위 법선 (축 위의 최근접점 → 점 방향) */
export function capsuleNormal(cap, point, out = v3()) {
  const a = cap.a, b = cap.b;
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = point.x - (a.x + abx * t);
  out.y = point.y - (a.y + aby * t);
  out.z = point.z - (a.z + abz * t);
  if (len(out) < 1e-9) return set(out, 0, 1, 0);
  return normalize(out, out);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
