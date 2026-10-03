// 큰 나무(교목층) 형태 변형 — 렌더링(render/TreeBuilder.js)과 물리(판근 충돌)가 같은 데이터를 쓴다.
// 크기는 기준값이며 배치마다 scale 로 키운다.
import { RNG } from '../core/rng.js';

/**
 * fins: 판근 { a: 땅에서의 방향(rad), span: 줄기 밖으로 뻗는 길이(m), h: 줄기와 합쳐지는 높이(m),
 *              thick: 두께(m), curl: 위로 가며 비틀리는 각도(rad) }
 * bend: 줄기 휨 { ax, az: 꼭대기에서의 휨(m), phase }
 */
function makeVariant(seed, o) {
  const r = new RNG(seed);
  const fins = [];
  const count = r.int(o.fins[0], o.fins[1]);
  const base = r.range(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    fins.push({
      a: base + (i / Math.max(1, count)) * Math.PI * 2 + r.range(-0.4, 0.4),
      span: r.range(1.3, 2.9) * o.finScale,
      h: r.range(1.8, 3.4) * o.finScale,
      thick: r.range(0.18, 0.32) * (0.7 + 0.3 * o.finScale),
      curl: r.range(-0.4, 0.4),
    });
  }
  return {
    seed, height: o.height, trunkR: o.trunkR, crownR: o.crownR, crownBase: o.crownBase,
    fins,
    bend: { ax: r.range(-1.2, 1.2), az: r.range(-1.2, 1.2), phase: r.range(0, 6.28), wobble: r.range(0.15, 0.4) },
    limbs: r.int(o.limbs[0], o.limbs[1]),
    maxScale: o.maxScale,
  };
}

export const BIG_TREE_VARIANTS = [
  makeVariant(101, { height: 30, trunkR: 0.62, crownR: 8.5, crownBase: 0.62, fins: [4, 6], finScale: 1.0, limbs: [4, 6], maxScale: 1.2 }),
  makeVariant(202, { height: 34, trunkR: 0.76, crownR: 10, crownBase: 0.66, fins: [5, 7], finScale: 1.15, limbs: [5, 6], maxScale: 1.15 }),
  makeVariant(303, { height: 26, trunkR: 0.5, crownR: 7.2, crownBase: 0.58, fins: [3, 5], finScale: 0.85, limbs: [4, 5], maxScale: 1.25 }),
  makeVariant(404, { height: 37, trunkR: 0.86, crownR: 11, crownBase: 0.7, fins: [5, 7], finScale: 1.3, limbs: [5, 7], maxScale: 1.06 }),
  makeVariant(505, { height: 21, trunkR: 0.4, crownR: 6, crownBase: 0.52, fins: [2, 3], finScale: 0.6, limbs: [3, 5], maxScale: 1.3 }),
];

/**
 * 판근 능선 (로컬 단위, 배치 scale 곱하기 전): s=0 줄기 쪽 → s=1 끝(땅속).
 * 렌더링(TreeBuilder)과 물리(Flora 의 판근 지지 캡슐)가 같은 식을 쓴다.
 * @returns {{r:number, y:number}} 줄기 중심에서의 거리, 능선 높이
 */
export function finRidge(f, trunkR, s) {
  return {
    r: trunkR * 0.55 + s * (f.span + trunkR * 0.35) + trunkR * 0.25 * s * s,
    y: (f.h + 0.25) * Math.pow(1 - s, 1.65) - 0.25 * s * s + 0.06,
  };
}

