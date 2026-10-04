// 지면별 발소리 합성: 흙, 낙엽, 질척이는 진흙, 첨벙이는 물, 풀 헤치는 소리, 지피식물·덤불 바스락
// 4단계 적 발소리는 같은 함수를 재사용한다: spatial.pos 가 있으면 소리 하나를 공용 경로(voice: 거리 저역 통과 + HRTF 위치)로
//  모아 보내고 (재료마다 좌우 팬을 만들지 않음), 거리/음속 만큼 늦게 들린다.
import { CONFIG } from '../config.js';

export class Footsteps {
  constructor(engine) {
    this.e = engine;
    this._outOverride = null;
  }

  get out() { return this._outOverride ?? this.e.buses.footsteps; }

  /**
   * 남(적)의 발소리·헤치는 소리: fn 안의 재료(burst/tone)를 위치 경로 하나로 모음
   * (fn 이 쓰는 this.e 를 잠깐 대리 객체로 바꿔 팬을 떼고 출력·시각을 바꿈)
   */
  _spatial(spatial, fn) {
    const E = this.e;
    const d = Math.max(0.5, spatial.distance ?? 0);
    const lp = Math.max(900, 12000 * Math.pow(5 / Math.max(5, d), 0.75));
    const v = E.voice({ gain: 1, lowpass: lp, pos: spatial.pos, out: E.buses.footsteps, send: 0.04 + 0.2 * Math.min(1, d / 30) });
    const delay = d / CONFIG.ballistics.speedOfSound;
    const proxy = {
      ready: true, buses: E.buses,
      get now() { return E.now + delay; },
      burst: (o) => { o.pan = undefined; o.out = v; return E.burst(o); },
      tone: (o) => { o.pan = undefined; o.out = v; return E.tone(o); },
    };
    this.e = proxy;
    this._outOverride = v;
    try { fn(); } finally { this.e = E; this._outOverride = null; }
  }

  /**
   * @param {object} evt  HumanMotor 'footstep' 이벤트
   * @param {{pan?:number, distance?:number, pos?:{x,y,z}}} spatial
   */
  play(evt, spatial = {}) {
    if (!this.e.ready) return;
    if (spatial.pos && !this._outOverride) { this._spatial(spatial, () => this.play(evt, { distance: spatial.distance, pan: 0 })); return; }
    const t = this.e.now + 0.005;
    const dist = spatial.distance ?? 0;
    const att = 1 / (1 + dist * 0.12);
    const g = Math.min(1.6, evt.intensity) * att * (0.85 + Math.random() * 0.3);
    const pan = spatial.pan ?? (evt.foot === 'L' ? -0.08 : 0.08);
    const pitch = 0.9 + Math.random() * 0.2;
    const fn = this[`_${evt.sound}`] || this._dirt;
    fn.call(this, t, g, pitch, pan, evt);
  }

