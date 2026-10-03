// 숨소리 (스태미나·심박 연동) + 심장 박동 — 수치 바 대신 소리로 지침을 전달
import { CONFIG } from '../config.js';

export class Breathing {
  constructor(engine) {
    this.e = engine;
    this.heartPhase = 0;
    this.holding = false;   // 숨 참는 중 (조준 중 Shift) — 숨소리 없음 (참기 직전 들숨·놓을 때 헐떡임은 WeaponAudio.breath)
  }

  /**
   * @param {import('../player/BreathCycle.js').BreathCycle} cycle
   * @param {{heartRate:number, exhausted:boolean}} body
   */
  update(dt, cycle, body) {
    if (!this.e.ready) return;
    const b = cycle.intensity;
    const audible = CONFIG.audio.breathAudibleFrom;
    if (b > audible && !this.holding) {
      const level = Math.pow((b - audible) / (1 - audible), 1.3);
      if (cycle.justInhaled) this._inhale(level, 0.42 / cycle.rate, body.exhausted);
      if (cycle.justExhaled) this._exhale(level, 0.58 / cycle.rate, body.exhausted);
    }
    // 심장 박동 (심박 140 이상에서 희미하게)
    if (body.heartRate > 135) {
      this.heartPhase += (body.heartRate / 60) * dt;
      if (this.heartPhase >= 1) {
        this.heartPhase -= 1;
        const g = Math.min(1, (body.heartRate - 135) / 40) * 0.22;
        const t = this.e.now + 0.01;
        const out = this.e.buses.body;
        this.e.tone({ t, freq: 58, freqEnd: 40, dur: 0.1, gain: g, attack: 0.005, out });
        this.e.tone({ t: t + 0.16, freq: 52, freqEnd: 38, dur: 0.09, gain: g * 0.7, attack: 0.005, out });
      }
    }
  }

  _inhale(level, period, exhausted) {
    const e = this.e, out = e.buses.body;
    const t = e.now + 0.01;
    const dur = Math.min(1.2, period * 0.85);
    e.burst({ t, dur, attack: dur * 0.5, gain: 0.24 * level, filter: 'bandpass', freq: 1700, freqEnd: 2300, sweep: dur, q: 1.1, out });
    e.burst({ t, dur, attack: dur * 0.6, gain: 0.08 * level, filter: 'highpass', freq: 3000, q: 0.5, out });
    if (exhausted) {
      // 거친 숨: 목이 긁히는 쌕쌕거림
      e.burst({ t: t + 0.03, dur: dur * 0.8, attack: dur * 0.4, gain: 0.07 * level, filter: 'bandpass', freq: 2600, q: 9, out });
    }
  }

  _exhale(level, period, exhausted) {
    const e = this.e, out = e.buses.body;
    const t = e.now + 0.01;
    const dur = Math.min(1.5, period * 0.8);
    e.burst({ t, dur, attack: 0.05, gain: 0.34 * level, filter: 'bandpass', freq: 1100, freqEnd: 700, sweep: dur, q: 0.9, noise: 'pink', out });
    e.burst({ t, dur: dur * 0.7, attack: 0.03, gain: 0.07 * level, filter: 'lowpass', freq: 500, q: 1, noise: 'brown', out });
    if (exhausted) {
      e.tone({ t, freq: 125, freqEnd: 105, dur: dur * 0.6, gain: 0.025 * level, wave: 'sawtooth', attack: 0.03, out, filter: { type: 'bandpass', freq: 600, q: 2 } });
    }
  }
}
