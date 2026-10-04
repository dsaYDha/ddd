// =====================================================================
//  FieldAudio — 6단계 소리 (절차 합성, 외부 파일 없음)
//   · 함정: 폭발 (가까우면 귀를 때리는 '꽝' + 땅을 울리는 저음 + 흙이 쏟아지는 소리, 멀면 낮게 굴러오는 '쿵' — 거리/음속만큼 늦게, HRTF),
//           철선 걸림 '딸깍·팅' (안전 손잡이가 튀는 작은 금속음), 꼬챙이 구덩이 (덮개 가지가 부러지며 떨어지는 소리)
//   · 조명탄: 쏘는 '퐁' + 올라가는 '쉬익', 높은 곳에서 터지는 '팍', 타는 동안 지글거림 (흔들리는 위치에서)
//   · 몸: 수통 마시기 (뚜껑·꿀꺽), 개울에서 채우기 (물 차는 꾸르륵), 탐침 (땅 찌르기), 철선 해제 (조심스러운 손·자르기), 손전등 딸깍
// =====================================================================
import { CONFIG } from '../config.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class FieldAudio {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.e = engine;
    this._flares = new Map();     // flare → { src, gain, panner }
    this._t = { drink: 0, refill: 0, probe: 0, disarm: 0 };
  }

  _ok() { return this.e.ready && this.e.ctx; }
  /** 폭발·조명탄: 총성 버스 (압축) / 몸 가까운 소리: 몸 버스 */
  get out() { return this.e.buses.weapons ?? this.e.master; }
  get body() { return this.e.buses.body ?? this.e.master; }

  /**
   * 폭발. d: 거리 (m), pos: 위치 (HRTF), behind: 뒤쪽
   */
  explosion({ distance = 30, pos = null, pan = 0, behind = false } = {}) {
    if (!this._ok()) return;
    const e = this.e, d = Math.max(1, distance);
    const t = e.now + 0.003 + d / CONFIG.ballistics.speedOfSound;
    const near = clamp(1 - d / 60, 0, 1);
    const att = 1 / (1 + d / 25);
    const lp = clamp(16000 * Math.pow(15 / Math.max(15, d), 0.9) * (behind ? 0.75 : 1), 260, 16000);
    const v = e.voice({ gain: 1.5 * att, lowpass: lp, stages: 2, pan, pos, out: this.out, send: 0.5 + 0.8 * clamp(d / 150, 0, 1) });
    // 꽝: 넓은 대역 충격 (가까울수록 날카롭게)
    e.burst({ t, dur: 0.09 + 0.05 * near, attack: 0.0008, gain: 0.9, filter: 'lowpass', freq: 9000, q: 0.5, out: v });
    e.burst({ t, dur: 0.035, attack: 0.0005, gain: 0.6 * near, filter: 'highpass', freq: 1800, q: 0.7, out: v });
    // 땅을 울리는 저음 (멀리까지)
    e.tone({ t, freq: 62, freqEnd: 26, dur: 1.4, gain: 0.9, attack: 0.004, release: 1.1, out: v });
    e.tone({ t: t + 0.01, freq: 110, freqEnd: 45, dur: 0.5, gain: 0.45, attack: 0.003, release: 0.4, out: v });
    // 굴러가는 울림 (숲에서 되돌아옴)
    e.burst({ t: t + 0.02, dur: 1.8, attack: 0.05, gain: 0.35, filter: 'lowpass', freq: 380, q: 0.6, noise: 'brown', out: v });
    // 흙·잎이 쏟아져 내림 (가까울 때)
    if (near > 0.2) {
      const n = Math.round(10 + 30 * near);
      for (let i = 0; i < n; i++) {
        e.burst({ t: t + rand(0.35, 2.6), dur: rand(0.005, 0.02), attack: 0.001, gain: rand(0.03, 0.12) * near, filter: 'bandpass', freq: rand(1200, 4500), q: 2.5, out: v });
      }
      e.burst({ t: t + 0.4, dur: 1.8, attack: 0.2, gain: 0.06 * near, filter: 'bandpass', freq: 2600, q: 0.6, noise: 'pink', out: v });
    }
  }

  /** 철선에 걸림: 안전 손잡이가 튀는 '팅' + 철선 떨림 (아주 가까워야 들림) */
  trip({ distance = 2, pos = null, pan = 0 } = {}) {
    if (!this._ok()) return;
    const e = this.e;
    const g = 0.22 / (1 + distance / 3);
    const t = e.now + 0.01;
    const v = e.voice({ gain: 1, pan, pos, out: this.out, send: 0.05 });
    e.tone({ t, freq: 2850, freqEnd: 2700, dur: 0.06, gain: g, attack: 0.001, release: 0.05, out: v });
    e.tone({ t: t + 0.004, freq: 4400, freqEnd: 4300, dur: 0.035, gain: g * 0.5, attack: 0.001, release: 0.03, out: v });
    e.tone({ t: t + 0.03, freq: 380, freqEnd: 330, dur: 0.28, gain: g * 0.6, attack: 0.002, release: 0.25, wave: 'triangle', out: v });
    e.burst({ t, dur: 0.02, attack: 0.001, gain: g * 0.8, filter: 'bandpass', freq: 3200, q: 3, out: v });
  }

  /** 꼬챙이 구덩이: 덮개 가지가 부러지며 무너지는 소리 + 쿵 */
  pitFall() {
    if (!this._ok()) return;
    const e = this.e, out = this.body, t = e.now + 0.01;
    for (let i = 0; i < 9; i++) e.burst({ t: t + rand(0, 0.18), dur: rand(0.006, 0.02), attack: 0.001, gain: rand(0.1, 0.25), filter: 'bandpass', freq: rand(900, 3200), q: 3, out, pan: rand(-0.3, 0.3) });
    e.burst({ t: t + 0.02, dur: 0.4, attack: 0.02, gain: 0.12, filter: 'bandpass', freq: 2400, q: 0.7, noise: 'pink', out, pan: 0 });
    e.tone({ t: t + 0.12, freq: 95, freqEnd: 48, dur: 0.22, gain: 0.5, attack: 0.003, release: 0.2, out, pan: 0 });
  }

  // ---- 조명탄 ---------------------------------------------------------
  /** 쏘는 '퐁' + 올라가는 쉬익 */
  flareLaunch({ distance = 50, pos = null } = {}) {
    if (!this._ok()) return;
    const e = this.e, d = Math.max(1, distance);
    const t = e.now + 0.01 + d / CONFIG.ballistics.speedOfSound;
    const att = 1 / (1 + d / 20);
    const v = e.voice({ gain: att, lowpass: clamp(14000 * Math.pow(20 / Math.max(20, d), 0.8), 600, 14000), pos, out: this.out, send: 0.4 });
    e.tone({ t, freq: 190, freqEnd: 80, dur: 0.16, gain: 0.7, attack: 0.002, release: 0.14, out: v });
    e.burst({ t, dur: 0.05, attack: 0.001, gain: 0.5, filter: 'lowpass', freq: 1800, q: 0.7, out: v });
    e.burst({ t: t + 0.05, dur: 2.4, attack: 0.1, gain: 0.12, filter: 'bandpass', freq: 3800, freqEnd: 1800, sweep: 2.4, q: 1.4, out: v });
  }

  /** 높은 곳에서 터짐 + 타는 소리 (위치를 따라감) */
  flareIgnite(flare, { distance = 150, pos = null } = {}) {
    if (!this._ok()) return;
    const e = this.e, ctx = e.ctx, d = Math.max(1, distance);
    const t = e.now + 0.01 + d / CONFIG.ballistics.speedOfSound;
    const v = e.voice({ gain: 1 / (1 + d / 60), lowpass: clamp(9000 * Math.pow(60 / Math.max(60, d), 0.7), 800, 9000), pos, out: this.out, send: 0.6 });
    e.burst({ t, dur: 0.06, attack: 0.001, gain: 0.5, filter: 'lowpass', freq: 2500, q: 0.6, out: v });
    e.tone({ t, freq: 140, freqEnd: 60, dur: 0.3, gain: 0.35, attack: 0.002, release: 0.25, out: v });
    // 지글거림 (반복 잡음 + 느린 출렁임)
    if (this._flares.has(flare)) return;
    const src = e.noise('white', true);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 7.3;
    const lg = ctx.createGain(); lg.gain.value = 0.012;
    lfo.connect(lg).connect(g.gain);
    let panner = null, node = src.connect(bp).connect(g);
    if (pos && e.listener && e.hrtf && ctx.createPanner) { panner = e.panner(pos); node = node.connect(panner); }
    node.connect(this.out);
    src.start(t, src._offset); lfo.start(t);
    g.gain.setTargetAtTime(0.03 / (1 + d / 80), t, 0.3);
    this._flares.set(flare, { src, g, lfo, panner });
  }

  /** 매 프레임: 타는 조명탄 소리 위치·크기 (꺼진 것은 정리) — list = Flares.list, listener 기준 거리는 cam */
  updateFlares(list, cam) {
    if (!this._ok() || !this._flares.size) return;
    const e = this.e, t = e.now;
    for (const [f, s] of this._flares) {
      const alive = list.includes(f) && f.phase === 'burn';
      if (!alive) {
        s.g.gain.setTargetAtTime(0, t, 0.4);
        s.src.stop(t + 2); s.lfo.stop(t + 2);
        this._flares.delete(f);
        continue;
      }
      const d = Math.hypot(f.x - cam.x, f.y - cam.y, f.z - cam.z);
      s.g.gain.setTargetAtTime(0.03 * f.intensity / (1 + d / 80), t, 0.2);
      if (s.panner) e.placePanner(s.panner, { x: f.x, y: f.y, z: f.z });
    }
  }

  stopAll() {
    if (!this._ok()) return;
    const t = this.e.now;
    for (const [, s] of this._flares) { s.g.gain.setTargetAtTime(0, t, 0.1); s.src.stop(t + 0.5); s.lfo.stop(t + 0.5); }
    this._flares.clear();
  }

  // ---- 몸 ----------------------------------------------------------------
  /** 수통: start → 뚜껑 돌리는 소리, 마시는 동안 꿀꺽 (tick), 끝 → 뚜껑 */
  canteenCap() {
    if (!this._ok()) return;
    const e = this.e, out = this.body, t = e.now + 0.01;
    for (let i = 0; i < 3; i++) e.burst({ t: t + i * 0.06, dur: 0.02, attack: 0.002, gain: 0.05, filter: 'bandpass', freq: rand(2200, 3000), q: 4, out, pan: 0.1 });
    e.tone({ t: t + 0.2, freq: 1500, freqEnd: 1300, dur: 0.03, gain: 0.025, attack: 0.001, out, pan: 0.1 });
  }

  drinkTick(dt) {
    if (!this._ok()) return;
    this._t.drink -= dt;
    if (this._t.drink > 0) return;
    this._t.drink = rand(0.55, 0.8);
    const e = this.e, out = this.body, t = e.now + 0.01;
    // 꿀꺽: 낮은 공명 + 물 흐르는 소리
    e.tone({ t, freq: 210, freqEnd: 120, dur: 0.12, gain: 0.12, attack: 0.01, release: 0.08, out, pan: 0, filter: { type: 'lowpass', freq: 700 } });
    e.burst({ t: t + 0.03, dur: 0.18, attack: 0.02, gain: 0.03, filter: 'bandpass', freq: rand(700, 1100), q: 2, out, pan: 0 });
  }

  refillTick(dt) {
    if (!this._ok()) return;
    this._t.refill -= dt;
    if (this._t.refill > 0) return;
    this._t.refill = rand(0.08, 0.2);
    const e = this.e, out = this.body, t = e.now + 0.01;
    // 꾸르륵: 물이 수통으로 들어가며 공기 방울
    const f = rand(380, 900);
    e.tone({ t, freq: f, freqEnd: f * rand(1.3, 1.8), dur: rand(0.04, 0.09), gain: 0.05, attack: 0.004, release: 0.04, out, pan: rand(-0.15, 0.15) });
    if (Math.random() < 0.4) e.burst({ t, dur: 0.15, attack: 0.02, gain: 0.04, filter: 'bandpass', freq: rand(900, 1600), q: 1.2, out, pan: 0 });
  }

  probeTick(dt) {
    if (!this._ok()) return;
    this._t.probe -= dt;
    if (this._t.probe > 0) return;
    this._t.probe = rand(0.4, 0.55);
    const e = this.e, out = this.body, t = e.now + 0.01;
    // 칼끝이 흙에 들어가는 둔한 소리
    e.burst({ t, dur: 0.05, attack: 0.004, gain: 0.07, filter: 'lowpass', freq: 700, q: 0.8, out, pan: 0.05 });
    e.burst({ t, dur: 0.02, attack: 0.002, gain: 0.03, filter: 'bandpass', freq: 2400, q: 2, out, pan: 0.05 });
  }

  /** 탐침 끝에 단단한 것 (지뢰) / 빈 곳 (구덩이) */
  probeHit(kind) {
    if (!this._ok()) return;
    const e = this.e, out = this.body, t = e.now + 0.01;
    if (kind === 'mine') {
      e.tone({ t, freq: 1900, freqEnd: 1750, dur: 0.05, gain: 0.05, attack: 0.001, release: 0.04, out, pan: 0.05 });
      e.burst({ t, dur: 0.015, attack: 0.001, gain: 0.05, filter: 'bandpass', freq: 3500, q: 4, out, pan: 0.05 });
    } else {
      e.burst({ t, dur: 0.12, attack: 0.01, gain: 0.06, filter: 'bandpass', freq: 1400, q: 1, noise: 'pink', out, pan: 0.05 });
    }
  }

  disarmTick(dt) {
    if (!this._ok()) return;
    this._t.disarm -= dt;
    if (this._t.disarm > 0) return;
    this._t.disarm = rand(0.6, 1.2);
    const e = this.e, out = this.body, t = e.now + 0.01;
    e.burst({ t, dur: 0.08, attack: 0.01, gain: 0.025, filter: 'bandpass', freq: rand(2500, 4000), q: 1.5, out, pan: rand(-0.2, 0.2) });
  }

  /** 철선을 끊음 */
  snip() {
    if (!this._ok()) return;
    const e = this.e, out = this.body, t = e.now + 0.01;
    e.tone({ t, freq: 3600, freqEnd: 3300, dur: 0.04, gain: 0.05, attack: 0.001, release: 0.03, out, pan: 0 });
    e.tone({ t: t + 0.01, freq: 420, freqEnd: 360, dur: 0.2, gain: 0.03, attack: 0.002, release: 0.18, wave: 'triangle', out, pan: 0 });
  }

  click() {
    if (!this._ok()) return;
    const e = this.e, out = this.body, t = e.now + 0.005;
    e.burst({ t, dur: 0.012, attack: 0.001, gain: 0.06, filter: 'bandpass', freq: 3000, q: 3, out, pan: 0.15 });
  }
}
