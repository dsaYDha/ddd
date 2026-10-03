// 시드 고정 난수. 같은 시드 → 같은 맵.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RNG {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }
  float() { return this.next(); }
  range(min, max) { return min + (max - min) * this.next(); }
  int(min, maxInclusive) { return Math.floor(this.range(min, maxInclusive + 1)); }
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** 근사 정규분포 (평균 0, 표준편차 1) */
  gauss() { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732; }
  /** 하위 스트림 — 생성 단계별로 독립된 난수열이 필요할 때 */
  fork(salt) { return new RNG(hash2(this.seed, salt)); }
}

/** 정수 두 개 → 32bit 해시 */
export function hash2(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 좌표 기반 결정적 난수 [0,1) */
export function hashFloat(x, z, salt = 0) {
  return hash2(hash2(x | 0, z | 0), salt) / 4294967296;
}
