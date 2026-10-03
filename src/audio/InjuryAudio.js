// 부상 소리 (Web Audio 절차 합성 — 외부 파일 없음)
//  · 내 몸에 맞음: 몸 안에서 울리는 둔탁한 '퍽' (저역 쿵 + 갈비뼈 울림) + 짧은 신음 + 이명 (먹먹함을 건너뛰는 귀 안의 고음)
//  · 사람 개체: 맞는 소리는 WeaponAudio.impact('body'), 여기서는 신음·거친 숨·기침 (거리·방향·숲 흡수)
//  · 자가 처치: 붕대 포장 뜯기 → 감는 천 소리 (진행 중 틱), 지혈대 찍찍이 → 끈 당김 → 막대 돌리는 딸깍
//  목소리 = 톱니파 성대음 → 모음 포먼트(대역 통과 2~3개) + 숨 잡음. 남성 기본 주파수 95~150Hz.
import { CONFIG } from '../config.js';

const rand = (a, b) => a + Math.random() * (b - a);
// 멀리서 들리는 목소리: 크기 = 1 / (1 + d·fall), 저역 통과 = lpHz·(lpRefM/d)^lpExp
const FAR = { fall: 0.18, lpHz: 9000, lpRefM: 6, lpExp: 0.7, minLp: 500, send: 0.12, farSend: 0.35, farM: 50 };
// 모음 포먼트 (Hz, 상대 크기) — 신음 '으/어/아'
const VOWELS = {
  uh: [[500, 1], [1000, 0.5], [2400, 0.12]],
  ah: [[720, 1], [1150, 0.6], [2500, 0.15]],
  oh: [[480, 1], [820, 0.55], [2450, 0.1]],
};

