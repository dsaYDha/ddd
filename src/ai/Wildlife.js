// =====================================================================
//  Wildlife — 동물 정적 (순수 로직). 새·벌레 소리의 '활동도' 격자 0~1.
//   · 움직이는 사람(적·플레이어 모두, moveSpeed 이상) 주변 moveRadius m: 활동도가 잦아들고,
//     조용히 recover(20~40초) 지나면 rampTime 에 걸쳐 다시 살아남.
//   · 총성: gunshotRadius m 안이 gunshotSilence(30~90초, 가까울수록 김) 동안 조용해짐.
//   → 환경음(Ambience)이 듣는 사람 주변·방향별 활동도로 벌레 합창 크기와 새 위치를 정한다.
//     갑자기 조용해지는 것 자체가 '근처에 누가 있다'는 단서.
// =====================================================================
import { CONFIG } from '../config.js';

export class Wildlife {
  /** @param {number} size  맵 한 변 (m)  @param {{rng?: {range(a,b):number}}} opts */
  constructor(size = 400, opts = {}) {
    const W = CONFIG.wildlife;
    this.cell = W.cell;
    this.half = size / 2;
    this.n = Math.ceil(size / this.cell);
    this.quietUntil = new Float32Array(this.n * this.n);
    this.activity = new Float32Array(this.n * this.n).fill(1);
    this.time = 0;
    this.rng = opts.rng ?? { range: (a, b) => a + Math.random() * (b - a) };
  }

  _ci(v) {
    const i = Math.floor((v + this.half) / this.cell);
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  /** 반경 r 안의 칸에 '조용해질 때까지' 시각을 늦춤 (가까울수록 길게: until(d)) */
  _silence(x, z, r, untilFn) {
    const i0 = this._ci(x - r), i1 = this._ci(x + r), j0 = this._ci(z - r), j1 = this._ci(z + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = -this.half + (i + 0.5) * this.cell, cz = -this.half + (j + 0.5) * this.cell;
      const d = Math.hypot(cx - x, cz - z);
      if (d > r) continue;
      const k = j * this.n + i;
      const u = untilFn(d / r);
      if (u > this.quietUntil[k]) this.quietUntil[k] = u;
    }
  }

  /** 총성 (그 일대 30~90초 정적) */
  gunshot(x, z) {
    const W = CONFIG.wildlife, [a, b] = W.gunshotSilence;
    const extra = this.rng.range(0.9, 1.1);
    this._silence(x, z, W.gunshotRadius, (f) => this.time + (b + (a - b) * f) * extra);
  }

  /**
   * @param {number} dt
   * @param {Array<{x:number, z:number, speed:number}>} movers  움직이는 사람들 (플레이어·적)
   */
  update(dt, movers = []) {
    const W = CONFIG.wildlife;
    this.time += dt;
    for (const m of movers) {
      if (!(m.speed >= W.moveSpeed)) continue;
      const [a, b] = W.recover;
      const rec = this.rng.range(a, b);
      this._silence(m.x, m.z, W.moveRadius, () => this.time + rec);
    }
    // 활동도: 조용해질 땐 빨리(약 1.5초), 살아날 땐 천천히 (rampTime)
    const down = 1 - Math.exp(-dt / 1.5), up = dt / Math.max(0.1, W.rampTime);
    const act = this.activity, q = this.quietUntil, t = this.time, lo = W.minActivity;
    for (let k = 0; k < act.length; k++) {
      if (t < q[k]) act[k] += (lo - act[k]) * down;
      else if (act[k] < 1) act[k] = Math.min(1, act[k] + up);
    }
  }

  /** 지점의 활동도 0~1 */
  activityAt(x, z) {
    return this.activity[this._ci(z) * this.n + this._ci(x)];
  }

  /** 반경 r 안 평균 활동도 (듣는 사람 주변 — 벌레 합창 크기) */
  around(x, z, r = 30) {
    let s = 0, c = 0;
    const i0 = this._ci(x - r), i1 = this._ci(x + r), j0 = this._ci(z - r), j1 = this._ci(z + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = -this.half + (i + 0.5) * this.cell, cz = -this.half + (j + 0.5) * this.cell;
      if (Math.hypot(cx - x, cz - z) > r) continue;
      s += this.activity[j * this.n + i]; c++;
    }
    return c ? s / c : 1;
  }

  /** 방향별 (사분면) 활동도 — 동·서·남·북 (Ambience 가 그쪽 벌레 소리 크기로) */
  quadrants(x, z, r = 28, out = { n: 1, e: 1, s: 1, w: 1 }) {
    const f = (dx, dz) => (this.activityAt(x + dx * r * 0.45, z + dz * r * 0.45) + this.activityAt(x + dx * r * 0.85, z + dz * r * 0.85)) / 2;
    out.n = f(0, -1); out.s = f(0, 1); out.e = f(1, 0); out.w = f(-1, 0);
    return out;
  }

  reset() {
    this.quietUntil.fill(0);
    this.activity.fill(1);
  }
}
