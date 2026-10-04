// =====================================================================
//  WeatherCycle — 5단계 임무 중 날씨 흐름 (순수 로직).
//   계획(plan) = [{ kind, dur }] (실제 s) — 기본 흐름: 맑음 → 흐림 → 비 → 폭우 → 그침(안개).
//   구간 끝 trans 초 동안 다음 구간으로 섞는다 → params { rain, wetness, fogAdd, sunMul, skyGray, mistMul, kind, next, k }.
//   (Atmosphere 가 이 값으로 하늘·안개·비를, 젖음도가 1단계 미끄러짐을, 빗소리가 4단계 청각(소음 반경)을 가린다)
//   천둥: 폭우 중 9~30초, 비 중 가끔 — 'flash' {distance, intensity} 즉시, 'thunder' {distance, intensity} 는 거리/음속 뒤.
//   천둥이 울리는 동안 thunderMask (0~1, 약 2.5초에 걸쳐 줄어듦) — 총성이 묻힌다 (적 청각 반경·플레이어 귀).
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const FIELDS = ['rain', 'wetness', 'fogAdd', 'sunMul', 'skyGray', 'mistMul'];
const ORDER = ['clear', 'overcast', 'rain', 'storm', 'clearing'];

export class WeatherCycle extends EventEmitter {
  /** @param {Array<{kind:string, dur:number}>} plan  @param {{range(a,b):number, chance(p):boolean}} rng */
  constructor(plan, rng, opts = {}) {
    super();
    this.plan = plan.length ? plan : [{ kind: 'clear', dur: 1e9 }];
    this.rng = rng;
    this.trans = opts.trans ?? 75;       // 구간 사이 섞는 시간 (s)
    this.t = 0;
    this.params = {};
    this.thunderMask = 0;
    this._thunderIn = this._nextThunder(this.plan[0].kind);
    this._pending = [];                  // 번쩍인 뒤 소리가 올 천둥
    this._eval();
  }

  /** 임무 길이(s)에 맞춘 기본 흐름 — 시작 구간을 무작위로 앞당겨 매번 조금 다르게 (가끔 흐림부터) */
  static makePlan(total, rng) {
    const w = { clear: 0.17, overcast: 0.15, rain: 0.2, storm: 0.16, clearing: 0.32 };
    const startAt = rng.chance(0.3) ? 1 : 0;   // 30% 는 흐림부터 시작
    const kinds = ORDER.slice(startAt);
    let sum = 0;
    for (const k of kinds) sum += w[k];
    const plan = kinds.map((k) => ({ kind: k, dur: (total * 1.05 * w[k] / sum) * rng.range(0.8, 1.2) }));
    plan.push({ kind: 'clearing', dur: 1e6 });
    return plan;
  }

  get kind() { return this.params.kind; }

  /** 지금 구간 */
  _segment() {
    let acc = 0;
    for (let i = 0; i < this.plan.length; i++) {
      const seg = this.plan[i];
      if (this.t < acc + seg.dur || i === this.plan.length - 1) return { i, seg, local: this.t - acc };
      acc += seg.dur;
    }
    return { i: this.plan.length - 1, seg: this.plan[this.plan.length - 1], local: 0 };
  }

  _eval() {
    const { i, seg, local } = this._segment();
    const next = this.plan[Math.min(this.plan.length - 1, i + 1)];
    const W = CONFIG.weather.presets;
    const a = W[seg.kind], b = W[next.kind];
    const tr = Math.min(this.trans, seg.dur * 0.5);
    let k = seg.dur - local < tr ? 1 - (seg.dur - local) / tr : 0;
    k = k * k * (3 - 2 * k);
    const P = this.params;
    for (const f of FIELDS) {
      const va = a[f] ?? (f === 'mistMul' ? 1 : 0), vb = b[f] ?? (f === 'mistMul' ? 1 : 0);
      P[f] = va + (vb - va) * k;
    }
    P.kind = seg.kind; P.next = next.kind; P.k = k;
    P.label = k > 0.5 ? b.label : a.label;
    return P;
  }

  _nextThunder(kind) {
    if (kind === 'storm') return this.rng.range(9, 30);
    if (kind === 'rain') return this.rng.range(40, 100);
    return Infinity;
  }

  update(dt) {
    if (!(dt > 0)) return this.params;
    this.t += dt;
    const P = this._eval();
    // 천둥 마스크 감소
    this.thunderMask *= Math.exp(-dt / 2.5);
    // 번쩍임 → 소리
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const th = this._pending[i];
      th.in -= dt;
      if (th.in <= 0) {
        this._pending.splice(i, 1);
        this.thunderMask = Math.max(this.thunderMask, th.intensity);
        this.emit('thunder', th);
      }
    }
    // 다음 천둥 (폭우: 자주, 비: 가끔 — 섞이는 중이면 비 강도로)
    const kind = P.rain >= 0.7 ? 'storm' : P.rain >= 0.3 ? 'rain' : 'none';
    if (kind === 'none') { this._thunderIn = Math.max(this._thunderIn, 20); return P; }
    if (!Number.isFinite(this._thunderIn)) this._thunderIn = this._nextThunder(kind);
    this._thunderIn -= dt;
    if (this._thunderIn <= 0) {
      this._thunderIn = this._nextThunder(kind);
      const distance = this.rng.range(350, kind === 'storm' ? 2800 : 4000);
      const intensity = Math.max(0.25, Math.min(1, 1.15 - distance / 3200)) * this.rng.range(0.8, 1.1);
      const th = { distance, intensity: Math.min(1, intensity), in: distance / CONFIG.ballistics.speedOfSound };
      this.emit('flash', { distance, intensity: th.intensity });
      this._pending.push(th);
    }
    return P;
  }
}
