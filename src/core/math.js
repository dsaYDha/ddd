export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;

/** 지수 감쇠 보간 — 프레임레이트 독립 (rate: 1/s) */
export const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));

/** 값을 target 쪽으로 최대 maxDelta만큼 이동 */
export const approach = (current, target, maxDelta) => {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
};

/** 점 (px,pz) 와 선분 (ax,az)-(bx,bz) 사이 거리², 투영 비율 t */
export function segmentDistSq(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  if (out) out.t = t;
  return cx * cx + cz * cz;
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