  // --- 재료 ------------------------------------------------------
  _thump(t, g, freq, dur, pan) {
    this.e.tone({ t, freq, freqEnd: freq * 0.5, dur, gain: 0.5 * g, attack: 0.004, release: dur * 0.9, out: this.out, pan });
  }
  _crackles(t, g, n, spread, lo, hi, pan) {
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * spread;
      this.e.burst({ t: tt, dur: 0.01 + Math.random() * 0.025, gain: g * (0.15 + Math.random() * 0.25), filter: 'bandpass', freq: lo + Math.random() * (hi - lo), q: 2.5, out: this.out, pan: pan + (Math.random() - 0.5) * 0.2 });
    }
  }
  _squelch(t, g, p, pan, long = 1) {
    // 질척: 공명 대역통과가 아래로 훑음 + 낮은 '퍽'
    this.e.burst({ t, dur: 0.18 * long, attack: 0.02, gain: 0.55 * g, filter: 'bandpass', freq: 1100 * p, freqEnd: 260 * p, q: 6, noise: 'pink', out: this.out, pan });
    this.e.burst({ t: t + 0.02, dur: 0.12 * long, attack: 0.01, gain: 0.35 * g, filter: 'lowpass', freq: 500 * p, q: 1, noise: 'brown', out: this.out, pan });
    this.e.tone({ t: t + 0.01, freq: 140 * p, freqEnd: 55, dur: 0.12 * long, gain: 0.25 * g, attack: 0.005, out: this.out, pan });
  }
  _suck(t, g, p, pan, len = 1) {
    // 발을 빼는 빨아들이는 소리: 위로 훑는 공명 + 마지막 '뽁'
    this.e.burst({ t, dur: 0.3 * len, attack: 0.08 * len, gain: 0.5 * g, filter: 'bandpass', freq: 260 * p, freqEnd: 1400 * p, sweep: 0.3 * len, q: 9, noise: 'pink', out: this.out, pan });
    this.e.tone({ t: t + 0.3 * len, freq: 420 * p, freqEnd: 160, dur: 0.07, gain: 0.32 * g, attack: 0.003, out: this.out, pan });
  }
  _splashCore(t, g, p, pan, size = 1) {
    this.e.burst({ t, dur: 0.22 * size, attack: 0.004, gain: 0.5 * g, filter: 'highpass', freq: 1400 * p, q: 0.7, out: this.out, pan });
    this.e.burst({ t, dur: 0.16 * size, attack: 0.01, gain: 0.45 * g, filter: 'lowpass', freq: 700 * p, q: 1.2, noise: 'pink', out: this.out, pan });
    const drops = 3 + Math.floor(Math.random() * 4 * size);
    for (let i = 0; i < drops; i++) {
      const tt = t + 0.05 + Math.random() * 0.25 * size;
      this.e.tone({ t: tt, freq: 1600 + Math.random() * 2400, freqEnd: 900 + Math.random() * 600, dur: 0.03 + Math.random() * 0.03, gain: 0.08 * g, attack: 0.002, out: this.out, pan: pan + (Math.random() - 0.5) * 0.4 });
    }
  }

  // --- 지면별 -----------------------------------------------------
  _dirt(t, g, p, pan) {
    this._thump(t, g * 0.8, 95 * p, 0.09, pan);
    this.e.burst({ t, dur: 0.07, gain: 0.32 * g, filter: 'lowpass', freq: 1100 * p, q: 0.8, noise: 'pink', out: this.out, pan });
    this._crackles(t, g * 0.4, 3, 0.05, 2000, 4000, pan);
  }
  _wetDirt(t, g, p, pan) {
    this._thump(t, g * 0.8, 85 * p, 0.1, pan);
    this.e.burst({ t, dur: 0.09, gain: 0.3 * g, filter: 'lowpass', freq: 700 * p, q: 1, noise: 'pink', out: this.out, pan });
    this.e.burst({ t: t + 0.03, dur: 0.08, attack: 0.01, gain: 0.18 * g, filter: 'bandpass', freq: 900 * p, freqEnd: 400, q: 5, out: this.out, pan });
  }
  _leaves(t, g, p, pan) {
    this._thump(t, g * 0.5, 100 * p, 0.07, pan);
    this.e.burst({ t, dur: 0.16, attack: 0.015, gain: 0.3 * g, filter: 'bandpass', freq: 3200 * p, q: 0.7, out: this.out, pan });
    this._crackles(t, g * 1.1, 14, 0.18, 1800, 7000, pan);
  }
  _mud(t, g, p, pan) {
    this._squelch(t, g, p, pan, 1);
    if (Math.random() < 0.4) this._suck(t + 0.22, g * 0.45, p, pan, 0.7);
  }
  _deepMud(t, g, p, pan) {
    this._squelch(t, g * 1.15, p * 0.85, pan, 1.6);
    this._suck(t + 0.28, g * 0.8, p * 0.9, pan, 1.1);
  }
  _paddy(t, g, p, pan) {
    this._splashCore(t, g * 0.75, p, pan, 0.8);
    this._squelch(t + 0.05, g * 0.8, p, pan, 1.2);
    if (Math.random() < 0.5) this._suck(t + 0.3, g * 0.5, p, pan, 0.8);
  }
  _splash(t, g, p, pan) {
    this._splashCore(t, g * 1.1, p, pan, 1);
  }
  _wade(t, g, p, pan) {
    // 허리까지 오는 물: 묵직하게 밀어내는 소리
    this.e.burst({ t, dur: 0.55, attack: 0.15, gain: 0.55 * g, filter: 'lowpass', freq: 650 * p, freqEnd: 380, q: 1.5, noise: 'pink', out: this.out, pan });
    this.e.burst({ t: t + 0.1, dur: 0.35, attack: 0.08, gain: 0.2 * g, filter: 'bandpass', freq: 1800 * p, q: 0.8, out: this.out, pan });
    this._splashCore(t + 0.15, g * 0.35, p, pan, 0.6);
  }
  _brush(t, g, p, pan) {
    // 키 큰 풀·밀집 덤불: 줄기 부딪힘 + 짧은 쉬익 (긴 '헤치는' 소리는 rustle 이벤트가 냄)
    this.e.burst({ t, dur: 0.22, attack: 0.04, gain: 0.22 * g, filter: 'bandpass', freq: 2400 * p, freqEnd: 4200 * p, q: 0.9, out: this.out, pan });
    this._crackles(t, g * 0.7, 8, 0.3, 1500, 5000, pan);
    this._thump(t, g * 0.4, 90 * p, 0.08, pan);
  }
  _groundCover(t, g, p, pan) {
    // 낮은 지피식물: 부드러운 발 디딤 + 잎이 눌리는 작은 소리
    this._thump(t, g * 0.55, 95 * p, 0.08, pan);
    this.e.burst({ t, dur: 0.12, attack: 0.012, gain: 0.18 * g, filter: 'bandpass', freq: 2600 * p, q: 0.8, out: this.out, pan });
    this._crackles(t, g * 0.55, 5, 0.12, 1800, 5200, pan);
  }
  _shrub(t, g, p, pan) {
    // 무릎~허리 덤불: 가지 부딪힘
    this._thump(t, g * 0.5, 92 * p, 0.08, pan);
    this.e.burst({ t, dur: 0.16, attack: 0.02, gain: 0.2 * g, filter: 'bandpass', freq: 2200 * p, q: 0.9, out: this.out, pan });
    this._crackles(t, g * 0.75, 7, 0.22, 1400, 4800, pan);
  }

  /**
   * 식물을 헤치고 지나가는 '바스락·쉬익' (HumanMotor 'rustle' 이벤트, 반경이 클수록 큼)
   * @param {{surfaceKey:string, radius:number, gait:string}} evt
   */
  rustle(evt, spatial = {}) {
    if (!this.e.ready) return;
    if (spatial.pos && !this._outOverride) { this._spatial(spatial, () => this.rustle(evt, { distance: spatial.distance, pan: 0 })); return; }
    const t = this.e.now + 0.02 + Math.random() * 0.04;
    const dist = spatial.distance ?? 0;
    const pan = spatial.pan ?? (Math.random() - 0.5) * 0.5;
    const g = Math.min(1.4, evt.radius / 20) / (1 + dist * 0.12);
    const tall = evt.surfaceKey === 'brush' ? 1 : evt.surfaceKey === 'shrub' ? 0.7 : 0.4;
    const p = 0.9 + Math.random() * 0.2;
    const dur = 0.25 + 0.3 * tall;
    this.e.burst({ t, dur, attack: dur * 0.3, gain: 0.38 * g, filter: 'bandpass', freq: 2100 * p, freqEnd: (3200 + 2200 * tall) * p, q: 0.8, out: this.out, pan });
    this.e.burst({ t: t + dur * 0.25, dur: dur * 0.8, attack: dur * 0.2, gain: 0.22 * g * tall, filter: 'bandpass', freq: 4400 * p, freqEnd: 2500 * p, q: 1.1, out: this.out, pan: -pan });
    this._crackles(t, g * (0.4 + 0.5 * tall), 4 + Math.round(6 * tall), dur, 1200, 5200, pan);
  }

  // --- 기타 몸 동작 ----------------------------------------------
  land(evt) {
    if (!this.e.ready) return;
    const t = this.e.now + 0.003;
    const g = Math.min(1.5, 0.6 + evt.speed * 0.25);
    this._thump(t, g * 1.3, 70, 0.16, 0);
    const fn = this[`_${evt.sound || 'dirt'}`] || this._dirt;
    fn.call(this, t + 0.01, g, 0.85, 0, evt);
  }

  suction(evt) {
    if (!this.e.ready) return;
    const t = this.e.now + 0.01;
    const g = 0.6 + evt.intensity * 0.9;
    // 빠진 발을 빼는 길고 무거운 빨아들이는 소리
    this.e.burst({ t, dur: 0.35, attack: 0.12, gain: 0.35 * g, filter: 'lowpass', freq: 380, q: 2, noise: 'brown', out: this.out });
    this._suck(t + 0.1, g, 0.8, 0, 1.6 + evt.intensity);
  }

  slide(evt) {
    if (!this.e.ready) return;
    const t = this.e.now;
    const g = Math.min(1.2, 0.5 + evt.speed * 0.35);
    // 진흙 위로 미끄러지는 '쓰윽' + 흙 부스러기
    this.e.burst({ t, dur: 0.6, attack: 0.08, gain: 0.8 * g, filter: 'bandpass', freq: 650, freqEnd: 380, q: 1.2, noise: 'pink', out: this.out });
    this.e.burst({ t: t + 0.08, dur: 0.45, attack: 0.05, gain: 0.45 * g, filter: 'bandpass', freq: 1400, freqEnd: 650, q: 3, out: this.out });
    this._crackles(t, g * 0.8, 6, 0.5, 900, 3000, 0);
  }

  stance(evt) {
    if (!this.e.ready) return;
    const t = this.e.now;
    // 장비 덜그럭 + 옷 스치는 소리
    this.e.burst({ t, dur: 0.25 + (evt.to === 'prone' ? 0.25 : 0), attack: 0.05, gain: 0.18, filter: 'bandpass', freq: 2200, q: 0.8, out: this.out });
    if (evt.to === 'prone') this._thump(t + evt.duration * 0.8, 0.7, 75, 0.14, 0);
    this.e.tone({ t: t + 0.05 + Math.random() * 0.1, freq: 2600, freqEnd: 2400, dur: 0.05, gain: 0.03, attack: 0.002, out: this.out });
  }
}