export class InjuryAudio {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.e = engine;
    this._aidT = 0;
    this._tin = null;
  }

  get ok() { return !!this.e.ready; }

  // =================================================================
  // 플레이어
  // =================================================================
  /** 내가 맞음: severity 'lethal'|'wound'|'graze' */
  selfHit({ severity = 'wound' } = {}) {
    if (!this.ok) return;
    const e = this.e, out = e.buses.body, t = e.now + 0.005;
    const k = severity === 'graze' ? 0.55 : 1;
    // 몸 안에서 울리는 둔탁한 충격 (낮은 쿵 + 짧은 퍽 + 갈비뼈 울림)
    e.tone({ t, freq: 95, freqEnd: 34, dur: 0.32, gain: 0.95 * k, attack: 0.002, release: 0.3, out });
    e.burst({ t, dur: 0.16, attack: 0.002, gain: 0.7 * k, filter: 'lowpass', freq: 420, q: 0.9, noise: 'brown', out });
    e.burst({ t, dur: 0.035, attack: 0.001, gain: 0.35 * k, filter: 'bandpass', freq: 1400, q: 0.8, noise: 'pink', out });
    e.tone({ t: t + 0.01, freq: 230, freqEnd: 160, dur: 0.12, gain: 0.12 * k, attack: 0.003, release: 0.1, out, filter: { type: 'bandpass', freq: 400, q: 3 } });
    if (severity !== 'lethal') this._voice({ t: t + rand(0.12, 0.22), dur: rand(0.28, 0.45), f0: rand(125, 150), f1: rand(95, 110), vowel: 'uh', gain: 0.11 * k, breath: 0.05, out });
    else this._voice({ t: t + 0.08, dur: 0.22, f0: 120, f1: 80, vowel: 'oh', gain: 0.06, breath: 0.08, out });
  }

  /** 이명: 귀 안에서 울리는 고음 — 먹먹함·세상 소리 크기와 무관 (master 로 바로), duration 초에 걸쳐 사라짐 */
  tinnitus(duration = 3, strength = 1) {
    if (!this.ok) return;
    const e = this.e, ctx = e.ctx, t = e.now + 0.01;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 * strength, t + 0.04);
    g.gain.setValueAtTime(0.06 * strength, t + duration * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    g.connect(e.master);
    const f = rand(3900, 4600);
    for (const [mul, a] of [[1, 1], [1.007, 0.6], [1.52, 0.18]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + duration + 0.05);
    }
  }

  /** 아파서 내는 짧은 신음 (플레이어, 처치 끝 등) */
  grunt(gain = 1) {
    if (!this.ok) return;
    const e = this.e;
    this._voice({ t: e.now + 0.01, dur: rand(0.3, 0.5), f0: rand(118, 135), f1: rand(92, 104), vowel: 'uh', gain: 0.09 * gain, breath: 0.05, out: e.buses.body });
  }

  /** 내 기침 (가슴 부상) */
  ownCough() {
    if (!this.ok) return;
    this._cough(this.e.now + 0.01, this.e.buses.body, 1);
  }

  // =================================================================
  // 사람 개체 (거리·방향)
  // =================================================================
  /** kind: 'moan'|'breath'|'cough', spatial {distance, pan, behind}, stage: 'normal'|'weak'|'faint' */
  vocal(kind, { distance = 10, pan = 0, behind = false, stage = 'normal' } = {}) {
    if (!this.ok) return;
    const e = this.e;
    const d = Math.max(0.5, distance);
    if (d > 80) return;
    const lp = Math.max(FAR.minLp, FAR.lpHz * Math.pow(FAR.lpRefM / Math.max(FAR.lpRefM, d), FAR.lpExp) * (behind ? 0.75 : 1));
    const v = e.voice({ gain: 1 / (1 + d * FAR.fall), lowpass: lp, stages: 2, pan, out: e.buses.ambience, send: FAR.send + FAR.farSend * Math.min(1, d / FAR.farM) });
    const t = e.now + 0.01 + d / CONFIG.ballistics.speedOfSound;
    const weak = stage === 'faint' ? 0.55 : stage === 'weak' ? 0.8 : 1;
    if (kind === 'moan') {
      const dur = rand(0.8, 1.6) * (stage === 'faint' ? 1.3 : 1);
      const f0 = rand(105, 150) * (stage === 'faint' ? 0.85 : 1);
      this._voice({ t, dur, f0, f1: f0 * rand(0.7, 0.85), peak: f0 * rand(1.05, 1.25), vowel: Math.random() < 0.5 ? 'oh' : 'uh', gain: 0.34 * weak, breath: 0.12, out: v });
      if (Math.random() < 0.4) this._voice({ t: t + dur + rand(0.2, 0.5), dur: dur * 0.6, f0: f0 * 0.95, f1: f0 * 0.7, vowel: 'uh', gain: 0.2 * weak, breath: 0.1, out: v });
    } else if (kind === 'breath') {
      // 거친 숨: 빠르고 떨리는 들숨·날숨 2~3번 (목소리가 살짝 섞임)
      const n = stage === 'faint' ? 2 : 3;
      let tt = t;
      for (let i = 0; i < n; i++) {
        const din = rand(0.35, 0.5), dout = rand(0.45, 0.7);
        e.burst({ t: tt, dur: din, attack: din * 0.5, gain: 0.3 * weak, filter: 'bandpass', freq: 1700, freqEnd: 2400, sweep: din, q: 1.2, out: v });
        e.burst({ t: tt + din, dur: dout, attack: 0.04, gain: 0.38 * weak, filter: 'bandpass', freq: 1150, freqEnd: 650, sweep: dout, q: 0.9, noise: 'pink', out: v });
        e.tone({ t: tt + din, freq: rand(120, 140), freqEnd: 95, dur: dout * 0.7, gain: 0.05 * weak, wave: 'sawtooth', attack: 0.04, out: v, filter: { type: 'bandpass', freq: 650, q: 2 } });
        tt += din + dout + rand(0.05, 0.2);
      }
    } else if (kind === 'cough') {
      this._cough(t, v, 0.9 * weak);
    }
  }

  /** 몸이 땅에 쓰러지는 소리 (delay 초 뒤): 둔한 쿵 + 낙엽·풀 바스락 + 장비 덜컥 */
  bodyFall({ distance = 10, pan = 0, behind = false, delay = 0.5, heavy = true } = {}) {
    if (!this.ok) return;
    const e = this.e;
    const d = Math.max(0.5, distance);
    if (d > 90) return;
    const lp = Math.max(FAR.minLp, FAR.lpHz * Math.pow(FAR.lpRefM / Math.max(FAR.lpRefM, d), FAR.lpExp) * (behind ? 0.75 : 1));
    const v = e.voice({ gain: 1 / (1 + d * FAR.fall), lowpass: lp, stages: 2, pan, out: e.buses.ambience, send: FAR.send + FAR.farSend * Math.min(1, d / FAR.farM) });
    const t = e.now + delay + d / CONFIG.ballistics.speedOfSound;
    const k = heavy ? 1 : 0.6;
    e.tone({ t, freq: 80, freqEnd: 42, dur: 0.22, gain: 0.55 * k, attack: 0.004, release: 0.2, out: v });
    e.burst({ t, dur: 0.18, attack: 0.004, gain: 0.4 * k, filter: 'lowpass', freq: 600, q: 0.8, noise: 'brown', out: v });
    e.burst({ t: t + 0.01, dur: 0.45, attack: 0.02, gain: 0.16 * k, filter: 'bandpass', freq: 2800, q: 0.8, out: v });
    e.burst({ t: t + 0.06, dur: 0.02, attack: 0.001, gain: 0.12 * k, filter: 'bandpass', freq: 1900, q: 6, out: v });   // 장비
  }

  // =================================================================
  // 자가 처치
  // =================================================================
  /** 처치 시작: 붕대 포장 뜯기 / 지혈대 찍찍이 */
  aidStart(kind) {
    if (!this.ok) return;
    const e = this.e, out = e.buses.body, t = e.now + 0.01;
    this._aidT = rand(0.3, 0.5);
    if (kind === 'bandage') {
      // 비닐 포장 뜯는 소리: 짧고 바스락거리는 고역 잡음 여러 개
      for (let i = 0; i < 9; i++) e.burst({ t: t + i * 0.03 + rand(0, 0.02), dur: rand(0.01, 0.03), attack: 0.001, gain: rand(0.08, 0.16), filter: 'highpass', freq: rand(2500, 5000), q: 0.7, out });
      e.burst({ t: t + 0.05, dur: 0.25, attack: 0.02, gain: 0.08, filter: 'bandpass', freq: 3200, q: 0.8, out });
    } else {
      this._velcro(t, out, 0.45);
    }
  }

  /** 처치 중 매 프레임 (progress 0~1): 천을 감는 소리 / 끈을 당기고 막대를 돌리는 소리 */
  aidTick(kind, progress, dt) {
    if (!this.ok) return;
    this._aidT -= dt;
    if (this._aidT > 0) return;
    const e = this.e, out = e.buses.body, t = e.now + 0.01;
    if (kind === 'bandage') {
      this._aidT = rand(0.55, 0.9);
      const dur = rand(0.35, 0.6);
      e.burst({ t, dur, attack: dur * 0.4, gain: rand(0.09, 0.14), filter: 'bandpass', freq: rand(1800, 2600), freqEnd: rand(2800, 3800), sweep: dur, q: 1.4, out });
      e.burst({ t, dur: dur * 0.8, attack: dur * 0.3, gain: 0.04, filter: 'highpass', freq: 4500, q: 0.6, out });
    } else if (progress < 0.55) {
      // 끈 당김
      this._aidT = rand(0.5, 0.8);
      const dur = rand(0.25, 0.4);
      e.burst({ t, dur, attack: 0.03, gain: 0.12, filter: 'bandpass', freq: 1300, freqEnd: 2200, sweep: dur, q: 2, out });
    } else {
      // 막대(윈드라스) 돌리기: 플라스틱 딸깍 + 신음
      this._aidT = rand(0.45, 0.7);
      e.burst({ t, dur: 0.012, attack: 0.001, gain: 0.25, filter: 'bandpass', freq: rand(2500, 3200), q: 4, out });
      e.tone({ t, freq: 1800, freqEnd: 1300, dur: 0.03, gain: 0.05, attack: 0.001, release: 0.025, out });
      if (Math.random() < 0.35) this.grunt(0.7);
    }
  }

  /** 처치 끝: 붕대 마무리(테이프) / 지혈대 고정 딸깍 + 신음 */
  aidEnd(kind) {
    if (!this.ok) return;
    const e = this.e, out = e.buses.body, t = e.now + 0.01;
    if (kind === 'bandage') {
      e.burst({ t, dur: 0.18, attack: 0.01, gain: 0.12, filter: 'bandpass', freq: 2200, freqEnd: 1500, sweep: 0.18, q: 1.5, out });
    } else {
      e.burst({ t, dur: 0.015, attack: 0.001, gain: 0.3, filter: 'bandpass', freq: 2800, q: 5, out });
      this._velcro(t + 0.12, out, 0.25);
    }
    this.grunt(0.8);
  }

  // =================================================================
  // 재료
  // =================================================================
  /**
   * 목소리: 톱니파 성대음 (f0 → peak → f1 음정 곡선, 떨림) → 포먼트 대역 통과 → 숨 잡음 섞음
   * o: { t, dur, f0, f1, peak?, vowel, gain, breath, out }
   */
  _voice(o) {
    const e = this.e, ctx = e.ctx;
    const t = o.t, dur = o.dur;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.peak) osc.frequency.linearRampToValueAtTime(o.peak, t + dur * 0.3);
    osc.frequency.linearRampToValueAtTime(o.f1, t + dur);
    // 떨림 (아파서 목소리가 흔들림)
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rand(5, 8);
    const lg = ctx.createGain();
    lg.gain.value = o.f0 * 0.025;
    lfo.connect(lg).connect(osc.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + Math.min(0.12, dur * 0.25));
    env.gain.setValueAtTime(Math.max(0.0002, o.gain * 0.8), t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const sum = ctx.createGain();
    sum.gain.value = 1;
    for (const [f, a] of VOWELS[o.vowel] || VOWELS.uh) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * rand(0.95, 1.05);
      bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.value = a * 2.2;
      osc.connect(bp).connect(g).connect(sum);
    }
    sum.connect(env).connect(o.out);
    osc.start(t); osc.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);
    if (o.breath > 0) e.burst({ t, dur: dur * 0.9, attack: dur * 0.2, gain: o.breath, filter: 'bandpass', freq: 1200, q: 0.8, noise: 'pink', out: o.out });
  }

  /** 기침 2~3번: 성문이 터지는 퍽 + 거친 잡음 + 낮은 목소리 */
  _cough(t, out, gain) {
    const e = this.e;
    const n = 2 + (Math.random() < 0.5 ? 1 : 0);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const g = gain * (i === 0 ? 1 : rand(0.6, 0.85));
      e.burst({ t: tt, dur: 0.14, attack: 0.004, gain: 0.32 * g, filter: 'bandpass', freq: rand(800, 1100), q: 1.3, noise: 'pink', out });
      e.burst({ t: tt, dur: 0.05, attack: 0.002, gain: 0.25 * g, filter: 'lowpass', freq: 500, q: 1, noise: 'brown', out });
      e.tone({ t: tt, freq: rand(150, 175), freqEnd: 95, dur: 0.13, gain: 0.07 * g, wave: 'sawtooth', attack: 0.004, release: 0.1, out, filter: { type: 'bandpass', freq: 700, q: 2.5 } });
      // 젖은 그르렁 (가슴 부상)
      e.burst({ t: tt + 0.05, dur: 0.12, attack: 0.01, gain: 0.06 * g, filter: 'bandpass', freq: 350, q: 6, noise: 'brown', out });
      tt += rand(0.22, 0.34);
    }
    // 기침 뒤 급한 들숨
    e.burst({ t: tt + 0.05, dur: 0.3, attack: 0.15, gain: 0.14 * gain, filter: 'bandpass', freq: 1900, freqEnd: 2500, sweep: 0.3, q: 1.2, out });
  }

  /** 찍찍이 뜯는 소리: 아주 짧은 고역 잡음이 빠르게 이어짐 */
  _velcro(t, out, dur) {
    const e = this.e;
    const n = Math.round(dur / 0.012);
    for (let i = 0; i < n; i++) {
      e.burst({ t: t + i * 0.012 + rand(0, 0.005), dur: rand(0.004, 0.009), attack: 0.0006, gain: rand(0.06, 0.13) * (1 - 0.4 * i / n), filter: 'bandpass', freq: rand(2500, 4500), q: 1.2, out });
    }
  }

}
